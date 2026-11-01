"""Route and rate effects with read-back.

Route updates are versioned: packets are tagged with a DSCP version at the ingress switch, and
downstream switches forward tagged packets along that version's path. An update prepares the new
version's downstream rules (read back per switch), switches the ingress rule, and later retires the
old version after a drain interval. An effect is reported only after its rule is read back.
"""
import json
import os
import re
import subprocess

MAX_VERSION = 63  # six DSCP bits; 0 is the untagged reference policy
PROBE_PORT = 9900
PROBE_COOKIE_BASE = 0xF00000


class ControlError(RuntimeError):
    def __init__(self, detail):
        RuntimeError.__init__(self, detail)
        self.code = 'action_rejected'
        self.detail = detail.split(':')[0]
        self.message = detail


class OvsOpenFlow:
    """Real switch access through ovs-ofctl (OpenFlow 1.3). Arguments are registry-derived only."""
    OF = ['ovs-ofctl', '-O', 'OpenFlow13']

    def _run(self, *args):
        done = subprocess.run(self.OF + list(args), capture_output=True, text=True)
        if done.returncode != 0:
            raise ControlError('openflow_failed: %s' % done.stderr.strip()[:200])
        return done.stdout

    def add_flow(self, bridge, spec):
        self._run('add-flow', bridge, spec)

    def del_flows(self, bridge, cookie):
        self._run('del-flows', bridge, 'cookie=%#x/-1' % cookie)

    def _dump(self, bridge, cookie):
        return [l for l in self._run('dump-flows', bridge, 'cookie=%#x/-1' % cookie).splitlines() if 'cookie=' in l]

    def count(self, bridge, cookie):
        return len(self._dump(bridge, cookie))

    def packets(self, bridge, cookie):
        return sum(int(m.group(1)) for l in self._dump(bridge, cookie) for m in [re.search(r'n_packets=(\d+)', l)] if m)

    def add_group(self, bridge, spec):
        self._run('add-group', bridge, spec)

    def del_group(self, bridge, group_id):
        self._run('del-groups', bridge, 'group_id=%d' % group_id)

    def del_flow_strict(self, bridge, match):
        self._run('--strict', 'del-flows', bridge, match)


def _validate_path(spec, path, start, end):
    adjacency = spec['_adjacency']
    if not isinstance(path, list) or len(path) < 2 or any(n not in adjacency for n in path):
        raise ControlError('unknown_node' if isinstance(path, list) and len(path) >= 2 else 'route_not_simple')
    if len(set(path)) != len(path):
        raise ControlError('route_not_simple')
    if path[0] != start or path[-1] != end:
        raise ControlError('bad_endpoint')
    for a, b in zip(path, path[1:]):
        if b not in adjacency[a]:
            raise ControlError('unknown_link')


