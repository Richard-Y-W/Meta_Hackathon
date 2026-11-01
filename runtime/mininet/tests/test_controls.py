"""Unprivileged control-plane contract tests with a fake OpenFlow layer."""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))

import controls  # noqa: E402
import topology  # noqa: E402


class FakeOpenFlow:
    """In-memory switch tables. `fail_on` makes the next add on a bridge fail; `drop_on` accepts but never installs."""

    def __init__(self):
        self.tables, self.groups, self.fail_on, self.drop_on, self.log = {}, {}, set(), set(), []

    def add_flow(self, bridge, spec):
        self.log.append(('add', bridge, spec))
        if bridge in self.fail_on:
            self.fail_on.discard(bridge)
            raise controls.ControlError('openflow_failed: injected')
        if bridge in self.drop_on:
            return
        table = self.tables.setdefault(bridge, [])
        key = spec.split(',actions=')[0].split(',', 1)[1]  # match without cookie: a re-add replaces
        table[:] = [r for r in table if r.split(',actions=')[0].split(',', 1)[1] != key]
        table.append(spec)

    def del_flows(self, bridge, cookie):
        self.log.append(('del', bridge, cookie))
        self.tables[bridge] = [r for r in self.tables.get(bridge, []) if not r.startswith('cookie=%#x,' % cookie)]

    def count(self, bridge, cookie):
        return sum(1 for r in self.tables.get(bridge, []) if r.startswith('cookie=%#x,' % cookie))

    def packets(self, bridge, cookie):
        return 0

    def add_group(self, bridge, spec):
        self.groups.setdefault(bridge, []).append(spec)

    def del_flow_strict(self, bridge, match):
        self.log.append(('del-strict', bridge, match))
        self.tables[bridge] = [r for r in self.tables.get(bridge, []) if r.split(',actions=')[0].split(',', 1)[1] != match]


def spec():
    with open(os.path.join(REPO, 'fixtures/lifeline/development/cascade.json')) as handle:
        doc = json.load(handle)
    doc.pop('faults')
    return topology.validate_scenario(doc)


class Names(dict):
    pass


class Node:
    def __init__(self, name):
        self.name = name


def setup():
    s = spec()
    names = {k: Node('t' + k) for k in s['topology']['switches']}
    ports, n = {}, 1
    for link in s['topology']['links']:
        ports[(link['a'], link['b'])] = (n, 'x'); n += 1
        ports[(link['b'], link['a'])] = (n, 'x'); n += 1
    for h in s['topology']['hosts']:
        ports[(h['switch'], h['hostId'])] = (n, 'x'); n += 1
    of = FakeOpenFlow()
    table = controls.RouteTable(s, names, ports, of)
    table.install_reference()
    return s, names, of, table


