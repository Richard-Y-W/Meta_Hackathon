"""Counter collection and controller-visible observations.

Observations carry measured counters, link state and age only. Configured capacities,
fault records and schedules are never read into them. Unknown counters stay None.
"""
import re
import subprocess
import time

PORT_HEAD = re.compile(r'port\s+"?([\w.-]+)"?:\s+rx pkts=(\S+), bytes=(\S+), drop=(\S+)')
PORT_TX = re.compile(r'tx pkts=(\S+), bytes=(\S+), drop=(\S+)')


def _count(text):
    text = text.rstrip(',')
    return None if text == '?' else int(text)


def parse_dump_ports(text):
    ports, current = {}, None
    for line in text.splitlines():
        head = PORT_HEAD.search(line)
        if head:
            current = head.group(1)
            ports[current] = {'rxPackets': _count(head.group(2)), 'rxBytes': _count(head.group(3)), 'rxDrops': _count(head.group(4))}
            continue
        tx = PORT_TX.search(line)
        if tx and current:
            ports[current].update(txPackets=_count(tx.group(1)), txBytes=_count(tx.group(2)), txDrops=_count(tx.group(3)))
    return ports


def parse_tc(text):
    """Root-qdisc drops and backlog. Rates and limits in the configuration are deliberately ignored."""
    drops = backlog_bytes = backlog_packets = None
    root = False
    for line in text.splitlines():
        if line.startswith('qdisc'):
            root = ' root ' in line
            continue
        if not root:
            continue
        sent = re.search(r'dropped (\d+)', line)
        if sent:
            drops = int(sent.group(1))
        backlog = re.search(r'backlog (\d+)b (\d+)p', line)
        if backlog:
            backlog_bytes, backlog_packets = int(backlog.group(1)), int(backlog.group(2))
    return {'drops': drops, 'backlogBytes': backlog_bytes, 'backlogPackets': backlog_packets}


def port_counters(ports, ofport, intf_name):
    """OVS reports OpenFlow 1.3 port statistics by port number; fall back to the interface name."""
    return ports.get(str(ofport)) or ports.get(intf_name) or {}


def build_observation(run_id, seq, sample, spec, config_revision, now_ms, interval_ms):
    """Assemble ObservationV1 from a measured sample. Only whitelisted measured fields pass through."""
    links = {}
    for link_id, values in sample.get('links', {}).items():
        links[link_id] = {k: values.get(k) for k in ('state', 'txBytes', 'txPackets', 'txDrops', 'queueDrops', 'backlogBytes')
                          if k in values}
    services = {}
    for flow_id, values in sample.get('services', {}).items():
        services[flow_id] = {k: values.get(k) for k in ('offered', 'transmissions', 'acked', 'ackedWithinDeadline', 'resolvedOffered', 'resolvedOnTime') if k in values}
    return {
        'version': 'ObservationV1', 'runId': run_id, 'seq': seq, 'sampleIntervalMs': interval_ms,
        'collectedAtMs': sample['collectedAtMs'], 'ageMs': round(now_ms - sample['collectedAtMs'], 3),
        'topologyRevision': spec['topologyRevision'], 'configRevision': config_revision,
        'links': links, 'services': services,
    }


def collect_links(spec, names, ports):
    """Read OVS port counters, link state and root-qdisc counters for each registered link end."""
    per_switch = {}
    for s in spec['topology']['switches']:
        out = subprocess.run(['ovs-ofctl', '-O', 'OpenFlow13', 'dump-ports', names[s].name], capture_output=True, text=True).stdout
        per_switch[s] = parse_dump_ports(out)
    links = {}
    for link in spec['topology']['links']:
        entry = {'txBytes': {}, 'txPackets': {}, 'txDrops': {}, 'queueDrops': {}, 'backlogBytes': {}}
        up = True
        for end, peer in ((link['a'], link['b']), (link['b'], link['a'])):
            ofport, intf = ports[(end, peer)]
            counters = port_counters(per_switch[end], ofport, intf)
            entry['txBytes'][end] = counters.get('txBytes')
            entry['txPackets'][end] = counters.get('txPackets')
            entry['txDrops'][end] = counters.get('txDrops')
            queue = parse_tc(subprocess.run(['tc', '-s', 'qdisc', 'show', 'dev', intf], capture_output=True, text=True).stdout)
            entry['queueDrops'][end] = queue['drops']
            entry['backlogBytes'][end] = queue['backlogBytes']
            state = subprocess.run(['cat', '/sys/class/net/%s/operstate' % intf], capture_output=True, text=True).stdout.strip()
            up = up and state == 'up'
        entry['state'] = 'up' if up else 'down'
        links[link['linkId']] = entry
    return links


class ServiceCounter:
    """Sender-side application counters for one essential flow, fed with the sender's own records.

    `resolvedOffered`/`resolvedOnTime` count only messages whose deadline has passed, so their ratio
    over any window is exact: in-flight messages are neither successes nor failures yet.
    """

    def __init__(self, deadline_ms):
        self.deadline_ns = int(deadline_ms * 1e6)
        self.created, self.order, self.on_time, self.acked = {}, [], set(), set()
        self.transmissions = 0
        self.cursor = self.resolved_on_time = 0

    def feed(self, rec):
        if rec['t'] == 'offered':
            self.created[rec['id']] = rec['createdAtNs']
            self.order.append(rec['id'])
        elif rec['t'] == 'tx':
            self.transmissions += 1
        elif rec['t'] == 'ack' and rec['id'] not in self.acked:
            self.acked.add(rec['id'])
            created = self.created.get(rec['id'])
            if created is not None and rec['atNs'] - created <= self.deadline_ns:
                self.on_time.add(rec['id'])

    def snapshot(self, now_ns):
        while self.cursor < len(self.order) and self.created[self.order[self.cursor]] + self.deadline_ns <= now_ns:
            if self.order[self.cursor] in self.on_time:
                self.resolved_on_time += 1
            self.cursor += 1
        return {'offered': len(self.order), 'transmissions': self.transmissions, 'acked': len(self.acked),
                'ackedWithinDeadline': len(self.on_time), 'resolvedOffered': self.cursor, 'resolvedOnTime': self.resolved_on_time}


def now_ms(epoch_ns):
    return (time.monotonic_ns() - epoch_ns) / 1e6
