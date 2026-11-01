"""P08 water distribution plant (EPANET 2.2 via WNTR, pressure-driven demand). Runs in the water environment:
.work/environments/water/bin/python -m unittest discover -s runtime/infra/tests -p test_water.py"""
import copy
import io
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
    import checkpoints
    import protocol
    from protocol import Rejected
    from water_wntr import WaterPlant, worker_handlers

FIXTURES = os.path.join(ROOT, 'fixtures/lifeline/infra/water')
with open(os.path.join(FIXTURES, 'networks.json')) as handle:
    NETWORKS = json.load(handle)['networks']
ANALYTIC, REFERENCE = NETWORKS['analytic'], NETWORKS['reference']
S = 1000000
STEP_S = ANALYTIC['hydraulicStepS']


def plant(spec=ANALYTIC, faults=()):
    return WaterPlant(copy.deepcopy(spec), faults=list(faults), fixture_dir=FIXTURES)


def fault(fid, at_s, kind, asset, **extra):
    return dict({'faultId': fid, 'atUs': at_s * S, 'type': kind, 'assetId': asset}, **extra)


def reading(obs, sensor_id):
    return next(r for r in obs['readings'] if r['sensorId'] == sensor_id)


PUMP_OUT = fault('pump-out', 0, 'pump_outage', 'PU1')


