"""Packet integration tests. Run only inside the qualified VM, as root, when explicitly enabled:

    sudo LIFELINE_INTEGRATION=1 python3 -m unittest discover -s runtime/mininet/tests -p test_integration.py

An unavailable environment is a skip with its reason, never a pass.
"""
import json
import os
import socket
import subprocess
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(RUNTIME))
ENABLED = os.environ.get('LIFELINE_INTEGRATION') == '1'
REASON = 'set LIFELINE_INTEGRATION=1 and run as root in the qualified VM'
UNITS = {'time': 'ms', 'rate': 'bit/s', 'size': 'byte', 'clock': 'CLOCK_MONOTONIC'}


class Client:
    def __init__(self, path, run_id, role):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self.reader = self.sock.makefile('r')
        self.id = 0
        self.hello = self.call('hello', {'protocol': 1, 'runId': run_id, 'role': role, 'units': UNITS})

    def call(self, cmd, args=None):
        self.id += 1
        self.sock.sendall((json.dumps({'v': 1, 'id': self.id, 'cmd': cmd, 'args': args or {}}) + '\n').encode())
        return json.loads(self.reader.readline())

    def close(self):
        self.reader.close()
        self.sock.close()


@unittest.skipUnless(ENABLED and hasattr(os, 'geteuid') and os.geteuid() == 0, REASON)
class WorkerIntegration(unittest.TestCase):
    def setUp(self):
        self.run_id = 'itest-%d' % os.getpid()
        self.dir = '/run/lifeline/%s' % self.run_id
        self.path = self.dir + '/worker.sock'
        os.makedirs(self.dir)
        self.proc = subprocess.Popen([sys.executable, os.path.join(RUNTIME, 'worker.py'), '--run-id', self.run_id,
                                      '--socket', self.path, '--dir', self.dir, '--tag', 'lfit'])
        for _ in range(100):
            if os.path.exists(self.path):
                break
            time.sleep(0.1)
        with open(os.path.join(REPO, 'fixtures/lifeline/development/no-fault.json')) as handle:
            self.scenario = json.load(handle)
        self.scenario.pop('faults')

    def tearDown(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(10)

    def test_build_observe_fault_teardown_leaves_no_run_objects(self):
        orch = Client(self.path, self.run_id, 'orchestrator')
        sup = Client(self.path, self.run_id, 'supervisor')
        self.assertTrue(orch.hello['ok'] and sup.hello['ok'])
        built = orch.call('build', self.scenario)
        self.assertTrue(built['ok'], built)
        self.assertEqual(len(built['result']['interfaces']), 2 * 8 + 4)  # both ends of 8 links + 4 host ports
        self.assertEqual(sup.call('inject_fault', {'atMs': 0, 'kind': 'link_down', 'linkId': 'r0-r3'})['error']['detail'], 'role_forbidden')
        before = sup.call('telemetry', {'intervalMs': 500})['result']
        self.assertEqual(before['links']['r0-r3']['state'], 'up')
        self.assertTrue(orch.call('inject_fault', {'atMs': 0, 'kind': 'link_down', 'linkId': 'r0-r3'})['ok'])
        after = sup.call('telemetry', {'intervalMs': 500})['result']
        self.assertEqual(after['links']['r0-r3']['state'], 'down')
        self.assertGreater(after['seq'], before['seq'])
        self.assertNotIn('link_down', json.dumps(after))
        down = orch.call('teardown')['result']
        self.assertEqual(down['runOwnedBridgesRemaining'], [])
        self.assertEqual(down['runOwnedLinksRemaining'], [])
        self.assertTrue(orch.call('shutdown')['ok'])
        orch.close()
        sup.close()
        self.assertEqual(self.proc.wait(10), 0)
        self.assertFalse(os.path.exists(self.path))


if __name__ == '__main__':
    unittest.main()
