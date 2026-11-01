"""P09 water control on the qualified EPANET/WNTR plant.

Policy      admissible actions: on/off pumps and open/closed links only, actuator availability, minimum run/
            off/dwell times, starts per hour, and two horizon checks on the admitted model: no protected node
            may be pushed below its minimum service, and the plan may not end below the storage reserve when
            doing nothing would not.
Local       conventional threshold policy: tank-level pump band, backup start when the main pump is
            unavailable, conservation of the non-essential zone below a level. Ignores forecasts.
Predictive  horizon baseline with the same actions, forecasts and delays: every admissible end configuration
            of the actuators, scored by admitted-model previews.
exhaustive_schedules  independent enumeration of every slot-by-slot schedule on a tiny network, scored
            by the plant's own service ledger.
run_episode true plant + controller + actuator delays; per-node metrics from the private ledger.
"""
import copy
import itertools
import json
import os

import checkpoints
from protocol import Rejected
from water_wntr import WaterPlant

INF = float('inf')
HOUR_US = 3600 * 1000000
FIXTURES = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'fixtures/lifeline/infra/water')


def load_development(path):
    with open(path) as handle:
        dev = json.load(handle)
    with open(os.path.join(os.path.dirname(path), dev['policy'])) as handle:
        policy = json.load(handle)
    return dev['network'], policy, dev['cases']


def case_spec(spec, case):
    out = copy.deepcopy(spec)
    out.update(copy.deepcopy(case.get('network', {})))
    return out


def world_faults(case):
    return copy.deepcopy(case['faults'])


def pump(pid, on):
    return {'type': 'set_pump', 'params': {'pumpId': pid, 'on': on}}


def link(lid, open_):
    return {'type': 'set_link', 'params': {'linkId': lid, 'open': open_}}


def asset_of(action):
    return action['params'].get('pumpId') or action['params'].get('linkId')


def fresh_readings(obs):
    return {r['sensorId']: r['value'] for r in obs['readings'] if r['value'] is not None and obs['atUs'] - r['observedAtUs'] <= obs['staleAfterUs']}


def commanded(state, fixture_dir=FIXTURES):
    """Commanded on/open state of every actuator: the last applied change, else the network's initial
    status. This is what SCADA knows; EPANET may additionally hold a pump closed while a tank is full."""
    plant = WaterPlant(None, fixture_dir=fixture_dir, state=copy.deepcopy(state))
    plant.session.close()
    wn = plant.net.wn
    status = {a: str(wn.get_link(a).initial_status).lower() in ('open', '1', 'linkstatus.open') for a in plant.net.pumps + plant.net.links}
    for group in state['history']:
        for change in group['changes']:
            if change['op'] == 'link_status' and change['link'] in status:
                status[change['link']] = change['open']
    return status


def config_after(model_record, actions, fixture_dir=FIXTURES):
    state = checkpoints.unseal(model_record)
    config = commanded(state, fixture_dir)
    for a in actions:
        config[asset_of(a)] = a['params'].get('on', a['params'].get('open'))
    return config


