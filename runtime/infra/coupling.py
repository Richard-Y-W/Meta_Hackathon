"""LIFELINE coupled town (P11): qualified power (pandapower) and water (EPANET/WNTR) plants plus a labeled
modeled communications profile, joined only through declared dependency edges.

Each coupling step (fixed-length, declared) starts with a bounded fixed-point at the step's start time:
  power solution -> pump supply (bus energized)   -> water pump physical status (restart delay on return)
  water solution -> pump electrical load (P = rho g Q H / efficiency) -> power load -> re-solve
until pump powers change by less than the tolerance; then both plants advance to the next step. Routers
run on mains while their bus is energized, otherwise on battery until it is exhausted. Remote telemetry and
commands need the site router; local station control and electrical protection never do.

Private truth (both ledgers, comms states) is evaluator-only. Controllers see `observe()` and `command()`.
"""
import copy
import json
import math
import os

import checkpoints
from clock import ClockMapping
from power_pandapower import PowerPlant
from protocol import Rejected
from water_wntr import WaterPlant

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIX = os.path.join(ROOT, 'fixtures/lifeline/infra')
S = 1000000


def load_town(path=os.path.join(FIX, 'town/development.json')):
    with open(path) as handle:
        town = json.load(handle)
    base = os.path.dirname(path)
    with open(os.path.normpath(os.path.join(base, town['power']['development']))) as handle:
        pdev = json.load(handle)
    with open(os.path.normpath(os.path.join(os.path.dirname(os.path.join(base, town['power']['development'])), pdev['network']['base']))) as handle:
        power = json.load(handle)
    power.pop('scenario', None)
    power.update(copy.deepcopy(pdev['network']['overrides']))
    power['extraLoads'] = copy.deepcopy(town['power']['extraLoads'])
    with open(os.path.normpath(os.path.join(base, town['water']['development']))) as handle:
        water = json.load(handle)['network']
    with open(os.path.join(base, town['dependencies'])) as handle:
        deps = json.load(handle)
    return {'town': town, 'power': power, 'water': water, 'dependencies': deps}