class RouteTable:
    def __init__(self, spec, names, ports, openflow):
        self.spec, self.names, self.ports, self.of = spec, names, ports, openflow
        self.hosts = {h['hostId']: h for h in spec['topology']['hosts']}
        self.routes = {}  # (flowId, role) -> {src, dst, port, index, active, versions: {v: path}}
        index = 0
        for f in spec['workload']['essential']:
            self.routes[(f['flowId'], 'data')] = {'src': f['source'], 'dst': f['destination'], 'port': f['port'], 'index': index}
            self.routes[(f['flowId'], 'ack')] = {'src': f['destination'], 'dst': f['source'], 'port': f['ackPort'], 'index': index}
            index += 1
        for f in spec['workload']['background']:
            self.routes[(f['sourceId'], 'data')] = {'src': f['source'], 'dst': f['destination'], 'port': f['port'], 'index': index}
            index += 1
        for route in self.routes.values():
            route.update(active=0, versions={}, prepared=set(), groups={})
        self.config_revision = 0
        self.next_group = 1

    def cookie(self, flow_id, role, version):
        return ((self.routes[(flow_id, role)]['index'] + 1) << 16) | ((1 if role == 'ack' else 0) << 8) | version

    def active(self, flow_id, role):
        return self.routes[(flow_id, role)]['active']

    def _match(self, route):
        return 'udp,nw_src=%s,nw_dst=%s,tp_dst=%d' % (self.hosts[route['src']]['ip'], self.hosts[route['dst']]['ip'], route['port'])

    def _next(self, path, i, dst):
        return self.ports[(path[i], path[i + 1] if i + 1 < len(path) else dst)][0]

    def install_reference(self):
        """Version 0: untagged primary routes with fast-failover to the backup at each ingress switch."""
        policy = self.spec['referencePolicy']
        for (flow_id, role), route in self.routes.items():
            paths = (policy['ackRoutes'] if role == 'ack' else policy['routes'])[flow_id]
            primary, backup = paths['primary'], paths['backup']
            cookie, match = self.cookie(flow_id, role, 0), self._match(route)
            p = {s: self._next(primary, i, route['dst']) for i, s in enumerate(primary)}
            b = {s: self._next(backup, i, route['dst']) for i, s in enumerate(backup)}
            for switch in sorted(set(p) | set(b)):
                bridge = self.names[switch].name
                if switch == primary[0] and p[switch] != b[switch]:
                    group = self.next_group
                    self.next_group += 1
                    self.of.add_group(bridge, 'group_id=%d,type=fast_failover,bucket=watch_port:%d,actions=output:%d,bucket=watch_port:%d,actions=output:%d'
                                      % (group, p[switch], p[switch], b[switch], b[switch]))
                    route['groups'][switch] = group
                    action = 'group:%d' % group
                elif switch in p and switch in b and p[switch] != b[switch]:
                    raise ControlError('backup_conflicts_with_primary')
                else:
                    action = 'output:%d' % p.get(switch, b.get(switch))
                self.of.add_flow(bridge, 'cookie=%#x,priority=100,%s,actions=%s' % (cookie, match, action))
                if self.of.count(bridge, cookie) < 1:
                    raise ControlError('readback_mismatch')
            route['versions'][0] = primary
        self.config_revision = 1
        return {'routes': len(self.routes), 'groups': self.next_group - 1, 'configRevision': self.config_revision}

    def _free_version(self, keys):
        used = set()
        for key in keys:
            used |= set(self.routes[key]['versions']) | {self.routes[key]['active']}
        for v in range(1, MAX_VERSION + 1):
            if v not in used:
                return v
        raise ControlError('versions_exhausted')

    def _keys(self, flow_id):
        keys = [k for k in ((flow_id, 'data'), (flow_id, 'ack')) if k in self.routes]
        if not keys:
            raise ControlError('unknown_flow')
        return keys

    def prepare(self, operation_id, flowId, path, ackPath=None):
        keys = self._keys(flowId)
        paths = {'data': path, 'ack': ackPath}
        if len(keys) == 2 and ackPath is None:
            raise ControlError('ack_path_required')
        if len(keys) == 1 and ackPath is not None:
            raise ControlError('ack_path_not_applicable')
        for key in keys:
            route = self.routes[key]
            _validate_path(self.spec, paths[key[1]], self.spec['_attach'][route['src']], self.spec['_attach'][route['dst']])
        version = self._free_version(keys)
        effects = []
        for key in keys:
            route, p = self.routes[key], paths[key[1]]
            route['versions'][version] = p
            cookie, match = self.cookie(flowId, key[1], version), self._match(route)
            for i in range(1, len(p)):  # downstream switches only; the ingress changes at commit
                bridge = self.names[p[i]].name
                try:
                    self.of.add_flow(bridge, 'cookie=%#x,priority=200,%s,ip_dscp=%d,actions=output:%d' % (cookie, match, version, self._next(p, i, route['dst'])))
                except ControlError as error:
                    return {'status': 'failed', 'detail': error.detail, 'version': version, 'effects': effects}
                if self.of.count(bridge, cookie) < 1:
                    return {'status': 'failed', 'detail': 'readback_mismatch', 'version': version, 'effects': effects}
                effects.append({'switch': p[i], 'role': key[1], 'cookie': cookie, 'version': version})
            route['prepared'].add(version)
        return {'status': 'prepared', 'version': version, 'effects': effects}

    def commit(self, operation_id, flowId, version):
        """Point the ingress at a prepared version, or reactivate a still-installed earlier one (rollback)."""
        keys = self._keys(flowId)
        for k in keys:
            route = self.routes[k]
            installed = version in route['prepared'] or (version in route['versions'] and version != route['active'])
            if not installed:
                raise ControlError('version_not_prepared')
        effects = []
        for key in keys:
            route = self.routes[key]
            p = route['versions'][version]
            cookie = self.cookie(flowId, key[1], version)
            bridge = self.names[p[0]].name
            host_port = self.ports[(p[0], route['src'])][0]
            match = 'priority=300,in_port=%d,%s' % (host_port, self._match(route))
            try:
                if version == 0:
                    # The untagged reference rules are still installed; removing the tagging rule restores them.
                    self.of.del_flow_strict(bridge, match)
                else:
                    self.of.add_flow(bridge, 'cookie=%#x,%s,actions=set_field:%d->ip_dscp,output:%d'
                                     % (cookie, match, version, self._next(p, 0, route['dst'])))
            except ControlError as error:
                return self._partial(effects, error.detail)
            if self.of.count(bridge, cookie) < 1:
                return self._partial(effects, 'readback_mismatch')
            route['previous'], route['active'] = route['active'], version
            route['prepared'].discard(version)
            effects.append({'switch': p[0], 'role': key[1], 'cookie': cookie, 'version': version, 'ingress': True})
        self.config_revision += 1  # one logical change, however many roles it covers
        return {'status': 'committed', 'version': version, 'effects': effects, 'configRevision': self.config_revision}

    def _partial(self, effects, detail):
        if effects:
            self.config_revision += 1  # a partial commit still changed the network
        return {'status': 'partial' if effects else 'failed', 'detail': detail, 'effects': effects, 'configRevision': self.config_revision}

    def _remove(self, flow_id, version):
        remaining = 0
        for key in self._keys(flow_id):
            route = self.routes[key]
            cookie = self.cookie(flow_id, key[1], version)
            for switch in self.spec['topology']['switches']:
                bridge = self.names[switch].name
                self.of.del_flows(bridge, cookie)
                remaining += self.of.count(bridge, cookie)
            if version == 0:
                for switch, group in route['groups'].items():
                    if hasattr(self.of, 'del_group'):
                        self.of.del_group(self.names[switch].name, group)
                route['groups'] = {}
            route['versions'].pop(version, None)
            route['prepared'].discard(version)
        return remaining

    def retire(self, operation_id, flowId, version):
        if any(self.routes[k]['active'] == version for k in self._keys(flowId)):
            raise ControlError('version_active')
        remaining = self._remove(flowId, version)
        return {'status': 'retired' if remaining == 0 else 'partial', 'version': version, 'remaining': remaining}

    def abort(self, operation_id, flowId, version):
        if any(self.routes[k]['active'] == version for k in self._keys(flowId)):
            raise ControlError('version_active')
        remaining = self._remove(flowId, version)
        return {'status': 'aborted' if remaining == 0 else 'partial', 'version': version, 'remaining': remaining}

    def verify(self, flowId, version):
        """Packet counters on the version's rule at each downstream switch of the data path."""
        route = self.routes[(flowId, 'data')]
        path = route['versions'].get(version)
        if path is None:
            raise ControlError('version_unknown')
        cookie = self.cookie(flowId, 'data', version)
        return {'version': version, 'packets': {s: self.of.packets(self.names[s].name, cookie) for s in path}}

    def state(self):
        return {'configRevision': self.config_revision,
                'routes': {'%s/%s' % k: {'active': r['active'], 'path': r['versions'].get(r['active']), 'versions': sorted(r['versions'])}
                           for k, r in self.routes.items()}}


