"""Route and rate effects with read-back. Task 4 installs the fixed reference policy."""
import subprocess

OF = ['ovs-ofctl', '-O', 'OpenFlow13']


class ControlError(RuntimeError):
    def __init__(self, detail):
        RuntimeError.__init__(self, detail)
        self.code = 'action_rejected'
        self.detail = detail


def _of(*args):
    done = subprocess.run(OF + list(args), capture_output=True, text=True)
    if done.returncode != 0:
        raise ControlError('openflow_failed: %s' % done.stderr.strip()[:200])
    return done.stdout


def hops(path, dst_host):
    """switch -> next registered peer along the path (host at the end)."""
    return {s: (path[i + 1] if i + 1 < len(path) else dst_host) for i, s in enumerate(path)}


def flow_rules(primary, backup, dst_host):
    """Per-switch forwarding: fast-failover at the ingress when the paths diverge there."""
    p, b = hops(primary, dst_host), hops(backup, dst_host)
    rules = {}
    for switch in set(p) | set(b):
        if switch == primary[0] and p[switch] != b[switch]:
            rules[switch] = ('failover', p[switch], b[switch])
        elif switch in p and switch in b and p[switch] != b[switch]:
            raise ControlError('backup_conflicts_with_primary at %s' % switch)
        else:
            rules[switch] = ('output', p.get(switch, b.get(switch)))
    return rules


def install_reference_policy(spec, names, ports, cookie=0x1):
    """Install every data, acknowledgement and background route; return installed rule counts per switch."""
    hosts = {h['hostId']: h for h in spec['topology']['hosts']}
    entries = []
    for f in spec['workload']['essential']:
        route, ack = spec['referencePolicy']['routes'][f['flowId']], spec['referencePolicy']['ackRoutes'][f['flowId']]
        entries.append((f['source'], f['destination'], f['port'], route))
        entries.append((f['destination'], f['source'], f['ackPort'], ack))
    for f in spec['workload']['background']:
        entries.append((f['source'], f['destination'], f['port'], spec['referencePolicy']['routes'][f['sourceId']]))
    group = 1
    counts = {}
    for src, dst, port, route in entries:
        match = 'cookie=%#x,priority=100,udp,nw_src=%s,nw_dst=%s,tp_dst=%d' % (cookie, hosts[src]['ip'], hosts[dst]['ip'], port)
        for switch, rule in flow_rules(route['primary'], route['backup'], dst).items():
            bridge = names[switch].name
            if rule[0] == 'failover':
                primary_port, backup_port = ports[(switch, rule[1])][0], ports[(switch, rule[2])][0]
                _of('add-group', bridge, 'group_id=%d,type=fast_failover,bucket=watch_port:%d,actions=output:%d,bucket=watch_port:%d,actions=output:%d'
                    % (group, primary_port, primary_port, backup_port, backup_port))
                _of('add-flow', bridge, '%s,actions=group:%d' % (match, group))
                group += 1
            else:
                _of('add-flow', bridge, '%s,actions=output:%d' % (match, ports[(switch, rule[1])][0]))
            counts[switch] = counts.get(switch, 0) + 1
    readback = {s: _of('dump-flows', names[s].name, 'cookie=%#x/-1' % cookie).count('priority=100') for s in counts}
    if readback != counts:
        raise ControlError('readback_mismatch')
    return {'rules': counts, 'groups': group - 1}


def set_static_arp(spec, names):
    hosts = spec['topology']['hosts']
    for h in hosts:
        node = names[h['hostId']]
        for other in hosts:
            if other is not h:
                node.cmd('arp -s %s %s' % (other['ip'], names[other['hostId']].MAC()))
