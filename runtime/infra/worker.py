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

from coupling import CAPABILITIES, LAYOUT_DEFAULT, Town, apply_layout, load_town  # noqa: E402
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
        if 'tankInitialLevels' in args:  # declared case parameter: starting storage
            bundle['water']['tankInitialLevels'] = args['tankInitialLevels']
        apply_layout(bundle, args.get('layout'))  # declared case parameter: dependency layout
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

    def admitted_model(args):
        record = town().admitted_model()
        key = 'model-%d' % (len(session.setdefault('models', {})) + 1)
        session['models'][key] = record
        return {'modelId': key, 'hash': record['hash'], 'atUs': town().state['nowUs']}

    def preview(args):
        record = session.get('models', {}).get(args.get('modelId'))
        if record is None:
            raise Rejected('unknown_model', str(args.get('modelId')))
        return town().preview(args['plan'], record, assume=args.get('assume', []))

    JUDGE = {'line_trip': 'power', 'actuator_unavailable': 'water', 'router_fail': 'communications', 'sensor_freeze': None}

    def inject(args):
        """A judge fault, admitted for the next coupling step. The request and effect times are recorded."""
        t = town()
        fault = dict(args['fault'])
        kind = fault.get('type')
        if kind not in JUDGE:
            raise Rejected('fault_not_admitted', str(kind))
        domain = JUDGE[kind] or ('power' if fault.get('assetId', '') in [x['id'] for x in t.power.spec['sensors']] else 'water')
        now = t.state['nowUs']
        session['judge'] = session.get('judge', 0) + 1
        record = {'faultId': 'judge-%d' % session['judge'], 'atUs': now + t.step_us, 'type': kind, 'assetId': fault.get('assetId')}
        if domain == 'communications':
            if record['assetId'] not in t.state['routers']:
                raise Rejected('unknown_asset', str(record['assetId']))
            t.state['commsFaults'] = sorted(t.state['commsFaults'] + [record], key=lambda f: (f['atUs'], f['faultId']))
        else:
            plant = t.power if domain == 'power' else t.water
            plant._check_fault(record)
            plant.state['faults'] = sorted(plant.state['faults'] + [record], key=lambda f: (f['atUs'], f['faultId']))
        event = {'atUs': now, 'type': 'judge_fault', 'fault': record, 'domain': domain, 'requestedAtUs': now, 'effectAtUs': record['atUs']}
        t.state['events'].append(event)
        return event

    return {
        'hello': lambda a: {'domainId': 'town', 'protocol': 1},
        'inject': inject,
        'receipts': lambda a: {'receipts': [{'atUs': c['atUs'], 'domain': c['domain'], 'action': c['action'], 'status': c['status'], 'reason': c.get('reason')}
                                            for c in town().state['commands'][-int(a.get('last', 12)):]]},  # this system's own command receipts
        'capabilities': lambda a: {'commands': list(CAPABILITIES), 'switches': sorted(town().power.state['switches']), 'pumps': list(town().water.net.pumps),
                                   'links': list(town().water.net.links), 'resources': sorted(town().state['resources'])},
        'admitted_model': admitted_model, 'preview': preview,
        'state': lambda a: {'nowUs': town().state['nowUs'], 'stationMode': town().state['stationMode'], 'resources': town().state['resources'],
                            'revisions': {'power': town().power.revision, 'water': town().water.revision}, 'worldRevision': town().world_revision(),
                            'layout': town().bundle.get('layout', LAYOUT_DEFAULT),
                            'closedLinks': sorted(l for l in town().water.net.links if not town().water.ledger_tail()['links'][l]['open'])},
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
