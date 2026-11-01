"""P09 water control: admissible actions, protected minimum service, local threshold policy, predictive
baseline against exhaustive schedule enumeration, and development-case metrics. Run with the water
environment: .work/environments/water/bin/python -m unittest discover -s runtime/infra/tests -p 'test_water_control.py'"""
import copy
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, os.path.dirname(HERE))

try:
    import wntr  # noqa: F401
    HAVE_WNTR = True
except ImportError:
    HAVE_WNTR = False

if HAVE_WNTR:
    import water_control as wc
    from water_wntr import WaterPlant

FIXTURES = os.path.join(ROOT, 'fixtures/lifeline/infra/water')
S = 1000000
pump = lambda pid, on: {'type': 'set_pump', 'params': {'pumpId': pid, 'on': on}}
link = lambda lid, open_: {'type': 'set_link', 'params': {'linkId': lid, 'open': open_}}


@unittest.skipUnless(HAVE_WNTR, 'wntr is installed only in .work/environments/water')
class AdmissibleActions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec, cls.policy_json, cases = wc.load_development(os.path.join(FIXTURES, 'development.json'))
        cls.case = {c['caseId']: c for c in cases}

    def at(self, case_id, until_s, actions=()):
        p = WaterPlant(wc.case_spec(self.spec, self.case[case_id]), faults=wc.world_faults(self.case[case_id]), fixture_dir=FIXTURES)
        p.advance(until_s * S)
        for a in actions:
            p.change(a, p.revision)
        return p

    def check(self, p, actions, assume=()):
        return wc.Policy(self.policy_json).check(p.admitted_model(), actions, p.preview, list(assume))

    def test_plan_that_starves_a_protected_node_is_rejected(self):
        # Closing the fire-station branch keeps more water for the hospital, but JF falls below its
        # protected minimum service: the plan is refused, however good the average looks.
        p = self.at('w-unavailable-backup', 2400)
        verdict = self.check(p, [link('PF', False)])
        self.assertEqual(verdict['code'], 'protected_service_violation')
        self.assertEqual(verdict['node'], 'JF')
        self.assertTrue(self.check(p, [link('PZ', False)])['ok'])

    def test_unsupported_pump_speed_is_rejected(self):
        p = self.at('w-no-fault', 60)
        verdict = self.check(p, [{'type': 'set_pump', 'params': {'pumpId': 'PU2', 'on': True, 'speed': 0.7}}])
        self.assertEqual(verdict['code'], 'unsupported_parameter')

    def test_unavailable_actuator_is_rejected(self):
        p = self.at('w-unavailable-backup', 60)
        self.assertEqual(self.check(p, [pump('PU2', True)])['code'], 'actuator_unavailable')

    def test_minimum_run_and_start_limits(self):
        p = self.at('w-no-fault', 60, [pump('PU2', True)])
        p.advance(300 * S)
        self.assertEqual(self.check(p, [pump('PU2', False)])['code'], 'dwell_active')
        q = self.at('w-no-fault', 60, [pump('PU2', True)])        # start 1 at 60 s
        for at, on in ((660, False), (1260, True), (1860, False)):  # start 2 at 1260 s
            q.advance(at * S)
            q.change(pump('PU2', on), q.revision)
        q.advance(2460 * S)                                         # off long enough, but 2 starts in the last hour
        self.assertEqual(self.check(q, [pump('PU2', True)])['code'], 'cycling_limit')

    def test_reserve_violation_is_rejected(self):
        # Just above the 1.5 m reserve, stopping the pump and closing the residential zone keeps the
        # protected nodes served over the commitment window but ends below the reserve; doing nothing would not.
        p = self.at('w-low-storage', 660)
        self.assertTrue(1.5 < p.ledger_tail()['tanks']['T1']['levelM'] < 2.0)
        verdict = self.check(p, [pump('PU1', False), link('PZ', False)])
        self.assertEqual(verdict['code'], 'reserve_violation')
        self.assertLess(verdict['planEndLevelM'], 1.5)
        q = self.at('w-low-storage', 120)  # stopping the only pump at low storage starves protected nodes first
        self.assertEqual(self.check(q, [pump('PU1', False)])['code'], 'protected_service_violation')

    def test_normal_pump_cycling_is_admissible(self):
        p = self.at('w-no-fault', 1800)  # tank full: switching the duty pump off is routine, not a risk
        self.assertTrue(self.check(p, [pump('PU1', False)])['ok'])


