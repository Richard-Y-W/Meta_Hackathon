"""P06 electrical adapter qualification: physics checks, private service accounting, restart/fork and
preview isolation. Run: python3 -m unittest discover -s runtime/infra/tests -p test_power.py"""
import copy
import io
import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, os.path.dirname(HERE))

import checkpoints  # noqa: E402
import protocol  # noqa: E402
from power_pandapower import PowerPlant, classify_solve, worker_handlers  # noqa: E402
from protocol import Rejected  # noqa: E402

with open(os.path.join(ROOT, 'fixtures/lifeline/infra/power/analytic.json')) as handle:
    ANALYTIC = json.load(handle)['networks']
FEEDER, TWO_BUS = ANALYTIC['feeder'], ANALYTIC['two-bus']
S = 1000000


def plant(network=FEEDER, faults=()):
    return PowerPlant(copy.deepcopy(network), faults=list(faults))


def reading(observation, sensor_id):
    return next(r for r in observation['readings'] if r['sensorId'] == sensor_id)


OPEN_FEEDER = {'actions': [{'type': 'set_switch', 'params': {'switchId': 'sw-main', 'closed': False}}], 'horizonUs': 60 * S}


class KnownFlow(unittest.TestCase):
    def test_two_bus_matches_closed_form_receiving_voltage_and_losses(self):
        p = plant(TWO_BUS)
        p.advance(S)
        line = TWO_BUS['lines'][0]
        r, x = line['rOhmPerKm'] * line['lengthKm'], line['xOhmPerKm'] * line['lengthKm']
        load = TWO_BUS['loads'][0]
        v1 = 12470.0
        b = v1 ** 2 - 2 * (load['pW'] * r + load['qVar'] * x)
        v2 = math.sqrt((b + math.sqrt(b * b - 4 * (load['pW'] ** 2 + load['qVar'] ** 2) * (r * r + x * x))) / 2)
        self.assertAlmostEqual(reading(p.observe(), 'v-far')['value'] / v2, 1.0, delta=1e-6)
        losses = (load['pW'] ** 2 + load['qVar'] ** 2) / v2 ** 2 * r
        self.assertAlmostEqual(p.solution['lineLossW']['L'], losses, delta=losses * 1e-6)

    def test_ac_balance_sources_equal_loads_plus_losses_minus_storage(self):
        p = plant()
        p.change({'type': 'set_storage_power', 'params': {'storageId': 'bess-clinic', 'dischargeW': 50000}}, p.revision)
        p.advance(S)
        sol = p.solution
        supplied = sum(sol['sourcesW'].values()) + sum(sol['generatorsW'].values()) + sum(sol['storageW'].values())
        consumed = sum(sol['loadsW'].values()) + sum(sol['lineLossW'].values())
        self.assertAlmostEqual(supplied, consumed, delta=1.0)
        self.assertAlmostEqual(sol['storageW']['bess-clinic'], 50000, delta=1e-6)
        self.assertAlmostEqual(sol['generatorsW']['diesel-clinic'], 100000, delta=1.0)

    def test_voltage_and_thermal_limits_become_constraint_events(self):
        p = plant(faults=[{'faultId': 'surge', 'atUs': 0, 'type': 'load_change', 'assetId': 'housing', 'scale': 2.5}])
        p.advance(S)
        kinds = {(e['type'], e['assetId']) for e in p.solution['constraintEvents']}
        self.assertIn(('thermal_limit', 'L3'), kinds)
        self.assertFalse(any(t == 'voltage_limit' for t, _ in kinds))
        weak = plant(TWO_BUS, faults=[{'faultId': 'surge', 'atUs': 0, 'type': 'load_change', 'assetId': 'far-load', 'scale': 3}])
        weak.advance(S)
        self.assertEqual(weak.solve_status['status'], 'converged')
        self.assertIn(('voltage_limit', 'far'), {(e['type'], e['assetId']) for e in weak.solution['constraintEvents']})