class Policy:
    def __init__(self, policy, fixture_dir=FIXTURES):
        self.p, self.fixture_dir = policy, fixture_dir

    def table(self, action):
        return self.p['pumps'] if action['type'] == 'set_pump' else self.p['links']

    def delay_us(self, action):
        return self.table(action).get(asset_of(action), {}).get('delayUs', 0)

    def cost(self, action):
        return self.table(action).get(asset_of(action), {}).get('cost', 0.0)

    def horizon(self, model_record, actions, previewer, assume):
        """Admissibility preview over the commitment window (not the forecast horizon)."""
        plan = {'actions': actions, 'horizonUs': self.p.get('commitmentHorizonUs', self.p['predictive']['horizonUs']), 'assume': assume}
        return previewer(plan, model_record)

    def check(self, model_record, actions, previewer, assume=(), noop=None):
        def fail(code, **detail):
            return dict({'ok': False, 'code': code}, **detail)
        state = checkpoints.unseal(model_record)
        now = state['nowUs']
        schema = {'set_pump': ('on', 'pumpId'), 'set_link': ('linkId', 'open')}
        assets = []
        for i, action in enumerate(actions):
            if action.get('type') not in schema:
                return fail('not_admissible', index=i)
            if tuple(sorted(action.get('params', {}))) != schema[action['type']]:
                return fail('unsupported_parameter', index=i, detail=','.join(sorted(action.get('params', {}))))
            asset = asset_of(action)
            if asset not in self.table(action):
                return fail('not_admissible', index=i, detail=asset)
            if asset in state['unavailable']:
                return fail('actuator_unavailable', index=i, detail=asset)
            assets.append(asset)
        if len(set(assets)) != len(assets):
            return fail('incompatible_actions')
        current = commanded(state, self.fixture_dir)
        operations = [(g['atUs'], c['link'], c['open']) for g in state['history'] if g.get('source') == 'action' for c in g['changes']]
        for i, action in enumerate(actions):
            asset, target = asset_of(action), action['params'].get('on', action['params'].get('open'))
            if current[asset] == target:
                continue
            cfg = self.table(action)[asset]
            last = max((t for t, a, _ in operations if a == asset), default=None)
            if action['type'] == 'set_pump':
                hold = cfg['minRunUs'] if current[asset] else cfg['minOffUs']
                if last is not None and now - last < hold:
                    return fail('dwell_active', index=i, detail=asset)
                if target and sum(1 for t, a, on in operations if a == asset and on and now - t < HOUR_US) >= cfg['maxStartsPerHour']:
                    return fail('cycling_limit', index=i, detail=asset)
            elif last is not None and now - last < cfg['minDwellUs']:
                return fail('dwell_active', index=i, detail=asset)
        if not actions:
            return {'ok': True, 'code': 'ok'}
        assume = list(assume)
        base = noop or self.horizon(model_record, [], previewer, assume)
        plan = self.horizon(model_record, actions, previewer, assume)
        for node, rule in sorted(self.p['protectedNodes'].items()):
            a, b = plan['node_service'].get(node), base['node_service'].get(node)
            if a is None:
                continue
            if a < rule['minServiceFraction'] and (b is None or b >= rule['minServiceFraction'] or a < b - 1e-6):
                return fail('protected_service_violation', node=node, planService=a, noopService=b)
        reserve = self.p['reserve']
        tank, level = reserve['tank'], reserve['reserveLevelM']
        if plan['end_tank_levels_m'][tank] < level <= base['end_tank_levels_m'][tank]:
            return fail('reserve_violation', planEndLevelM=plan['end_tank_levels_m'][tank], noopEndLevelM=base['end_tank_levels_m'][tank])
        return {'ok': True, 'code': 'ok', 'preview': plan, 'noop': base}


class Controller:
    name = 'none'

    def __init__(self, policy, fixture_dir=FIXTURES):
        self.p, self.fixture_dir = policy, fixture_dir
        self.policy = Policy(policy, fixture_dir)

    def decide(self, obs, advisories, model_record, previewer):
        return []


class Local(Controller):
    """Conventional threshold policy on fresh readings; actuator availability comes from SCADA."""
    name = 'local'

    def decide(self, obs, advisories, model_record, previewer):
        cfg = self.p['local']
        fresh = fresh_readings(obs)
        level = fresh.get(cfg['levelSensor'])
        state = checkpoints.unseal(model_record)
        current = commanded(state, self.fixture_dir)
        unavailable = set(obs['unavailableActuators'])
        wanted = []
        for main, backup in cfg['backup'].items():
            duty = main if main not in unavailable else backup if backup not in unavailable else None
            for p in (main, backup):
                if p in unavailable:
                    continue
                if p != duty and current[p]:
                    wanted.append(pump(p, False))  # only the duty pump runs
            if duty is None:
                continue
            if level is None:
                if duty != main and not current[duty]:
                    wanted.append(pump(duty, True))  # level unknown: keep supply on the healthy pump
            elif level < cfg['pumpOnBelowM'] and not current[duty]:
                wanted.append(pump(duty, True))
            elif level > cfg['pumpOffAboveM'] and current[duty]:
                wanted.append(pump(duty, False))
        if level is not None:
            zone = cfg['conserveLink']
            if level < cfg['conserveBelowM'] and current[zone]:
                wanted.append(link(zone, False))
            elif level > cfg['reopenAboveM'] and not current[zone]:
                wanted.append(link(zone, True))
        assume = []
        noop = self.policy.horizon(model_record, [], previewer, assume) if wanted else None
        return [a for a in wanted if self.policy.check(model_record, [a], previewer, assume, noop=noop)['ok']]


def forecast_events(advisories, now_us):
    return [dict(e, faultId='assumed-%s' % e['faultId']) for a in advisories for e in a['events'] if e['atUs'] > now_us]


