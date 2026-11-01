"""Unprivileged worker contract tests. No Mininet import, no network objects, no socket files."""
import copy
import json
import os
import socket
import sys
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))

import faults  # noqa: E402
import telemetry  # noqa: E402
import topology  # noqa: E402
import worker  # noqa: E402

UNITS = {'time': 'ms', 'rate': 'bit/s', 'size': 'byte', 'clock': 'CLOCK_MONOTONIC'}


def scenario(name='cascade'):
    with open(os.path.join(REPO, 'fixtures/lifeline/development/%s.json' % name)) as handle:
        return json.load(handle)


def public(name='cascade'):
    doc = scenario(name)
    doc.pop('faults')
    return doc


class FakeBackend:
    """Records calls; never touches the network."""

    def __init__(self):
        self.calls = []

    def build(self, spec):
        self.calls.append(('build', spec['scenarioId']))
        return {'interfaces': {}}

    def inject_fault(self, fault):
        self.calls.append(('fault', fault['kind'], fault['linkId']))
        return {'applied': True}

    def telemetry(self, interval_ms=None):
        return {'seq': 1, 'sampleIntervalMs': interval_ms}

    def teardown(self):
        self.calls.append(('teardown',))
        return {'removed': True}

    def control(self, cmd, args):
        self.calls.append(('control', cmd, args.get('operationId')))
        return {'status': 'applied', 'operationId': args.get('operationId')}


