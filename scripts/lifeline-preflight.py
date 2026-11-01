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


# Tool caches whose defaults land on the internal drive unless redirected; checked when configured.
CACHE_ENV = ('PLAYWRIGHT_BROWSERS_PATH', 'PIP_CACHE_DIR')
WORK_ROOTS = {'environments': '.work/environments', 'cache': '.work/cache', 'downloads': '.work/downloads', 'tmp': '.work/tmp',
              'build': '.work/build', 'logs': '.work/logs', 'vm': '.work/vm', 'artifacts': 'artifacts/lifeline'}


def mounted_images(fixture):
    """Mount point -> backing image file, from hdiutil (macOS) or a test fixture."""
    if fixture:
        with open(fixture) as handle:
            return json.load(handle)
    import plistlib
    try:
        info = plistlib.loads(subprocess.run(['hdiutil', 'info', '-plist'], capture_output=True, timeout=10).stdout)
    except Exception:
        return {}
    images = {}
    for image in info.get('images', []):
        for entity in image.get('system-entities', []):
            if entity.get('mount-point'):
                images[entity['mount-point']] = image.get('image-path')
    return images


def check_storage(role, ssd_root, repo, out, vm_backing, workspace, caches=(), projected=0, reserve=0, image_fixture=None):
    repo_real = os.path.realpath(repo)
    record = {'role': role, 'repo': repo_real, 'output': os.path.realpath(out)}

    def fail(code, detail, path=None):
        record.update(code=code, detail=detail)
        if path:
            record['path'] = path
        return record

    if role == 'host':
        record.update(ssdRoot=ssd_root, ssdRootOverridden=ssd_root != CANONICAL_SSD)
        if not is_mount(ssd_root):
            return fail('storage_unavailable', 'SSD root is not a mounted volume')
        if not within(repo_real, ssd_root):
            return fail('storage_path_rejected', 'repository does not resolve onto the SSD')
        record['roots'] = {name: os.path.realpath(os.path.join(repo_real, rel)) for name, rel in WORK_ROOTS.items()}
        for name, path in record['roots'].items():
            if not within(path, ssd_root):
                return fail('storage_path_rejected', 'work_root_off_ssd', '%s=%s' % (name, path))
        configured = [(p, p) for p in caches] + [('%s=%s' % (k, os.environ[k]), os.environ[k]) for k in CACHE_ENV if os.environ.get(k)]
        for label, path in configured:
            if not within(path, ssd_root):
                return fail('storage_path_rejected', 'cache_off_ssd', label)
        record['caches'] = [os.path.realpath(p) for _, p in configured]
        images = None
        backing = []
        for path in vm_backing:
            real = os.path.realpath(path)
            if within(real, ssd_root):
                backing.append({'path': real, 'image': None})
                continue
            images = mounted_images(image_fixture) if images is None else images
            mount = max((m for m in images if within(real, m)), key=len, default=None)
            image = images.get(mount) if mount else None
            if not image or not within(image, ssd_root):
                return fail('storage_path_rejected', 'vm_backing_off_ssd', real)
            backing.append({'path': real, 'mountPoint': mount, 'image': os.path.realpath(image)})
        record['vmBacking'] = backing
        free = shutil.disk_usage(ssd_root).free
        record['freeBytes'] = free
        record['capacity'] = {'freeBytes': free, 'projectedBytes': projected, 'reserveBytes': reserve, 'requiredBytes': projected + reserve}
        if free < projected + reserve:
            return fail('storage_insufficient', 'free space below projected batch plus reserve')
    else:
        # Inside the VM, the SSD is reached through the VM disk; the host report qualifies that backing.
        record['workspace'] = os.path.realpath(workspace)
        if not within(repo_real, workspace):
            return fail('storage_path_rejected', 'repository does not resolve into the guest workspace')
        record['freeBytes'] = shutil.disk_usage(repo_real).free
        # Raw run logs are written to guest RAM-backed /run before they are copied into the bundle.
        scratch = shutil.disk_usage('/run').free if os.path.isdir('/run') else None
        record['capacity'] = {'freeBytes': record['freeBytes'], 'scratchFreeBytes': scratch, 'projectedBytes': projected,
                              'reserveBytes': reserve, 'requiredBytes': projected + reserve}
        if record['freeBytes'] < projected + reserve or (scratch is not None and scratch < projected + reserve):
            return fail('storage_insufficient', 'workspace or /run scratch below projected batch plus reserve')
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
    parser.add_argument('--cache', action='append', default=[], help='cache directory that must resolve onto the SSD')
    parser.add_argument('--projected-bytes', type=int, default=0, help='estimated bytes the next batch will write')
    parser.add_argument('--reserve-bytes', type=int, default=0, help='free space that must remain after the batch')
    parser.add_argument('--disk-image-fixture', default=None, help='test only: JSON {mountPoint: imagePath} instead of hdiutil')
    args = parser.parse_args(argv)

    report = {'schema': SCHEMA, 'generatedAtUnix': round(time.time(), 3),
              'storage': check_storage(args.role, args.ssd_root, args.repo, args.out, args.vm_backing, args.workspace,
                                       args.cache, args.projected_bytes, args.reserve_bytes, args.disk_image_fixture)}
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
