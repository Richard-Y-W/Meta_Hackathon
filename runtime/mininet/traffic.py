"""Scheduled application traffic, run inside Mininet host namespaces.

    python3 traffic.py essential-sender  '<json>'   offered/transmission/ack records
    python3 traffic.py essential-receiver '<json>'  receipt records; sends an ack per copy
    python3 traffic.py bulk-sender '<json>'         scheduled and sent bytes; rate from a control file
    python3 traffic.py bulk-receiver '<json>'       delivered bytes per 100 ms bin

All times are CLOCK_MONOTONIC nanoseconds of the shared kernel. The essential schedule
is fixed by the scenario and never consults the controller.
"""
import json
import os
import select
import socket
import sys
import time

HEADER = 40  # message id, space padded; then attempt digit


def log(handle, record):
    handle.write(json.dumps(record, separators=(',', ':')) + '\n')
    handle.flush()


def essential_sender(cfg):
    start_ns = cfg['epochNs'] + int(cfg['startAtMs'] * 1e6)
    stop_ns = cfg['epochNs'] + int(cfg['stopAtMs'] * 1e6)
    period_ns = int(1e9 / cfg['messagesPerS'])
    retries_ns = [int(r * 1e6) for r in cfg['retryAtMs']]
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('0.0.0.0', cfg['ackPort']))
    sock.setblocking(False)
    pad = b'x' * (cfg['payloadBytes'] - HEADER - 1)
    pending = {}  # id -> [created_ns, next retry index]
    index = 0
    linger_ns = stop_ns + int((max(retries_ns + [0]) + cfg['deadlineMs']) * 1e6)
    with open(cfg['log'], 'w') as out:
        def transmit(mid, attempt):
            sock.sendto(mid.ljust(HEADER).encode() + str(attempt).encode() + pad, (cfg['destinationIp'], cfg['port']))
            log(out, {'t': 'tx', 'id': mid, 'attempt': attempt, 'atNs': time.monotonic_ns()})

        while True:
            now = time.monotonic_ns()
            next_new = start_ns + index * period_ns
            if next_new < stop_ns and now >= next_new:
                mid = '%s:%06d' % (cfg['flowId'], index)
                log(out, {'t': 'offered', 'id': mid, 'flowId': cfg['flowId'], 'scheduledNs': next_new,
                          'createdAtNs': now, 'deadlineMs': cfg['deadlineMs']})  # recorded before transmission
                pending[mid] = [now, 0]
                transmit(mid, 0)
                index += 1
                continue
            for mid, state in list(pending.items()):
                if state[1] < len(retries_ns) and now >= state[0] + retries_ns[state[1]]:
                    state[1] += 1
                    transmit(mid, state[1])
                elif state[1] >= len(retries_ns) and now > state[0] + int(cfg['deadlineMs'] * 1e6):
                    del pending[mid]
            if next_new >= stop_ns and (not pending or now >= linger_ns):
                break
            wake = [next_new] if next_new < stop_ns else []
            wake += [s[0] + retries_ns[s[1]] for s in pending.values() if s[1] < len(retries_ns)]
            timeout = max(0.0, min(wake + [now + 5_000_000]) - time.monotonic_ns()) / 1e9
            ready, _, _ = select.select([sock], [], [], timeout)
            while ready:
                try:
                    data, _ = sock.recvfrom(256)
                except BlockingIOError:
                    break
                mid = data[:HEADER].decode().strip()
                log(out, {'t': 'ack', 'id': mid, 'atNs': time.monotonic_ns()})
                pending.pop(mid, None)
        log(out, {'t': 'complete', 'offered': index, 'atNs': time.monotonic_ns()})


def essential_receiver(cfg):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('0.0.0.0', cfg['port']))
    stop_ns = cfg['epochNs'] + int(cfg['listenUntilMs'] * 1e6)
    with open(cfg['log'], 'w') as out:
        while time.monotonic_ns() < stop_ns:
            ready, _, _ = select.select([sock], [], [], 0.2)
            if not ready:
                continue
            data, (ip, _) = sock.recvfrom(2048)
            now = time.monotonic_ns()
            mid = data[:HEADER].decode().strip()
            log(out, {'t': 'rx', 'id': mid, 'attempt': int(data[HEADER:HEADER + 1]), 'receivedAtNs': now, 'bytes': len(data)})
            sock.sendto(mid.ljust(HEADER).encode(), (ip, cfg['ackPort']))
        log(out, {'t': 'complete', 'atNs': time.monotonic_ns()})


def read_rate(path, current):
    try:
        with open(path) as handle:
            return int(handle.read().strip())
    except (OSError, ValueError):
        return current