@unittest.skipUnless(HAVE_WNTR, 'wntr is installed only in .work/environments/water')
class Accounting(unittest.TestCase):
    def test_analytic_tank_depletion(self):
        # Analytic control: 12 m3 usable storage, 0.01 m3/s net draw.
        p = plant(faults=[PUMP_OUT])
        p.advance(3600 * S)
        result = p.depletion_result('T1')
        step_s = STEP_S
        self.assertAlmostEqual(result["depletion_time_s"], 1200, delta=step_s)
        self.assertGreater(result["unmet_m3_after_depletion"], 0)
        self.assertFalse(result["quality_model_qualified"])
        self.assertAlmostEqual(result['delivered_m3_before_depletion'], 12.0, delta=0.6)

    def test_pump_outage_changes_storage_and_then_delivery(self):
        on, off = plant(), plant(faults=[fault('out', 300, 'pump_outage', 'PU1')])
        on.advance(900 * S)
        off.advance(900 * S)
        self.assertLess(reading(off.observe(), 'lv-T1')['value'], reading(on.observe(), 'lv-T1')['value'] - 0.5)
        self.assertEqual(reading(off.observe(), 'fl-PU1')['value'], 0)
        off.advance(3600 * S)
        self.assertGreater(off.service_summary()['byNode']['JD']['deficitM3'], 0)

    def test_isolated_demand_node_receives_nothing_by_convention(self):
        p = plant()
        p.advance(600 * S)
        jx = p.service_summary()['byNode']['JX']
        self.assertEqual(jx['deliveredM3'], 0)
        self.assertAlmostEqual(jx['deficitM3'], 0.005 * 600, delta=1e-9)
        self.assertTrue(p.ledger_tail()['nodes']['JX']['isolated'])
        p.change({'type': 'set_link', 'params': {'linkId': 'P3', 'open': True}}, p.revision)
        p.advance(1200 * S)
        self.assertGreater(p.service_summary()['byNode']['JX']['deliveredM3'], 0.005 * 600 * 0.99)

    def test_tank_mass_balance(self):
        def balance(p, until_s):
            p.advance(until_s * S)
            samples = p.service_record()['samples']
            net = sum((s['links']['PU1']['flowM3s'] - s['links']['P2']['flowM3s']) * (e['atUs'] - s['atUs']) / 1e6 for s, e in zip(samples, samples[1:]))
            dv = (samples[-1]['tanks']['T1']['levelM'] - samples[0]['tanks']['T1']['levelM']) * p.tank_area('T1')
            fills = sum(1 for s in samples if abs(s['tanks']['T1']['levelM'] - 4.0) < 1e-6)
            return dv, net, fills
        dv, net, fills = balance(plant(faults=[PUMP_OUT]), 900)  # draining only: exact
        self.assertEqual(fills, 0)
        self.assertAlmostEqual(dv, net, delta=ANALYTIC['tolerances']['volumeM3'])
        dv, net, fills = balance(plant(), 900)  # filling: EPANET clips the tank at full on whole seconds
        self.assertGreater(fills, 0)
        self.assertLessEqual(abs(dv - net), fills * 0.0246 * 1.0)  # at most one second of net inflow per fill event

    def test_closed_link_cuts_supply(self):
        p = plant(faults=[fault('break', 120, 'pipe_break', 'P2')])
        p.advance(600 * S)
        self.assertAlmostEqual(p.service_summary()['byNode']['JD']['deficitM3'], 0.01 * 480, delta=1e-6)
        self.assertTrue(p.ledger_tail()['nodes']['JD']['isolated'])

    def test_leak_is_not_delivered_service_and_drains_storage_sooner(self):
        p = plant(faults=[PUMP_OUT, fault('leak', 0, 'leak', 'JD', emitterM3sPerSqrtM=0.001)])
        p.advance(3600 * S)
        summary = p.service_summary()
        self.assertGreater(summary['leakM3'], 0)
        self.assertLessEqual(summary['byNode']['JD']['deliveredM3'], 0.01 * 3600)
        before = [x['nodes']['JD'] for x in p.service_record()['samples'] if not x['nodes']['JD']['isolated']]
        for n in before:  # pressure is adequate until the tank empties: consumers get exactly their demand, the leak is separate
            self.assertAlmostEqual(n['deliveredM3s'], n['requiredM3s'], delta=1e-6)
            self.assertGreater(n['leakM3s'], 0)
        self.assertLess(p.depletion_result('T1')['depletion_time_s'], 1200 - STEP_S)

    def test_low_pressure_reduces_delivery_and_is_timed(self):
        p = plant(faults=[fault('surge', 0, 'demand_change', 'JD', scale=3.0)])
        p.advance(300 * S)
        jd = p.service_summary()['byNode']['JD']
        self.assertLess(jd['score'], 1.0)
        self.assertGreater(jd['lowPressureSeconds'], 0)
        self.assertLess(reading(p.observe(), 'pr-JD')['value'], 15.0 * 9806.65)

    def test_isolated_service_counts_as_low_pressure(self):
        # Net3 after losing pump 335: emptied tanks still hold static head over lower junctions, so EPANET
        # reports pressures above the service threshold at nodes cut off from every source. Their time
        # without service must count as low-pressure time.
        p = plant(REFERENCE, faults=[fault('out', 3600, 'pump_outage', '335')])
        p.advance(24 * 3600 * S)
        samples = p.service_record()['samples']
        ends = [x['atUs'] for x in samples[1:]] + [p.now_us]
        for node in REFERENCE['essentialNodes']:
            isolated = sum((e - x['atUs']) / 1e6 for x, e in zip(samples, ends) if x['nodes'][node]['isolated'])
            self.assertGreater(isolated, 0)
            self.assertGreaterEqual(p.service_summary()['byNode'][node]['lowPressureSeconds'], isolated)

    def test_zero_demand_has_no_score(self):
        p = plant(faults=[fault('zero', 0, 'demand_change', 'JD', scale=0.0)])
        p.advance(300 * S)
        jd = p.service_summary()['byNode']['JD']
        self.assertEqual((jd['requiredM3'], jd['score'], jd['status']), (0, None, 'scored'))

    def test_quality_model_is_not_qualified(self):
        self.assertFalse(plant().describe()['qualityModelQualified'])