class RouteVersionTests(unittest.TestCase):
    def test_reference_policy_uses_per_route_cookies(self):
        s, names, of, table = setup()
        dc = table.cookie('dispatch-clinic', 'data', 0)
        self.assertEqual(of.count('tr0', dc), 1)
        self.assertNotEqual(dc, table.cookie('dispatch-clinic', 'ack', 0))
        self.assertEqual(table.active('dispatch-clinic', 'data'), 0)

    def test_prepare_installs_tagged_rules_without_touching_ingress(self):
        s, names, of, table = setup()
        result = table.prepare('op-1', 'dispatch-clinic', ['r0', 'r5', 'r4', 'r3'], ['r3', 'r4', 'r5', 'r0'])
        self.assertEqual(result['status'], 'prepared')
        v = result['version']
        self.assertEqual(v, 1)
        for switch in ('r5', 'r4', 'r3'):
            rules = [r for r in of.tables['t' + switch] if r.startswith('cookie=%#x,' % table.cookie('dispatch-clinic', 'data', v))]
            self.assertEqual(len(rules), 1)
            self.assertIn('ip_dscp=%d' % v, rules[0])
        self.assertEqual(table.active('dispatch-clinic', 'data'), 0)  # ingress unchanged
        self.assertEqual(sorted(e['switch'] for e in result['effects'] if e['role'] == 'data'), ['r3', 'r4', 'r5'])

    def test_commit_switches_ingress_and_increments_configuration(self):
        s, names, of, table = setup()
        v = table.prepare('op-1', 'dispatch-clinic', ['r0', 'r5', 'r4', 'r3'], ['r3', 'r4', 'r5', 'r0'])['version']
        before = table.config_revision
        result = table.commit('op-2', 'dispatch-clinic', v)
        self.assertEqual(result['status'], 'committed')
        self.assertEqual(table.active('dispatch-clinic', 'data'), v)
        self.assertEqual(table.config_revision, before + 1)
        ingress = [r for r in of.tables['tr0'] if 'priority=300' in r]
        self.assertTrue(any('set_field:%d->ip_dscp' % v in r for r in ingress))

    def test_commit_of_an_unprepared_version_is_rejected(self):
        s, names, of, table = setup()
        with self.assertRaises(controls.ControlError) as caught:
            table.commit('op-1', 'dispatch-clinic', 7)
        self.assertEqual(caught.exception.detail, 'version_not_prepared')

    def test_prepare_failure_reports_partial_effects_and_aborts_cleanly(self):
        s, names, of, table = setup()
        of.fail_on.add('tr4')
        result = table.prepare('op-1', 'dispatch-clinic', ['r0', 'r5', 'r4', 'r3'], ['r3', 'r4', 'r5', 'r0'])
        self.assertEqual(result['status'], 'failed')
        self.assertTrue(result['effects'])  # what was installed before the failure is reported
        aborted = table.abort('op-2', 'dispatch-clinic', result['version'])
        self.assertEqual(aborted['remaining'], 0)
        self.assertEqual(table.active('dispatch-clinic', 'data'), 0)

    def test_unconfirmed_install_is_not_an_effect(self):
        s, names, of, table = setup()
        of.drop_on.add('tr5')
        result = table.prepare('op-1', 'dispatch-clinic', ['r0', 'r5', 'r4', 'r3'], ['r3', 'r4', 'r5', 'r0'])
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['detail'], 'readback_mismatch')
        self.assertNotIn('r5', [e['switch'] for e in result['effects'] if e['role'] == 'data'])

    def test_retire_removes_only_the_old_version(self):
        s, names, of, table = setup()
        v = table.prepare('op-1', 'dispatch-clinic', ['r0', 'r5', 'r4', 'r3'], ['r3', 'r4', 'r5', 'r0'])['version']
        table.commit('op-2', 'dispatch-clinic', v)
        result = table.retire('op-3', 'dispatch-clinic', 0)
        self.assertEqual(result['status'], 'retired')
        old = table.cookie('dispatch-clinic', 'data', 0)
        self.assertEqual(sum(of.count(b, old) for b in of.tables), 0)
        self.assertEqual(of.count('tr5', table.cookie('dispatch-clinic', 'data', v)), 1)
        self.assertEqual(of.count('tr0', table.cookie('field-clinic', 'data', 0)) + of.count('tr1', table.cookie('field-clinic', 'data', 0)), 1)

    def test_active_version_cannot_be_retired(self):
        s, names, of, table = setup()
        with self.assertRaises(controls.ControlError) as caught:
            table.retire('op-1', 'dispatch-clinic', 0)
        self.assertEqual(caught.exception.detail, 'version_active')

    def test_rollback_reactivates_a_still_installed_version(self):
        s, names, of, table = setup()
        v1 = table.prepare('op-1', 'dispatch-clinic', ['r0', 'r5', 'r4', 'r3'], ['r3', 'r4', 'r5', 'r0'])['version']
        table.commit('op-2', 'dispatch-clinic', v1)
        v2 = table.prepare('op-3', 'dispatch-clinic', ['r0', 'r1', 'r2', 'r3'], ['r3', 'r2', 'r1', 'r0'])['version']
        table.commit('op-4', 'dispatch-clinic', v2)
        result = table.commit('op-5', 'dispatch-clinic', v1)
        self.assertEqual(result['status'], 'committed')
        self.assertEqual(table.active('dispatch-clinic', 'data'), v1)
        ingress = [r for r in of.tables['tr0'] if 'priority=300' in r and 'tp_dst=7001' in r]
        self.assertEqual(len(ingress), 1)
        self.assertIn('set_field:%d->ip_dscp' % v1, ingress[0])

    def test_rollback_to_the_reference_removes_the_tagging_ingress_rule(self):
        s, names, of, table = setup()
        v1 = table.prepare('op-1', 'dispatch-clinic', ['r0', 'r5', 'r4', 'r3'], ['r3', 'r4', 'r5', 'r0'])['version']
        table.commit('op-2', 'dispatch-clinic', v1)
        result = table.commit('op-3', 'dispatch-clinic', 0)
        self.assertEqual(result['status'], 'committed')
        self.assertEqual(table.active('dispatch-clinic', 'data'), 0)
        self.assertEqual([r for r in of.tables['tr0'] if 'priority=300' in r and 'tp_dst=7001' in r], [])

    def test_a_retired_version_cannot_be_reactivated(self):
        s, names, of, table = setup()
        v1 = table.prepare('op-1', 'dispatch-clinic', ['r0', 'r5', 'r4', 'r3'], ['r3', 'r4', 'r5', 'r0'])['version']
        table.commit('op-2', 'dispatch-clinic', v1)
        table.retire('op-3', 'dispatch-clinic', 0)
        with self.assertRaises(controls.ControlError) as caught:
            table.commit('op-4', 'dispatch-clinic', 0)
        self.assertEqual(caught.exception.detail, 'version_not_prepared')

    def test_two_successive_updates_use_distinct_versions(self):
        s, names, of, table = setup()
        v1 = table.prepare('op-1', 'dispatch-clinic', ['r0', 'r5', 'r4', 'r3'], ['r3', 'r4', 'r5', 'r0'])['version']
        table.commit('op-2', 'dispatch-clinic', v1)
        v2 = table.prepare('op-3', 'dispatch-clinic', ['r0', 'r1', 'r2', 'r3'], ['r3', 'r2', 'r1', 'r0'])['version']
        self.assertNotEqual(v1, v2)
        table.commit('op-4', 'dispatch-clinic', v2)
        self.assertEqual(table.active('dispatch-clinic', 'data'), v2)

    def test_routes_are_validated_against_the_registry(self):
        s, names, of, table = setup()
        for path, ack, detail in [(['r0', 'r2', 'r3'], ['r3', 'r2', 'r0'], 'unknown_link'),
                                  (['r0', 'r1', 'r0', 'r3'], ['r3', 'r0'], 'route_not_simple'),
                                  (['r1', 'r2', 'r3'], ['r3', 'r2', 'r1'], 'bad_endpoint')]:
            with self.assertRaises(controls.ControlError) as caught:
                table.prepare('op-x', 'dispatch-clinic', path, ack)
            self.assertEqual(caught.exception.detail, detail)
        with self.assertRaises(controls.ControlError):
            table.prepare('op-y', 'bulk-field', ['r1', 'r0', 'r3'], ['r3', 'r0', 'r1'])  # background has no ack path


