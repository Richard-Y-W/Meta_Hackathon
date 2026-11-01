"""P07 electrical control: admissible actions, local protection/recovery, predictive baseline vs exhaustive
enumeration, and development-case metrics. Run:
python3 -m unittest discover -s runtime/infra/tests -p 'test_power_control.py'"""
import copy
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, os.path.dirname(HERE))

import power_control as pc  # noqa: E402
from power_pandapower import PowerPlant  # noqa: E402

S = 1000000
SPEC, POLICY, CASES = pc.load_development(os.path.join(ROOT, 'fixtures/lifeline/infra/power/development.json'))
CASE = {c['caseId']: c for c in CASES}
with open(os.path.join(ROOT, 'fixtures/lifeline/infra/power/analytic.json')) as handle:
    FEEDER = json.load(handle)['networks']['feeder']

switch = lambda sid, closed: {'type': 'set_switch', 'params': {'switchId': sid, 'closed': closed}}
shed = lambda lid: {'type': 'set_load_connected', 'params': {'loadId': lid, 'connected': False}}
store = lambda sid, w: {'type': 'set_storage_power', 'params': {'storageId': sid, 'dischargeW': w}}


def plant_at(case_id, until_us):
    p = PowerPlant(copy.deepcopy(SPEC), faults=pc.world_faults(CASE[case_id]))
    p.advance(until_us)
    return p


class AdmissibleActions(unittest.TestCase):
    def setUp(self):
        self.policy = pc.Policy(POLICY)

    def test_overload_producing_intermediate_transition_is_rejected(self):
        p = plant_at('p-constrained-backup', 70 * S)  # line 1-2 tripped at 60 s under 1.5x peak
        residential = POLICY['sheddingOrder'][:7]
        tie_first = [switch('sw-S1', True)] + [shed(l) for l in residential]
        verdict = self.policy.check(p.admitted_model(), tie_first)
        self.assertEqual(verdict['code'], 'overload_transition')
        self.assertEqual(verdict['index'], 0)
        shed_first = [shed(l) for l in residential] + [switch('sw-S1', True)]
        self.assertTrue(self.policy.check(p.admitted_model(), shed_first)['ok'])

    def test_simultaneous_incompatible_switching_is_rejected(self):
        p = plant_at('p-no-fault', 5 * S)
        self.assertEqual(self.policy.check(p.admitted_model(), [switch('sw-S2', True), switch('sw-S3', True)])['code'], 'incompatible_switching')
        self.assertEqual(self.policy.check(p.admitted_model(), [switch('sw-S1', True), switch('sw-S1', False)])['code'], 'incompatible_switching')

    def test_storage_below_reserve_is_rejected(self):
        p = plant_at('p-no-fault', 5 * S)
        p.state['storage']['bess-1']['energyJ'] = POLICY['storage']['bess-1']['reserveJ'] + 1e6
        self.assertEqual(self.policy.check(p.admitted_model(), [store('bess-1', 300000)])['code'], 'storage_below_reserve')
        p.state['storage']['bess-1']['energyJ'] = 4.32e9
        self.assertTrue(self.policy.check(p.admitted_model(), [store('bess-1', 300000)])['ok'])
        self.assertEqual(self.policy.check(p.admitted_model(), [store('bess-1', 600000)])['code'], 'ramp_exceeded')

    def test_unavailable_actuator_is_rejected(self):
        p = plant_at('p-unavailable-actuator', 70 * S)
        self.assertEqual(self.policy.check(p.admitted_model(), [switch('sw-S1', True)])['code'], 'actuator_unavailable')
        self.assertTrue(self.policy.check(p.admitted_model(), [switch('sw-S3', True)])['ok'])

    def test_unauthorized_shedding_of_protected_load_is_rejected(self):
        p = plant_at('p-no-fault', 5 * S)
        self.assertEqual(self.policy.check(p.admitted_model(), [shed('load-ci9')])['code'], 'protected_load_shedding')
        self.assertTrue(self.policy.check(p.admitted_model(), [shed('load-ci9')], authority='operator_approved')['ok'])
        self.assertTrue(self.policy.check(p.admitted_model(), [shed('load-r11')])['ok'])

    def test_dwell_time_blocks_rapid_reoperation(self):
        p = plant_at('p-no-fault', 5 * S)
        p.change(switch('sw-S1', True), p.revision)
        p.advance(20 * S)
        self.assertEqual(self.policy.check(p.admitted_model(), [switch('sw-S1', False)])['code'], 'dwell_active')
        p.advance(70 * S)
        self.assertTrue(self.policy.check(p.admitted_model(), [switch('sw-S1', False)])['ok'])


