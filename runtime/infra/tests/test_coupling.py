"""P11 coupled town: declared edges, conservation, comms reserves, telemetry vs physical state, ablations,
restart and sensitivity. Runs in the town environment (pandapower + WNTR):
.work/environments/town/bin/python -m unittest discover -s runtime/infra/tests -p test_coupling.py"""
import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import pandapower  # noqa: F401
    import wntr  # noqa: F401
    HAVE = True
except ImportError:
    HAVE = False

if HAVE:
    from coupling import Town, apply_layout, load_town

S = 1000000
TRIP = {'domain': 'power', 'faultId': 'trip-3-8', 'atUs': 1800 * S, 'type': 'line_trip', 'assetId': 'line-3-8'}
PU2_OUT = {'domain': 'water', 'faultId': 'pu2-maint', 'atUs': 0, 'type': 'actuator_unavailable', 'assetId': 'PU2'}


@unittest.skipUnless(HAVE, 'needs the town environment (.work/environments/town)')
class Coupling(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = load_town()

    def town(self, faults=(), **kw):
        return Town(copy.deepcopy(self.bundle), faults=list(faults), **kw)

    def first(self, town, kind, asset=None):
        return next((e for e in town.state['events'] if e['type'] == kind and (asset is None or e.get('assetId') == asset)), None)

    def test_pump_electrical_load_follows_the_declared_equation(self):
        t = self.town()
        t.advance(600 * S)
        edge = t.edges['pump-to-load-PU1']
        sample = t.water.ledger_tail()['pumps']['PU1']
        rho, g, eta = edge['rhoKgM3'], edge['gMs2'], edge['efficiency']
        pump_w = t.power.state['coupledLoads']['load-pump-1']['pW']
        self.assertAlmostEqual(pump_w, rho * g * sample['flowM3s'] * sample['headGainM'] / eta, delta=1e-6)
        self.assertAlmostEqual(t.power.solution['loadsW']['load-pump-1'], pump_w, delta=1e-3)  # the electrical plant actually carries it
        self.assertAlmostEqual(pump_w, sample['powerW'], delta=0.01 * pump_w)  # EPANET's own energy figure (75%) agrees

    def test_tank_volume_balance_over_a_coupling_step(self):
        t = self.town()
        t.advance(300 * S)
        before, area = t.water.ledger_tail(), t.water.tank_area('T1')
        net = before['links']['PU1']['flowM3s'] + before['links']['PU2']['flowM3s'] - before['links']['PM']['flowM3s']
        t.advance(360 * S)
        next_volume_m3 = t.water.ledger_tail()['tanks']['T1']['levelM'] * area
        self.assertAlmostEqual(next_volume_m3, before['tanks']['T1']['levelM'] * area + net * 60, delta=0.05)

    def test_a_pump_cannot_deliver_without_electrical_supply(self):
        t = self.town([TRIP, PU2_OUT])
        t.advance(2400 * S)
        # Commanded on (over the battery-backed router) while its bus is dead: it still cannot run.
        self.assertEqual(t.command('water', {'type': 'set_pump', 'params': {'pumpId': 'PU1', 'on': True}}, t.water.revision)['status'], 'delivered')
        t.advance(2460 * S)  # the next coupling step, before the station's next local decision at 2700 s
        self.assertTrue(t.state['commanded']['PU1'])
        self.assertFalse(t.state['powered']['PU1'])
        self.assertEqual(t.water.ledger_tail()['pumps']['PU1']['flowM3s'], 0)
        self.assertEqual(t.power.state['coupledLoads']['load-pump-1']['pW'], 0)
        t.advance(4 * 3600 * S)
        self.assertGreater(t.truth()['water']['essentialUnmetM3'], 0)  # secondary service loss, from the equations
        # Ablation: without the supply edge the same trip leaves water service intact.
        free = self.town([TRIP, PU2_OUT], disabled_edges=['power-to-pump-PU1'])
        free.advance(4 * 3600 * S)
        self.assertEqual(free.truth()['water']['essentialUnmetM3'], 0)

    def test_a_held_out_layout_moves_the_dependencies_in_the_physics(self):
        # P17: line-8-9 de-energizes buses 9-11. Layout B puts the pump station on bus 10, layout A on bus 7.
        trip = dict(TRIP, faultId='trip-8-9', assetId='line-8-9')
        moved = Town(apply_layout(copy.deepcopy(self.bundle), {'pumpStationBus': 'bus-10', 'backupPumpBus': 'bus-13', 'substationRouterBus': 'bus-13'}), faults=[trip, PU2_OUT])
        moved.advance(2400 * S)
        self.assertFalse(moved.state['powered']['PU1'])
        self.assertEqual(moved.power.state['coupledLoads']['load-pump-1']['pW'], 0)
        base = self.town([trip, PU2_OUT])
        base.advance(2400 * S)
        self.assertTrue(base.state['powered']['PU1'])

    def test_battery_supported_comms_continue_until_reserve_exhaustion(self):
        t = self.town([TRIP])
        t.advance(4 * 3600 * S)
        edge = t.edges['power-to-comms-rt-pump']['battery']
        exhausted = self.first(t, 'router_battery_exhausted', 'rt-pump')
        self.assertEqual(exhausted['atUs'], 1800 * S + int(edge['capacityJ'] / edge['drawW'] * S))
        up = {r['atUs']: r['routers']['rt-pump']['up'] for r in t.state['trace']}
        self.assertTrue(all(up[a] for a in up if 1800 * S <= a < exhausted['atUs']))
        self.assertFalse(up[exhausted['atUs']])
        longer = copy.deepcopy(self.bundle)
        next(e for e in longer['dependencies']['edges'] if e['id'] == 'power-to-comms-rt-pump')['battery']['capacityJ'] *= 2
        t2 = Town(longer, faults=[TRIP])
        t2.advance(4 * 3600 * S)
        self.assertEqual(self.first(t2, 'router_battery_exhausted', 'rt-pump')['atUs'] - 1800 * S, 2 * (exhausted['atUs'] - 1800 * S))

    def test_losing_telemetry_does_not_report_physical_failure(self):
        t = self.town([{'domain': 'communications', 'faultId': 'rt', 'atUs': 1800 * S, 'type': 'router_fail', 'assetId': 'rt-pump'}])
        t.advance(1740 * S)
        before = {r['sensorId']: r for r in t.observe()['readings']}
        t.advance(3600 * S)
        view = t.observe()
        obs = {r['sensorId']: r for r in view['readings']}
        level = obs['water:lv-T1']
        self.assertEqual(level['observedAtUs'], before['water:lv-T1']['observedAtUs'])  # last delivered value, old time
        self.assertEqual(level['value'], before['water:lv-T1']['value'])
        self.assertLess(level['observedAtUs'], t.state['nowUs'] - view['staleAfterUs'])  # stale by age, not a zero or a failure
        self.assertEqual(view['routers']['rt-pump'], 'unreachable')
        self.assertEqual(obs['water:pr-JH']['observedAtUs'], t.state['nowUs'])            # hospital link unaffected
        self.assertEqual(t.truth()['water']['essentialUnmetM3'], 0)                         # the physical system kept running
        self.assertFalse(any(e['type'] in ('supply_lost', 'pump_stopped') and e['atUs'] >= 1800 * S and e.get('cause') == 'coupling' for e in t.state['events']))

    def test_command_without_control_path_is_unconfirmed_and_local_control_continues(self):
        t = self.town([{'domain': 'communications', 'faultId': 'rt', 'atUs': 600 * S, 'type': 'router_fail', 'assetId': 'rt-pump'}])
        t.advance(900 * S)
        result = t.command('water', {'type': 'set_link', 'params': {'linkId': 'PZ', 'open': False}}, t.water.revision)
        command_status_without_control_path = result['status']
        self.assertEqual(command_status_without_control_path, "unconfirmed")
        self.assertTrue(t.water.ledger_tail()['links']['PZ']['open'])
        t.advance(4 * 3600 * S)
        local = [e for e in t.state['events'] if e['type'] == 'local_command' and e['atUs'] > 600 * S]
        local_protection_remained_enabled = bool(local)
        self.assertTrue(local_protection_remained_enabled)
        self.assertEqual(t.truth()['water']['essentialUnmetM3'], 0)
        ok = self.town()
        ok.advance(900 * S)
        self.assertEqual(ok.command('water', {'type': 'set_link', 'params': {'linkId': 'PZ', 'open': False}}, ok.water.revision)['status'], 'delivered')

    def test_removing_or_reversing_an_irrelevant_edge_changes_nothing(self):
        base = self.town([TRIP, PU2_OUT])
        base.advance(3 * 3600 * S)
        off = self.town([TRIP, PU2_OUT], disabled_edges=['irrelevant-power-to-comms-rt-spare'])
        off.advance(3 * 3600 * S)
        rev = copy.deepcopy(self.bundle)
        e = next(e for e in rev['dependencies']['edges'] if e['id'] == 'irrelevant-power-to-comms-rt-spare')
        e['source']['asset'] = 'bus-14'
        rv = Town(rev, faults=[TRIP, PU2_OUT])
        rv.advance(3 * 3600 * S)
        for other in (off, rv):
            self.assertEqual(other.truth()['water']['essentialUnmetM3'], base.truth()['water']['essentialUnmetM3'])
            self.assertEqual([r['tankLevelM'] for r in other.state['trace']], [r['tankLevelM'] for r in base.state['trace']])

    def test_removing_the_pump_load_edge_removes_its_electrical_demand(self):
        t = self.town(disabled_edges=['pump-to-load-PU1'])
        t.advance(600 * S)
        self.assertEqual(t.power.state['coupledLoads']['load-pump-1']['pW'], 0)
        self.assertGreater(t.water.ledger_tail()['pumps']['PU1']['flowM3s'], 0)

    def test_common_cause_hazard_failures_are_direct_not_a_cascade(self):
        storm = [TRIP | {'hazard': 'storm-1'}, {'domain': 'communications', 'faultId': 'storm-rt-sub', 'atUs': 1800 * S, 'type': 'router_fail', 'assetId': 'rt-sub', 'hazard': 'storm-1'}]
        t = self.town(storm)
        t.advance(2400 * S)
        router = self.first(t, 'router_fail', 'rt-sub')
        self.assertEqual(router['hazard'], 'storm-1')
        self.assertTrue(t.state['routers']['rt-sub']['onMains'])  # its bus is still energized: the failure is direct, not propagated
        self.assertFalse(t.state['routers']['rt-sub']['up'])

    def test_step_size_sensitivity_of_the_secondary_loss(self):
        def onset(step):
            bundle = copy.deepcopy(self.bundle)
            bundle['water']['hydraulicStepS'] = step // S  # refine both the coupling and the hydraulic step
            t = Town(bundle, faults=[TRIP, PU2_OUT], coupling_step_us=step)
            t.advance(4 * 3600 * S)
            return next(r['atUs'] for r in t.state['trace'] if r['hospitalWaterFraction'] is not None and r['hospitalWaterFraction'] < 0.99)
        self.assertLessEqual(abs(onset(60 * S) - onset(30 * S)), 60 * S)

    def test_checkpoint_restore_reproduces_the_uninterrupted_coupled_run(self):
        ref = self.town([TRIP, PU2_OUT])
        ref.advance(3 * 3600 * S)
        t = self.town([TRIP, PU2_OUT])
        t.advance(1200 * S)
        cp = t.checkpoint()
        r = Town.from_checkpoint(copy.deepcopy(self.bundle), cp)
        r.advance(3 * 3600 * S)
        self.assertEqual([x['tankLevelM'] for x in r.state['trace']], [x['tankLevelM'] for x in ref.state['trace']])
        self.assertEqual(r.state['events'], ref.state['events'])
        self.assertEqual(r.truth()['water']['essentialUnmetM3'], ref.truth()['water']['essentialUnmetM3'])

    def test_solver_order_does_not_change_the_coupled_result(self):
        a = self.town([TRIP, PU2_OUT])
        b = self.town([TRIP, PU2_OUT], order='load_first')
        for t in (a, b):
            t.advance(3 * 3600 * S)
        self.assertEqual([x['tankLevelM'] for x in a.state['trace']], [x['tankLevelM'] for x in b.state['trace']])
        self.assertEqual(a.truth()['water']['essentialUnmetM3'], b.truth()['water']['essentialUnmetM3'])

    def test_electrical_nonconvergence_is_flagged_and_attributed_not_treated_as_supply_loss(self):
        t = self.town()
        t.advance(600 * S)
        t.power.bus_energized = lambda bus: None  # stands in for a power flow with no solution
        t.power.solve_status = dict(t.power.solve_status, status='no_feasible_operating_point')
        t.advance(660 * S)
        flagged = [e for e in t.state['events'] if e['type'] == 'coupling_unresolved']
        self.assertTrue(flagged and flagged[0]['cause'] == 'model_nonconvergence')
        self.assertTrue(t.state['powered']['PU1'])  # previous supply state kept, not invented as a failure
        t.command('water', {'type': 'set_link', 'params': {'linkId': 'PZ', 'open': False}}, t.water.revision)
        self.assertEqual([e for e in t.state['events'] if e['type'] == 'coupling_unresolved'][-1]['cause'], 'action_caused')

    def test_out_of_order_telemetry_is_dropped(self):
        t = self.town()
        t.advance(600 * S)
        t.observe()
        late = dict(t.state['telemetry']['water:lv-T1'], observedAtUs=300 * S, value=99.0)
        self.assertFalse(t.admit_telemetry(late))
        self.assertEqual(t.state['outOfOrderDropped'], 1)
        self.assertNotEqual(t.state['telemetry']['water:lv-T1']['value'], 99.0)

    def test_intervention_changes_the_cascade_path(self):
        base = self.town([TRIP, PU2_OUT])
        base.advance(2400 * S)
        act = self.town([TRIP, PU2_OUT])
        act.advance(2400 * S)
        receipt = act.command('power', {'type': 'set_switch', 'params': {'switchId': 'sw-S1', 'closed': True}}, act.power.revision)
        self.assertEqual(receipt['status'], 'delivered')
        for t in (base, act):
            t.advance(4 * 3600 * S)
        self.assertTrue(self.first(act, 'supply_restored', 'PU1'))
        self.assertEqual(act.truth()['water']['essentialUnmetM3'], 0)
        self.assertGreater(base.truth()['water']['essentialUnmetM3'], 0)
        self.assertLess(act.truth()['power']['essentialUnservedJ'], base.truth()['power']['essentialUnservedJ'])


if __name__ == '__main__':
    unittest.main()
