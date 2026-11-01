#!/usr/bin/env python3
"""Task 1 packet qualification: two hosts, one run-owned switch, real UDP messages.

Run as root inside the isolated Linux VM:
    sudo python3 runtime/mininet/packet_smoke.py --out .work/packet-smoke.json
Only network objects created by this run (prefix lf<run>) are removed; `mn -c` is never used.
"""
import argparse
import json
import os
import subprocess
import sys
import time

from mininet.link import TCLink
from mininet.net import Mininet
from mininet.node import OVSSwitch

RECEIVER = r'''
import json, socket, sys, time
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("0.0.0.0", 5005)); sock.settimeout(0.2)
end = time.monotonic() + float(sys.argv[2])
with open(sys.argv[1], "w") as out:
    while time.monotonic() < end:
        try: data, _ = sock.recvfrom(4096)
        except socket.timeout: continue
        out.write(json.dumps({"id": data[:32].decode().strip(), "receivedAtNs": time.monotonic_ns(), "bytes": len(data)}) + "\n"); out.flush()
'''

SENDER = r'''
import json, socket, sys, time
dest, count, interval, payload = sys.argv[2], int(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5])
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
with open(sys.argv[1], "w") as out:
    for i in range(count):
        mid = "m%06d" % i
        out.write(json.dumps({"id": mid, "createdAtNs": time.monotonic_ns()}) + "\n"); out.flush()  # offered before transmission
        sock.sendto(mid.ljust(32).encode() + b"x" * (payload - 32), (dest, 5005))
        time.sleep(interval)
'''


def sh(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stdout.split()


def read_lines(path):
    with open(path) as handle:
        return [json.loads(line) for line in handle if line.strip()]


def check_controls(net, h1, h2, s1):
    """Exercise each control primitive LIFELINE will need and read back its effect."""
    controls = {}
    reach = lambda: '1 received' in h1.cmd('ping -c 1 -W 1 10.77.0.2')
    net.configLinkStatus(s1.name, h2.name, 'down')
    controls['linkDown'] = {'appliedUnreachable': not reach()}
    net.configLinkStatus(s1.name, h2.name, 'up')
    time.sleep(0.5)
    controls['linkUp'] = {'appliedReachable': reach()}
    intf = s1.connectionsTo(h2)[0][0]
    intf.config(bw=2)
    qdisc = s1.cmd('tc class show dev %s' % intf.name)
    controls['rateChange'] = {'requestedMbit': 2, 'readBack': '2Mbit' in qdisc, 'tc': qdisc.strip().splitlines()[:2]}
    intf.config(bw=10)
    s1.cmd('ovs-ofctl add-flow %s "cookie=0x77,priority=50,ip,nw_dst=10.77.0.2,actions=NORMAL"' % s1.name)
    flows = s1.cmd('ovs-ofctl dump-flows %s cookie=0x77/-1' % s1.name)
    controls['flowInstall'] = {'readBack': 'priority=50' in flows}
    s1.cmd('ovs-ofctl del-flows %s cookie=0x77/-1' % s1.name)
    controls['flowRemove'] = {'readBack': 'priority=50' not in s1.cmd('ovs-ofctl dump-flows %s cookie=0x77/-1' % s1.name)}
    controls['allSupported'] = all(v for c in controls.values() for k, v in c.items() if k != 'tc' and isinstance(v, bool))
    return controls


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--count', type=int, default=200)
    parser.add_argument('--interval-ms', type=float, default=10.0)
    parser.add_argument('--payload-bytes', type=int, default=1024)
    args = parser.parse_args(argv)
    tag = 'lf%04d' % (os.getpid() % 10000)
    work = os.path.join(os.path.dirname(os.path.abspath(args.out)), tag)
    os.makedirs(work, exist_ok=True)
    before = {'bridges': sh('ovs-vsctl', 'list-br'), 'links': sh('ip', '-o', 'link', 'show')[1::9]}

    net = Mininet(switch=OVSSwitch, link=TCLink, controller=None, autoSetMacs=True, build=False)
    h1, h2 = net.addHost(tag + 'h1', ip='10.77.0.1/24'), net.addHost(tag + 'h2', ip='10.77.0.2/24')
    s1 = net.addSwitch(tag + 's1', failMode='standalone', dpid='0000000000007701')
    net.addLink(h1, s1, bw=10, delay='5ms')
    net.addLink(s1, h2, bw=10, delay='5ms')
    result = {'schema': 'lifeline.packet-smoke.v1', 'evidenceLevel': 'emulator-packets', 'runTag': tag,
              'topology': {'hosts': [h1.name, h2.name], 'switch': s1.name, 'linkBwMbit': 10, 'linkDelayMs': 5}}
    try:
        net.build(); net.start()
        result['interfaces'] = {n.name: [i.name for i in n.intfList()] for n in (h1, h2, s1)}
        ping = h1.cmd('ping -c 5 -i 0.2 -q 10.77.0.2')
        result['ping'] = ping.strip().splitlines()[-2:]
        horizon_s = args.count * args.interval_ms / 1000 + 2
        receipts, offered = os.path.join(work, 'receipts.jsonl'), os.path.join(work, 'offered.jsonl')
        rx = h2.popen(['python3', '-c', RECEIVER, receipts, str(horizon_s)])
        time.sleep(0.3)
        tx = h1.popen(['python3', '-c', SENDER, offered, '10.77.0.2', str(args.count), str(args.interval_ms / 1000), str(args.payload_bytes)])
        tx.wait(); rx.wait()
        sent, got = read_lines(offered), read_lines(receipts)
        created = {r['id']: r['createdAtNs'] for r in sent}
        first = {}
        for r in got:
            first.setdefault(r['id'], r['receivedAtNs'])
        delays = sorted((first[i] - created[i]) / 1e6 for i in first if i in created)
        result['messages'] = {
            'offered': len(sent), 'receipts': len(got), 'uniqueDelivered': len([i for i in first if i in created]),
            'unknownIds': len([i for i in first if i not in created]), 'payloadBytes': args.payload_bytes,
            'oneWayDelayMs': {'min': delays[0], 'median': delays[len(delays) // 2], 'max': delays[-1]} if delays else None,
            'clock': 'CLOCK_MONOTONIC, same kernel for sender and receiver',
        }
        result['controls'] = check_controls(net, h1, h2, s1)
    finally:
        net.stop()
    after = {'bridges': sh('ovs-vsctl', 'list-br'), 'links': sh('ip', '-o', 'link', 'show')[1::9]}
    result['teardown'] = {
        'runOwnedBridgesRemaining': [b for b in after['bridges'] if b.startswith(tag)],
        'runOwnedLinksRemaining': [l for l in after['links'] if l.startswith(tag)],
        'preexistingBridgesPreserved': all(b in after['bridges'] for b in before['bridges']),
        'bridgesBefore': before['bridges'], 'bridgesAfter': after['bridges'],
    }
    with open(args.out, 'w') as handle:
        json.dump(result, handle, indent=2, sort_keys=True)
    print(json.dumps({k: result.get(k) for k in ('messages', 'controls', 'teardown')}, indent=1))
    clean = not result['teardown']['runOwnedBridgesRemaining'] and not result['teardown']['runOwnedLinksRemaining']
    return 0 if clean and result.get('messages', {}).get('uniqueDelivered') else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