class ProbeRules:
    """Temporary highest-priority rules that pin a probe and its echo to one registered path."""

    def __init__(self, spec, names, ports, openflow, hosts):
        self.spec, self.names, self.ports, self.of, self.hosts = spec, names, ports, openflow, hosts

    def default_path(self, source, destination):
        start, end = self.spec['_attach'][source], self.spec['_attach'][destination]
        frontier, seen = [[start]], {start}
        while frontier:  # breadth-first, neighbours in registry order: deterministic
            nxt = []
            for path in frontier:
                if path[-1] == end:
                    return path
                for peer in sorted(self.spec['_adjacency'][path[-1]]):
                    if peer not in seen:
                        seen.add(peer)
                        nxt.append(path + [peer])
            frontier = nxt
        raise ControlError('route_unavailable')

    def install(self, probe_id, source, destination, path):
        _validate_path(self.spec, path, self.spec['_attach'][source], self.spec['_attach'][destination])
        cookie = PROBE_COOKIE_BASE | probe_id
        src, dst = self.hosts[source]['ip'], self.hosts[destination]['ip']
        legs = [(path, destination, 'udp,nw_src=%s,nw_dst=%s,tp_dst=%d' % (src, dst, PROBE_PORT)),
                (path[::-1], source, 'udp,nw_src=%s,nw_dst=%s,tp_src=%d' % (dst, src, PROBE_PORT))]
        for leg, end_host, match in legs:
            for i, switch in enumerate(leg):
                peer = leg[i + 1] if i + 1 < len(leg) else end_host
                self.of.add_flow(self.names[switch].name, 'cookie=%#x,priority=400,%s,actions=output:%d' % (cookie, match, self.ports[(switch, peer)][0]))
        for switch in path:
            if self.of.count(self.names[switch].name, cookie) < 2:
                self.remove({'cookie': cookie, 'switches': path})
                raise ControlError('readback_mismatch')
        return {'cookie': cookie, 'switches': list(path), 'path': list(path)}

    def remove(self, installed):
        remaining = 0
        for switch in installed['switches']:
            bridge = self.names[switch].name
            self.of.del_flows(bridge, installed['cookie'])
            remaining += self.of.count(bridge, installed['cookie'])
        return remaining