@unittest.skipUnless(HAVE_WNTR, 'wntr is installed only in .work/environments/water')
class Controllers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec, cls.policy, cases = wc.load_development(os.path.join(FIXTURES, 'development.json'))
        cls.case = {c['caseId']: c for c in cases}

    def test_local_threshold_policy_cycles_the_pump_within_its_band(self):
        none = wc.run_episode(self.spec, self.policy, self.case['w-no-fault'], 'none')
        r = wc.run_episode(self.spec, self.policy, self.case['w-no-fault'], 'local')
        self.assertEqual(r['essentialUnmetM3'], 0)
        self.assertGreaterEqual(r['starts'], 1)
        self.assertLess(r['reserve']['minLevelM'], self.policy['local']['pumpOffAboveM'])
        # Worst-case overshoot below the start level: one decision period plus the actuator delay at full draw
        # (18 L/s over the 20 m2 tank).
        overshoot = (self.policy['decisionPeriodUs'] + self.policy['pumps']['PU1']['delayUs']) / 1e6 * 0.018 / 20.0
        self.assertGreaterEqual(r['reserve']['minLevelM'], self.policy['local']['pumpOnBelowM'] - overshoot - 1e-3)
        self.assertLess(r['pumpEnergyJ'], none['pumpEnergyJ'])

    def test_local_starts_the_backup_when_the_main_pump_is_lost(self):
        r = wc.run_episode(self.spec, self.policy, self.case['w-pump-loss'], 'local')
        starts = [a for a in r['actions'] if a['status'] == 'applied' and a['action'] == pump('PU2', True)]
        self.assertTrue(starts)
        self.assertEqual(r['essentialUnmetM3'], 0)

    def test_source_isolation_cannot_be_avoided_by_any_controller(self):
        for name in ('none', 'local', 'predictive'):
            r = wc.run_episode(self.spec, self.policy, self.case['w-source-isolation'], name)
            self.assertGreater(r['essentialUnmetM3'], 0, name)

    def test_metrics_are_per_node_and_flag_protected_violations(self):
        r = wc.run_episode(self.spec, self.policy, self.case['w-source-isolation'], 'none')
        self.assertEqual(sorted(r['byNode']), ['JF', 'JH', 'JR'])
        for key in ('deliveredM3', 'unmetM3', 'lowPressureSeconds', 'score'):
            self.assertIn(key, r['byNode']['JH'])
        self.assertIn('JH', r['protectedViolations'])
        for key in ('pumpEnergyJ', 'switchingCost', 'reserve', 'nonessentialUnmetM3', 'leakM3'):
            self.assertIn(key, r)

    def test_predictive_against_exhaustive_schedule_enumeration_on_the_tiny_network(self):
        # Every 4-slot schedule (pump x branch link, 256 schedules) is simulated on a fork and scored from
        # the plant's own ledger. The receding-horizon predictive baseline, re-deciding each slot, is
        # scored the same way; it cannot beat the optimum, and its gap is reported in the run note.
        with open(os.path.join(FIXTURES, 'networks.json')) as handle:
            analytic = json.load(handle)['networks']['analytic']
        tiny = wc.tiny_policy()
        outage = [{'faultId': 'risk', 'atUs': 1800 * S, 'type': 'pump_outage', 'assetId': 'PU1'}]
        p = WaterPlant(copy.deepcopy(analytic), fixture_dir=FIXTURES)
        p.advance(60 * S)
        model = p.admitted_model()
        best = wc.exhaustive_schedules(tiny, model, outage, slots=4, slot_us=900 * S, fixture_dir=FIXTURES)
        self.assertGreater(best['evaluated'], 16)  # schedules that need the failed pump after 1800 s are infeasible
        self.assertTrue(best['schedule'][0]['PU1'], 'the optimum keeps pumping before the announced outage')
        closed = wc.closed_loop(tiny, model, outage, slots=4, slot_us=900 * S, fixture_dir=FIXTURES)
        self.assertGreaterEqual(closed['objective'], best['objective'] - 1e-6)
        self.assertEqual(closed['schedule'][0], best['schedule'][0])


if __name__ == '__main__':
    unittest.main()
