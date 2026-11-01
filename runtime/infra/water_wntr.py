#!/usr/bin/env python3
"""LIFELINE water distribution plant on the EPANET 2.2 toolkit (via WNTR 1.5.0), pressure-driven demand.

    .work/environments/water/bin/python runtime/infra/water_wntr.py serve     # stdio worker (protocol.py)

Forward simulation keeps one EPANET hydraulic session open and steps it (ENrunH/ENnextH). A checkpoint is
the initial network plus the complete ordered history of applied changes and the elapsed time; restore and
fork rebuild a session and replay that history. WNTR's own pause/restart was measured as not equivalent
(the network clock overshoots one step on resume), so it is not used.

Accounting conventions: a consumer node with no open path to a source (reservoir, or tank above its
minimum level) receives nothing regardless of the solver's residual value; emitter (leak) flow is loss,
never delivered service; required demand is the immutable pattern schedule times declared scale.
Canonical units at the boundary: m, m3, m3/s, Pa, W, J, microseconds. No water-quality model is qualified.
"""
import argparse
import copy
import hashlib
import json
import os
import sys
import time
import warnings

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
os.environ.setdefault('MPLBACKEND', 'Agg')
warnings.filterwarnings('ignore')

import networkx as nx  # noqa: E402
import wntr  # noqa: E402
from wntr.epanet import toolkit  # noqa: E402
from wntr.epanet.util import EN  # noqa: E402

import checkpoints  # noqa: E402
from protocol import Rejected, serve  # noqa: E402

DOMAIN = 'water'
MODEL_VERSION = 'wntr-%s/epanet-2.2/lifeline-water-v1' % wntr.__version__
PA_PER_M = 9806.65  # rho = 1000 kg/m3, g = 9.80665 m/s2
LPS = 1000.0        # the session runs in L/s; canonical is m3/s
S = 1000000
UNITS = {'water.pressure': 'Pa', 'water.level': 'm', 'water.flow': 'm3/s', 'link.state': 'state'}
ACTIONS = {'set_pump': {'pumpId': 'id', 'on': 'bool'}, 'set_link': {'linkId': 'id', 'open': 'bool'}}
FAULTS = ('pump_outage', 'pipe_break', 'leak', 'demand_change', 'actuator_unavailable', 'sensor_freeze', 'sensor_offset')
WORLD_FAULTS = ('pump_outage', 'pipe_break', 'leak', 'demand_change', 'actuator_unavailable')
WORKDIR = os.path.join(ROOT, '.work', 'tmp', 'water')


def _digest(*parts):
    h = hashlib.sha256()
    for part in parts:
        h.update(part if isinstance(part, bytes) else json.dumps(part, sort_keys=True).encode())
    return h.hexdigest()


class Network:
    """Immutable model of one spec: WNTR network (schedule, geometry, graph) and the SI INP the toolkit runs.
    INP controls acting on declared actuators are removed: actuator behavior belongs to the controller."""
    _cache = {}

    @classmethod
    def load(cls, spec, fixture_dir):
        with open(os.path.join(fixture_dir, spec['inp']), 'rb') as handle:
            raw = handle.read()
        key = _digest(raw, spec)
        if key not in cls._cache:
            cls._cache[key] = cls(spec, os.path.join(fixture_dir, spec['inp']), key)
        return cls._cache[key]

    def __init__(self, spec, path, key):
        wn = wntr.network.WaterNetworkModel(path)
        dm, o = spec['demandModel'], wn.options
        o.hydraulic.demand_model = 'PDA'
        o.hydraulic.required_pressure, o.hydraulic.minimum_pressure, o.hydraulic.pressure_exponent = dm['requiredPressureM'], dm['minimumPressureM'], dm['exponent']
        o.time.duration = spec['durationS']
        o.time.hydraulic_timestep = o.time.report_timestep = o.time.rule_timestep = spec['hydraulicStepS']
        o.quality.parameter = 'NONE'
        self.pumps, self.links = list(spec['actuators']['pumps']), list(spec['actuators']['links'])
        for asset in self.pumps + self.links:
            if asset not in wn.link_name_list:
                raise Rejected('unknown_asset', asset)
        self.removed_controls = []
        for name, control in list(wn.controls()):
            if any(getattr(a.target()[0], 'name', None) in self.pumps + self.links for a in control.actions()):
                wn.remove_control(name)
                self.removed_controls.append(name)
        self.consumers = spec.get('consumers') or [n for n, j in wn.junctions() if j.base_demand > 0]
        for node in self.consumers + spec['essentialNodes']:
            if node not in wn.junction_name_list:
                raise Rejected('unknown_asset', node)
        for sensor in spec['sensors']:
            if sensor['assetId'] not in wn.node_name_list + wn.link_name_list:
                raise Rejected('unknown_asset', sensor['assetId'])
        os.makedirs(WORKDIR, exist_ok=True)
        self.inp = os.path.join(WORKDIR, '%s.inp' % key[:24])
        if not os.path.exists(self.inp):
            tmp = self.inp + '.%d.tmp' % os.getpid()
            wntr.network.write_inpfile(wn, tmp, units='LPS')
            os.replace(tmp, self.inp)
        self.wn, self.key = wn, key
        self.graph = wn.to_graph().to_undirected()
        self.edges = {name: (link.start_node_name, link.end_node_name) for name, link in wn.links()}
        self.tanks = {name: {'elevation': t.elevation, 'min': t.min_level, 'max': t.max_level, 'area': 3.141592653589793 * t.diameter ** 2 / 4} for name, t in wn.tanks()}
        self.sources = list(wn.reservoir_name_list)
        self.base = {n: wn.get_node(n).base_demand for n in self.consumers}
        self.multiplier = o.hydraulic.demand_multiplier

    def required(self, node, t_s, scale):
        return self.wn.get_node(node).demand_timeseries_list.at(t_s, multiplier=self.multiplier) * scale