class Predictive(Controller):
    name = 'predictive'

    def objective(self, preview, actions):
        if preview['essential_unmet_m3'] is None:
            return INF
        w, reserve = self.p['predictive']['weights'], self.p['reserve']
        deficit = max(0.0, reserve['reserveLevelM'] - preview['end_tank_levels_m'][reserve['tank']])
        return (w['essentialM3'] * preview['essential_unmet_m3'] + w['nonessentialM3'] * preview['nonessential_unmet_m3'] + w['energyMJ'] * preview['pump_energy_j'] / 1e6
                + w['actionCost'] * sum(self.policy.cost(a) for a in actions) + w['reserveDeficitM'] * deficit)

    def configs(self, state):
        actuators = [a for a in sorted(self.p['pumps']) + sorted(self.p['links']) if a not in state['unavailable']]
        return [dict(zip(actuators, values)) for values in itertools.product((True, False), repeat=len(actuators))]

    def diff(self, config, current):
        return [(pump if a in self.p['pumps'] else link)(a, v) for a, v in sorted(config.items()) if current[a] != v]

    def choose(self, model_record, previewer, assume):
        """Two-stage plans: a configuration for one decision period, then a continuation held to the end of
        the horizon. Admissibility of the first stage is judged without forecasts (the check the runner
        enforces); the continuation is provisional and re-decided next period. The objective uses the
        forecast assumptions. Continuations: every configuration on small actuator sets, otherwise the
        first stage itself, the current configuration and the best constant plan."""
        state = checkpoints.unseal(model_record)
        now, horizon, period = state['nowUs'], self.p['predictive']['horizonUs'], self.p['decisionPeriodUs']
        current = commanded(state, self.fixture_dir)
        configs = self.configs(state)
        plain = self.policy.horizon(model_record, [], previewer, [])  # admissibility baseline (commitment window)
        def score(first, then):
            actions = self.diff(first, current)
            later = self.diff(then, first)
            plan = {'actions': actions, 'horizonUs': horizon, 'assume': assume}
            if later and period < horizon:
                plan['later'] = [{'atUs': now + period, 'actions': later}]
            preview = previewer(plan, model_record)
            return self.objective(preview, actions + (later if period < horizon else [])), preview
        admissible = []
        for first in configs:
            actions = self.diff(first, current)
            if actions and not self.policy.check(model_record, actions, previewer, [], noop=plain)['ok']:
                continue
            admissible.append(first)
        constant = {tuple(sorted(c.items())): score(c, c) for c in admissible}
        best_constant = min(admissible, key=lambda c: constant[tuple(sorted(c.items()))][0])
        scored = []
        for first in admissible:
            continuations = configs if len(configs) <= 4 else [first, {a: current[a] for a in first}, best_constant]
            for then in {tuple(sorted(c.items())): c for c in continuations}.values():
                value, preview = constant[tuple(sorted(first.items()))] if then == first else score(first, then)
                scored.append({'actions': self.diff(first, current), 'then': then, 'objective': value, 'preview': preview})
        noop = min((c for c in scored if not c['actions']), key=lambda c: c['objective'], default=None)
        best = min(scored, key=lambda c: (c['objective'], len(c['actions'])))
        if noop is not None and best['actions'] and noop['objective'] - best['objective'] < self.p['predictive']['minImprovement']:
            best = noop
        return dict(best, evaluated=len(scored))

    def decide(self, obs, advisories, model_record, previewer):
        return self.choose(model_record, previewer, forecast_events(advisories, obs['atUs']))['actions']


CONTROLLERS = {'none': Controller, 'local': Local, 'predictive': Predictive}


def tiny_policy():
    """Policy for the analytic network (one pump, one branch link), small enough to enumerate schedules."""
    return {'policyId': 'water-control-tiny', 'decisionPeriodUs': 900 * 1000000, 'commitmentHorizonUs': 3600 * 1000000,
            'pumps': {'PU1': {'minRunUs': 0, 'minOffUs': 0, 'maxStartsPerHour': 99, 'delayUs': 0, 'cost': 1.0}},
            'links': {'P3': {'minDwellUs': 0, 'delayUs': 0, 'cost': 0.5, 'serves': ['JX']}},
            'protectedNodes': {}, 'reserve': {'tank': 'T1', 'reserveLevelM': 0.0},
            'predictive': {'horizonUs': 3600 * 1000000, 'minImprovement': 0.0,
                           'weights': {'essentialM3': 1000.0, 'nonessentialM3': 100.0, 'energyMJ': 1.0, 'actionCost': 10.0, 'reserveDeficitM': 0.0}}}