class Session:
    def __init__(self, role_allowed=('supervisor', 'orchestrator')):
        self.backend = FakeBackend()
        self.client, server = socket.socketpair()
        self.proto = worker.WorkerProtocol(run_id='run-1', backend=self.backend, roles=role_allowed)
        self.thread = threading.Thread(target=self.proto.serve, args=(server,), daemon=True)
        self.thread.start()
        self.reader = self.client.makefile('r')
        self.next_id = 1

    def raw(self, text):
        self.client.sendall(text.encode())
        line = self.reader.readline()
        return json.loads(line) if line else None

    def call(self, cmd, args=None, frame_id=None):
        frame_id = self.next_id if frame_id is None else frame_id
        self.next_id = max(self.next_id, frame_id) + 1
        return self.raw(json.dumps({'v': 1, 'id': frame_id, 'cmd': cmd, 'args': args or {}}) + '\n')

    def hello(self, role='supervisor', **overrides):
        args = {'protocol': 1, 'runId': 'run-1', 'role': role, 'units': UNITS}
        args.update(overrides)
        return self.call('hello', args)

    def close(self):
        self.reader.close()  # the makefile holds a socket reference; close both so the server sees EOF
        self.client.close()
        self.thread.join(2)
        assert not self.thread.is_alive(), 'worker connection thread did not exit on EOF'


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.s = Session()

    def tearDown(self):
        self.s.close()

    def test_handshake_returns_protocol_units_and_epoch(self):
        reply = self.s.hello()
        self.assertTrue(reply['ok'], reply)
        self.assertEqual(reply['result']['protocol'], 1)
        self.assertEqual(reply['result']['units'], UNITS)
        self.assertRegex(reply['result']['epochMonotonicNs'], r'^\d+$')
        self.assertEqual(reply['workerSeq'], 1)

    def test_handshake_rejects_wrong_run_protocol_and_units(self):
        self.assertEqual(self.s.hello(runId='run-2')['error']['detail'], 'run_mismatch')
        self.assertEqual(self.s.hello(protocol=2)['error']['detail'], 'protocol_mismatch')
        self.assertEqual(self.s.hello(units=dict(UNITS, time='s'))['error']['detail'], 'units_mismatch')

    def test_commands_before_hello_are_rejected(self):
        self.assertEqual(self.s.call('telemetry')['error']['detail'], 'not_ready')

    def test_unknown_command_and_malformed_frames_are_rejected(self):
        self.s.hello()
        self.assertEqual(self.s.call('rm_rf')['error']['detail'], 'unknown_command')
        self.assertEqual(self.s.raw('{not json}\n')['error']['detail'], 'bad_frame')
        self.assertEqual(self.s.raw(json.dumps({'v': 1, 'id': 50, 'cmd': 'telemetry', 'args': [], 'x': 1}) + '\n')['error']['detail'], 'bad_frame')

    def test_request_ids_must_increase(self):
        self.s.hello()
        self.s.call('telemetry', frame_id=10)
        self.assertEqual(self.s.call('telemetry', frame_id=10)['error']['detail'], 'non_monotonic_id')

    def test_worker_sequence_increases_on_every_reply(self):
        seqs = [self.s.hello()['workerSeq'], self.s.call('telemetry')['workerSeq'], self.s.call('nope')['workerSeq']]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(set(seqs)), 3)

    def test_supervisor_cannot_inject_faults(self):
        self.s.hello(role='supervisor')
        reply = self.s.call('inject_fault', {'atMs': 0, 'kind': 'link_down', 'linkId': 'r0-r3'})
        self.assertEqual(reply['error']['detail'], 'role_forbidden')
        self.assertEqual([c for c in self.s.backend.calls if c[0] == 'fault'], [])

    def test_build_rejects_a_scenario_carrying_the_fault_schedule(self):
        self.s.hello(role='orchestrator')
        reply = self.s.call('build', scenario('cascade'))
        self.assertEqual(reply['error']['detail'], 'hidden_schedule_present')
        self.assertTrue(self.s.call('build', public('cascade'))['ok'])

    def test_orchestrator_fault_is_validated_then_applied(self):
        self.s.hello(role='orchestrator')
        self.s.call('build', public())
        self.assertEqual(self.s.call('inject_fault', {'atMs': 0, 'kind': 'link_down', 'linkId': 'r9-r3'})['error']['detail'], 'unknown_link')
        self.assertTrue(self.s.call('inject_fault', {'atMs': 0, 'kind': 'link_down', 'linkId': 'r0-r3'})['ok'])
        self.assertIn(('fault', 'link_down', 'r0-r3'), self.s.backend.calls)

    def test_telemetry_interval_is_declared_and_validated(self):
        self.s.hello()
        self.assertEqual(self.s.call('telemetry', {'intervalMs': 500})['result']['sampleIntervalMs'], 500)
        self.assertEqual(self.s.call('telemetry', {'intervalMs': -1})['error']['detail'], 'bad_quantity')

    def test_control_commands_are_supervisor_only_and_need_an_operation_id(self):
        self.s.hello(role='supervisor')
        self.assertTrue(self.s.call('set_rate', {'operationId': 'op-1', 'sourceId': 'bulk-field', 'bitsPerSecond': 1})['ok'])
        self.assertEqual(self.s.call('set_rate', {'sourceId': 'bulk-field', 'bitsPerSecond': 1})['error']['detail'], 'operation_id_required')
        orch = Session()
        orch.hello(role='orchestrator')
        self.assertEqual(orch.call('prepare_route', {'operationId': 'op-2', 'flowId': 'x'})['error']['detail'], 'role_forbidden')
        orch.close()
        self.assertEqual([c for c in self.s.backend.calls if c[0] == 'control'], [('control', 'set_rate', 'op-1')])

    def test_commands_after_shutdown_are_rejected(self):
        self.s.hello()
        self.assertTrue(self.s.call('shutdown')['ok'])
        self.assertEqual(self.s.call('telemetry')['error']['detail'], 'worker_stopped')

    def test_oversized_frame_is_rejected(self):
        self.s.hello()
        reply = self.s.raw(json.dumps({'v': 1, 'id': 99, 'cmd': 'telemetry', 'args': {'pad': 'x' * (1 << 20)}}) + '\n')
        self.assertEqual(reply['error']['detail'], 'bad_frame')