@unittest.skipUnless(HAVE_WNTR, 'wntr is installed only in .work/environments/water')
class Commands(unittest.TestCase):
    def test_stale_and_unavailable_commands_are_rejected(self):
        p = plant(faults=[fault('trip', 120, 'pump_outage', 'PU1')])
        p.advance(60 * S)
        seen = p.revision
        p.advance(180 * S)
        with self.assertRaises(Rejected) as caught:
            p.change({'type': 'set_pump', 'params': {'pumpId': 'PU1', 'on': True}}, seen)
        self.assertEqual(caught.exception.code, 'stale_command')
        with self.assertRaises(Rejected) as caught:
            p.change({'type': 'set_pump', 'params': {'pumpId': 'PU1', 'on': True}}, p.revision)
        self.assertEqual(caught.exception.code, 'actuator_unavailable')

    def test_off_grid_time_and_clock_regression_are_refused(self):
        p = plant()
        with self.assertRaises(Rejected) as caught:
            p.advance(90 * S)
        self.assertEqual(caught.exception.code, 'off_grid_time')
        p.advance(120 * S)
        with self.assertRaises(Rejected) as caught:
            p.advance(60 * S)
        self.assertEqual(caught.exception.code, 'clock_regression')

    def test_out_of_envelope_fault_is_refused(self):
        with self.assertRaises(Rejected) as caught:
            plant(faults=[fault('x', 0, 'demand_change', 'JD', scale=9.0)])
        self.assertEqual(caught.exception.code, 'outside_model_envelope')


@unittest.skipUnless(HAVE_WNTR, 'wntr is installed only in .work/environments/water')
class RestartAndPreview(unittest.TestCase):
    FAULTS = [fault('out', 600, 'pump_outage', 'PU1'), fault('leak', 900, 'leak', 'JD', emitterM3sPerSqrtM=0.0005)]

    def test_replay_restart_and_fork_reproduce_uninterrupted_run(self):
        reference = plant(faults=self.FAULTS)
        reference.advance(480 * S)
        reference.change({'type': 'set_link', 'params': {'linkId': 'P3', 'open': True}}, reference.revision)
        reference.advance(2400 * S)
        p = plant(faults=self.FAULTS)
        p.advance(480 * S)
        p.change({'type': 'set_link', 'params': {'linkId': 'P3', 'open': True}}, p.revision)
        p.advance(720 * S)
        cp = p.checkpoint()
        p.advance(1500 * S)
        p.change({'type': 'set_link', 'params': {'linkId': 'P3', 'open': False}}, p.revision)
        p.restore(cp)
        self.assertEqual(p.checkpoint_hash(), cp['hash'])
        p.advance(2400 * S)
        fork = WaterPlant.from_checkpoint(cp, fixture_dir=FIXTURES)
        fork.advance(2400 * S)
        for other in (p, fork):
            self.assertEqual(other.service_record()['samples'], reference.service_record()['samples'])
        self.assertGreater(p.replay_seconds, 0)

    def test_preview_does_not_mutate_or_see_future_faults(self):
        p = plant(faults=[fault('out', 600, 'pump_outage', 'PU1')])
        p.advance(300 * S)
        before = p.checkpoint()
        model = p.admitted_model()
        self.assertEqual(checkpoints.unseal(model)['faults'], [])
        idle = p.preview({'actions': [], 'horizonUs': 3000 * S}, model)
        stop = p.preview({'actions': [{'type': 'set_pump', 'params': {'pumpId': 'PU1', 'on': False}}], 'horizonUs': 3000 * S}, model)
        self.assertEqual(p.checkpoint_hash(), before['hash'])
        self.assertEqual(idle['essential_unmet_m3'], 0)
        self.assertGreater(stop['essential_unmet_m3'], 0)
        self.assertEqual(idle['kind'], 'preview')
        with self.assertRaises(Rejected) as caught:
            p.preview({'actions': [], 'horizonUs': 60 * S}, p.checkpoint())
        self.assertEqual(caught.exception.code, 'model_not_admitted')

    def test_step_size_sensitivity_of_depletion_time(self):
        coarse = plant(faults=[PUMP_OUT])
        fine_spec = copy.deepcopy(ANALYTIC)
        fine_spec['hydraulicStepS'] = 10
        fine = plant(fine_spec, faults=[PUMP_OUT])
        coarse.advance(1800 * S)
        fine.advance(1800 * S)
        a, b = coarse.depletion_result('T1')['depletion_time_s'], fine.depletion_result('T1')['depletion_time_s']
        self.assertLessEqual(abs(a - b), STEP_S)