def schedule_objective(policy, summary, plant, switches):
    w = policy['predictive']['weights']
    others = [n for n in plant.net.consumers if n not in plant.essential]
    return (w['essentialM3'] * summary['essentialUnmetM3'] + w['nonessentialM3'] * sum(summary['byNode'][n]['deficitM3'] for n in others)
            + w['energyMJ'] * summary['pumpEnergyJ'] / 1e6 + w['actionCost'] * switches)


def exhaustive_schedules(policy, model_record, assume, slots, slot_us, fixture_dir=FIXTURES):
    """Every sequence of actuator configurations over `slots` equal slots, each simulated on a fork of the
    admitted model with the assumed events and scored from that fork's service ledger."""
    start_state = checkpoints.unseal(model_record)
    actuators = sorted(policy['pumps']) + sorted(policy['links'])
    configs = [dict(zip(actuators, v)) for v in itertools.product((True, False), repeat=len(actuators))]
    cost = {a: (policy['pumps'].get(a) or policy['links'].get(a))['cost'] for a in actuators}
    best, evaluated = None, 0
    for schedule in itertools.product(configs, repeat=slots):
        fork = WaterPlant(None, fixture_dir=fixture_dir, state=copy.deepcopy(start_state))
        fork.state['faults'] = sorted(copy.deepcopy(assume), key=lambda f: (f['atUs'], f['faultId']))
        current, switches, feasible = commanded(start_state, fixture_dir), 0.0, True
        for n, config in enumerate(schedule):
            for a in actuators:
                if config[a] != current[a]:
                    try:
                        fork.change((pump if a in policy['pumps'] else link)(a, config[a]), fork.revision)
                    except Rejected:
                        feasible = False
                        break
                    switches += cost[a]
                    current[a] = config[a]
            if not feasible:
                break
            fork.advance(start_state['nowUs'] + (n + 1) * slot_us)
        if feasible:
            value = schedule_objective(policy, fork.service_summary(from_us=start_state['nowUs']), fork, switches)
            evaluated += 1
            if best is None or value < best['objective']:
                best = {'schedule': list(schedule), 'objective': value}
        fork.session.close()
    return dict(best, evaluated=evaluated)


def run_episode(spec, policy, case, controller_name, fixture_dir=FIXTURES):
    plant = WaterPlant(case_spec(spec, case), faults=world_faults(case), fixture_dir=fixture_dir)
    checker = Policy(policy, fixture_dir)
    controller = CONTROLLERS[controller_name](policy, fixture_dir)
    period, duration = policy['decisionPeriodUs'], case['durationUs']
    pending, log, rejected = [], [], []
    next_decision, plan_seq = 0, 0
    while True:
        t = min([next_decision, duration] + [i['applyAtUs'] for i in pending])
        plant.advance(t)
        for item in sorted([i for i in pending if i['applyAtUs'] <= t], key=lambda i: (i['applyAtUs'], i['seq'])):
            pending.remove(item)
            try:
                plant.change(item['action'], item['baseRevision'])
                item.update(status='applied', appliedAtUs=t)
            except Rejected as error:
                item.update(status='rejected', reason=error.code, appliedAtUs=None)
            log.append(item)
        if t >= duration:
            break
        if t >= next_decision:
            obs = plant.observe()
            visible = [a for a in case['advisories'] if a['announceAtUs'] <= t]
            model = plant.admitted_model()
            actions = controller.decide(obs, visible, model, plant.preview)
            if actions:
                verdict = checker.check(model, actions, plant.preview, [])  # enforced for every controller
                if not verdict['ok']:
                    rejected.append({'atUs': t, 'actions': actions, 'code': verdict['code']})
                else:
                    plan_seq += 1
                    for n, action in enumerate(actions):
                        # Bound to the configuration the plan saw; the plan's own earlier actions are expected.
                        pending.append({'seq': len(log) + len(pending), 'planSeq': plan_seq, 'decidedAtUs': t, 'applyAtUs': t + checker.delay_us(action),
                                        'action': action, 'baseRevision': obs['configurationRevision'] + n, 'cost': checker.cost(action)})
            next_decision = t + period
    summary = plant.service_summary()
    others = [n for n in plant.net.consumers if n not in plant.essential]
    levels = [(s['atUs'], s['tanks'][policy['reserve']['tank']]['levelM']) for s in plant.state['ledger']]
    ends = [t for t, _ in levels[1:]] + [plant.now_us]
    below = sum((e - t) / 1e6 for (t, lv), e in zip(levels, ends) if lv < policy['reserve']['reserveLevelM'])
    protected = [n for n, rule in sorted(policy['protectedNodes'].items()) if (summary['byNode'][n]['score'] or 1.0) < rule['minServiceFraction']]
    applied = [i for i in log if i['status'] == 'applied']
    return {
        'caseId': case['caseId'], 'controller': controller_name, 'status': summary['status'],
        'byNode': {n: {'requiredM3': v['requiredM3'], 'deliveredM3': v['deliveredM3'], 'unmetM3': v['deficitM3'], 'lowPressureSeconds': v['lowPressureSeconds'], 'score': v['score']}
                   for n, v in summary['byNode'].items()},
        'essentialUnmetM3': summary['essentialUnmetM3'], 'nonessentialUnmetM3': sum(summary['byNode'][n]['deficitM3'] for n in others),
        'lowPressureSeconds': summary['lowPressureSeconds'], 'pumpEnergyJ': summary['pumpEnergyJ'], 'leakM3': summary['leakM3'],
        'switchingCost': sum(i['cost'] for i in applied), 'starts': sum(1 for i in applied if i['action']['type'] == 'set_pump' and i['action']['params']['on']),
        'reserve': {'tank': policy['reserve']['tank'], 'minLevelM': min(lv for _, lv in levels), 'endLevelM': levels[-1][1], 'secondsBelowReserve': below,
                    'trajectory': levels[::10]},
        'protectedViolations': protected, 'actions': log, 'rejected': rejected,
    }


