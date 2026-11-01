"""P06 capability spike: lifecycle timings, checkpoint size/state inventory and restart/fork repeatability
on the analytic feeder and the CIGRE MV reference network.

    python3 runtime/infra/power_pandapower.py spike --out artifacts/lifeline/infra/p06-run-0/spike.json
"""
import json
import os
import platform
import statistics
import time

import checkpoints
from power_pandapower import MODEL_VERSION, PowerPlant

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
S = 1000000
REPS = 15


def timed(fn, reps=REPS):
    values, result = [], None
    for _ in range(reps):
        start = time.perf_counter()
        result = fn()
        values.append((time.perf_counter() - start) * 1000)
    values.sort()
    return {'medianMs': round(statistics.median(values), 3), 'p95Ms': round(values[min(len(values) - 1, int(0.95 * len(values)))], 3), 'reps': reps}, result


def lifecycle(spec, faults, switch_id, storage_id):
    out = {}
    out['initialize'], plant = timed(lambda: PowerPlant(json.loads(json.dumps(spec)), faults=faults))
    out['solve'], _ = timed(lambda: plant.solve())
    out['observe'], _ = timed(lambda: (setattr(plant, 'dirty', False), plant.observe())[1])
    toggles = iter(range(10 ** 6))
    out['changeAndSolve'], _ = timed(lambda: (plant.change({'type': 'set_switch', 'params': {'switchId': switch_id, 'closed': next(toggles) % 2 == 0}}, plant.revision), plant.solve()))
    fresh = PowerPlant(json.loads(json.dumps(spec)), faults=faults)
    if storage_id:
        fresh.change({'type': 'set_storage_power', 'params': {'storageId': storage_id, 'dischargeW': 10000.0}}, fresh.revision)
    start = time.perf_counter()
    fresh.advance(60 * fresh.state['stepUs'])
    out['advance60Steps'] = {'ms': round((time.perf_counter() - start) * 1000, 3), 'stepUs': fresh.state['stepUs'], 'solves': len({s['atUs'] for s in fresh.state['ledger']})}
    out['checkpoint'], record = timed(lambda: fresh.checkpoint())
    out['checkpointBytes'] = len(checkpoints.canonical(record))
    out['restore'], _ = timed(lambda: fresh.restore(record))
    out['fork'], _ = timed(lambda: PowerPlant.from_checkpoint(record))
    out['checkpointHash'], _ = timed(lambda: fresh.checkpoint_hash())
    model = fresh.admitted_model()
    out['preview60s'], _ = timed(lambda: fresh.preview({'actions': [], 'horizonUs': 60 * S}, model), reps=5)
    out['stateInventory'] = sorted(record['state'])
    return out


def repeatability(spec, faults, actions, mid_us, end_us):
    """Uninterrupted reference vs checkpoint/diverge/restore vs fork-from-checkpoint, plus a negative
    control that diverges without restoring (it must differ, or the comparison has no power)."""
    def run(interrupt):
        p = PowerPlant(json.loads(json.dumps(spec)), faults=faults)
        for at, action in actions:
            if at <= mid_us:
                p.advance(at)
                p.change(action, p.revision)
        p.advance(mid_us)
        record = p.checkpoint()
        if interrupt in ('restore', 'diverge'):
            p.advance(mid_us + 30 * S)
            p.change({'type': 'set_switch', 'params': {'switchId': actions[0][1]['params']['switchId'], 'closed': not p.state['switches'][actions[0][1]['params']['switchId']]}}, p.revision)
        if interrupt == 'restore':
            p.restore(record)
        if interrupt == 'fork':
            p = PowerPlant.from_checkpoint(record)
        for at, action in actions:
            if at > mid_us:
                p.advance(max(at, p.now_us))
                p.change(action, p.revision)
        p.advance(max(end_us, p.now_us))
        return p

    reference = run(None)

    def difference(other):
        a = {s['atUs']: s['loads'] for s in reference.state['ledger']}
        b = {s['atUs']: s['loads'] for s in other.state['ledger']}
        common = sorted(set(a) & set(b))
        worst = 0.0
        for t in common:
            for load, value in a[t].items():
                if value is None or b[t][load] is None:
                    worst = max(worst, 0.0 if value is b[t][load] else float('inf'))
                else:
                    worst = max(worst, abs(value - b[t][load]))
        ra, rb = reference.service_summary()['essentialUnservedJ'], other.service_summary()['essentialUnservedJ']
        return {'sameSampleTimes': sorted(a) == sorted(b), 'maxLoadDiffW': worst, 'essentialUnservedDiffJ': None if ra is None or rb is None else abs(ra - rb)}

    return {'restored': difference(run('restore')), 'forked': difference(run('fork')), 'negativeControlDiverged': difference(run('diverge')),
            'tolerances': spec['tolerances']}


def run(out_path):
    with open(os.path.join(ROOT, 'fixtures/lifeline/infra/power/analytic.json')) as handle:
        feeder = json.load(handle)['networks']['feeder']
    with open(os.path.join(ROOT, 'fixtures/lifeline/infra/power/reference.json')) as handle:
        reference = json.load(handle)
    feeder_faults = [{'faultId': 'trip', 'atUs': 20 * S, 'type': 'line_trip', 'assetId': 'L2'},
                     {'faultId': 'diesel', 'atUs': 50 * S, 'type': 'generator_unavailable', 'assetId': 'diesel-clinic'}]
    report = {
        'schema': 'lifeline.power-spike.v1', 'modelVersion': MODEL_VERSION, 'python': platform.python_version(), 'platform': platform.platform(),
        'feeder': {'lifecycle': lifecycle(feeder, feeder_faults, 'sw-tie', 'bess-clinic'),
                   'repeatability': repeatability(feeder, feeder_faults, [(30 * S, {'type': 'set_switch', 'params': {'switchId': 'sw-tie', 'closed': True}})], 40 * S, 90 * S)},
        'reference': {'lifecycle': lifecycle(reference, reference['scenario']['faults'], 'sw-S2', 'bess-1'),
                      'repeatability': repeatability(reference, reference['scenario']['faults'], [(180 * S, {'type': 'set_switch', 'params': {'switchId': 'sw-S1', 'closed': True}})], 120 * S, 300 * S)},
    }
    for net in ('feeder', 'reference'):
        rep, tol = report[net]['repeatability'], report[net]['repeatability']['tolerances']
        rep['pass'] = all(rep[k]['sameSampleTimes'] and rep[k]['maxLoadDiffW'] <= tol['powerW'] and (rep[k]['essentialUnservedDiffJ'] or 0) <= tol['energyJ'] for k in ('restored', 'forked'))
        rep['negativeControlDetected'] = rep['negativeControlDiverged']['maxLoadDiffW'] > tol['powerW'] or (rep['negativeControlDiverged']['essentialUnservedDiffJ'] or 0) > tol['energyJ']
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w') as handle:
        json.dump(report, handle, indent=2, allow_nan=False, default=str)
        handle.write('\n')
    print(json.dumps({net: {'pass': report[net]['repeatability']['pass'], 'negativeControlDetected': report[net]['repeatability']['negativeControlDetected'],
                            'solveMs': report[net]['lifecycle']['solve']['medianMs'], 'checkpointBytes': report[net]['lifecycle']['checkpointBytes']} for net in ('feeder', 'reference')}))
    return 0 if all(report[n]['repeatability']['pass'] and report[n]['repeatability']['negativeControlDetected'] for n in ('feeder', 'reference')) else 1