class Service(unittest.TestCase):
    def test_disconnected_critical_load_creates_unserved_demand(self):
        p = plant(faults=[{'faultId': 'trip', 'atUs': 10 * S, 'type': 'line_trip', 'assetId': 'L2'}])
        p.advance(60 * S)
        summary = p.service_summary()
        self.assertEqual(summary['status'], 'scored')
        self.assertAlmostEqual(summary['byLoad']['hospital']['deficitJ'], 400000 * 50, delta=1.0)
        self.assertAlmostEqual(summary['essentialUnservedJ'], 400000 * 50, delta=1.0)
        self.assertEqual(reading(p.observe(), 'p-hospital')['value'], 0)
        self.assertEqual(reading(p.observe(), 'v-hosp')['value'], 0)

    def test_islanded_load_is_unsupplied_until_tie_restores_it(self):
        p = plant()
        p.advance(10 * S)
        p.change({'type': 'set_switch', 'params': {'switchId': 'sw-main', 'closed': False}}, p.revision)
        p.advance(20 * S)
        self.assertEqual(p.solution['loadsW']['hospital'], 0)
        p.change({'type': 'set_switch', 'params': {'switchId': 'sw-tie', 'closed': True}}, p.revision)
        p.advance(30 * S)
        self.assertAlmostEqual(p.solution['loadsW']['hospital'], 400000, delta=1e-3)
        self.assertAlmostEqual(p.service_summary()['byLoad']['hospital']['deficitJ'], 400000 * 10, delta=1.0)

    def test_unavailable_generation_leaves_island_load_unsupplied(self):
        p = plant(faults=[{'faultId': 'diesel', 'atUs': 5 * S, 'type': 'generator_unavailable', 'assetId': 'diesel-clinic'}])
        p.advance(15 * S)
        self.assertEqual(p.solution['loadsW']['clinic-load'], 0)
        self.assertAlmostEqual(p.service_summary()['byLoad']['clinic-load']['deficitJ'], 150000 * 10, delta=1.0)
        self.assertEqual(p.solution['storageW']['bess-clinic'], 0)

    def test_losing_every_source_de_energizes_the_network_without_a_solver_failure(self):
        p = plant(faults=[{'faultId': 'a', 'atUs': 5 * S, 'type': 'source_loss', 'assetId': 'grid-a'},
                          {'faultId': 'b', 'atUs': 5 * S, 'type': 'source_loss', 'assetId': 'grid-b'},
                          {'faultId': 'd', 'atUs': 5 * S, 'type': 'generator_unavailable', 'assetId': 'diesel-clinic'}])
        p.advance(15 * S)
        self.assertEqual(p.solve_status['status'], 'converged')
        self.assertTrue(p.solve_status['diagnostics']['noReferenceSource'])
        self.assertEqual(set(p.solution['loadsW'].values()), {0.0})
        self.assertAlmostEqual(p.service_summary()['essentialUnservedJ'], (400000 + 150000) * 10, delta=1.0)

    def test_frozen_sensor_reports_its_old_value_and_time(self):
        p = plant(faults=[{'faultId': 'f', 'atUs': 5 * S, 'type': 'sensor_freeze', 'assetId': 'p-hospital'},
                          {'faultId': 't', 'atUs': 10 * S, 'type': 'line_trip', 'assetId': 'L2'}])
        p.advance(20 * S)
        frozen = reading(p.observe(), 'p-hospital')
        self.assertEqual((frozen['value'], frozen['observedAtUs']), (400000.0, 5 * S))
        self.assertEqual(reading(p.observe(), 'v-hosp')['value'], 0)
        self.assertEqual(p.service_summary()['byLoad']['hospital']['deficitJ'], 400000 * 10)
        self.assertEqual(checkpoints.unseal(p.admitted_model())['sensorFaults'], {})

    def test_shed_load_keeps_its_demand(self):
        p = plant()
        p.change({'type': 'set_load_connected', 'params': {'loadId': 'housing', 'connected': False}}, p.revision)
        p.advance(10 * S)
        housing = p.service_summary()['byLoad']['housing']
        self.assertAlmostEqual(housing['demandJ'], 600000 * 10, delta=1.0)
        self.assertAlmostEqual(housing['deficitJ'], 600000 * 10, delta=1.0)

    def test_nonconverged_solve_cannot_report_full_service(self):
        p = plant(TWO_BUS, faults=[{'faultId': 'surge', 'atUs': 5 * S, 'type': 'load_change', 'assetId': 'far-load', 'scale': 6}])
        p.advance(10 * S)
        self.assertEqual(p.solve_status['status'], 'no_feasible_operating_point')
        summary = p.service_summary()
        self.assertEqual(summary['status'], 'capture_incomplete')
        self.assertIsNone(summary['essentialUnservedJ'])
        self.assertIsNone(summary['byLoad']['far-load']['score'])
        far = reading(p.observe(), 'v-far')
        self.assertIsNone(far['value'])
        self.assertEqual(far['missingReason'], 'solution_unavailable')