def bulk_sender(cfg):
    start_ns = cfg['epochNs'] + int(cfg['startAtMs'] * 1e6)
    stop_ns = cfg['epochNs'] + int(cfg['stopAtMs'] * 1e6)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    packet = b'b' * cfg['packetBytes']
    scheduled_bps = cfg['bitsPerSecond']  # independent demand: never changed by the controller
    rate = read_rate(cfg['rateFile'], scheduled_bps)
    credit, last = 0.0, start_ns
    bin_ns, next_bin = 100_000_000, start_ns + 100_000_000
    sent = 0
    while time.monotonic_ns() < start_ns:
        time.sleep(0.001)
    with open(cfg['log'], 'w') as out:
        while True:
            now = time.monotonic_ns()
            if now >= next_bin or now >= stop_ns:
                end = min(next_bin, stop_ns)
                log(out, {'t': 'bin', 'endNs': end, 'scheduledBytes': int(scheduled_bps / 8 * (end - (next_bin - bin_ns)) / 1e9),
                          'sentBytes': sent, 'rateBps': rate})
                sent = 0
                rate = read_rate(cfg['rateFile'], rate)
                if now >= stop_ns:
                    break
                next_bin += bin_ns
            credit = min(credit + rate / 8 * (now - last) / 1e9, cfg['packetBytes'] * 4)
            last = now
            while credit >= cfg['packetBytes']:
                try:
                    sock.sendto(packet, (cfg['destinationIp'], cfg['port']))
                    sent += cfg['packetBytes']
                except OSError:
                    pass
                credit -= cfg['packetBytes']
            time.sleep(0.0005)
        log(out, {'t': 'complete', 'atNs': time.monotonic_ns()})


def bulk_receiver(cfg):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('0.0.0.0', cfg['port']))
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 21)
    stop_ns = cfg['epochNs'] + int(cfg['listenUntilMs'] * 1e6)
    bins = {}
    while time.monotonic_ns() < stop_ns:
        ready, _, _ = select.select([sock], [], [], 0.2)
        while ready:
            try:
                data = sock.recv(4096, socket.MSG_DONTWAIT)
            except BlockingIOError:
                break
            key = (time.monotonic_ns() - cfg['epochNs']) // 100_000_000
            bins[key] = bins.get(key, 0) + len(data)
    with open(cfg['log'], 'w') as out:
        for key in sorted(bins):
            log(out, {'t': 'bin', 'endMs': (key + 1) * 100, 'deliveredBytes': bins[key]})
        log(out, {'t': 'complete', 'atNs': time.monotonic_ns()})


def probe_echo(cfg):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('0.0.0.0', cfg['port']))
    stop_ns = time.monotonic_ns() + int(cfg['listenMs'] * 1e6)
    echoed = 0
    while time.monotonic_ns() < stop_ns:
        ready, _, _ = select.select([sock], [], [], 0.05)
        if ready:
            data, addr = sock.recvfrom(4096)
            sock.sendto(data, addr)
            echoed += 1
    print(json.dumps({'echoed': echoed}))


def probe_sender(cfg):
    """Send numbered probes at a fixed interval; report loss and round-trip times. Output: one JSON line."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)
    pad = b'p' * max(0, cfg['payloadBytes'] - 24)
    sent_at, rtts = {}, {}
    for i in range(cfg['packetCount']):
        now = time.monotonic_ns()
        sent_at[i] = now
        sock.sendto(('%08d%016d' % (i, now)).encode() + pad, (cfg['destinationIp'], cfg['port']))
        end = now + int(cfg['intervalMs'] * 1e6)
        while time.monotonic_ns() < end:
            ready, _, _ = select.select([sock], [], [], max(0, end - time.monotonic_ns()) / 1e9)
            while ready:
                try:
                    data = sock.recv(4096)
                except BlockingIOError:
                    break
                rtts.setdefault(int(data[:8]), (time.monotonic_ns() - int(data[8:24])) / 1e6)
    tail = time.monotonic_ns() + int(cfg['tailMs'] * 1e6)
    while time.monotonic_ns() < tail and len(rtts) < cfg['packetCount']:
        ready, _, _ = select.select([sock], [], [], 0.05)
        while ready:
            try:
                data = sock.recv(4096)
            except BlockingIOError:
                break
            rtts.setdefault(int(data[:8]), (time.monotonic_ns() - int(data[8:24])) / 1e6)
    values = sorted(rtts.values())
    print(json.dumps({'sent': len(sent_at), 'received': len(values), 'bytesSent': len(sent_at) * cfg['payloadBytes'],
                      'bytesEchoed': len(values) * cfg['payloadBytes'],
                      'rttMs': {'min': values[0], 'median': values[len(values) // 2], 'max': values[-1]} if values else None}))


MODES = {'essential-sender': essential_sender, 'essential-receiver': essential_receiver,
         'bulk-sender': bulk_sender, 'bulk-receiver': bulk_receiver, 'probe-echo': probe_echo, 'probe-sender': probe_sender}

if __name__ == '__main__':
    MODES[sys.argv[1]](json.loads(sys.argv[2]))