class Protection(unittest.TestCase):
    def test_sustained_overcurrent_trips_and_timer_is_checkpointed(self):
        p = plant_at('p-gradual-overload', 900 * S)
        trips = [e for e in p.state['events'] if e['type'] == 'protection_trip']
        self.assertTrue(trips, 'an unmanaged 1.8x ramp must trip feeder protection')
        cfg = SPEC['protection']['overcurrent'][trips[0]['assetId']]
        q = PowerPlant(copy.deepcopy(SPEC), faults=pc.world_faults(CASE['p-gradual-overload']))
        q.advance(trips[0]['atUs'] - cfg['delayUs'] // 2)
        self.assertIn(trips[0]['assetId'], q.state['memory']['overcurrent'])
        fork = PowerPlant.from_checkpoint(q.checkpoint())
        fork.advance(trips[0]['atUs'] + S)
        self.assertEqual([e for e in fork.state['events'] if e['type'] == 'protection_trip'][0], trips[0])


class LocalPolicy(unittest.TestCase):
    def test_restores_after_its_delay_through_an_available_tie(self):
        result = pc.run_episode(SPEC, POLICY, CASE['p-feeder-loss'], 'local')
        closes = [a for a in result['actions'] if a['status'] == 'applied' and a['action']['type'] == 'set_switch']
        self.assertEqual(closes[0]['action']['params'], {'switchId': 'sw-S1', 'closed': True})
        self.assertGreaterEqual(closes[0]['appliedAtUs'] - 60 * S, POLICY['local']['restoration'][0]['delayUs'])
        self.assertTrue(result['recovery']['recovered'])

    def test_sheds_before_restoring_through_a_constrained_backup_path(self):
        none = pc.run_episode(SPEC, POLICY, CASE['p-constrained-backup'], 'none')
        local = pc.run_episode(SPEC, POLICY, CASE['p-constrained-backup'], 'local')
        plan = [a for a in local['actions'] if a['status'] == 'applied']
        tie = next(i for i, a in enumerate(plan) if a['action']['type'] == 'set_switch')
        self.assertTrue(all(a['action']['type'] == 'set_load_connected' for a in plan[:tie]) and tie > 0)
        self.assertLess(local['essentialUnservedJ'], none['essentialUnservedJ'])
        self.assertTrue(local['recovery']['recovered'])

    def test_stale_readings_are_not_used_as_evidence(self):
        obs = {'atUs': 100 * S, 'staleAfterUs': 10 * S, 'configurationRevision': 1, 'unavailableActuators': [],
               'readings': [{'sensorId': 'v-bus-9', 'value': 0, 'observedAtUs': 100 * S}, {'sensorId': 'v-bus-8', 'value': 19000, 'observedAtUs': 50 * S}]}
        fresh = pc.fresh_readings(obs)
        self.assertIn('v-bus-9', fresh)
        self.assertNotIn('v-bus-8', fresh)


class PredictiveBaseline(unittest.TestCase):
    def test_matches_exhaustive_enumeration_on_the_tiny_feeder(self):
        tiny_policy = pc.tiny_policy(FEEDER)
        for assume in ([], [{'faultId': 'risk', 'atUs': 30 * S, 'type': 'line_trip', 'assetId': 'L2'}]):
            p = PowerPlant(copy.deepcopy(FEEDER))
            p.advance(5 * S)
            model = p.admitted_model()
            chosen = pc.Predictive(tiny_policy).choose(model, p.preview, assume)
            best = pc.exhaustive_best(tiny_policy, model, p.preview, assume)
            self.assertAlmostEqual(chosen['objective'], best['objective'], delta=1.0, msg=str(assume))
        self.assertTrue(any(a['params'].get('switchId') == 'sw-tie' for a in chosen['actions']), 'announced L2 loss: close the tie first')

    def test_prevents_an_announced_loss_that_local_policy_only_repairs(self):
        local = pc.run_episode(SPEC, POLICY, CASE['p-announced-loss'], 'local')
        predictive = pc.run_episode(SPEC, POLICY, CASE['p-announced-loss'], 'predictive')
        self.assertGreater(local['essentialUnservedJ'], 0)
        self.assertLess(predictive['essentialUnservedJ'], local['essentialUnservedJ'])


class DevelopmentMetrics(unittest.TestCase):
    def test_impossible_supply_is_unrecoverable_for_both_controllers(self):
        for controller in ('local', 'predictive'):
            r = pc.run_episode(SPEC, POLICY, CASE['p-impossible-supply'], controller)
            self.assertFalse(r['recovery']['recovered'], controller)
            self.assertAlmostEqual(r['essentialUnservedJ'], r['essentialDemandJ'] * (840 / 900), delta=1e3)

    def test_metrics_report_every_required_quantity(self):
        r = pc.run_episode(SPEC, POLICY, CASE['p-no-fault'], 'local')
        for key in ('essentialUnservedJ', 'essentialOutageSeconds', 'constraintEventSeconds', 'nonessentialUnservedJ', 'actionCost', 'actions', 'rejected', 'protectionTrips', 'recovery'):
            self.assertIn(key, r)
        self.assertEqual(r['essentialUnservedJ'], 0)
        self.assertEqual(r['actions'], [])


if __name__ == '__main__':
    unittest.main()
