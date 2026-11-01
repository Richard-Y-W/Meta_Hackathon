#!/usr/bin/env python3
"""Private typed command server for the isolated Linux network.

    sudo python3 runtime/mininet/worker.py --run-id RUN --socket /run/lifeline/RUN/worker.sock --dir /run/lifeline/RUN

Newline-delimited JSON. Request {v, id, cmd, args}; reply {v, id, workerSeq, ok, result|error}.
Commands are allowlisted per role; arguments never reach a shell without registry validation.
"""
import argparse
import json
import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import faults  # noqa: E402
import topology  # noqa: E402

PROTOCOL = 1
UNITS = {'time': 'ms', 'rate': 'bit/s', 'size': 'byte', 'clock': 'CLOCK_MONOTONIC'}
MAX_FRAME = 1 << 20
COMMANDS = {
    'hello': ('supervisor', 'orchestrator'),
    'telemetry': ('supervisor', 'orchestrator'),
    'build': ('orchestrator',),
    'start_traffic': ('orchestrator',),
    'inject_fault': ('orchestrator',),
    'collect': ('orchestrator',),
    'teardown': ('orchestrator',),
    'shutdown': ('supervisor', 'orchestrator'),
}
# Controller authority: the supervisor connection only, every call carrying an operation ID.
CONTROL_COMMANDS = ('prepare_route', 'commit_route', 'retire_route', 'abort_route', 'set_rate', 'probe')
QUERY_COMMANDS = ('operation', 'verify_route', 'control_state', 'probe_result')
for _name in CONTROL_COMMANDS + QUERY_COMMANDS:
    COMMANDS[_name] = ('supervisor',)
OPERATION_ID = __import__('re').compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$')


class Rejected(Exception):
    def __init__(self, detail, code='command_rejected'):
        Exception.__init__(self, detail)
        self.code, self.detail = code, detail


class WorkerProtocol:
    """Shared across connections: one sequence counter, one backend, serialized commands."""

    def __init__(self, run_id, backend, roles=('supervisor', 'orchestrator'), epoch_ns=None):
        self.run_id, self.backend, self.roles = run_id, backend, roles
        self.epoch_ns = epoch_ns or time.monotonic_ns()
        self.seq = 0
        self.lock = threading.Lock()
        self.stopped = False
        self.spec = None

    def serve(self, conn):
        state = {'role': None, 'last_id': 0}
        reader = conn.makefile('rb')
        try:
            while True:
                line = reader.readline(MAX_FRAME + 1)
                if not line:
                    return
                if len(line) > MAX_FRAME or not line.endswith(b'\n'):
                    while line and not line.endswith(b'\n'):
                        line = reader.readline(MAX_FRAME + 1)  # discard the rest of the oversized frame
                    self._send(conn, None, error=('command_rejected', 'bad_frame'))
                    continue
                frame_id, result, error = self.handle(line, state)
                self._send(conn, frame_id, result=result, error=error)
        except (OSError, ValueError):
            return
        finally:
            reader.close()
            conn.close()

    def _send(self, conn, frame_id, result=None, error=None):
        with self.lock:
            self.seq += 1
            reply = {'v': PROTOCOL, 'id': frame_id if frame_id is not None else 0, 'workerSeq': self.seq, 'ok': error is None}
            if error is None:
                reply['result'] = result
            else:
                reply['error'] = {'code': error[0], 'detail': error[1]}
            conn.sendall((json.dumps(reply, separators=(',', ':')) + '\n').encode())

    def handle(self, line, state):
        try:
            frame = json.loads(line)
        except ValueError:
            return None, None, ('command_rejected', 'bad_frame')
        if (not isinstance(frame, dict) or set(frame) != {'v', 'id', 'cmd', 'args'} or frame['v'] != PROTOCOL
                or not isinstance(frame['id'], int) or isinstance(frame['id'], bool) or not isinstance(frame['args'], dict)):
            return frame.get('id') if isinstance(frame, dict) and isinstance(frame.get('id'), int) else None, None, ('command_rejected', 'bad_frame')
        frame_id = frame['id']
        try:
            if frame_id <= state['last_id']:
                raise Rejected('non_monotonic_id')
            state['last_id'] = frame_id
            return frame_id, self.dispatch(frame['cmd'], frame['args'], state), None
        except Rejected as rejected:
            return frame_id, None, (rejected.code, rejected.detail)
        except (topology.ScenarioError, faults.FaultError) as invalid:
            return frame_id, None, (invalid.code, invalid.detail)
        except Exception as failure:  # backend failure: report, never crash the server
            return frame_id, None, ('worker_failed', '%s: %s' % (type(failure).__name__, str(failure)[:200]))

    def dispatch(self, cmd, args, state):
        if cmd not in COMMANDS:
            raise Rejected('unknown_command')
        if self.stopped:
            raise Rejected('worker_stopped', 'worker_unavailable')
        if cmd == 'hello':
            return self.hello(args, state)
        if state['role'] is None:
            raise Rejected('not_ready')
        if state['role'] not in COMMANDS[cmd]:
            raise Rejected('role_forbidden')
        with self.lock:
            if cmd == 'build':
                self.spec = topology.validate_scenario(args)
                return self.backend.build(self.spec)
            if cmd == 'shutdown':
                self.stopped = True
                return {'stopped': True}
            if cmd == 'inject_fault':
                if self.spec is None:
                    raise Rejected('not_built')
                return self.backend.inject_fault(faults.validate_fault(args, self.spec))
            if cmd == 'telemetry':
                interval = args.get('intervalMs')
                if interval is not None and (isinstance(interval, bool) or not isinstance(interval, (int, float)) or not 0 < interval <= 60000):
                    raise Rejected('bad_quantity')
                return self.backend.telemetry(interval)
            if cmd == 'start_traffic':
                return self.backend.start_traffic(args)
            if cmd == 'collect':
                return self.backend.collect()
            if cmd == 'teardown':
                return self.backend.teardown()
            if cmd in CONTROL_COMMANDS or cmd in ('operation', 'probe_result'):
                if not isinstance(args.get('operationId'), str) or not OPERATION_ID.match(args['operationId']):
                    raise Rejected('operation_id_required')
            return self.backend.control(cmd, args)

    def hello(self, args, state):
        if args.get('protocol') != PROTOCOL:
            raise Rejected('protocol_mismatch')
        if args.get('runId') != self.run_id:
            raise Rejected('run_mismatch')
        if args.get('units') != UNITS:
            raise Rejected('units_mismatch')
        if args.get('role') not in self.roles:
            raise Rejected('role_forbidden')
        state['role'] = args['role']
        return {'protocol': PROTOCOL, 'runId': self.run_id, 'role': args['role'], 'units': UNITS,
                'epochMonotonicNs': str(self.epoch_ns), 'workerPid': os.getpid()}


