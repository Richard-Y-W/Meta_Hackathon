#!/usr/bin/env python3
"""Remove the network objects and processes of one interrupted run, identified by its tag.

    sudo python3 runtime/mininet/cleanup.py --tag lfx0

Only names that start with the validated run tag are touched; `mn -c` is never used.
"""
import argparse
import json
import os
import re
import signal
import subprocess
import sys

TAG = re.compile(r'^lf[a-z0-9]{1,2}$')


def run(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def cleanup(tag):
    removed = {'bridges': [], 'links': [], 'processes': []}
    for bridge in run('ovs-vsctl', 'list-br').split():
        if bridge.startswith(tag):
            subprocess.run(['ovs-vsctl', 'del-br', bridge])
            removed['bridges'].append(bridge)
    for line in run('ip', '-o', 'link', 'show').splitlines():
        name = line.split(':')[1].strip().split('@')[0]
        if name.startswith(tag):
            subprocess.run(['ip', 'link', 'del', name], capture_output=True)  # a veth peer may already be gone
            removed['links'].append(name)
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            with open('/proc/%s/cmdline' % pid, 'rb') as handle:
                args = handle.read().split(b'\0')
        except OSError:
            continue
        # Mininet host shells carry 'mininet:<node>' as an argument; traffic generators name their node's logs.
        if any(a.decode(errors='ignore').startswith('mininet:' + tag) for a in args):
            try:
                os.kill(int(pid), signal.SIGKILL)
                removed['processes'].append(int(pid))
            except OSError:
                pass
    return removed


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--tag', required=True)
    tag = parser.parse_args().tag
    if not TAG.match(tag):
        sys.exit('refusing: tag must match %s' % TAG.pattern)
    print(json.dumps(cleanup(tag)))