@unittest.skipUnless(HAVE_WNTR, 'wntr is installed only in .work/environments/water')
class ObservationAndReference(unittest.TestCase):
    def test_observation_is_declared_sensors_in_canonical_units(self):
        p = plant(faults=[fault('out', 600, 'pump_outage', 'PU1')])
        p.advance(60 * S)
        obs = p.observe()
        self.assertEqual(sorted(r['sensorId'] for r in obs['readings']), sorted(s['id'] for s in ANALYTIC['sensors']))
        units = {'water.pressure': 'Pa', 'water.level': 'm', 'water.flow': 'm3/s', 'link.state': 'state'}
        for r in obs['readings']:
            self.assertEqual(r['unit'], units[r['metric']])
        self.assertNotIn('pump-out', json.dumps(obs))
        self.assertEqual(reading(obs, 'lv-T1')['value'], p.ledger_tail()['tanks']['T1']['levelM'])
        self.assertTrue(3.5 < reading(obs, 'lv-T1')['value'] <= 4.0)  # the pump is filling until 600 s

    def test_frozen_sensor_keeps_old_value_and_time(self):
        p = plant(faults=[fault('fz', 120, 'sensor_freeze', 'lv-T1'), fault('out', 120, 'pump_outage', 'PU1')])
        p.advance(900 * S)
        frozen = reading(p.observe(), 'lv-T1')
        self.assertEqual(frozen['observedAtUs'], 120 * S)
        self.assertGreater(frozen['value'], p.ledger_tail()['tanks']['T1']['levelM'] + 0.5)

    def test_reference_network_matches_provenance_and_runs(self):
        with open(os.path.join(FIXTURES, 'provenance.json')) as handle:
            provenance = json.load(handle)
        import hashlib
        with open(os.path.join(FIXTURES, REFERENCE['inp']), 'rb') as handle:
            self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), provenance['reference.inp']['sha256'])
        base = plant(REFERENCE)
        outage = plant(REFERENCE, faults=[fault('out', 3600, 'pump_outage', '335')])
        base.advance(6 * 3600 * S)
        outage.advance(6 * 3600 * S)
        self.assertEqual(base.service_summary()['status'], 'scored')
        level = lambda q: sum(q.ledger_tail()['tanks'][t]['levelM'] for t in ('1', '2', '3'))
        self.assertLess(level(outage), level(base))
        with self.assertRaises(Rejected):
            plant(dict(REFERENCE, actuators={'pumps': ['nope'], 'links': []}))

    def test_worker_round_trip(self):
        h = worker_handlers()
        call = lambda cmd, args, n: protocol.handle(h, json.dumps({'v': 1, 'id': n, 'cmd': cmd, 'args': args}), n)
        self.assertTrue(call('initialize', {'runId': 'w1', 'network': ANALYTIC, 'faults': [PUMP_OUT]}, 1)['ok'])
        self.assertTrue(call('advance', {'toUs': 600 * S}, 2)['ok'])
        cp = call('checkpoint', {}, 3)['result']
        self.assertEqual(sorted(cp), ['atUs', 'checkpointId', 'hash'])
        self.assertEqual(call('restore', {'checkpointId': 'nope'}, 4)['error']['code'], 'unknown_checkpoint')
        out = io.StringIO()
        protocol.serve(h, io.StringIO(json.dumps({'v': 1, 'id': 9, 'cmd': 'hello', 'args': {}}) + '\n'), out)
        self.assertEqual(json.loads(out.getvalue())['result']['domainId'], 'water')


if __name__ == '__main__':
    unittest.main()