class Session:
    """One EPANET hydraulic session; every solve and status change goes through here."""

    def __init__(self, net):
        self.en = toolkit.ENepanet()
        self.en.ENopen(net.inp, os.path.join(WORKDIR, 'session-%d-%d.rpt' % (os.getpid(), id(self))), '')
        self.en.ENopenH()
        self.en.ENinitH(0)
        self.node = {n: self.en.ENgetnodeindex(n) for n in net.wn.node_name_list}
        self.link = {l: self.en.ENgetlinkindex(l) for l in net.wn.link_name_list}
        self.t = None

    def run(self):
        self.t = int(round(self.en.ENrunH()))
        return self.t

    def next(self):
        return int(round(self.en.ENnextH()))

    def apply(self, change, net):
        op = change['op']
        if op == 'link_status':
            self.en.ENsetlinkvalue(self.link[change['link']], EN.STATUS, 1 if change['open'] else 0)
        elif op == 'emitter':
            self.en.ENsetnodevalue(self.node[change['node']], EN.EMITTER, change['coefficient'] * LPS)
        elif op == 'demand_scale':
            self.en.ENsetnodevalue(self.node[change['node']], EN.BASEDEMAND, net.base[change['node']] * change['scale'] * LPS)
        else:
            raise Rejected('unknown_change', op)

    def close(self):
        try:
            self.en.ENcloseH()
            self.en.ENclose()
        except Exception:
            pass


def initial_state(spec, faults):
    return {'kind': 'true', 'modelVersion': MODEL_VERSION, 'spec': spec, 'nowUs': 0, 'revision': 0, 'history': [],
            'faults': sorted(faults, key=lambda f: (f['atUs'], f['faultId'])), 'appliedFaults': [], 'unavailable': [],
            'scale': {}, 'emitter': {}, 'sensorFaults': {}, 'ledger': [], 'receipts': {}, 'events': []}