def develop(out_path, controllers=('none', 'local', 'predictive')):
    import hashlib
    import platform
    import time
    fixture = os.path.join(FIXTURES, 'development.json')
    spec, policy, cases = load_development(fixture)
    episodes = []
    for case in cases:
        for name in controllers:
            started = time.perf_counter()
            r = run_episode(spec, policy, case, name)
            r['wallSeconds'] = round(time.perf_counter() - started, 3)
            episodes.append(r)
            print(json.dumps({k: r[k] for k in ('caseId', 'controller', 'essentialUnmetM3', 'nonessentialUnmetM3', 'lowPressureSeconds', 'pumpEnergyJ', 'switchingCost', 'protectedViolations', 'wallSeconds')}), flush=True)
    with open(fixture, 'rb') as handle:
        sha = hashlib.sha256(handle.read()).hexdigest()
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w') as handle:
        json.dump({'schema': 'lifeline.water-development-run.v1', 'fixtureSha256': sha, 'policyId': policy['policyId'], 'python': platform.python_version(),
                   'controllers': list(controllers), 'episodes': episodes}, handle, indent=1, allow_nan=False)
        handle.write('\n')
    return 0


if __name__ == '__main__':
    import argparse
    import sys
    parser = argparse.ArgumentParser(description='P09 water development suite')
    parser.add_argument('command', choices=('develop',))
    parser.add_argument('--out', required=True)
    sys.exit(develop(parser.parse_args().out))


def closed_loop(policy, model_record, assume, slots, slot_us, fixture_dir=FIXTURES):
    """The predictive baseline run receding-horizon on a fork (re-deciding at each slot with the remaining
    horizon), scored exactly like exhaustive_schedules, so the two are directly comparable."""
    start_state = checkpoints.unseal(model_record)
    fork = WaterPlant(None, fixture_dir=fixture_dir, state=copy.deepcopy(start_state))
    fork.state['faults'] = sorted(copy.deepcopy(assume), key=lambda f: (f['atUs'], f['faultId']))
    actuators = sorted(policy['pumps']) + sorted(policy['links'])
    cost = {a: (policy['pumps'].get(a) or policy['links'].get(a))['cost'] for a in actuators}
    schedule, switches = [], 0.0
    for n in range(slots):
        end = start_state['nowUs'] + slots * slot_us
        local = dict(policy, predictive=dict(policy['predictive'], horizonUs=end - fork.now_us))
        model = fork.admitted_model()
        remaining = [e for e in assume if e['atUs'] > fork.now_us]
        actions = Predictive(local, fixture_dir).choose(model, fork.preview, remaining)['actions']
        for a in actions:
            fork.change(a, fork.revision)
            switches += cost[asset_of(a)]
        schedule.append(commanded(fork.state, fixture_dir))
        fork.advance(start_state['nowUs'] + (n + 1) * slot_us)
    value = schedule_objective(policy, fork.service_summary(from_us=start_state['nowUs']), fork, switches)
    fork.session.close()
    return {'schedule': schedule, 'objective': value}