class Storage(unittest.TestCase):
    def test_storage_energy_is_conserved_and_stops_at_empty(self):
        network = copy.deepcopy(FEEDER)
        network['storage'][0]['energyJ'] = 1000000  # 10 s at 100 kW
        p = plant(network)
        p.change({'type': 'set_storage_power', 'params': {'storageId': 'bess-clinic', 'dischargeW': 100000}}, p.revision)
        p.advance(25 * S)
        record = p.service_record()
        delivered = sum(s['storage']['bess-clinic']['dischargeW'] * (e['atUs'] - s['atUs']) / 1e6
                        for s, e in zip(record['samples'], record['samples'][1:] + [{'atUs': p.now_us}]))
        self.assertAlmostEqual(delivered, 1000000, delta=FEEDER['tolerances']['energyJ'])
        self.assertEqual(p.state['storage']['bess-clinic']['energyJ'], 0)
        self.assertEqual(p.solution['storageW']['bess-clinic'], 0)


class Commands(unittest.TestCase):
    def test_stale_command_cannot_switch_a_changed_topology(self):
        p = plant(faults=[{'faultId': 'trip', 'atUs': 2 * S, 'type': 'line_trip', 'assetId': 'L2'}])
        p.advance(S)
        seen = p.observe()['configurationRevision']
        p.advance(3 * S)
        with self.assertRaises(Rejected) as caught:
            p.change({'type': 'set_switch', 'params': {'switchId': 'sw-tie', 'closed': True}}, seen)
        self.assertEqual(caught.exception.code, 'stale_command')
        self.assertFalse(p.state['switches']['sw-tie'])

    def test_unknown_actuator_and_out_of_envelope_commands_are_rejected(self):
        p = plant()
        for action, code in [({'type': 'set_switch', 'params': {'switchId': 'nope', 'closed': True}}, 'unknown_actuator'),
                             ({'type': 'set_storage_power', 'params': {'storageId': 'bess-clinic', 'dischargeW': 1e6}}, 'limit_exceeded'),
                             ({'type': 'open_valve', 'params': {}}, 'unknown_action')]:
            with self.assertRaises(Rejected) as caught:
                p.change(action, p.revision)
            self.assertEqual(caught.exception.code, code)

    def test_fault_outside_the_model_envelope_is_refused(self):
        with self.assertRaises(Rejected) as caught:
            plant(faults=[{'faultId': 'x', 'atUs': 0, 'type': 'load_change', 'assetId': 'housing', 'scale': 20}])
        self.assertEqual(caught.exception.code, 'outside_model_envelope')

    def test_clock_cannot_run_backwards(self):
        p = plant()
        p.advance(5 * S)
        with self.assertRaises(Rejected) as caught:
            p.advance(4 * S)
        self.assertEqual(caught.exception.code, 'clock_regression')


class SolveClassification(unittest.TestCase):
    def test_numerical_failure_is_distinguished_from_infeasibility(self):
        self.assertEqual(classify_solve(lambda lam: True)[0], 'converged')
        status, diagnostics = classify_solve(lambda lam: lam <= 0.6)
        self.assertEqual(status, 'no_feasible_operating_point')
        lo, hi = diagnostics['loadabilityBracket']
        self.assertTrue(lo <= 0.6 < hi and hi - lo < 0.01)
        self.assertEqual(classify_solve(lambda lam: False)[0], 'solver_failure')