class Town:
    def __init__(self, bundle, faults=(), disabled_edges=(), coupling_step_us=None, state=None, order='supply_first', admitted=False):
        self.bundle = bundle
        self.cfg = bundle['town']
        self.edges = {e['id']: e for e in bundle['dependencies']['edges']}
        for edge in disabled_edges:
            if edge not in self.edges:
                raise Rejected('unknown_edge', edge)
        self.clock = ClockMapping(**self.cfg['clock'])
        self.step_us = coupling_step_us or self.cfg['couplingStepUs']
        if order not in ('supply_first', 'load_first'):
            raise Rejected('invalid_coupling_order', order)
        self.order = order  # fixed-point sweep order; the converged state must not depend on it
        if self.step_us % (bundle['water']['hydraulicStepS'] * S):
            raise Rejected('invalid_coupling_step', 'the coupling step must be a multiple of the hydraulic step')
        if state is not None:
            self.state = state
            if admitted:  # admitted plant models are forked through their own previews' rules
                self.power = PowerPlant(None, state=checkpoints.unseal(state.pop('powerCheckpoint')))
                self.water = WaterPlant(None, state=checkpoints.unseal(state.pop('waterCheckpoint')))
            else:
                self.power = PowerPlant.from_checkpoint(state.pop('powerCheckpoint'))
                self.water = WaterPlant.from_checkpoint(state.pop('waterCheckpoint'))
            self.state.setdefault('resources', {rid: {'allocatedTo': None, 'readyAtUs': None, 'fuelJ': float(r['fuelJ']), 'tripped': False, 'exhaustedAtUs': None}
                                                for rid, r in self.cfg.get('resources', {}).items()})
            return
        by = {'power': [], 'water': [], 'communications': []}
        for f in faults:
            by[f['domain']].append({k: v for k, v in f.items() if k not in ('domain', 'hazard')})
        self.power = PowerPlant(copy.deepcopy(bundle['power']), faults=by['power'])
        self.water = WaterPlant(copy.deepcopy(bundle['water']), faults=by['water'])
        wn = self.water.net.wn
        self.state = {
            'nowUs': 0, 'disabled': sorted(disabled_edges), 'stepUs': self.step_us,
            'commanded': {p: str(wn.get_link(p).initial_status).lower() in ('open', '1', 'linkstatus.open') for p in self.water.net.pumps},
            'powered': {}, 'restartAtUs': {}, 'physical': {},
            'routers': {e['destination']['asset']: {'batteryJ': float(e['battery']['capacityJ']), 'onMains': True, 'failed': False, 'up': True, 'exhaustedAtUs': None}
                        for e in self.edges.values() if e['kind'] == 'physical_supply' and e['destination']['domain'] == 'communications'},
            'commsFaults': sorted(by['communications'], key=lambda f: (f['atUs'], f['faultId'])),
            'hazards': {f['faultId']: f.get('hazard') for f in faults if f.get('hazard')},
            'stationMode': 'auto', 'telemetry': {}, 'outOfOrderDropped': 0, 'commands': [], 'events': [], 'trace': [], 'lastLocalUs': None,
            'resources': {rid: {'allocatedTo': None, 'readyAtUs': None, 'fuelJ': float(r['fuelJ']), 'tripped': False, 'exhaustedAtUs': None}
                          for rid, r in self.cfg.get('resources', {}).items()},
        }
        for p, on in self.state['commanded'].items():
            self.state['physical'][p] = on
        self.power.advance(0)
        self.water.advance(0)
        self._couple(0)
        self._record(0, 0)

    # ---- shared resources (portable generator) --------------------------------------------------------
    def generator_for(self, kind, asset, now):
        """The allocated, connected, fuelled generator serving this pump or router, if any."""
        for rid, cfg in self.cfg.get('resources', {}).items():
            r = self.state['resources'].get(rid)
            if r is None or r['allocatedTo'] is None or r['tripped'] or r['fuelJ'] <= 0 or r['readyAtUs'] > now:
                continue
            if asset in cfg['serves'].get(r['allocatedTo'], {}).get(kind, []):
                return rid
        return None

    def _generator_load_w(self, rid, now):
        cfg, total = self.cfg['resources'][rid], 0.0
        site = cfg['serves'][self.state['resources'][rid]['allocatedTo']]
        for pump in site.get('pumps', []):
            edge = next((e for e in self._supply_edges('water') if e['destination']['asset'] == pump), None)
            on_mains = edge is not None and self.enabled(edge['id']) and self.power.bus_energized(edge['source']['asset'])
            if not on_mains and self.state['physical'].get(pump):
                load_edge = next(e for e in self.edges.values() if e['kind'] == 'physical_load' and e['source']['asset'] == pump)
                total += self.power.state.get('coupledLoads', {}).get(load_edge['destination']['asset'], {}).get('pW', 0.0)
        for router in site.get('routers', []):
            r = self.state['routers'].get(router)
            if r is not None and not r['onMains']:
                total += next(e for e in self._supply_edges('communications') if e['destination']['asset'] == router)['battery']['drawW']
        return total

    def _resources(self, start, end):
        for rid, r in self.state['resources'].items():
            if r['allocatedTo'] is None or r['tripped'] or r['readyAtUs'] > start or r['fuelJ'] <= 0:
                continue
            draw = self._generator_load_w(rid, start) * self.cfg['resources'][rid]['fuelPerElectricalJ']
            before = r['fuelJ']
            r['fuelJ'] = max(0.0, before - draw * (end - start) / 1e6)
            if before > 0 and r['fuelJ'] == 0:
                r['exhaustedAtUs'] = start + int(round(before / draw * S)) if draw else start
                self.state['events'].append({'atUs': r['exhaustedAtUs'], 'type': 'generator_fuel_exhausted', 'assetId': rid})

    def _check_generators(self, now):
        changed = False
        for rid, r in self.state['resources'].items():
            if r['allocatedTo'] is None or r['tripped'] or r['readyAtUs'] > now:
                continue
            load = self._generator_load_w(rid, now)
            if load > self.cfg['resources'][rid]['capacityW']:
                r['tripped'] = True
                self.state['events'].append({'atUs': now, 'type': 'generator_overload', 'assetId': rid, 'loadW': load})
                changed = True
        return changed

    # ---- edges -----------------------------------------------------------------------------------------
    def enabled(self, edge_id):
        return edge_id in self.edges and edge_id not in self.state['disabled']

    def _supply_edges(self, domain):
        return [e for e in self.edges.values() if e['kind'] == 'physical_supply' and e['destination']['domain'] == domain]

    def pump_power_w(self, sample, pump, edge):
        """Declared coupling equation; no power is generated by reverse flow or negative head."""
        p = sample['pumps'][pump]
        q, h = p['flowM3s'], p['headGainM']
        if q <= 0 or h <= 0:
            return 0.0
        return edge['rhoKgM3'] * edge['gMs2'] * q * h / edge['efficiency']

    # ---- coupling at one instant ----------------------------------------------------------------------
    def _set_pump(self, pump, on, now, cause):
        if self.state['physical'].get(pump) != on:
            self.water.set_physical(pump, on, source=cause)
            self.state['physical'][pump] = on
            self.state['events'].append({'atUs': now, 'type': 'pump_running' if on else 'pump_stopped', 'assetId': pump, 'cause': cause})

    def _couple(self, now):
        st, iterations = self.state, 0
        for iterations in range(1, self.cfg['maxCouplingIterations'] + 1):
            changed = False
            if self.order == 'load_first':
                changed |= self._loads()
            changed |= self._supply(now)
            if self.order == 'supply_first':
                changed |= self._loads()
            changed |= self._check_generators(now)
            if not changed:
                return iterations
        st['events'].append({'atUs': now, 'type': 'coupling_not_converged', 'iterations': iterations})
        return iterations

    def _supply(self, now):
        st, changed = self.state, False
        if True:
            for e in self._supply_edges('water'):
                pump, bus = e['destination']['asset'], e['source']['asset']
                energized = True if not self.enabled(e['id']) else self.power.bus_energized(bus)
                if energized is False and self.generator_for('pumps', pump, now):
                    energized = True  # supplied by the allocated portable generator
                if energized is None:
                    # No electrical solution: keep the previous supply state, flagged, and attribute it: a
                    # controller command at this instant makes it action-caused, otherwise a model result.
                    acted = any(c['atUs'] == now and c['status'] == 'delivered' for c in st['commands'])
                    st['events'].append({'atUs': now, 'type': 'coupling_unresolved', 'assetId': bus, 'solveStatus': self.power.solve_status['status'],
                                         'cause': 'action_caused' if acted else 'model_nonconvergence'})
                    continue
                if st['powered'].get(pump) != energized:
                    first = pump not in st['powered']
                    st['powered'][pump] = energized
                    if first:
                        continue  # initial supply state: no restart sequence
                    st['events'].append({'atUs': now, 'type': 'supply_restored' if energized else 'supply_lost', 'assetId': pump, 'edge': e['id']})
                    if energized:
                        st['restartAtUs'][pump] = now + e['restartDelayUs']
                    else:
                        st['restartAtUs'].pop(pump, None)
                    changed = True
            for pump in self.water.net.pumps:
                want = st['commanded'][pump] and st['powered'].get(pump, True) and pump not in self.water.state['unavailable'] and st['restartAtUs'].get(pump, 0) <= now
                if st['physical'][pump] != want:
                    self._set_pump(pump, want, now, 'coupling' if not st['powered'].get(pump, True) or st['restartAtUs'].get(pump, 0) else 'command')
                    changed = True
        return changed

    def _loads(self):
        changed = False
        if True:
            sample = self.water.ledger_tail()
            for e in self.edges.values():
                if e['kind'] != 'physical_load':
                    continue
                watts = self.pump_power_w(sample, e['source']['asset'], e) if self.enabled(e['id']) else 0.0
                load = e['destination']['asset']
                previous = self.power.state.get('coupledLoads', {}).get(load, {}).get('pW')
                if previous is None or abs(previous - watts) > self.cfg['couplingToleranceW']:
                    changed = True
                self.power.set_coupled_load(load, watts, watts * math.tan(math.acos(e['powerFactor'])))
        return changed

    # ---- communications (modeled) ---------------------------------------------------------------------
    def _comms(self, start, end):
        st, dt = self.state, (end - start) / 1e6
        while st['commsFaults'] and st['commsFaults'][0]['atUs'] <= start:
            f = st['commsFaults'].pop(0)
            if f['type'] == 'router_fail':
                st['routers'][f['assetId']]['failed'] = True
            st['events'].append({'atUs': f['atUs'], 'type': f['type'], 'assetId': f['assetId'], 'hazard': st['hazards'].get(f['faultId'])})
        for e in self._supply_edges('communications'):
            r = st['routers'][e['destination']['asset']]
            mains = True if not self.enabled(e['id']) else bool(self.power.bus_energized(e['source']['asset'])) or bool(self.generator_for('routers', e['destination']['asset'], start))
            r['onMains'] = mains
            b = e['battery']
            if mains:
                r['batteryJ'] = min(b['capacityJ'], r['batteryJ'] + b['chargeW'] * dt)
            else:
                remaining = r['batteryJ']
                r['batteryJ'] = max(0.0, remaining - b['drawW'] * dt)
                if remaining > 0 and r['batteryJ'] == 0 and r['exhaustedAtUs'] is None:
                    r['exhaustedAtUs'] = start + int(round(remaining / b['drawW'] * S))
                    st['events'].append({'atUs': r['exhaustedAtUs'], 'type': 'router_battery_exhausted', 'assetId': e['destination']['asset']})
            r['up'] = not r['failed'] and (mains or r['batteryJ'] > 0)

    def router_up(self, router):
        return router is None or self.state['routers'].get(router, {'up': True})['up']

    def _path_edge(self, site):
        return next((e for e in self.edges.values() if e['kind'] == 'control_path' and e['destination']['asset'] == site), None)

    def site_reachable(self, site):
        edge = self._path_edge(site)
        if edge is None or not self.enabled(edge['id']):
            return True
        return self.router_up(self.bundle['dependencies']['sites'][site]['router'])

    # ---- local station control (needs station power, never comms) ------------------------------------
    def _local_station(self, now):
        cfg, st = self.cfg['localStation'], self.state
        if now % cfg['periodUs']:
            return  # fixed schedule (multiples of the period), independent of the coupling step
        st['lastLocalUs'] = now
        level = self.water.ledger_tail()['tanks']['T1']['levelM']  # hardwired local level transmitter
        if st.get('stationMode', 'auto') == 'paused':  # a permitted remote demand shift: duty pumps held off
            for p in cfg['duty']:
                if st['commanded'][p]:
                    st['commanded'][p] = False
                    st['events'].append({'atUs': now, 'type': 'local_command', 'assetId': p, 'on': False, 'reason': 'station_paused'})
            return
        duty = next((p for p in cfg['duty'] if p not in self.water.state['unavailable'] and st['powered'].get(p, True)), None)
        for p in cfg['duty']:
            if p != duty and st['commanded'][p]:
                st['commanded'][p] = False
                st['events'].append({'atUs': now, 'type': 'local_command', 'assetId': p, 'on': False})
        if duty is not None:
            if level < cfg['pumpOnBelowM'] and not st['commanded'][duty]:
                st['commanded'][duty] = True
                st['events'].append({'atUs': now, 'type': 'local_command', 'assetId': duty, 'on': True})
            elif level > cfg['pumpOffAboveM'] and st['commanded'][duty]:
                st['commanded'][duty] = False
                st['events'].append({'atUs': now, 'type': 'local_command', 'assetId': duty, 'on': False})

    # ---- time -----------------------------------------------------------------------------------------
    def advance(self, to_us):
        if to_us % self.step_us:
            raise Rejected('off_grid_time', str(to_us))
        if to_us < self.state['nowUs']:
            raise Rejected('clock_regression', str(to_us))
        while self.state['nowUs'] < to_us:
            t = self.state['nowUs']
            end = t + self.step_us
            self._comms(t, end)
            self._resources(t, end)
            self.power.advance(end)
            self.water.advance(end)
            self.state['nowUs'] = end
            self._local_station(end)
            iterations = self._couple(end)
            self._record(end, iterations)
        return {'atUs': self.state['nowUs']}

    def _record(self, now, iterations):
        w, p = self.water.ledger_tail(), self.power
        sol = p.solution if p._usable() else None
        essential_power = None
        if sol is not None:
            demand = sum(p.nominal[l][0] for l in p.essential) * 1e6
            essential_power = sum(sol['loadsW'][l] for l in p.essential) / demand if demand else None
        jh = w['nodes']['JH']
        self.state['trace'].append({
            'atUs': now, 'iterations': iterations, 'tankLevelM': w['tanks']['T1']['levelM'],
            'pumps': {q: {'commanded': self.state['commanded'][q], 'powered': self.state['powered'].get(q), 'running': self.state['physical'][q],
                          'flowM3s': w['pumps'][q]['flowM3s'], 'electricalW': p.state.get('coupledLoads', {}).get('load-pump-%s' % q[-1], {}).get('pW')} for q in self.water.net.pumps},
            'routers': {r: {'up': v['up'], 'onMains': v['onMains'], 'batteryJ': v['batteryJ']} for r, v in self.state['routers'].items()},
            'essentialPowerFraction': essential_power, 'hospitalWaterFraction': (jh['deliveredM3s'] / jh['requiredM3s']) if jh['requiredM3s'] else None,
        })

    # ---- controller-facing views ----------------------------------------------------------------------
    def _site_of(self, domain, sensor_id):
        for name, site in self.bundle['dependencies']['sites'].items():
            listed = site.get(domain)
            if listed == '*' or (isinstance(listed, list) and sensor_id in listed):
                return name
        return None

    def admit_telemetry(self, reading):
        """Keep the newest reading per sensor; an older one arriving late is dropped and counted."""
        held = self.state['telemetry'].get(reading['sensorId'])
        if held is not None and reading['observedAtUs'] < held['observedAtUs']:
            self.state['outOfOrderDropped'] += 1
            return False
        self.state['telemetry'][reading['sensorId']] = reading
        return True

    def observe(self):
        """Remote view: a reading reaches the control center only over a working path; otherwise the last
        delivered value is kept with its original time (stale), never replaced by a failure value."""
        now, out = self.state['nowUs'], []
        for domain, obs in (('power', self.power.observe()), ('water', self.water.observe())):
            for r in obs['readings']:
                site = self._site_of(domain, r['sensorId'])
                key = '%s:%s' % (domain, r['sensorId'])
                fresh = dict(r, sensorId=key, domain=domain, site=site)
                if self.site_reachable(site):
                    self.admit_telemetry(fresh)
                held = self.state['telemetry'].get(key)
                out.append(held if held is not None else dict(fresh, value=None, missingReason='telemetry_path_down', observedAtUs=now))
        return {'atUs': now, 'readings': out, 'routers': {r: ('up' if v['up'] else 'unreachable') for r, v in self.state['routers'].items()},
                'staleAfterUs': 2 * self.step_us, 'clock': self.clock.manifest()}

    def command(self, domain, action, base_revision):
        """Remote command over the site's control path. Without a path it is not delivered and has no
        effect: status `unconfirmed`. Delivered commands are applied after the declared latency."""
        now = self.state['nowUs']
        if domain == 'resource':
            return self._resource_command(action, now)
        if domain == 'water':
            site, asset = 'pump-station', action['params'].get('pumpId') or action['params'].get('linkId') or 'pump-station'
        else:
            site, asset = 'substation', action['params'].get('switchId')
        record = {'atUs': now, 'domain': domain, 'action': action, 'site': site}
        if not self.site_reachable(site):
            record.update(status='unconfirmed', reason='no_control_path')
            self.state['commands'].append(record)
            return record
        latency = self._path_edge(site)['latencyUs'] if self._path_edge(site) else 0
        try:
            if domain == 'power':
                effect = self.power.change(action, base_revision)
            elif action['type'] == 'set_station_mode':
                if action['params'].get('mode') not in ('auto', 'paused'):
                    raise Rejected('invalid_parameters', str(action['params'].get('mode')))
                self.state['stationMode'] = action['params']['mode']
                self.state['lastLocalUs'] = None
                effect = {'assetId': 'pump-station', 'mode': self.state['stationMode']}
                self._local_station(now - now % self.cfg['localStation']['periodUs']) if now % self.cfg['localStation']['periodUs'] == 0 else None
            elif action['type'] == 'set_pump':
                if asset in self.water.state['unavailable']:
                    raise Rejected('actuator_unavailable', asset)
                if base_revision != self.water.revision:
                    raise Rejected('stale_command')
                self.state['commanded'][asset] = bool(action['params']['on'])
                effect = {'assetId': asset, 'commanded': self.state['commanded'][asset]}
            else:
                effect = self.water.change(action, base_revision)
            record.update(status='delivered', effect=effect, effectAtUs=now + latency, ackAtUs=now + 2 * latency)
        except Rejected as error:
            record.update(status='rejected', reason=error.code)
        self.state['commands'].append(record)
        self._couple(now)
        return record

    def _resource_command(self, action, now):
        """Field dispatch of a shared resource (a crew, not SCADA): no control path needed; it takes the
        declared setup time and one resource cannot be allocated twice."""
        record = {'atUs': now, 'domain': 'resource', 'action': action, 'site': 'field'}
        rid = action['params'].get('resourceId')
        r, cfg = self.state['resources'].get(rid), self.cfg.get('resources', {}).get(rid)
        if r is None:
            record.update(status='rejected', reason='unknown_resource')
        elif action['type'] == 'allocate_generator':
            site = action['params'].get('site')
            if site not in cfg['serves']:
                record.update(status='rejected', reason='unknown_site')
            elif r['allocatedTo'] is not None:
                record.update(status='rejected', reason='resource_allocated', detail=r['allocatedTo'])
            else:
                r.update(allocatedTo=site, readyAtUs=now + cfg['setupUs'], tripped=False)
                record.update(status='delivered', effectAtUs=r['readyAtUs'])
                self.state['events'].append({'atUs': now, 'type': 'generator_dispatched', 'assetId': rid, 'site': site, 'readyAtUs': r['readyAtUs']})
        elif action['type'] == 'release_generator':
            r.update(allocatedTo=None, readyAtUs=None)
            record.update(status='delivered', effectAtUs=now)
        else:
            record.update(status='rejected', reason='unknown_action')
        self.state['commands'].append(record)
        self._couple(now)
        return record

    def world_revision(self):
        """Count of outside events so far (injected faults in any domain, communications faults, protection
        trips). A plan's own effects and the couplings it predicts do not change it."""
        comms = sum(1 for e in self.state['events'] if e['type'] in ('router_fail', 'link_down'))
        trips = sum(1 for e in self.power.state['events'] if e['type'] == 'protection_trip')
        return len(self.power.state['appliedFaults']) + len(self.water.state['appliedFaults']) + comms + trips

    # ---- admitted model and previews ------------------------------------------------------------------
    def admitted_model(self):
        """What a controller may fork: both plants' admitted models and the town state without pending
        hidden communications faults or hazard labels."""
        town = copy.deepcopy(self.state)
        town.update(commsFaults=[], hazards={}, trace=town['trace'][-1:], kind='admitted')
        return checkpoints.seal({'town': town, 'power': self.power.admitted_model(), 'water': self.water.admitted_model()})

    @classmethod
    def from_admitted(cls, bundle, record, assume=()):
        model = checkpoints.unseal(record)
        town = model['town']
        if town.get('kind') != 'admitted':
            raise Rejected('model_not_admitted')
        state = dict(town, powerCheckpoint=model['power'], waterCheckpoint=model['water'])
        t = cls(bundle, disabled_edges=town['disabled'], coupling_step_us=town['stepUs'], state=state, admitted=True)
        by = {'power': [], 'water': [], 'communications': []}
        for f in assume:
            by[f['domain']].append({k: v for k, v in f.items() if k not in ('domain', 'hazard')})
        for f in by['power']:
            t.power._check_fault(f)
        t.power.state['faults'] = sorted(by['power'], key=lambda f: (f['atUs'], f['faultId']))
        for f in by['water']:
            t.water._check_fault(f)
        t.water.state['faults'] = sorted(by['water'], key=lambda f: (f['atUs'], f['faultId']))
        t.state['commsFaults'] = sorted(by['communications'], key=lambda f: (f['atUs'], f['faultId']))
        if not t.water.state['ledger']:  # the admitted model carries no ledger: sample the forked state at its start
            t.water._record(t.water.session.t if t.water.session.t is not None else t.water.session.run())
        return t

    def preview(self, plan, model_record, assume=()):
        """Simulate a timed multi-domain plan on a fork of the admitted model. Each step is applied at its
        time (on the coupling grid); results report service outcomes, resource use and step receipts."""
        fork = Town.from_admitted(self.bundle, model_record, assume)
        start = fork.state['nowUs']
        receipts = []
        for step in sorted(plan.get('steps', []), key=lambda x: (x['atUs'], x.get('order', 0))):
            if step['atUs'] < start or step['atUs'] % fork.step_us:
                raise Rejected('invalid_plan', 'step %s is off the coupling grid or in the past' % step.get('id'))
            fork.advance(step['atUs'])
            revision = fork.power.revision if step['domain'] == 'power' else fork.water.revision
            r = fork.command(step['domain'], step['action'], revision)
            receipts.append({'id': step.get('id'), 'atUs': step['atUs'], 'status': r['status'], 'reason': r.get('reason')})
        end = start + plan['horizonUs']
        fork.advance(end)
        power = fork.power.service_summary(from_us=start)
        water = fork.water.service_summary(from_us=start)
        trace = [r for r in fork.state['trace'] if r['atUs'] >= start]
        return {'kind': 'preview', 'horizonUs': plan['horizonUs'], 'receipts': receipts,
                'waterEssentialUnmetM3': water['essentialUnmetM3'], 'powerEssentialUnservedJ': power['essentialUnservedJ'],
                'minTankLevelM': min(r['tankLevelM'] for r in trace), 'endTankLevelM': trace[-1]['tankLevelM'],
                'fuelUsedJ': {rid: model_fuel - fork.state['resources'][rid]['fuelJ'] for rid, model_fuel in ((rid, checkpoints.unseal(model_record)['town']['resources'][rid]['fuelJ']) for rid in fork.state['resources'])},
                'events': [e for e in fork.state['events'] if e['atUs'] >= start and e['type'] in ('generator_overload', 'generator_fuel_exhausted', 'supply_lost', 'supply_restored', 'router_battery_exhausted', 'coupling_unresolved', 'coupling_not_converged')],
                'constraintSeconds': fork.power.service_summary(from_us=start)['constraintEventSeconds']}

    # ---- restart --------------------------------------------------------------------------------------
    def checkpoint(self):
        state = dict(copy.deepcopy(self.state), powerCheckpoint=self.power.checkpoint(), waterCheckpoint=self.water.checkpoint())
        return checkpoints.seal(state)

    @classmethod
    def from_checkpoint(cls, bundle, record):
        state = checkpoints.unseal(record)
        return cls(bundle, disabled_edges=state['disabled'], coupling_step_us=state['stepUs'], state=state)

    # ---- private evaluator view -----------------------------------------------------------------------
    def truth(self):
        return {'power': self.power.service_summary(), 'water': self.water.service_summary(), 'routers': copy.deepcopy(self.state['routers']),
                'events': copy.deepcopy(self.state['events']), 'commands': copy.deepcopy(self.state['commands'])}