class WaterPlant:
    def __init__(self, spec, faults=(), fixture_dir=None, state=None):
        self.fixture_dir = fixture_dir or os.path.join(ROOT, 'fixtures/lifeline/infra/water')
        self.state = state if state is not None else initial_state(spec, list(faults))
        if self.state['modelVersion'] != MODEL_VERSION:
            raise Rejected('model_version_mismatch', self.state['modelVersion'])
        self.spec = self.state['spec']
        self.net = Network.load(self.spec, self.fixture_dir)
        self.step_us = self.spec['hydraulicStepS'] * S
        self.essential = list(self.spec['essentialNodes'])
        self.level_tol = self.spec['tolerances'].get('levelM', 1e-4)
        for fault in self.state['faults']:
            self._check_fault(fault)
        self.replay_seconds = 0.0
        self.session = None
        self._start(replay=bool(self.state['history']) or self.state['nowUs'] > 0)

    # ---- restart: replay of the applied-change history ----------------------------------------------
    def _start(self, replay):
        if self.session:
            self.session.close()
        self.session = Session(self.net)
        if not replay:
            return
        started = time.perf_counter()
        groups = list(self.state['history'])
        target = self.state['nowUs'] // S
        t = self.session.run()
        while True:
            while groups and groups[0]['atUs'] <= t * S:
                for change in groups.pop(0)['changes']:
                    self.session.apply(change, self.net)
                self.session.run()
            if t >= target:
                break
            if self.session.next() == 0:
                raise Rejected('replay_failed', 'session ended before the checkpoint time')
            t = self.session.run()
        if groups or t != target:
            raise Rejected('replay_failed', 'history not consumed at %s s' % t)
        self.replay_seconds += time.perf_counter() - started

    @classmethod
    def from_checkpoint(cls, record, fixture_dir=None):
        return cls(None, fixture_dir=fixture_dir, state=checkpoints.unseal(record))

    def checkpoint(self):
        return checkpoints.seal(self.state)

    def checkpoint_hash(self):
        return checkpoints.digest(self.state)

    def restore(self, record):
        state = checkpoints.unseal(record)
        if checkpoints.digest(state['spec']) != checkpoints.digest(self.spec):
            raise Rejected('checkpoint_network_mismatch')
        self.state = state
        self._start(replay=True)

    def admitted_model(self):
        state = {k: v for k, v in self.state.items() if k not in ('faults', 'appliedFaults', 'ledger', 'receipts', 'sensorFaults')}
        state.update(kind='admitted', faults=[], appliedFaults=[], ledger=[], receipts={}, sensorFaults={})
        return checkpoints.seal(state)

    @property
    def now_us(self):
        return self.state['nowUs']

    @property
    def revision(self):
        return self.state['revision']

    def tank_area(self, tank):
        return self.net.tanks[tank]['area']

    # ---- validation ---------------------------------------------------------------------------------
    def _check_fault(self, fault):
        kind, asset = fault.get('type'), fault.get('assetId')
        if kind not in FAULTS:
            raise Rejected('unknown_fault', str(kind))
        if not isinstance(fault.get('atUs'), int) or fault['atUs'] < 0:
            raise Rejected('invalid_time', fault.get('faultId', ''))
        if fault['atUs'] % self.step_us:
            raise Rejected('off_grid_time', '%s at %s us' % (fault.get('faultId'), fault['atUs']))
        wn = self.net.wn
        known = {'pump_outage': self.net.pumps, 'pipe_break': wn.link_name_list, 'leak': wn.junction_name_list, 'demand_change': self.net.consumers,
                 'actuator_unavailable': self.net.pumps + self.net.links, 'sensor_freeze': [s['id'] for s in self.spec['sensors']],
                 'sensor_offset': [s['id'] for s in self.spec['sensors']]}[kind]
        if asset not in known:
            raise Rejected('unknown_asset', str(asset))
        env = self.spec['envelope']
        if kind == 'demand_change' and not env['demandScale'][0] <= fault['scale'] <= env['demandScale'][1]:
            raise Rejected('outside_model_envelope', 'demand scale %s' % fault['scale'])
        if kind == 'leak' and not env['emitterM3sPerSqrtM'][0] <= fault['emitterM3sPerSqrtM'] <= env['emitterM3sPerSqrtM'][1]:
            raise Rejected('outside_model_envelope', 'emitter %s' % fault['emitterM3sPerSqrtM'])

    # ---- time ---------------------------------------------------------------------------------------
    def advance(self, to_us):
        st = self.state
        if not isinstance(to_us, int) or to_us % self.step_us:
            raise Rejected('off_grid_time', str(to_us))
        if to_us < st['nowUs']:
            raise Rejected('clock_regression', '%d < %d' % (to_us, st['nowUs']))
        target = to_us // S
        if self.session.t is None:
            self._visit(self.session.run())
        while self.session.t < target:
            if self.session.next() == 0:
                raise Rejected('outside_model_envelope', 'beyond the declared duration %s s' % self.spec['durationS'])
            self._visit(self.session.run())
        st['nowUs'] = to_us
        return {'atUs': to_us, 'revision': st['revision']}

    def _visit(self, t):
        """At a solved time: apply due faults as one change group (then re-solve), record the sample."""
        st = self.state
        changes = []
        while st['faults'] and st['faults'][0]['atUs'] <= t * S:
            fault = st['faults'].pop(0)
            st['appliedFaults'].append(fault['faultId'])
            kind, asset = fault['type'], fault['assetId']
            if kind == 'pump_outage':
                st['unavailable'] = sorted(set(st['unavailable']) | {asset})
                changes.append({'op': 'link_status', 'link': asset, 'open': False})
                st['revision'] += 1
            elif kind == 'pipe_break':
                changes.append({'op': 'link_status', 'link': asset, 'open': False})
                st['revision'] += 1
            elif kind == 'leak':
                st['emitter'][asset] = fault['emitterM3sPerSqrtM']
                changes.append({'op': 'emitter', 'node': asset, 'coefficient': fault['emitterM3sPerSqrtM']})
            elif kind == 'demand_change':
                st['scale'][asset] = fault['scale']
                changes.append({'op': 'demand_scale', 'node': asset, 'scale': fault['scale']})
            elif kind == 'actuator_unavailable':
                st['unavailable'] = sorted(set(st['unavailable']) | {asset})
            else:  # observation faults change what is reported, never the plant
                sensor = next(s for s in self.spec['sensors'] if s['id'] == asset)
                st['sensorFaults'][asset] = {'type': kind, 'atUs': t * S, 'value': self._sensor_value(sensor), 'scale': fault.get('scale')}
        if changes:
            st['history'].append({'atUs': t * S, 'changes': changes})
            for change in changes:
                self.session.apply(change, self.net)
            self.session.run()
        self._record(t)

    # ---- sampling and accounting --------------------------------------------------------------------
    def _status(self, link):
        return self.session.en.ENgetlinkvalue(self.session.link[link], EN.STATUS) > 0.5

    def _record(self, t):
        en, s, net = self.session.en, self.session, self.net
        tanks = {}
        for name, geo in net.tanks.items():
            level = en.ENgetnodevalue(s.node[name], EN.HEAD) - geo['elevation']
            tanks[name] = {'levelM': level, 'volumeM3': level * geo['area']}
        live = [n for n in net.sources] + [n for n, v in tanks.items() if v['levelM'] > net.tanks[n]['min'] + self.level_tol]
        g = net.graph.copy()
        g.remove_edges_from([(a, b, name) for name, (a, b) in net.edges.items() if not self._status(name)])
        reachable = set()
        for source in live:
            reachable |= nx.node_connected_component(g, source)
        exponent = self.spec['demandModel']['exponent']
        nodes = {}
        for node in net.consumers:
            pressure = en.ENgetnodevalue(s.node[node], EN.PRESSURE)
            required = net.required(node, t, self.state['scale'].get(node, 1.0))
            isolated = node not in reachable
            leak = 0.0 if isolated else self.state['emitter'].get(node, 0.0) * max(pressure, 0.0) ** exponent
            reported = en.ENgetnodevalue(s.node[node], EN.DEMAND) / LPS
            delivered = 0.0 if isolated else max(0.0, reported - leak)
            nodes[node] = {'deliveredM3s': delivered, 'requiredM3s': required, 'pressureM': pressure, 'leakM3s': leak, 'isolated': isolated}
        links = {name: {'flowM3s': en.ENgetlinkvalue(s.link[name], EN.FLOW) / LPS, 'open': self._status(name)} for name in net.wn.link_name_list}
        pumps = {name: {'powerW': en.ENgetlinkvalue(s.link[name], EN.ENERGY) * 1000.0 if self._status(name) else 0.0} for name in net.wn.pump_name_list}
        sample = {'atUs': t * S, 'status': 'solved', 'nodes': nodes, 'tanks': tanks, 'links': links, 'pumps': pumps}
        ledger = self.state['ledger']
        if ledger and ledger[-1]['atUs'] == sample['atUs']:
            ledger[-1] = sample  # a change at this instant replaces the pre-change solution
        else:
            ledger.append(sample)

    def ledger_tail(self):
        return self.state['ledger'][-1]

    # ---- actions ------------------------------------------------------------------------------------
    def change(self, action, base_revision):
        params, schema = action.get('params', {}), ACTIONS.get(action.get('type'))
        if schema is None:
            raise Rejected('unknown_action', str(action.get('type')))
        if sorted(params) != sorted(schema):
            raise Rejected('invalid_parameters', ','.join(sorted(params)))
        st = self.state
        if base_revision != st['revision']:
            raise Rejected('stale_command', 'based on revision %s, plant is at %s' % (base_revision, st['revision']))
        if action['type'] == 'set_pump':
            asset, value = params['pumpId'], bool(params['on'])
            if asset not in self.net.pumps:
                raise Rejected('unknown_actuator', asset)
        else:
            asset, value = params['linkId'], bool(params['open'])
            if asset not in self.net.links:
                raise Rejected('unknown_actuator', asset)
        if asset in st['unavailable']:
            raise Rejected('actuator_unavailable', asset)
        if self.session.t is None:
            self._visit(self.session.run())
        change = {'op': 'link_status', 'link': asset, 'open': value}
        st['history'].append({'atUs': st['nowUs'], 'changes': [change]})
        self.session.apply(change, self.net)
        self.session.run()
        self._record(self.session.t)
        st['revision'] += 1
        return {'kind': 'link_status', 'assetId': asset, 'value': value, 'revision': st['revision']}

    # ---- controller-facing views --------------------------------------------------------------------
    def _sensor_value(self, sensor):
        sample, asset = self.ledger_tail(), sensor['assetId']
        metric = sensor['metric']
        if metric == 'water.pressure':
            return sample['nodes'][asset]['pressureM'] * PA_PER_M if asset in sample['nodes'] else self.session.en.ENgetnodevalue(self.session.node[asset], EN.PRESSURE) * PA_PER_M
        if metric == 'water.level':
            return sample['tanks'][asset]['levelM']
        if metric == 'water.flow':
            return sample['links'][asset]['flowM3s']
        return 1 if sample['links'][asset]['open'] else 0

    def observe(self):
        if self.session.t is None:
            self._visit(self.session.run())
        readings = []
        for sensor in self.spec['sensors']:
            value, observed = self._sensor_value(sensor), self.now_us
            fault = self.state['sensorFaults'].get(sensor['id'])
            if fault and fault['type'] == 'sensor_freeze':
                value, observed = fault['value'], fault['atUs']
            elif fault and fault['type'] == 'sensor_offset':
                value = value * fault['scale']
            readings.append({'sensorId': sensor['id'], 'assetId': sensor['assetId'], 'metric': sensor['metric'], 'value': value, 'unit': UNITS[sensor['metric']], 'observedAtUs': observed})
        return {'atUs': self.now_us, 'configurationRevision': self.revision, 'staleAfterUs': self.spec.get('staleAfterUs', 2 * self.step_us),
                'unavailableActuators': list(self.state['unavailable']), 'readings': readings}

    def preview(self, plan, model_record):
        """Fork the admitted model by replay, apply the plan and any assumed world events, advance over the
        horizon and report service outcomes. Never a receipt; the replay cost is reported."""
        state = checkpoints.unseal(model_record)
        if state.get('kind') != 'admitted':
            raise Rejected('model_not_admitted')
        start = state['nowUs']
        fork = WaterPlant(None, fixture_dir=self.fixture_dir, state=state)
        assumed = plan.get('assume', [])
        for event in assumed:
            if event.get('type') not in WORLD_FAULTS:
                raise Rejected('invalid_assumption', str(event.get('type')))
            fork._check_fault(event)
        fork.state['faults'] = sorted(assumed, key=lambda f: (f['atUs'], f['faultId']))
        for action in plan.get('actions', []):
            fork.change(action, fork.revision)
        fork.advance(start + plan['horizonUs'])
        summary = fork.service_summary(from_us=start)
        fork.session.close()
        return {'kind': 'preview', 'modelHash': model_record['hash'], 'modelVersion': MODEL_VERSION, 'horizonUs': plan['horizonUs'],
                'essential_unmet_m3': summary['essentialUnmetM3'], 'essential_required_m3': summary['essentialRequiredM3'],
                'low_pressure_seconds': summary['lowPressureSeconds'], 'pump_energy_j': summary['pumpEnergyJ'], 'status': summary['status'],
                'replaySeconds': round(fork.replay_seconds, 6), 'assumptions': [e['faultId'] for e in assumed]}

    # ---- private evaluator views --------------------------------------------------------------------
    def service_record(self):
        return {'networkId': self.spec['networkId'], 'toUs': self.now_us, 'samples': copy.deepcopy(self.state['ledger']), 'essential': self.essential}

    def _segments(self, from_us):
        samples = [s for s in self.state['ledger'] if s['atUs'] >= from_us]
        ends = [s['atUs'] for s in samples[1:]] + [self.now_us]
        return [(s, e) for s, e in zip(samples, ends) if e > s['atUs']]

    def service_cases(self, from_us=0):
        segments = self._segments(from_us)
        return {node: {'fromUs': segments[0][0]['atUs'] if segments else from_us, 'toUs': self.now_us,
                       'demand': [{'fromUs': s['atUs'], 'toUs': e, 'value': s['nodes'][node]['requiredM3s']} for s, e in segments],
                       'supply': [{'atUs': s['atUs'], 'value': s['nodes'][node]['deliveredM3s']} for s, _ in segments]} for node in self.net.consumers}

    def service_summary(self, from_us=0):
        from scoring import score_service
        segments = self._segments(from_us)
        threshold = self.spec['limits']['servicePressureM']
        by_node = {}
        for node, case in self.service_cases(from_us).items():
            r = score_service(case)
            low = sum((e - s['atUs']) / 1e6 for s, e in segments
                      if s['nodes'][node]['requiredM3s'] > 0 and (s['nodes'][node]['isolated'] or s['nodes'][node]['pressureM'] < threshold))
            by_node[node] = {'requiredM3': r['demandIntegral'], 'deliveredM3': r['servedIntegral'], 'deficitM3': r['deficitIntegral'], 'score': r['score'], 'status': r['status'], 'lowPressureSeconds': low}
        essential = [by_node[n] for n in self.essential]
        complete = all(r['status'] == 'scored' for r in essential)
        seconds = lambda s, e: (e - s['atUs']) / 1e6
        return {'byNode': by_node, 'status': 'scored' if complete else 'capture_incomplete',
                'essentialRequiredM3': sum(r['requiredM3'] for r in essential), 'essentialUnmetM3': sum(r['deficitM3'] for r in essential) if complete else None,
                'lowPressureSeconds': sum(r['lowPressureSeconds'] for r in essential),
                'pumpEnergyJ': sum(p['powerW'] * seconds(s, e) for s, e in segments for p in s['pumps'].values()),
                'leakM3': sum(n['leakM3s'] * seconds(s, e) for s, e in segments for n in s['nodes'].values()),
                'qualityModelQualified': False}

    def depletion_result(self, tank):
        minimum = self.net.tanks[tank]['min']
        hit = next((s['atUs'] for s in self.state['ledger'] if s['tanks'][tank]['levelM'] <= minimum + self.level_tol), None)
        before = self.service_summary() if hit is None else None
        delivered_before, unmet_after = 0.0, 0.0
        for s, e in self._segments(0):
            for node in self.essential:
                n, dt = s['nodes'][node], (e - s['atUs']) / 1e6
                if hit is None or s['atUs'] < hit:
                    delivered_before += min(n['deliveredM3s'], n['requiredM3s']) * dt
                else:
                    unmet_after += max(0.0, n['requiredM3s'] - n['deliveredM3s']) * dt
        return {'tank': tank, 'depletion_time_s': None if hit is None else hit / 1e6, 'delivered_m3_before_depletion': delivered_before,
                'unmet_m3_after_depletion': unmet_after, 'quality_model_qualified': False, **({'note': 'not depleted'} if before else {})}

    def describe(self):
        return describe(self.net)


