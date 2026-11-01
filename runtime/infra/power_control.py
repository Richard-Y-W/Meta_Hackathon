"""P07 electrical control on the qualified pandapower plant.

Policy      admissible actions: actuator availability, dwell, ramp, storage reserve, protected loads,
            incompatible switching and overload-free intermediate transitions (checked on the admitted model).
Local       conventional reactive policy: timed tie restoration from bus-dead evidence and fixed-order
            shedding/reconnection from loading evidence. Ignores forecasts. Protection lives in the plant.
Predictive  competent baseline with the same actions, forecasts and solver: bounded candidate plans scored
            by admitted-model previews over a horizon.
exhaustive_best  independent enumeration of every end configuration for tiny cases.
run_episode true plant + controller + actuator delays; metrics from the plant's private ledger.
"""
import copy
import itertools
import json
import os

import checkpoints
from power_pandapower import PowerPlant
from protocol import Rejected

INF = float('inf')
WATCH_DEAD_V = 1.0  # a bus reading at or below 1 V is de-energized


def load_development(path):
    with open(path) as handle:
        dev = json.load(handle)
    base_dir = os.path.dirname(path)
    with open(os.path.join(base_dir, dev['network']['base'])) as handle:
        spec = json.load(handle)
    spec.pop('scenario', None)
    spec.update(copy.deepcopy(dev['network']['overrides']))
    with open(os.path.join(base_dir, dev['policy'])) as handle:
        policy = json.load(handle)
    return spec, policy, dev['cases']


def world_faults(case):
    return copy.deepcopy(case['faults'])


def fresh_readings(obs):
    """Readings usable as evidence: present and no older than the declared staleness bound."""
    return {r['sensorId']: r['value'] for r in obs['readings'] if r['value'] is not None and obs['atUs'] - r['observedAtUs'] <= obs['staleAfterUs']}


def asset_of(action):
    params = action['params']
    return params.get('switchId') or params.get('loadId') or params.get('storageId')


def switch(sid, closed):
    return {'type': 'set_switch', 'params': {'switchId': sid, 'closed': closed}}


def connect(lid, connected):
    return {'type': 'set_load_connected', 'params': {'loadId': lid, 'connected': connected}}


def store(sid, watts):
    return {'type': 'set_storage_power', 'params': {'storageId': sid, 'dischargeW': float(watts)}}


def thermal_assets(plant):
    return {e['assetId'] for e in plant.solution['constraintEvents'] if e['type'] == 'thermal_limit'}


class Policy:
    def __init__(self, policy):
        self.p = policy
        self._scratch = None

    def _fork(self, state):
        if self._scratch is None:
            self._scratch = PowerPlant(None, state=copy.deepcopy(state))
        return self._scratch.reload(state)

    def delay_us(self, action):
        asset = asset_of(action)
        table = {'set_switch': self.p['switches'], 'set_load_connected': self.p['sheddable'], 'set_storage_power': self.p['storage']}[action['type']]
        return table.get(asset, {}).get('delayUs', 0)

    def cost(self, action):
        asset = asset_of(action)
        table = {'set_switch': self.p['switches'], 'set_load_connected': self.p['sheddable'], 'set_storage_power': self.p['storage']}[action['type']]
        return table.get(asset, {}).get('cost', 0.0)

    def check(self, model_record, actions, authority='bounded_auto'):
        """Static admissibility, then every action prefix replayed on the admitted model: a prefix may not
        create a thermal violation the starting state does not have, and must remain solvable."""
        def fail(code, index=None, detail=''):
            return {'ok': False, 'code': code, 'index': index, 'detail': detail}
        state = checkpoints.unseal(model_record)
        now = state['nowUs']
        assets = [asset_of(a) for a in actions]
        if len(set(assets)) != len(assets):
            return fail('incompatible_switching', None, 'one asset operated twice in a plan')
        for pair in self.p['incompatible']:
            if all(x in assets for x in pair):
                return fail('incompatible_switching', None, '+'.join(pair))
        for i, action in enumerate(actions):
            asset, kind = asset_of(action), action['type']
            if kind == 'set_switch':
                cfg = self.p['switches'].get(asset)
                if cfg is None:
                    return fail('not_admissible', i, asset)
                if asset in state['unavailableActuators']:
                    return fail('actuator_unavailable', i, asset)
                last = state['operations'].get(asset)
                if last is not None and now - last < cfg['dwellUs']:
                    return fail('dwell_active', i, asset)
            elif kind == 'set_load_connected':
                if asset in self.p['protectedLoads']:
                    if not action['params']['connected'] and authority != 'operator_approved':
                        return fail('protected_load_shedding', i, asset)
                elif asset not in self.p['sheddable']:
                    return fail('not_admissible', i, asset)
            elif kind == 'set_storage_power':
                cfg = self.p['storage'].get(asset)
                if cfg is None:
                    return fail('not_admissible', i, asset)
                watts, current = action['params']['dischargeW'], state['storage'][asset]['dischargeW']
                if abs(watts - current) > cfg['maxStepW']:
                    return fail('ramp_exceeded', i, asset)
                if watts > 0 and state['storage'][asset]['energyJ'] - watts * cfg['reserveHorizonUs'] / 1e6 < cfg['reserveJ']:
                    return fail('storage_below_reserve', i, asset)
            else:
                return fail('not_admissible', i, kind)
        fork = self._fork(state)
        fork.solve()
        if not fork._usable():
            return fail('infeasible_transition', None, 'starting state has no solution')
        before = thermal_assets(fork)
        for i, action in enumerate(actions):
            try:
                fork.change(action, fork.revision)
            except Rejected as error:
                return fail(error.code, i, error.detail)
            fork.solve()
            if not fork._usable():
                return fail('infeasible_transition', i, fork.solve_status['status'])
            created = thermal_assets(fork) - before
            if created:
                return fail('overload_transition', i, ','.join(sorted(created)))
        return {'ok': True, 'code': 'ok'}