class RestartAndFork(unittest.TestCase):
    FAULTS = [{'faultId': 'trip', 'atUs': 20 * S, 'type': 'line_trip', 'assetId': 'L2'},
              {'faultId': 'diesel', 'atUs': 50 * S, 'type': 'generator_unavailable', 'assetId': 'diesel-clinic'}]

    def rollout(self, p, mid=None):
        p.change({'type': 'set_storage_power', 'params': {'storageId': 'bess-clinic', 'dischargeW': 60000}}, p.revision)
        p.advance(30 * S)
        p.change({'type': 'set_switch', 'params': {'switchId': 'sw-tie', 'closed': True}}, p.revision)
        if mid:
            p = mid(p)
        p.advance(80 * S)
        return p

    def test_restored_and_forked_rollouts_match_uninterrupted_reference(self):
        reference = self.rollout(plant(faults=self.FAULTS))
        saved = {}

        def interrupt(p):
            saved['cp'] = p.checkpoint()
            p.advance(45 * S)  # diverge, then restore
            p.change({'type': 'set_load_connected', 'params': {'loadId': 'housing', 'connected': False}}, p.revision)
            p.restore(saved['cp'])
            return p
        restored = self.rollout(plant(faults=self.FAULTS), interrupt)
        forked = PowerPlant.from_checkpoint(saved['cp'])
        forked.advance(80 * S)
        tol = FEEDER['tolerances']
        for other in (restored, forked):
            self.assertEqual(other.revision, reference.revision)
            a, b = reference.service_record()['samples'], other.service_record()['samples']
            self.assertEqual([s['atUs'] for s in a], [s['atUs'] for s in b])
            for x, y in zip(a, b):
                for load, value in x['loads'].items():
                    self.assertAlmostEqual(value, y['loads'][load], delta=tol['powerW'])
            self.assertAlmostEqual(reference.state['storage']['bess-clinic']['energyJ'], other.state['storage']['bess-clinic']['energyJ'], delta=tol['energyJ'])
            self.assertAlmostEqual(reference.service_summary()['essentialUnservedJ'], other.service_summary()['essentialUnservedJ'], delta=tol['energyJ'])

    def test_restore_reproduces_the_checkpoint_hash_and_refuses_edits(self):
        p = plant(faults=self.FAULTS)
        p.advance(25 * S)
        cp = p.checkpoint()
        q = PowerPlant.from_checkpoint(cp)
        self.assertEqual(q.checkpoint_hash(), cp['hash'])
        edited = copy.deepcopy(cp)
        edited['state']['faults'] = []
        with self.assertRaises(checkpoints.CheckpointError) as caught:
            PowerPlant.from_checkpoint(edited)
        self.assertEqual(caught.exception.code, 'checkpoint_corrupt')


class Preview(unittest.TestCase):
    def test_preview_does_not_mutate_live_plant(self):
        plant_ = plant(faults=[{'faultId': 'trip', 'atUs': 30 * S, 'type': 'line_trip', 'assetId': 'L1'}])
        plant_.advance(5 * S)
        admitted_model = plant_.admitted_model()
        before = plant_.checkpoint()
        preview = plant_.preview(OPEN_FEEDER, admitted_model)
        self.assertEqual(plant_.checkpoint_hash(), before['hash'])
        self.assertGreater(preview['essential_unserved_j'], 0)
        self.assertEqual(preview['kind'], 'preview')
        self.assertNotIn('receipt', preview)

    def test_preview_cannot_read_future_faults(self):
        plant_ = plant(faults=[{'faultId': 'trip', 'atUs': 30 * S, 'type': 'line_trip', 'assetId': 'L1'}])
        plant_.advance(5 * S)
        model = plant_.admitted_model()
        self.assertEqual(checkpoints.unseal(model)['faults'], [])
        nothing = plant_.preview({'actions': [], 'horizonUs': 60 * S}, model)
        self.assertEqual(nothing['essential_unserved_j'], 0)
        truth = PowerPlant.from_checkpoint(plant_.checkpoint())
        truth.advance(65 * S)
        self.assertGreater(truth.service_summary()['essentialUnservedJ'], 0)
        with self.assertRaises(Rejected) as caught:
            plant_.preview({'actions': [], 'horizonUs': S}, plant_.checkpoint())
        self.assertEqual(caught.exception.code, 'model_not_admitted')


class Observation(unittest.TestCase):
    def test_observe_exposes_only_declared_sensors_in_canonical_units(self):
        p = plant(faults=[{'faultId': 'trip', 'atUs': 30 * S, 'type': 'line_trip', 'assetId': 'L1'}])
        p.advance(S)
        obs = p.observe()
        self.assertEqual(sorted(r['sensorId'] for r in obs['readings']), sorted(s['id'] for s in FEEDER['sensors']))
        units = {'power.voltage': 'V', 'power.active': 'W', 'power.loading': '1', 'power.switch_state': 'state', 'energy.stored': 'J'}
        for r in obs['readings']:
            self.assertEqual(r['unit'], units[r['metric']])
        self.assertNotIn('fault', json.dumps(obs))
        self.assertAlmostEqual(reading(obs, 'e-bess')['value'], 90000000)
        self.assertGreater(reading(obs, 'v-hosp')['value'], 0.95 * 12470)