class MininetBackend:
    """Owns the run's Mininet network. Created objects carry the run tag; nothing else is touched."""

    def __init__(self, run_dir, epoch_ns, tag):
        self.run_dir, self.epoch_ns, self.tag = run_dir, epoch_ns, tag
        self.net = self.names = self.ports = self.spec = None
        self.procs = []
        self.telemetry_seq = 0
        self.tails = {}

    def build(self, spec):
        import controls
        if self.net is not None:
            raise Rejected('already_built')
        self.spec = spec
        self.net, self.names = topology.build_network(spec, self.tag)
        self.ports = topology.port_map(spec, self.names)
        controls.set_static_arp(spec, self.names)
        self.routes = controls.RouteTable(spec, self.names, self.ports, controls.OvsOpenFlow())
        installed = self.routes.install_reference()
        self.rates = controls.RateControl(spec, self.run_dir)
        self.rates.initialize()
        self.operations = controls.Operations()
        self.probe_results = {}
        return {'configRevision': self.routes.config_revision, 'policy': installed,
                'interfaces': {'%s>%s' % k: {'ofport': v[0], 'name': v[1]} for k, v in sorted(self.ports.items())}}

    def start_traffic(self, args):
        start, stop = float(args['startAtMs']), float(args['stopAtMs'])
        tail_ms = float(args.get('tailMs', 2000))
        here = os.path.dirname(os.path.abspath(__file__))
        hosts = {h['hostId']: h for h in self.spec['topology']['hosts']}
        script = os.path.join(here, 'traffic.py')

        def launch(host, mode, cfg):
            self.procs.append(self.names[host].popen(['python3', script, mode, json.dumps(cfg)]))

        listen = stop + tail_ms + max(f['deadlineMs'] for f in self.spec['workload']['essential'])
        for f in self.spec['workload']['essential']:
            base = {'epochNs': self.epoch_ns, 'flowId': f['flowId'], 'port': f['port'], 'ackPort': f['ackPort']}
            launch(f['destination'], 'essential-receiver', dict(base, listenUntilMs=listen, log=self._log('rx', f['flowId'])))
        for f in self.spec['workload']['background']:
            launch(f['destination'], 'bulk-receiver', {'epochNs': self.epoch_ns, 'port': f['port'], 'listenUntilMs': listen,
                                                         'log': self._log('bulk-rx', f['sourceId'])})
        time.sleep(0.3)
        for f in self.spec['workload']['essential']:
            launch(f['source'], 'essential-sender', {
                'epochNs': self.epoch_ns, 'startAtMs': start, 'stopAtMs': stop, 'flowId': f['flowId'],
                'messagesPerS': f['messagesPerS'], 'payloadBytes': f['payloadBytes'], 'deadlineMs': f['deadlineMs'],
                'retryAtMs': f['retryAtMs'], 'port': f['port'], 'ackPort': f['ackPort'],
                'destinationIp': hosts[f['destination']]['ip'], 'log': self._log('tx', f['flowId'])})
        for f in self.spec['workload']['background']:
            rate_file = self.rates.path(f['sourceId'])
            launch(f['source'], 'bulk-sender', {
                'epochNs': self.epoch_ns, 'startAtMs': start, 'stopAtMs': stop, 'bitsPerSecond': f['bitsPerSecond'],
                'packetBytes': f['packetBytes'], 'port': f['port'], 'destinationIp': hosts[f['destination']]['ip'],
                'rateFile': rate_file, 'log': self._log('bulk-tx', f['sourceId'])})
        return {'processes': len(self.procs), 'listenUntilMs': listen}

    def _log(self, kind, name):
        return os.path.join(self.run_dir, '%s-%s.jsonl' % (kind, name))

    def _service_counters(self):
        """Sender-side application counters: what an endpoint can report, not the scorer's receipts."""
        import telemetry
        services = {}
        for f in self.spec['workload']['essential']:
            path = self._log('tx', f['flowId'])
            tail = self.tails.setdefault(path, {'offset': 0, 'counter': telemetry.ServiceCounter(f['deadlineMs'])})
            try:
                with open(path) as handle:
                    handle.seek(tail['offset'])
                    for line in handle:
                        if not line.endswith('\n'):
                            break
                        tail['offset'] += len(line.encode())
                        tail['counter'].feed(json.loads(line))
            except OSError:
                services[f['flowId']] = {k: None for k in ('offered', 'transmissions', 'acked', 'ackedWithinDeadline', 'resolvedOffered', 'resolvedOnTime')}
                continue
            services[f['flowId']] = tail['counter'].snapshot(time.monotonic_ns())
        return services

    def telemetry(self, interval_ms=None):
        import telemetry
        if self.net is None:
            raise Rejected('not_built')
        if time.monotonic_ns() < getattr(self, 'hold_until_ns', 0):
            raise Rejected('telemetry_unavailable')
        links = telemetry.collect_links(self.spec, self.names, self.ports)
        collected = telemetry.now_ms(self.epoch_ns)
        sample = {'collectedAtMs': round(collected, 3), 'links': links, 'services': self._service_counters()}
        self.telemetry_seq += 1
        return telemetry.build_observation(self.spec_run_id, self.telemetry_seq, sample, self.spec, self.routes.config_revision,
                                           telemetry.now_ms(self.epoch_ns), interval_ms=interval_ms)

    def inject_fault(self, fault):
        if self.net is None:
            raise Rejected('not_built')
        if fault['kind'] == 'telemetry_hold':
            self.hold_until_ns = time.monotonic_ns() + int(fault['durationMs'] * 1e6)
            return {'applied': True, 'appliedAtMs': round((time.monotonic_ns() - self.epoch_ns) / 1e6, 3)}
        result = faults.apply_fault(self.net, self.names, self.spec, fault)
        result['appliedAtMs'] = round(time.monotonic_ns() / 1e6 - self.epoch_ns / 1e6, 3)
        return result

    def control(self, cmd, args):
        import controls
        if self.net is None:
            raise Rejected('not_built')
        op = args.get('operationId')
        fields = {k: v for k, v in args.items() if k != 'operationId'}
        try:
            if cmd == 'operation':
                return self.operations.lookup(op)
            if cmd == 'verify_route':
                return self.routes.verify(args['flowId'], args['version'])
            if cmd == 'probe_result':
                return self.probe_results.get(op, {'operationId': op, 'status': 'unknown'})
            if cmd == 'control_state':
                return dict(self.routes.state(), rates={s: self.rates.read(s) for s in self.rates.sources})
            effect = {
                'prepare_route': lambda: self.routes.prepare(op, fields['flowId'], fields['path'], fields.get('ackPath')),
                'commit_route': lambda: self.routes.commit(op, fields['flowId'], fields['version']),
                'retire_route': lambda: self.routes.retire(op, fields['flowId'], fields['version']),
                'abort_route': lambda: self.routes.abort(op, fields['flowId'], fields['version']),
                'set_rate': lambda: self.rates.set(fields['sourceId'], fields['bitsPerSecond']),
                'probe': lambda: self.start_probe(op, fields),
            }[cmd]
            return self.operations.run(op, cmd, fields, effect)
        except controls.ControlError as error:
            raise Rejected(error.detail, 'action_rejected')
        except KeyError as missing:
            raise Rejected('missing_field')

    def start_probe(self, op, fields):
        """Install pinned rules and run the probe in the host namespaces without holding the worker lock."""
        import controls
        import threading as _threading
        hosts = {h['hostId']: h for h in self.spec['topology']['hosts']}
        source, destination = fields['sourceId'], fields['destinationId']
        if source not in hosts or destination not in hosts or source == destination:
            raise controls.ControlError('bad_endpoint')
        count, size, interval = fields['packetCount'], fields['payloadBytes'], fields['intervalMs']
        for value in (count, size, interval):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
                raise controls.ControlError('bad_quantity')
        if count > 64 or count * size > 65536 or size < 24 or interval < 5:
            raise controls.ControlError('probe_oversized')
        probe = controls.ProbeRules(self.spec, self.names, self.ports, self.routes.of, hosts)
        path = fields.get('path') or probe.default_path(source, destination)
        self.probe_count = getattr(self, 'probe_count', 0) + 1
        installed = probe.install(self.probe_count, source, destination, path)
        self.probe_results[op] = {'operationId': op, 'status': 'running', 'path': path}
        here = os.path.dirname(os.path.abspath(__file__))
        script = os.path.join(here, 'traffic.py')
        duration_ms = count * interval + 1000

        def run():
            echo = self.names[destination].popen(['python3', script, 'probe-echo', json.dumps({'port': controls.PROBE_PORT, 'listenMs': duration_ms + 500})])
            time.sleep(0.15)
            sender = self.names[source].popen(['python3', script, 'probe-sender', json.dumps({
                'destinationIp': hosts[destination]['ip'], 'port': controls.PROBE_PORT, 'packetCount': int(count),
                'payloadBytes': int(size), 'intervalMs': interval, 'tailMs': 1000})])
            out, _ = sender.communicate(timeout=duration_ms / 1000 + 10)
            echo.wait(duration_ms / 1000 + 10)
            remaining = probe.remove(installed)
            try:
                measured = json.loads(out.decode().strip().splitlines()[-1])
                self.probe_results[op] = dict(measured, operationId=op, status='complete', path=path, rulesRemaining=remaining)
            except (ValueError, IndexError):
                self.probe_results[op] = {'operationId': op, 'status': 'failed', 'detail': 'probe_output_missing', 'path': path, 'rulesRemaining': remaining}

        _threading.Thread(target=run, daemon=True).start()
        return {'status': 'started', 'path': path}

    def collect(self):
        running = [p.pid for p in self.procs if p.poll() is None]
        return {'running': running, 'logs': sorted(os.listdir(self.run_dir))}

    def teardown(self):
        for proc in self.procs:
            if proc.poll() is None:
                proc.terminate()
        for proc in self.procs:
            try:
                proc.wait(5)
            except Exception:
                proc.kill()
        if self.net is not None:
            self.net.stop()
            self.net = None
        import subprocess
        bridges = subprocess.run(['ovs-vsctl', 'list-br'], capture_output=True, text=True).stdout.split()
        links = subprocess.run(['ip', '-o', 'link', 'show'], capture_output=True, text=True).stdout
        return {'runOwnedBridgesRemaining': [b for b in bridges if b.startswith(self.tag)],
                'runOwnedLinksRemaining': sorted({l.split(':')[1].strip().split('@')[0] for l in links.splitlines()
                                                  if l.split(':')[1].strip().startswith(self.tag)}),
                'orphanProcesses': [p.pid for p in self.procs if p.poll() is None]}


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--dir', required=True)
    parser.add_argument('--tag', required=True, help='run-owned object prefix, e.g. lfa1')
    args = parser.parse_args(argv)
    if not topology.NAME.match(args.tag) or len(args.tag) > 4:
        raise SystemExit('tag must be a short registered name')
    os.makedirs(args.dir, exist_ok=True)
    epoch = time.monotonic_ns()
    backend = MininetBackend(args.dir, epoch, args.tag)
    proto = WorkerProtocol(args.run_id, backend, epoch_ns=epoch)
    backend.spec_run_id = args.run_id
    if os.path.exists(args.socket):
        raise SystemExit('socket already exists: refusing to reuse another run')
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(args.socket)
    owner = int(os.environ.get('SUDO_UID', os.getuid()))
    os.chown(args.socket, owner, -1)
    os.chmod(args.socket, 0o600)
    server.listen(4)
    server.settimeout(0.5)
    threads = []
    try:
        while not proto.stopped:
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            thread = threading.Thread(target=proto.serve, args=(conn,), daemon=True)
            thread.start()
            threads.append(thread)
    finally:
        if backend.net is not None:
            backend.teardown()
        server.close()
        os.unlink(args.socket)


if __name__ == '__main__':
    main(sys.argv[1:])