class Controller:
    name = 'none'

    def __init__(self, policy):
        self.p = policy
        self.policy = Policy(policy)

    def decide(self, obs, advisories, model_record, previewer):
        return []


class Local(Controller):
    """Conventional reactive policy. Uses fresh readings only; never forecasts."""
    name = 'local'

    def __init__(self, policy):
        Controller.__init__(self, policy)
        self.dead_since = {}
        self.shed = []
        self.calm_since = None

    def decide(self, obs, advisories, model_record, previewer):
        now, fresh = obs['atUs'], fresh_readings(obs)
        switches = {r['assetId']: r['value'] for r in obs['readings'] if r['metric'] == 'power.switch_state'}
        unavailable = set(obs['unavailableActuators'])
        for n, rule in enumerate(self.p['local']['restoration']):
            watched = [fresh[s] for s in rule['watch'] if s in fresh]
            if watched and min(watched) <= WATCH_DEAD_V:
                since = self.dead_since.setdefault(n, now)
                if now - since >= rule['delayUs']:
                    for tie in rule['ties']:
                        if switches.get(tie) == 0 and tie not in unavailable:
                            self.dead_since[n] = now  # wait another delay before trying the next tie
                            return self._restoration_plan(tie, model_record)
            else:
                self.dead_since.pop(n, None)
        relief = self.p['local']['relief']
        loadings = [fresh[s] for s in relief['loadingSensors'] if s in fresh]
        low = [v for k, v in fresh.items() if k.startswith('v-') and WATCH_DEAD_V < v < relief['undervoltageV']]
        if (loadings and max(loadings) > relief['threshold']) or low:
            self.calm_since = None
            for lid in self.p['sheddingOrder']:
                if lid not in self.shed:
                    self.shed.append(lid)
                    return [connect(lid, False)]
            return []
        if self.shed and loadings and max(loadings) < relief['reconnectBelow'] and not low:
            if self.calm_since is None:
                self.calm_since = now
            if now - self.calm_since >= relief['reconnectAfterUs']:
                self.calm_since = now
                return [connect(self.shed.pop(), True)]
        else:
            self.calm_since = None
        return []


    def _restoration_plan(self, tie, model_record):
        """Close the tie; if that transition would overload the backup path, shed in the fixed order first
        (the conventional shed-then-restore sequence), using the same admissibility check as execution."""
        plan = [switch(tie, True)]
        if self.policy.check(model_record, plan)['code'] != 'overload_transition':
            return plan
        available = [l for l in self.p['sheddingOrder'] if l not in self.shed]
        for depth in range(1, len(available) + 1):
            plan = [connect(l, False) for l in available[:depth]] + [switch(tie, True)]
            if self.policy.check(model_record, plan)['ok']:
                self.shed.extend(available[:depth])
                return plan
        return [switch(tie, True)]


