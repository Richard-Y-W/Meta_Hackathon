#!/usr/bin/env python3
"""LIFELINE platform preflight: storage admission, then capability detection.

Storage is checked before anything is written. Capability probes only read
host state; nothing is installed and no persistent network object is created.
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time

SCHEMA = 'lifeline.preflight.v1'
CANONICAL_SSD = '/Volumes/PortableSSD'
OUTPUT_ROOTS = ('artifacts', '.work')


def within(path, root):
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real == base or real.startswith(base + os.sep)


def is_mount(path):
    try:
        return os.path.ismount(path) and os.stat(path).st_dev != os.stat('/').st_dev
    except OSError:
        return False


def check_storage(role, ssd_root, repo, out, vm_backing, workspace):
    repo_real = os.path.realpath(repo)
    record = {'role': role, 'repo': repo_real, 'output': os.path.realpath(out)}

    def fail(code, detail):
        record.update(code=code, detail=detail)
        return record

    if role == 'host':
        record.update(ssdRoot=ssd_root, ssdRootOverridden=ssd_root != CANONICAL_SSD)
        if not is_mount(ssd_root):
            return fail('storage_unavailable', 'SSD root is not a mounted volume')
        if not within(repo_real, ssd_root):
            return fail('storage_path_rejected', 'repository does not resolve onto the SSD')
        for path in vm_backing:
            if not within(path, ssd_root):
                return fail('storage_path_rejected', 'VM/container backing path resolves off the SSD: %s' % os.path.realpath(path))
        record['vmBacking'] = [os.path.realpath(p) for p in vm_backing]
        record['freeBytes'] = shutil.disk_usage(ssd_root).free
    else:
        # Inside the VM, the SSD is reached through the VM disk; the host report qualifies that backing.
        record['workspace'] = os.path.realpath(workspace)
        if not within(repo_real, workspace):
            return fail('storage_path_rejected', 'repository does not resolve into the guest workspace')
        record['freeBytes'] = shutil.disk_usage(repo_real).free
    if not any(within(out, os.path.join(repo_real, r)) for r in OUTPUT_ROOTS):
        return fail('storage_path_rejected', 'output resolves outside artifacts/ and .work/')
    record.update(code='ok', detail='admitted')
    return record


def run(cmd, timeout=10):
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return done.returncode, (done.stdout or done.stderr).strip()
    except (OSError, subprocess.TimeoutExpired):
        return None, ''


def credential_present(repo):
    if os.environ.get('MODEL_API_KEY'):
        return True
    try:
        with open(os.path.join(repo, '.env')) as handle:
            return any(line.split('=', 1)[0].strip() == 'MODEL_API_KEY' and line.split('=', 1)[1].strip()
                       for line in handle if '=' in line)
    except OSError:
        return False


def live_probe(repo):
    linux = platform.system() == 'Linux'
    root = hasattr(os, 'geteuid') and os.geteuid() == 0
    sudo = [] if root else ['sudo', '-n']
    privileged = root or (linux and run(['sudo', '-n', 'true'])[0] == 0)
    code, mn = run(['mn', '--version']) if shutil.which('mn') else (None, '')
    ovs_code, ovs = run(['ovs-vsctl', '--version']) if shutil.which('ovs-vsctl') else (None, '')
    probe = {
        'platform': platform.system(), 'kernel': platform.release(), 'python': platform.python_version(),
        'netns': linux and os.path.exists('/proc/self/ns/net') and privileged
                 and run(sudo + ['unshare', '--net', 'true'])[0] == 0,
        'mininet': mn.splitlines()[-1] if code == 0 and mn else None,
        'ovs': ovs.splitlines()[0] if ovs_code == 0 and ovs else None,
        'ovsRunning': bool(ovs_code == 0 and privileged and run(sudo + ['ovs-vsctl', 'show'])[0] == 0),
        'privileged': privileged,
        'credential': credential_present(repo),
    }
    node = run(['node', '--version'])
    probe['node'] = node[1] if node[0] == 0 else None
    probe['cpus'] = os.cpu_count()
    if hasattr(os, 'getloadavg'):
        probe['loadAverage'] = list(os.getloadavg())
    try:
        with open('/proc/meminfo') as handle:
            probe['memoryKiB'] = int(handle.readline().split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return probe


def classify(probe):
    caps = {}

    def cap(name, ok, code, detail=''):
        caps[name] = {'available': bool(ok), 'code': 'ok' if ok else code, 'detail': detail}

    cap('linux', probe.get('platform') == 'Linux', 'linux_unavailable', probe.get('platform') or '')
    cap('netns', probe.get('netns'), 'netns_unavailable')
    cap('mininet', probe.get('mininet'), 'mininet_missing', probe.get('mininet') or '')
    if not probe.get('ovs'):
        cap('ovs', False, 'ovs_missing')
    else:
        cap('ovs', probe.get('ovsRunning'), 'ovs_not_running', probe.get('ovs'))
    cap('workerPrivilege', probe.get('privileged'), 'privilege_unavailable')
    cap('credential', probe.get('credential'), 'credential_missing')
    return caps


def emit(report, out, write):
    text = json.dumps(report, indent=2, sort_keys=True)
    if write:
        os.makedirs(os.path.dirname(os.path.realpath(out)), exist_ok=True)
        with open(os.path.realpath(out), 'w') as handle:
            handle.write(text + '\n')
    print(text)


def main(argv):
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True)
    parser.add_argument('--repo', default=here)
    parser.add_argument('--role', choices=('host', 'guest'), default='host')
    parser.add_argument('--ssd-root', default=CANONICAL_SSD)
    parser.add_argument('--workspace', default='/workspace')
    parser.add_argument('--host-mapping', default=None, help='guest only: text recording the SSD-backed VM disk')
    parser.add_argument('--vm-backing', action='append', default=[])
    parser.add_argument('--probe-fixture', default=None, help='test only: recorded probe values instead of live probes')
    parser.add_argument('--storage-only', action='store_true')
    args = parser.parse_args(argv)

    report = {'schema': SCHEMA, 'generatedAtUnix': round(time.time(), 3),
              'storage': check_storage(args.role, args.ssd_root, args.repo, args.out, args.vm_backing, args.workspace)}
    if args.role == 'guest':
        report['hostMapping'] = args.host_mapping
    if report['storage']['code'] != 'ok':
        emit(report, args.out, write=False)
        return 2
    if not args.storage_only:
        if args.probe_fixture:
            with open(args.probe_fixture) as handle:
                probe, source = json.load(handle), 'fixture'
        else:
            probe, source = live_probe(report['storage']['repo']), 'live'
        caps = classify(probe)
        packet = ('linux', 'netns', 'mininet', 'ovs', 'workerPrivilege')
        report.update(
            probeSource=source,
            qualificationEvidence=source == 'live' and not report['storage'].get('ssdRootOverridden', False),
            capabilities=caps,
            missing=[c['code'] for c in caps.values() if not c['available']],
            packetReady=all(caps[name]['available'] for name in packet),
            providerReady=caps['credential']['available'],
            versions={k: probe.get(k) for k in ('kernel', 'python', 'node', 'mininet', 'ovs')},
            host={k: probe.get(k) for k in ('platform', 'cpus', 'memoryKiB', 'loadAverage')},
        )
    emit(report, args.out, write=True)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
