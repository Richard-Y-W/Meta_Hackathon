#!/usr/bin/env python3
"""Coupled-town worker (P11), town environment.

    .work/environments/town/bin/python runtime/infra/worker.py serve
    .work/environments/town/bin/python runtime/infra/worker.py traces --out artifacts/lifeline/infra/p11-run-0

`serve` exposes the town over the stdio protocol (protocol.py); checkpoints stay in the worker and only
handles cross the boundary. `traces` retains the P11 evidence: a no-intervention coupled trace with a
developing secondary service loss, an intervention trace that changes that path, and edge ablations.
"""
import argparse
import copy
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from coupling import Town, load_town  # noqa: E402
from protocol import Rejected, serve  # noqa: E402

S = 1000000


def handlers():
    session = {'town': None, 'bundle': None, 'checkpoints': {}}

    def town():
        if session['town'] is None:
            raise Rejected('not_initialized')
        return session['town']

    def initialize(args):
        bundle = load_town()
        cases = {c['caseId']: c for c in bundle['town']['cases']}
        faults = args.get('faults') if 'faults' in args else cases[args['caseId']]['faults']
        session['bundle'] = bundle
        session['town'] = Town(copy.deepcopy(bundle), faults=faults, disabled_edges=args.get('disabledEdges', []))
        return {'atUs': 0, 'townId': bundle['town']['townId'], 'clock': session['town'].clock.manifest()}

    def checkpoint(args):
        record = town().checkpoint()
        key = 'cp-%d' % (len(session['checkpoints']) + 1)
        session['checkpoints'][key] = record
        return {'checkpointId': key, 'hash': record['hash'], 'atUs': town().state['nowUs']}

    def restore(args):
        record = session['checkpoints'].get(args.get('checkpointId'))
        if record is None:
            raise Rejected('unknown_checkpoint', str(args.get('checkpointId')))
        session['town'] = Town.from_checkpoint(copy.deepcopy(session['bundle']), record)
        return {'atUs': session['town'].state['nowUs'], 'hash': record['hash']}

    return {
        'hello': lambda a: {'domainId': 'town', 'protocol': 1},
        'initialize': initialize,
        'advance': lambda a: town().advance(a['toUs']),
        'observe': lambda a: town().observe(),
        'command': lambda a: town().command(a['domain'], a['action'], a['baseRevision']),
        'revisions': lambda a: {'power': town().power.revision, 'water': town().water.revision},
        'checkpoint': checkpoint, 'restore': restore,
        'trace': lambda a: {'trace': town().state['trace'], 'events': town().state['events']},
        'truth': lambda a: town().truth(),  # evaluator only
        'shutdown': lambda a: {'stopping': True},
    }


def summarize(town):
    truth = town.truth()
    onset = next((r['atUs'] for r in town.state['trace'] if r['hospitalWaterFraction'] is not None and r['hospitalWaterFraction'] < 0.99), None)
    return {'waterEssentialUnmetM3': truth['water']['essentialUnmetM3'], 'powerEssentialUnservedJ': truth['power']['essentialUnservedJ'],
            'hospitalWaterLossAtUs': onset, 'minTankLevelM': min(r['tankLevelM'] for r in town.state['trace']),
            'events': [e for e in truth['events'] if e['type'] != 'local_command'], 'localCommands': sum(1 for e in truth['events'] if e['type'] == 'local_command'),
            'commands': truth['commands'], 'maxCouplingIterations': max(r['iterations'] for r in town.state['trace'])}


def traces(out):
    os.makedirs(out, exist_ok=True)
    bundle = load_town()
    case = {c['caseId']: c for c in bundle['town']['cases']}['t-feeder-loss-backup-out']
    report = {'schema': 'lifeline.town-traces.v1', 'case': case, 'clock': None, 'runs': {}}
    runs = {
        'no-intervention': ([], None),
        'intervention-close-S1-at-2400s': ([], (2400 * S, 'power', {'type': 'set_switch', 'params': {'switchId': 'sw-S1', 'closed': True}})),
        'ablation-no-power-to-pump': (['power-to-pump-PU1'], None),
        'ablation-no-pump-load': (['pump-to-load-PU1'], None),
        'ablation-no-power-to-comms': (['power-to-comms-rt-pump'], None),
    }
    for name, (disabled, intervention) in runs.items():
        started = time.perf_counter()
        t = Town(copy.deepcopy(bundle), faults=case['faults'], disabled_edges=disabled)
        report['clock'] = t.clock.manifest()
        if intervention:
            at, domain, action = intervention
            t.advance(at)
            t.command(domain, action, t.power.revision if domain == 'power' else t.water.revision)
        t.advance(case['durationUs'])
        report['runs'][name] = dict(summarize(t), disabledEdges=disabled, wallSeconds=round(time.perf_counter() - started, 3))
        with open(os.path.join(out, '%s.trace.json' % name), 'w') as handle:
            json.dump(t.state['trace'], handle)
    with open(os.path.join(out, 'traces.json'), 'w') as handle:
        json.dump(report, handle, indent=1, allow_nan=False)
        handle.write('\n')
    print(json.dumps({k: {x: v[x] for x in ('waterEssentialUnmetM3', 'powerEssentialUnservedJ', 'hospitalWaterLossAtUs', 'minTankLevelM')} for k, v in report['runs'].items()}, indent=1))
    return 0


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=('serve', 'traces'))
    parser.add_argument('--out', default=None)
    args = parser.parse_args(argv)
    if args.command == 'serve':
        serve(handlers())
        return 0
    return traces(args.out)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