def forecast_events(advisories, now_us):
    """Future events announced by visible advisories, as assumptions for previews."""
    events = []
    for advisory in advisories:
        for event in advisory['events']:
            if event['atUs'] > now_us:
                events.append(dict(event, faultId='assumed-%s' % event['faultId']))
    return events


class Predictive(Controller):
    """Competent predictive baseline: same actions, forecasts and solver as any other controller."""
    name = 'predictive'

    def candidates(self, state):
        cfg = self.p['predictive']
        groups = []
        for sid in sorted(self.p['switches']):
            groups.append(('switch', [switch(sid, not state['switches'][sid])]))
        connected = [l for l in self.p['sheddingOrder'] if state['loads'][l]['connected']]
        for depth in cfg['shedDepths']:
            if depth <= len(connected):
                groups.append(('shed', [connect(l, False) for l in connected[:depth]]))
        disconnected = [l for l in self.p['sheddingOrder'] if not state['loads'][l]['connected']]
        if disconnected:
            groups.append(('reconnect', [connect(disconnected[-1], True)]))
            if len(disconnected) > 1:
                groups.append(('reconnect', [connect(l, True) for l in reversed(disconnected)]))
        for sid in sorted(self.p['storage']):
            pmax = self.p['storage'][sid].get('pMaxW') or self._pmax(state, sid)
            for level in cfg['storageLevels']:
                if abs(level * pmax - state['storage'][sid]['dischargeW']) > 1e-6:
                    groups.append(('storage', [store(sid, level * pmax)]))
        plans = [[]] + [g for _, g in groups]
        if cfg['maxActions'] >= 2:
            order = {'shed': 0, 'reconnect': 2, 'storage': 1, 'switch': 3}  # relieve before switching, reconnect last
            for (ka, a), (kb, b) in itertools.combinations(groups, 2):
                if ka == kb:
                    continue
                first, second = sorted([(ka, a), (kb, b)], key=lambda g: order[g[0]])
                plans.append(first[1] + second[1])
        return plans

    @staticmethod
    def _pmax(state, sid):
        return state['spec'].get('storageState', {}).get(sid, {}).get('pMaxW') or next(s['pMaxW'] for s in state['spec']['storage'] if s['id'] == sid)

    def objective(self, preview, actions):
        if preview['essential_unserved_j'] is None or preview['nonessential_unserved_j'] is None:
            return INF
        w = self.p['predictive']['weights']
        return (w['essentialJ'] * preview['essential_unserved_j'] + w['nonessentialJ'] * preview['nonessential_unserved_j']
                + w['constraintSecondJ'] * preview['constraint_event_seconds'] + w['actionCostJ'] * sum(self.policy.cost(a) for a in actions))

    def choose(self, model_record, previewer, assume):
        state = checkpoints.unseal(model_record)
        horizon = self.p['predictive']['horizonUs']
        scored = []
        for actions in self.candidates(state):
            if actions and not self.policy.check(model_record, actions)['ok']:
                continue
            preview = previewer({'actions': actions, 'horizonUs': horizon, 'assume': assume}, model_record)
            scored.append({'actions': actions, 'objective': self.objective(preview, actions), 'preview': preview})
        noop = scored[0]
        best = min(scored, key=lambda c: (c['objective'], len(c['actions'])))
        if best['actions'] and noop['objective'] - best['objective'] < self.p['predictive']['minImprovementJ']:
            best = noop
        return dict(best, evaluated=len(scored), noopObjective=noop['objective'])

    def triggered(self, obs, assume, state):
        fresh = fresh_readings(obs)
        horizon_end = obs['atUs'] + self.p['predictive']['horizonUs']
        if any(e['atUs'] <= horizon_end for e in assume):
            return True
        if any(v <= WATCH_DEAD_V for k, v in fresh.items() if k.startswith('v-')):
            return True
        if any(v > 0.9 for k, v in fresh.items() if k.startswith('ld-')):
            return True
        if any(not l['connected'] for l in state['loads'].values()) or any(s['dischargeW'] != 0 for s in state['storage'].values()):
            return True
        return False

    def decide(self, obs, advisories, model_record, previewer):
        assume = forecast_events(advisories, obs['atUs'])
        if not self.triggered(obs, assume, checkpoints.unseal(model_record)):
            return []
        return self.choose(model_record, previewer, assume)['actions']