class Operations:
    """Operation-ID registry: a repeated ID returns its recorded outcome and never reapplies an effect."""

    def __init__(self):
        self.records = {}

    def run(self, operation_id, cmd, args, effect):
        identity = json.dumps([cmd, args], sort_keys=True)
        record = self.records.get(operation_id)
        if record is not None:
            if record['identity'] != identity:
                raise ControlError('operation_id_reused')
            return dict(record['outcome'], replayed=True)
        try:
            outcome = effect()
        except ControlError as error:
            self.records[operation_id] = {'identity': identity, 'outcome': {'operationId': operation_id, 'status': 'failed', 'detail': error.detail}}
            raise
        outcome = dict(outcome, operationId=operation_id)
        self.records[operation_id] = {'identity': identity, 'outcome': outcome}
        return dict(outcome, replayed=False)

    def lookup(self, operation_id):
        record = self.records.get(operation_id)
        return dict(record['outcome']) if record else {'operationId': operation_id, 'status': 'unknown'}


class RateControl:
    """Background rate through the sender's control file. Throttle only: never above scheduled demand."""

    def __init__(self, spec, run_dir):
        self.sources = {f['sourceId']: f for f in spec['workload']['background']}
        self.run_dir = run_dir

    def path(self, source_id):
        return os.path.join(self.run_dir, 'rate-%s' % source_id)

    def _write(self, source_id, bps):
        tmp = self.path(source_id) + '.tmp'
        with open(tmp, 'w') as handle:
            handle.write(str(int(bps)))
        os.replace(tmp, self.path(source_id))  # atomic: the sender never reads a partial value

    def initialize(self):
        for source_id, flow in self.sources.items():
            self._write(source_id, flow['bitsPerSecond'])

    def read(self, source_id):
        with open(self.path(source_id)) as handle:
            return int(handle.read().strip())

    def set(self, source_id, bps):
        if source_id not in self.sources:
            raise ControlError('not_background')
        if isinstance(bps, bool) or not isinstance(bps, int) or bps < 0:
            raise ControlError('bad_quantity')
        if bps > self.sources[source_id]['bitsPerSecond']:
            raise ControlError('above_scheduled_demand')
        prior = self.read(source_id)
        self._write(source_id, bps)
        return {'status': 'applied', 'sourceId': source_id, 'priorBps': prior, 'appliedBps': bps, 'readBackBps': self.read(source_id)}


def set_static_arp(spec, names):
    hosts = spec['topology']['hosts']
    for h in hosts:
        node = names[h['hostId']]
        for other in hosts:
            if other is not h:
                node.cmd('arp -s %s %s' % (other['ip'], names[other['hostId']].MAC()))