class ReferenceNetwork(unittest.TestCase):
    with open(os.path.join(ROOT, 'fixtures/lifeline/infra/power/reference.json')) as handle:
        SPEC = json.load(handle)

    def test_reference_network_builds_from_recorded_provenance(self):
        p = plant(self.SPEC)
        p.advance(5 * S)
        self.assertEqual(p.solve_status['status'], 'converged')
        for load in self.SPEC['essentialLoads']:
            self.assertGreater(p.solution['loadsW'][load], 0)
        self.assertEqual(sorted(p.state['switches']), ['sw-S1', 'sw-S2', 'sw-S3'])
        self.assertFalse(any(p.state['switches'].values()))

    def test_fixture_scenario_never_reaches_the_admitted_model(self):
        p = plant(self.SPEC, faults=self.SPEC['scenario']['faults'])
        model = json.dumps(p.admitted_model())
        self.assertNotIn('trip-2-3', model)
        self.assertNotIn('conventionalRestoration', model)

    def test_builder_drift_is_refused(self):
        spec = copy.deepcopy(self.SPEC)
        spec['provenance']['builtNetworkSha256'] = '0' * 64
        with self.assertRaises(Rejected) as caught:
            plant(spec)
        self.assertEqual(caught.exception.code, 'reference_network_drift')

    def test_tie_closure_restores_the_tripped_feeder_section(self):
        p = plant(self.SPEC, faults=self.SPEC['scenario']['faults'])
        p.advance(70 * S)
        self.assertEqual(p.solution['loadsW']['load-ci9'], 0)
        p.change({'type': 'set_switch', 'params': {'switchId': 'sw-S1', 'closed': True}}, p.revision)
        p.advance(75 * S)
        self.assertGreater(p.solution['loadsW']['load-ci9'], 0)
        self.assertEqual(p.solve_status['status'], 'converged')


class Worker(unittest.TestCase):
    def call(self, handlers, cmd, args=None, rid=[0]):
        rid[0] += 1
        return protocol.handle(handlers, json.dumps({'v': 1, 'id': rid[0], 'cmd': cmd, 'args': args or {}}), rid[0])

    def test_worker_keeps_checkpoints_private_and_reports_rejections(self):
        h = worker_handlers()
        self.assertTrue(self.call(h, 'initialize', {'runId': 'run-1', 'network': FEEDER, 'faults': [{'faultId': 't', 'atUs': 9 * S, 'type': 'line_trip', 'assetId': 'L2'}]})['ok'])
        cp = self.call(h, 'checkpoint')['result']
        self.assertEqual(sorted(cp), ['atUs', 'checkpointId', 'hash'])
        stale = self.call(h, 'execute', {'action': {'actionId': 'a1', 'type': 'set_switch', 'params': {'switchId': 'sw-tie', 'closed': True}, 'baseRevision': 0}})
        self.assertTrue(stale['ok'])
        self.assertEqual(stale['result']['status'], 'success')
        again = self.call(h, 'execute', {'action': {'actionId': 'a2', 'type': 'set_switch', 'params': {'switchId': 'sw-tie', 'closed': False}, 'baseRevision': 0}})
        self.assertEqual(again['result']['status'], 'rejected')
        self.assertEqual(again['result']['reason'], 'stale_command')
        self.assertEqual(self.call(h, 'restore', {'checkpointId': 'missing'})['error']['code'], 'unknown_checkpoint')
        self.assertEqual(self.call(h, 'bogus')['error']['code'], 'unknown_command')

    def test_serve_round_trip(self):
        h = worker_handlers()
        lines = [json.dumps({'v': 1, 'id': 1, 'cmd': 'hello', 'args': {}}), json.dumps({'v': 1, 'id': 2, 'cmd': 'shutdown', 'args': {}}), '']
        out = io.StringIO()
        protocol.serve(h, io.StringIO('\n'.join(lines)), out)
        replies = [json.loads(x) for x in out.getvalue().splitlines()]
        self.assertEqual([r['workerSeq'] for r in replies], [1, 2])
        self.assertEqual(replies[0]['result']['domainId'], 'power')


if __name__ == '__main__':
    unittest.main()