CONTROLLERS = {'none': Controller, 'local': Local, 'predictive': Predictive}


def exhaustive_best(policy, model_record, previewer, assume):
    """Independent enumeration over every end configuration of the admissible actuators (tiny cases
    only). A configuration is feasible if some ordering of its actions passes the policy check."""
    checker, scorer = Policy(policy), Predictive(policy)
    state = checkpoints.unseal(model_record)
    dims = [[None] + [switch(sid, not state['switches'][sid])] for sid in sorted(policy['switches'])]
    dims += [[None, connect(l, not state['loads'][l]['connected'])] for l in sorted(policy['sheddable'])]
    for sid in sorted(policy['storage']):
        pmax = Predictive._pmax(state, sid)
        dims.append([None] + [store(sid, level * pmax) for level in policy['predictive']['storageLevels'] if abs(level * pmax - state['storage'][sid]['dischargeW']) > 1e-6])
    best = None
    for combo in itertools.product(*dims):
        changes = [a for a in combo if a is not None]
        feasible = next((list(order) for order in itertools.permutations(changes) if not order or checker.check(model_record, list(order))['ok']), None)
        if feasible is None:
            continue
        preview = previewer({'actions': feasible, 'horizonUs': policy['predictive']['horizonUs'], 'assume': assume}, model_record)
        value = scorer.objective(preview, feasible)
        if best is None or value < best['objective']:
            best = {'actions': feasible, 'objective': value}
    return best


def tiny_policy(network):
    """Policy for the hand-built analytic feeder, small enough for exhaustive enumeration."""
    return {
        'policyId': 'power-control-tiny', 'decisionPeriodUs': 30000000,
        'switches': {s['id']: {'dwellUs': 0, 'delayUs': 0, 'cost': 1.0} for s in network['switches'] if s.get('actuator')},
        'sheddable': {l['id']: {'delayUs': 0, 'cost': 0.5} for l in network['loads'] if not l.get('essential')},
        'sheddingOrder': [l['id'] for l in network['loads'] if not l.get('essential')],
        'protectedLoads': [l['id'] for l in network['loads'] if l.get('essential')],
        'storage': {s['id']: {'reserveJ': 0, 'maxStepW': s['pMaxW'], 'delayUs': 0, 'cost': 0.1, 'reserveHorizonUs': 0} for s in network['storage']},
        'incompatible': [], 'transition': {'maxLoading': 1.0},
        'predictive': {'horizonUs': 300000000, 'maxActions': 2, 'shedDepths': [1], 'storageLevels': [0.0, 0.5, 1.0],
                       'weights': {'essentialJ': 1.0, 'nonessentialJ': 0.1, 'constraintSecondJ': 100000.0, 'actionCostJ': 100000.0}, 'minImprovementJ': 0.0},
    }


def _first_incident(plant, case):
    times = [f['atUs'] for f in case['faults'] if f['type'] in ('line_trip', 'source_loss', 'generator_unavailable')]
    times += [e['atUs'] for e in plant.state['events'] if e['type'] == 'protection_trip']
    return min(times) if times else None


def _recovery(plant, case, threshold=0.99, sustain_us=60000000):
    incident = _first_incident(plant, case)
    if incident is None:
        return {'incidentAtUs': None, 'recovered': True, 'durationUs': 0}
    samples = plant.state['ledger']
    essential = sorted(plant.essential)
    series = []
    for s in samples:
        demand = sum(s['demand'][l] for l in essential)
        supplied = None if any(s['loads'][l] is None for l in essential) else sum(s['loads'][l] for l in essential)
        series.append((s['atUs'], 0.0 if supplied is None or demand == 0 else supplied / demand))
    after = [(t, f) for t, f in series if t >= incident]
    for i, (t, f) in enumerate(after):
        if f < threshold:
            continue
        stop = next((u for u, g in after[i + 1:] if g < threshold), plant.now_us)
        if stop - t >= sustain_us:
            return {'incidentAtUs': incident, 'recovered': True, 'recoveredAtUs': t, 'durationUs': t - incident}
    return {'incidentAtUs': incident, 'recovered': False, 'censoredAtUs': plant.now_us}