class ScenarioValidationTests(unittest.TestCase):
    def test_development_scenarios_validate(self):
        for name in ('cascade', 'no-fault', 'partition'):
            topology.validate_scenario(public(name))

    def rejects(self, mutate, detail):
        doc = public()
        mutate(doc)
        with self.assertRaises(topology.ScenarioError) as caught:
            topology.validate_scenario(doc)
        self.assertEqual(caught.exception.detail, detail)

    def test_shell_metacharacters_in_names_are_rejected(self):
        self.rejects(lambda d: d['topology']['switches'].append('r6;reboot'), 'bad_name')
        self.rejects(lambda d: d['topology']['hosts'][0].update(hostId='$(id)'), 'bad_name')

    def test_unregistered_link_endpoints_are_rejected(self):
        self.rejects(lambda d: d['topology']['links'].append({'linkId': 'r0-r9', 'a': 'r0', 'b': 'r9', 'bwMbit': 8, 'delayMs': 5, 'queuePackets': 10}), 'unknown_node')

    def test_duplicate_ids_are_rejected(self):
        self.rejects(lambda d: d['topology']['links'].append(dict(d['topology']['links'][0])), 'duplicate_id')

    def test_routes_must_be_simple_registered_paths(self):
        self.rejects(lambda d: d['referencePolicy']['routes']['dispatch-clinic'].update(primary=['r0', 'r2', 'r3']), 'unknown_link')
        self.rejects(lambda d: d['referencePolicy']['routes']['dispatch-clinic'].update(backup=['r0', 'r1', 'r0', 'r3']), 'route_not_simple')
        self.rejects(lambda d: d['referencePolicy']['routes']['dispatch-clinic'].update(primary=['r1', 'r2', 'r3']), 'bad_endpoint')

    def test_nonfinite_or_negative_quantities_are_rejected(self):
        self.rejects(lambda d: d['topology']['links'][0].update(bwMbit=float('nan')), 'bad_quantity')
        self.rejects(lambda d: d['workload']['essential'][0].update(deadlineMs=-1), 'bad_quantity')

    def test_validation_does_not_mutate_input(self):
        doc = public()
        before = copy.deepcopy(doc)
        topology.validate_scenario(doc)
        self.assertEqual(doc, before)


class FaultValidationTests(unittest.TestCase):
    def test_admitted_kinds_only(self):
        spec = topology.validate_scenario(public())
        faults.validate_fault({'atMs': 0, 'kind': 'link_down', 'linkId': 'r0-r3'}, spec)
        faults.validate_fault({'atMs': 0, 'kind': 'link_rate', 'linkId': 'r1-r2', 'bwMbit': 3}, spec)
        faults.validate_fault({'atMs': 0, 'kind': 'telemetry_hold', 'durationMs': 6000}, spec)
        for bad, detail in [({'atMs': 0, 'kind': 'power_off', 'linkId': 'r0-r3'}, 'unknown_fault_kind'),
                            ({'atMs': 0, 'kind': 'telemetry_hold', 'durationMs': 0}, 'bad_quantity'),
                            ({'atMs': 0, 'kind': 'telemetry_hold', 'durationMs': 5, 'linkId': 'r0-r3'}, 'unknown_field'),
                            ({'atMs': 0, 'kind': 'link_rate', 'linkId': 'r1-r2', 'bwMbit': 0}, 'bad_quantity'),
                            ({'atMs': 0, 'kind': 'link_down', 'linkId': 'r0-r3', 'cmd': 'x'}, 'unknown_field')]:
            with self.assertRaises(faults.FaultError) as caught:
                faults.validate_fault(bad, spec)
            self.assertEqual(caught.exception.detail, detail)


