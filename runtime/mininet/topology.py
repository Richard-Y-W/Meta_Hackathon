"""Registered network objects: scenario validation and Mininet construction.

Every name reaching a shell or OpenFlow command comes from a validated registry and
matches NAME. Validation never mutates its input.
"""
import copy
import math
import re

NAME = re.compile(r'^[a-z][a-z0-9]{0,7}$')
FLOW_ID = re.compile(r'^[a-z][a-z0-9-]{0,31}$')
IP = re.compile(r'^10\.0\.0\.(\d{1,3})$')
SCENARIO_FIELDS = {'version', 'scenarioId', 'topologyRevision', 'durationMs', 'warmupMs', 'synthetic', 'note',
                   'developmentNote', 'topology', 'workload', 'referencePolicy'}


class ScenarioError(ValueError):
    def __init__(self, detail, where=''):
        ValueError.__init__(self, '%s %s' % (detail, where))
        self.code = 'command_rejected'
        self.detail = detail


def _quantity(value, where, positive=False, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or (positive and value == 0):
        raise ScenarioError('bad_quantity', where)
    if integer and int(value) != value:
        raise ScenarioError('bad_quantity', where)
    return value


def _name(value, pattern=NAME):
    if not isinstance(value, str) or not pattern.match(value):
        raise ScenarioError('bad_name', repr(value))
    return value


def _unique(values):
    if len(set(values)) != len(values):
        raise ScenarioError('duplicate_id')


def _path(path, start, end, adjacency, where):
    if not isinstance(path, list) or len(path) < 2:
        raise ScenarioError('route_not_simple', where)
    for node in path:
        if node not in adjacency:
            raise ScenarioError('unknown_node', where)
    if len(set(path)) != len(path):
        raise ScenarioError('route_not_simple', where)
    if path[0] != start or path[-1] != end:
        raise ScenarioError('bad_endpoint', where)
    for a, b in zip(path, path[1:]):
        if b not in adjacency[a]:
            raise ScenarioError('unknown_link', where)


def validate_scenario(doc):
    """Return a normalized copy of a public scenario (no fault schedule) or raise ScenarioError."""
    if not isinstance(doc, dict) or doc.get('version') != 'ScenarioV1':
        raise ScenarioError('unsupported_version')
    if 'faults' in doc:
        raise ScenarioError('hidden_schedule_present')
    unknown = set(doc) - SCENARIO_FIELDS
    if unknown:
        raise ScenarioError('unknown_field', ','.join(sorted(unknown)))
    spec = copy.deepcopy(doc)
    topo = spec['topology']
    switches = [_name(s) for s in topo['switches']]
    hosts = topo['hosts']
    _unique(switches + [_name(h['hostId']) for h in hosts])
    adjacency = {s: {} for s in switches}
    _unique([l['linkId'] for l in topo['links']])
    for link in topo['links']:
        if not isinstance(link.get('linkId'), str) or not re.match(r'^r\d-r\d$', link['linkId']):
            raise ScenarioError('bad_name', repr(link.get('linkId')))
        a, b = link['a'], link['b']
        if a not in adjacency or b not in adjacency or a == b:
            raise ScenarioError('unknown_node', link['linkId'])
        if b in adjacency[a]:
            raise ScenarioError('duplicate_id', link['linkId'])
        _quantity(link['bwMbit'], link['linkId'], positive=True)
        _quantity(link['delayMs'], link['linkId'])
        _quantity(link['queuePackets'], link['linkId'], positive=True, integer=True)
        adjacency[a][b] = adjacency[b][a] = link['linkId']
    ips = []
    for host in hosts:
        if host['switch'] not in adjacency:
            raise ScenarioError('unknown_node', host['hostId'])
        match = IP.match(str(host.get('ip')))
        if not match or not 1 <= int(match.group(1)) <= 254:
            raise ScenarioError('bad_address', host['hostId'])
        ips.append(host['ip'])
    _unique(ips)
    attach = {h['hostId']: h['switch'] for h in hosts}

    flows = spec['workload']['essential'] + spec['workload']['background']
    _unique([f.get('flowId') or f.get('sourceId') for f in flows])
    ports = []
    for flow in spec['workload']['essential']:
        _name(flow['flowId'], FLOW_ID)
        for field in ('messagesPerS', 'payloadBytes', 'deadlineMs'):
            _quantity(flow[field], flow['flowId'], positive=True)
        if not 64 <= flow['payloadBytes'] <= 1400:
            raise ScenarioError('bad_quantity', flow['flowId'])
        for retry in flow['retryAtMs']:
            _quantity(retry, flow['flowId'], positive=True)
        ports += [flow['port'], flow['ackPort']]
    for flow in spec['workload']['background']:
        _name(flow['sourceId'], FLOW_ID)
        _quantity(flow['bitsPerSecond'], flow['sourceId'], positive=True)
        _quantity(flow['packetBytes'], flow['sourceId'], positive=True, integer=True)
        ports.append(flow['port'])
    for flow in flows:
        if flow['source'] not in attach or flow['destination'] not in attach or flow['source'] == flow['destination']:
            raise ScenarioError('unknown_node', flow.get('flowId') or flow.get('sourceId'))
    for port in ports:
        _quantity(port, 'port', positive=True, integer=True)
        if not 1024 < port < 65536:
            raise ScenarioError('bad_quantity', 'port')
    _unique(ports)

    by_id = {(f.get('flowId') or f.get('sourceId')): f for f in flows}
    routes = spec['referencePolicy']['routes']
    if set(routes) != set(by_id):
        raise ScenarioError('route_missing')
    for flow_id, route in routes.items():
        flow = by_id[flow_id]
        for key in ('primary', 'backup'):
            _path(route[key], attach[flow['source']], attach[flow['destination']], adjacency, flow_id)
    acks = spec['referencePolicy']['ackRoutes']
    if set(acks) != {f['flowId'] for f in spec['workload']['essential']}:
        raise ScenarioError('route_missing')
    for flow_id, route in acks.items():
        flow = by_id[flow_id]
        for key in ('primary', 'backup'):
            _path(route[key], attach[flow['destination']], attach[flow['source']], adjacency, flow_id)
    spec['_adjacency'] = adjacency
    spec['_attach'] = attach
    return spec


def build_network(spec, tag):
    """Construct the registered topology in Mininet. Requires root inside the isolated VM."""
    from mininet.link import TCLink
    from mininet.net import Mininet
    from mininet.node import OVSSwitch

    net = Mininet(switch=OVSSwitch, link=TCLink, controller=None, autoSetMacs=False, build=False)
    names = {}
    for i, s in enumerate(spec['topology']['switches']):
        names[s] = net.addSwitch(tag + s, failMode='secure', protocols='OpenFlow13', dpid='%016x' % (0x7700 + i))
    for i, h in enumerate(spec['topology']['hosts']):
        names[h['hostId']] = net.addHost(tag + h['hostId'][:3] + str(i), ip=h['ip'] + '/24', mac='02:00:00:00:00:%02x' % (i + 1))
    for h in spec['topology']['hosts']:
        net.addLink(names[h['hostId']], names[h['switch']], bw=1000)
    for link in spec['topology']['links']:
        net.addLink(names[link['a']], names[link['b']], bw=link['bwMbit'], delay='%gms' % link['delayMs'],
                    max_queue_size=int(link['queuePackets']))
    net.build()
    net.start()
    return net, names


def port_map(spec, names):
    """(switch, neighbor-or-host) -> OpenFlow port number, read from the built network."""
    ports = {}
    for registered, node in names.items():
        if registered not in spec['_adjacency']:
            continue
        for intf in node.intfList():
            if intf.link is None:
                continue
            other = intf.link.intf1 if intf.link.intf2 is intf else intf.link.intf2
            peer = [k for k, v in names.items() if v is other.node][0]
            ports[(registered, peer)] = (node.ports[intf], intf.name)
    return ports