def run_episode(spec, policy, case, controller_name):
    plant = PowerPlant(copy.deepcopy(spec), faults=world_faults(case))
    checker = Policy(policy)
    controller = CONTROLLERS[controller_name](policy)
    period, duration = policy['decisionPeriodUs'], case['durationUs']
    pending, log, rejected = [], [], []
    next_decision, seq = 0, 0
    while True:
        t = min([next_decision, duration] + [item['applyAtUs'] for item in pending])
        plant.advance(t)
        for item in sorted([i for i in pending if i['applyAtUs'] <= t], key=lambda i: (i['applyAtUs'], i['seq'])):
            pending.remove(item)
            try:
                plant.change(item['action'], item['baseRevision'])
                item.update(status='applied', appliedAtUs=t)
            except Rejected as error:
                item.update(status='rejected', reason=error.code, appliedAtUs=None)
                for later in [i for i in pending if i['planSeq'] == item['planSeq']]:  # the rest of the plan is abandoned
                    pending.remove(later)
                    later.update(status='abandoned', reason='earlier_action_failed', appliedAtUs=None)
                    log.append(later)
            log.append(item)
        if t >= duration:
            break
        if t >= next_decision:
            obs = plant.observe()
            visible = [a for a in case['advisories'] if a['announceAtUs'] <= t]
            model = plant.admitted_model()
            actions = controller.decide(obs, visible, model, plant.preview)
            if actions:
                verdict = checker.check(model, actions)
                if verdict['ok']:
                    seq += 1
                    at = t
                    for n, action in enumerate(actions):
                        at += checker.delay_us(action)
                        pending.append({'seq': len(log) + len(pending), 'planSeq': seq, 'decidedAtUs': t, 'applyAtUs': at, 'action': action,
                                        'baseRevision': obs['configurationRevision'] + n, 'cost': checker.cost(action)})
                else:
                    rejected.append({'atUs': t, 'actions': actions, 'code': verdict['code'], 'index': verdict.get('index')})
            next_decision = t + period
    summary = plant.service_summary()
    cases = plant.service_cases()
    outage = 0.0
    for lid in sorted(plant.essential):
        c = cases[lid]
        for seg, sample in zip(c['demand'], c['supply']):
            if sample['value'] is None or sample['value'] < 0.99 * seg['value']:
                outage += (seg['toUs'] - seg['fromUs']) / 1e6
    applied = [i for i in log if i['status'] == 'applied']
    return {
        'caseId': case['caseId'], 'controller': controller_name, 'status': summary['status'],
        'essentialDemandJ': summary['essentialDemandJ'], 'essentialUnservedJ': summary['essentialUnservedJ'],
        'essentialOutageSeconds': outage, 'nonessentialUnservedJ': summary['nonessentialUnservedJ'], 'constraintEventSeconds': summary['constraintEventSeconds'],
        'actionCost': sum(i['cost'] for i in applied), 'actions': log, 'rejected': rejected,
        'protectionTrips': [e for e in plant.state['events'] if e['type'] == 'protection_trip'], 'recovery': _recovery(plant, case),
    }


def develop(out_path, controllers=('none', 'local', 'predictive')):
    """Every development case under every controller; per-episode metrics and a comparison table."""
    import platform
    import time
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    fixture = os.path.join(root, 'fixtures/lifeline/infra/power/development.json')
    spec, policy, cases = load_development(fixture)
    episodes = []
    for case in cases:
        for name in controllers:
            started = time.perf_counter()
            result = run_episode(spec, policy, case, name)
            result['wallSeconds'] = round(time.perf_counter() - started, 3)
            episodes.append(result)
            print(json.dumps({k: result[k] for k in ('caseId', 'controller', 'essentialUnservedJ', 'essentialOutageSeconds', 'nonessentialUnservedJ', 'constraintEventSeconds', 'actionCost', 'wallSeconds')}), flush=True)
    with open(fixture, 'rb') as handle:
        fixture_sha = __import__('hashlib').sha256(handle.read()).hexdigest()
    report = {'schema': 'lifeline.power-development-run.v1', 'fixtureSha256': fixture_sha, 'policyId': policy['policyId'], 'python': platform.python_version(),
              'controllers': list(controllers), 'episodes': episodes}
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w') as handle:
        json.dump(report, handle, indent=1, allow_nan=False)
        handle.write('\n')
    return 0


if __name__ == '__main__':
    import argparse
    import sys
    parser = argparse.ArgumentParser(description='P07 development suite')
    parser.add_argument('command', choices=('develop',))
    parser.add_argument('--out', required=True)
    sys.exit(develop(parser.parse_args().out))