def describe(net=None):
    record = {
        'domainId': DOMAIN, 'modelVersion': MODEL_VERSION, 'units': UNITS, 'actions': ACTIONS, 'faultTypes': list(FAULTS),
        'operations': {op: True for op in ('describe', 'initialize', 'observe', 'preview', 'validate', 'execute', 'readback', 'checkpoint', 'restore', 'advance', 'close')},
        'timeModel': 'EPANET extended-period hydraulics; decisions and faults on the declared hydraulic step; intermediate tank events are solved exactly',
        'restart': 'replay of the initial network plus the ordered applied-change history (verified equal to an uninterrupted run)',
        'qualityModelQualified': False,
        'limitations': ['Distribution hydraulics only (pressure-driven demand); no water-quality, treatment-plant or transient model.',
                        'INP controls acting on declared actuators are removed; their behavior is the controller policy.',
                        'Isolation is judged on the undirected graph of open links (check valves are not modeled in that judgement).',
                        'Restore and preview cost a replay proportional to elapsed simulated time.'],
    }
    if net is not None:
        record.update(networkId=net.wn.name or None, removedControls=net.removed_controls, consumers=net.consumers)
    return record


def worker_handlers():
    session = {'plant': None, 'checkpoints': {}, 'models': {}}

    def plant():
        if session['plant'] is None:
            raise Rejected('not_initialized')
        return session['plant']

    def store(table, record, prefix):
        key = '%s-%d' % (prefix, len(session[table]) + 1)
        session[table][key] = record
        return key

    def initialize(args):
        session['plant'] = WaterPlant(args['network'], faults=args.get('faults', []), fixture_dir=args.get('fixtureDir'))
        return {'atUs': 0, 'configurationRevision': 0, 'networkId': args['network']['networkId'], 'modelVersion': MODEL_VERSION}

    def execute(args):
        action, p = args['action'], plant()
        prior = p.state['receipts'].get(action['actionId'])
        if prior is not None:
            return dict(prior, duplicate=True)
        requested = p.now_us
        try:
            effect = p.change(action, action['baseRevision'])
            receipt = {'actionId': action['actionId'], 'status': 'success', 'reason': 'applied', 'requestedAtUs': requested, 'startedAtUs': requested,
                       'completedAtUs': p.now_us, 'actualSettings': [effect], 'configurationRevision': p.revision}
        except Rejected as error:
            receipt = {'actionId': action['actionId'], 'status': 'rejected', 'reason': error.code, 'detail': error.detail, 'requestedAtUs': requested,
                       'startedAtUs': None, 'completedAtUs': None, 'actualSettings': [], 'configurationRevision': p.revision}
        p.state['receipts'][action['actionId']] = receipt
        return receipt

    def validate(args):
        p, action = plant(), args['action']
        schema = ACTIONS.get(action.get('type'))
        if schema is None or sorted(action.get('params', {})) != sorted(schema):
            return {'ok': False, 'code': 'unknown_action' if schema is None else 'invalid_parameters'}
        if action['baseRevision'] != p.revision:
            return {'ok': False, 'code': 'stale_command'}
        asset = action['params'].get('pumpId') or action['params'].get('linkId')
        if asset not in (p.net.pumps if action['type'] == 'set_pump' else p.net.links):
            return {'ok': False, 'code': 'unknown_actuator'}
        if asset in p.state['unavailable']:
            return {'ok': False, 'code': 'actuator_unavailable'}
        return {'ok': True, 'code': 'ok'}

    def readback(args):
        receipt = plant().state['receipts'].get(args['actionId'])
        if receipt is None:
            raise Rejected('unknown_action', args['actionId'])
        return receipt

    def checkpoint(args):
        record = plant().checkpoint()
        return {'checkpointId': store('checkpoints', record, 'cp'), 'hash': record['hash'], 'atUs': plant().now_us}

    def restore(args):
        record = session['checkpoints'].get(args.get('checkpointId'))
        if record is None:
            raise Rejected('unknown_checkpoint', str(args.get('checkpointId')))
        plant().restore(record)
        return {'atUs': plant().now_us, 'hash': record['hash'], 'configurationRevision': plant().revision}

    def admitted_model(args):
        record = plant().admitted_model()
        return {'modelId': store('models', record, 'model'), 'hash': record['hash'], 'atUs': plant().now_us}

    def preview(args):
        record = session['models'].get(args.get('modelId'))
        if record is None:
            raise Rejected('unknown_model', str(args.get('modelId')))
        return plant().preview(args['plan'], record)

    def service(args):
        p = plant()
        return {'record': {'networkId': p.spec['networkId'], 'essential': p.essential, 'toUs': p.now_us}, 'cases': p.service_cases(), 'summary': p.service_summary()}

    def close(args):
        if session['plant'] is not None:
            session['plant'].session.close()
        session.update(plant=None, checkpoints={}, models={})
        return {'closed': True}

    return {
        'hello': lambda a: dict(describe(), protocol=1),
        'describe': lambda a: plant().describe() if session['plant'] else describe(),
        'initialize': initialize, 'observe': lambda a: plant().observe(), 'validate': validate, 'execute': execute, 'readback': readback,
        'checkpoint': checkpoint, 'checkpoint_hash': lambda a: {'hash': plant().checkpoint_hash()}, 'restore': restore,
        'admitted_model': admitted_model, 'preview': preview, 'advance': lambda a: plant().advance(a['toUs']),
        'service_record': service, 'close': close, 'shutdown': lambda a: {'stopping': True},
    }


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=('serve',))
    parser.parse_args(argv)
    serve(worker_handlers())
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