class TelemetryBoundaryTests(unittest.TestCase):
    PORTS = '''OFPST_PORT reply (OF1.3) (xid=0x2): 3 ports
  port  "r0-eth1": rx pkts=10, bytes=1000, drop=0, errs=0, frame=0, over=0, crc=0
           tx pkts=20, bytes=2000, drop=1, errs=0, coll=0
           duration=12.5s
  port  "r0-eth2": rx pkts=?, bytes=?, drop=?, errs=?, frame=?, over=?, crc=?
           tx pkts=?, bytes=?, drop=?, errs=?, coll=?
           duration=12.5s
'''
    TC = '''qdisc htb 5: root refcnt 2 r2q 10 default 0x1 direct_packets_stat 0 direct_qlen 1000
 Sent 123456 bytes 99 pkt (dropped 7, overlimits 3 requeues 0)
 backlog 3000b 3p requeues 0
qdisc netem 10: parent 5:1 limit 200 delay 5ms
 Sent 123456 bytes 99 pkt (dropped 0, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0
'''

    def test_port_counters_parse_and_unknown_counters_stay_missing(self):
        ports = telemetry.parse_dump_ports(self.PORTS)
        self.assertEqual(ports['r0-eth1']['txBytes'], 2000)
        self.assertEqual(ports['r0-eth1']['txDrops'], 1)
        self.assertIsNone(ports['r0-eth2']['txBytes'])

    def test_real_ovs_output_is_keyed_by_openflow_port_number(self):
        real = '''OFPST_PORT reply (OF1.3) (xid=0x2): 2 ports
  port LOCAL: rx pkts=0, bytes=0, drop=0, errs=0, frame=0, over=0, crc=0
           tx pkts=0, bytes=0, drop=0, errs=0, coll=0
           duration=0.010s
  port  1: rx pkts=3, bytes=300, drop=0, errs=0, frame=0, over=0, crc=0
           tx pkts=4, bytes=400, drop=2, errs=0, coll=0
           duration=0.004s
'''
        ports = telemetry.parse_dump_ports(real)
        self.assertEqual(ports['1']['txBytes'], 400)
        self.assertEqual(telemetry.port_counters(ports, 1, 'lfs1r0-eth2')['txDrops'], 2)
        self.assertEqual(telemetry.port_counters(ports, 7, 'missing'), {})

    def test_queue_counters_exclude_configured_rate(self):
        queue = telemetry.parse_tc(self.TC)
        self.assertEqual(queue, {'drops': 7, 'backlogBytes': 3000, 'backlogPackets': 3})

    def test_service_counter_resolves_messages_only_after_their_deadline(self):
        c = telemetry.ServiceCounter(deadline_ms=500)
        ms = 1000000
        c.feed({'t': 'offered', 'id': 'a', 'createdAtNs': 0})
        c.feed({'t': 'tx', 'id': 'a'})
        c.feed({'t': 'offered', 'id': 'b', 'createdAtNs': 100 * ms})
        c.feed({'t': 'ack', 'id': 'a', 'atNs': 40 * ms})
        c.feed({'t': 'offered', 'id': 'c', 'createdAtNs': 200 * ms})
        c.feed({'t': 'ack', 'id': 'c', 'atNs': 900 * ms})  # late
        snap = c.snapshot(now_ns=650 * ms)  # a and b are past deadline; c is not yet
        self.assertEqual((snap['offered'], snap['resolvedOffered'], snap['resolvedOnTime']), (3, 2, 1))
        snap = c.snapshot(now_ns=2000 * ms)
        self.assertEqual((snap['resolvedOffered'], snap['resolvedOnTime'], snap['acked'], snap['ackedWithinDeadline']), (3, 1, 2, 1))

    def test_observation_omits_fault_truth_and_configured_capacity(self):
        spec = topology.validate_scenario(public())
        sample = {'collectedAtMs': 1500.0, 'links': {'r0-r3': {'state': 'down', 'txBytes': {'r0': 5, 'r3': None}}},
                  'services': {'dispatch-clinic': {'offered': 10, 'acked': 9}}}
        hidden = {'kind': 'link_rate', 'linkId': 'r1-r2', 'bwMbit': 3}
        obs = telemetry.build_observation('run-1', 4, sample, spec, config_revision=2, now_ms=1700.0, interval_ms=500)
        text = json.dumps(obs)
        self.assertEqual(obs['version'], 'ObservationV1')
        self.assertEqual(obs['seq'], 4)
        self.assertEqual(obs['ageMs'], 200.0)
        self.assertIsNone(obs['links']['r0-r3']['txBytes']['r3'])
        for forbidden in ('fault', 'bwMbit', 'link_rate', 'faults', 'queuePackets'):
            self.assertNotIn(forbidden, text)
        self.assertNotIn(json.dumps(hidden), text)


if __name__ == '__main__':
    unittest.main()