class OperationRegistryTests(unittest.TestCase):
    def test_repeated_operation_returns_the_prior_outcome_without_reapplying(self):
        s, names, of, table = setup()
        ops = controls.Operations()
        args = {'flowId': 'dispatch-clinic', 'path': ['r0', 'r5', 'r4', 'r3'], 'ackPath': ['r3', 'r4', 'r5', 'r0']}
        first = ops.run('op-1', 'prepare_route', args, lambda: table.prepare('op-1', **args))
        adds = len(of.log)
        second = ops.run('op-1', 'prepare_route', args, lambda: table.prepare('op-1', **args))
        self.assertEqual(second['version'], first['version'])
        self.assertTrue(second['replayed'])
        self.assertEqual(len(of.log), adds)

    def test_reusing_an_operation_id_for_different_arguments_is_rejected(self):
        ops = controls.Operations()
        ops.run('op-1', 'set_rate', {'sourceId': 'bulk-field', 'bitsPerSecond': 1}, lambda: {'status': 'applied'})
        with self.assertRaises(controls.ControlError) as caught:
            ops.run('op-1', 'set_rate', {'sourceId': 'bulk-field', 'bitsPerSecond': 2}, lambda: {'status': 'applied'})
        self.assertEqual(caught.exception.detail, 'operation_id_reused')

    def test_lookup_of_unknown_operation(self):
        self.assertEqual(controls.Operations().lookup('nope'), {'operationId': 'nope', 'status': 'unknown'})

    def test_a_failed_effect_is_recorded_as_the_operation_outcome(self):
        ops = controls.Operations()

        def boom():
            raise controls.ControlError('openflow_failed: x')
        with self.assertRaises(controls.ControlError):
            ops.run('op-9', 'commit_route', {'flowId': 'f', 'version': 1}, boom)
        self.assertEqual(ops.lookup('op-9')['status'], 'failed')


class RateTests(unittest.TestCase):
    def test_rate_is_throttle_only_and_read_back(self):
        s = spec()
        import tempfile
        with tempfile.TemporaryDirectory(dir=os.path.join(REPO, '.work', 'tmp')) as run_dir:
            rates = controls.RateControl(s, run_dir)
            rates.initialize()
            result = rates.set('bulk-field', 2000000)
            self.assertEqual(result, {'status': 'applied', 'sourceId': 'bulk-field', 'priorBps': 6500000, 'appliedBps': 2000000, 'readBackBps': 2000000})
            for source, bps, detail in [('dispatch-clinic', 1000, 'not_background'), ('bulk-field', 7000000, 'above_scheduled_demand'), ('bulk-field', -1, 'bad_quantity')]:
                with self.assertRaises(controls.ControlError) as caught:
                    rates.set(source, bps)
                self.assertEqual(caught.exception.detail, detail)


if __name__ == '__main__':
    unittest.main()
