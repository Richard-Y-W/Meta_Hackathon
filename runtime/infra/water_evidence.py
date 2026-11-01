"""P08 evidence: analytic depletion and step-size sensitivity, replay restart cost and equivalence (with a
negative control), and the Net3 reference run with a pump outage, cross-checked against an independent
WNTR EpanetSimulator solve of the same network.

    .work/environments/water/bin/python runtime/infra/water_evidence.py --out artifacts/lifeline/infra/p08-run-0/evidence.json
"""
import argparse
import copy
import json
import os
import platform
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import wntr  # noqa: E402

from water_wntr import MODEL_VERSION, WORKDIR, Network, WaterPlant  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(ROOT, 'fixtures/lifeline/infra/water')
S = 1000000


def fault(fid, at_s, kind, asset, **extra):
    return dict({'faultId': fid, 'atUs': at_s * S, 'type': kind, 'assetId': asset}, **extra)


def plant(spec, faults=()):
    return WaterPlant(copy.deepcopy(spec), faults=list(faults), fixture_dir=FIXTURES)


def analytic(spec):
    out = {}
    for step in (60, 30, 10):
        s = dict(copy.deepcopy(spec), hydraulicStepS=step)
        p = plant(s, [fault('out', 0, 'pump_outage', 'PU1')])
        started = time.perf_counter()
        p.advance(3600 * S)
        out['step%ds' % step] = dict(p.depletion_result('T1'), wallSeconds=round(time.perf_counter() - started, 4), samples=len(p.state['ledger']))
    times = [v['depletion_time_s'] for v in out.values()]
    out['analytic'] = {'usableM3': 12.0, 'netDrawM3s': 0.01, 'depletionTimeS': 1200.0, 'maxDeviationS': max(abs(t - 1200) for t in times)}
    return out


def replay(spec):
    faults = [fault('out', 600, 'pump_outage', 'PU1'), fault('leak', 900, 'leak', 'JD', emitterM3sPerSqrtM=0.0005)]
    action = {'type': 'set_link', 'params': {'linkId': 'P3', 'open': True}}

    def run(mode):
        p = plant(spec, faults)
        p.advance(480 * S)
        p.change(action, p.revision)
        p.advance(720 * S)
        cp = p.checkpoint()
        if mode in ('restore', 'diverge'):
            p.advance(1500 * S)
            p.change({'type': 'set_link', 'params': {'linkId': 'P3', 'open': False}}, p.revision)
        if mode == 'restore':
            p.restore(cp)
        if mode == 'fork':
            p = WaterPlant.from_checkpoint(cp, fixture_dir=FIXTURES)
        p.advance(2400 * S)
        return p

    reference = run(None)
    result = {}
    for mode in ('restore', 'fork', 'diverge'):
        p = run(mode)
        result[mode] = {'identicalSamples': p.service_record()['samples'] == reference.service_record()['samples'],
                        'essentialUnmetDiffM3': abs(p.service_summary()['essentialUnmetM3'] - reference.service_summary()['essentialUnmetM3'])}
    cost = {}
    long_spec = dict(copy.deepcopy(spec), durationS=86400)
    p = plant(long_spec)
    for t in (600, 3600, 21600, 86400):
        p.advance(t * S)
        cp = p.checkpoint()
        started = time.perf_counter()
        q = WaterPlant.from_checkpoint(cp, fixture_dir=FIXTURES)
        cost['%ds' % t] = {'replaySeconds': round(time.perf_counter() - started, 4), 'historyGroups': len(cp['state']['history']), 'checkpointBytes': len(json.dumps(cp))}
        q.session.close()
    result['restoreCost'] = cost
    result['pass'] = result['restore']['identicalSamples'] and result['fork']['identicalSamples'] and not result['diverge']['identicalSamples']
    return result


def reference(spec):
    horizon = 24 * 3600
    base, outage = plant(spec), plant(spec, [fault('out', 3600, 'pump_outage', '335')])
    started = time.perf_counter()
    base.advance(horizon * S)
    wall = time.perf_counter() - started
    outage.advance(horizon * S)

    def digest(p):
        s = p.service_summary()
        tanks = {t: min(x['tanks'][t]['levelM'] for x in p.state['ledger']) for t in ('1', '2', '3')}
        return {'essentialRequiredM3': s['essentialRequiredM3'], 'essentialUnmetM3': s['essentialUnmetM3'], 'lowPressureSeconds': s['lowPressureSeconds'],
                'pumpEnergyJ': s['pumpEnergyJ'], 'minTankLevelsM': tanks, 'endTankLevelsM': {t: p.ledger_tail()['tanks'][t]['levelM'] for t in ('1', '2', '3')},
                'essentialScores': {n: s['byNode'][n]['score'] for n in spec['essentialNodes']}, 'status': s['status']}

    # Independent solve: WNTR's EpanetSimulator on the same model, a different code path from the plant's
    # toolkit session (whole-run simulation, WNTR result tables), compared at every hydraulic step.
    net = Network.load(spec, FIXTURES)
    wn = copy.deepcopy(net.wn)
    wn.options.time.duration = horizon
    sim = wntr.sim.EpanetSimulator(wn)
    results = sim.run_sim(file_prefix=os.path.join(WORKDIR, 'independent-net3'))
    pressure, head = results.node['pressure'], results.node['head']
    worst_p, worst_level, compared = 0.0, 0.0, 0
    for sample in base.state['ledger']:
        t = sample['atUs'] // S
        if t not in pressure.index:
            continue
        compared += 1
        for n in spec['essentialNodes']:
            worst_p = max(worst_p, abs(sample['nodes'][n]['pressureM'] - float(pressure.at[t, n])))
        for tank, geo in net.tanks.items():
            worst_level = max(worst_level, abs(sample['tanks'][tank]['levelM'] - (float(head.at[t, tank]) - geo['elevation'])))
    return {'baseline': digest(base), 'pump335OutageAt1h': digest(outage), 'baselineWallSeconds': round(wall, 3), 'samples': len(base.state['ledger']),
            'removedControls': net.removed_controls,
            'independent': {'method': 'wntr.sim.EpanetSimulator full run of the same SI model', 'comparedSteps': compared, 'maxPressureDiffM': worst_p, 'maxTankLevelDiffM': worst_level}}


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True)
    args = parser.parse_args(argv)
    with open(os.path.join(FIXTURES, 'networks.json')) as handle:
        networks = json.load(handle)['networks']
    report = {'schema': 'lifeline.water-evidence.v1', 'modelVersion': MODEL_VERSION, 'python': platform.python_version(), 'wntr': wntr.__version__,
              'analytic': analytic(networks['analytic']), 'replay': replay(networks['analytic']), 'reference': reference(networks['reference'])}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as handle:
        json.dump(report, handle, indent=2, allow_nan=False)
        handle.write('\n')
    print(json.dumps({'depletion': {k: v['depletion_time_s'] for k, v in report['analytic'].items() if k.startswith('step')}, 'replayPass': report['replay']['pass'],
                      'restoreCost': {k: v['replaySeconds'] for k, v in report['replay']['restoreCost'].items()}, 'independent': report['reference']['independent'],
                      'baselineUnmet': report['reference']['baseline']['essentialUnmetM3'], 'outageUnmet': report['reference']['pump335OutageAt1h']['essentialUnmetM3']}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
