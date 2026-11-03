"""P13 baselines in Python: a perfect-information ceiling for headroom analysis.

`oracle_ceiling` searches a small finite schedule space (generator dispatch time x station mode per slot)
on in-process forks of the true town, with the true future faults, and scores each schedule with the
evaluator's own service ledgers (Town.truth). It shares no code path with the Node planner or previews,
so it checks them independently. It is an ORACLE: it uses hidden information and is never a comparator.
"""
import copy
import itertools
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from coupling import Town, load_town  # noqa: E402

S = 1000000


def objective(truth, fuel_used, cost):
    """Frozen service order: essential water, essential power, fuel, action cost."""
    return (round(truth['water']['essentialUnmetM3'], 3), round(truth['power']['essentialUnservedJ'], -3), fuel_used, cost)


def run_schedule(bundle, case, decision_us, dispatch, modes, slot_us, end_us, capabilities):
    t = Town(copy.deepcopy(bundle), faults=case['faults'])
    t.advance(decision_us)
    cost, mode = 0.0, 'auto'
    for i in range(len(modes) + 1):
        at = decision_us + i * slot_us
        if at > end_us:
            break
        if at > t.state['nowUs']:
            t.advance(at)
        if dispatch is not None and decision_us + dispatch == at:
            t.command('resource', {'type': 'allocate_generator', 'params': {'resourceId': 'gen-portable', 'site': 'pump-station'}}, 0)
            cost += 2
        want = modes[i] if i < len(modes) else 'auto'
        if want != mode and 'set_station_mode' in capabilities:
            t.command('water', {'type': 'set_station_mode', 'params': {'mode': want}}, t.water.revision)
            cost += 0.5
            mode = want
    t.advance(end_us)
    fuel = bundle['town']['resources']['gen-portable']['fuelJ'] - t.state['resources']['gen-portable']['fuelJ']
    return objective(t.truth(), fuel, cost)


def oracle_ceiling(case, decision_us, end_us, slots=4, slot_us=3600 * S, capabilities=('allocate_generator', 'set_station_mode')):
    bundle = load_town()
    if case.get('tankInitialLevels'):
        bundle['water']['tankInitialLevels'] = case['tankInitialLevels']
    dispatches = [0, slot_us, None] if 'allocate_generator' in capabilities else [None]
    modes = list(itertools.product(('auto', 'paused'), repeat=slots)) if 'set_station_mode' in capabilities else [('auto',) * slots]
    best = None
    for dispatch in dispatches:
        for m in modes:
            value = run_schedule(bundle, case, decision_us, dispatch, list(m), slot_us, end_us, capabilities)
            if best is None or value < best['objective']:
                best = {'objective': value, 'dispatch': dispatch, 'modes': list(m)}
    best['evaluated'] = len(dispatches) * len(modes)
    best['label'] = 'ORACLE: perfect information (true future faults); not deployable'
    return best
