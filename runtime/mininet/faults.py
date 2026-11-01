"""Administrative fault injection. Orchestrator role only; never exposed as a controller or AI action."""
import math

KINDS = {
    'link_down': {'atMs', 'kind', 'linkId'},
    'link_up': {'atMs', 'kind', 'linkId'},
    'link_rate': {'atMs', 'kind', 'linkId', 'bwMbit'},
    'telemetry_hold': {'atMs', 'kind', 'durationMs'},  # telemetry unavailable: tests stale-observation handling
}


class FaultError(ValueError):
    def __init__(self, detail):
        ValueError.__init__(self, detail)
        self.code = 'command_rejected'
        self.detail = detail


def validate_fault(fault, spec):
    if not isinstance(fault, dict) or fault.get('kind') not in KINDS:
        raise FaultError('unknown_fault_kind')
    if set(fault) != KINDS[fault['kind']]:
        raise FaultError('unknown_field' if set(fault) - KINDS[fault['kind']] else 'missing_field')
    if 'linkId' in fault and fault['linkId'] not in {l['linkId'] for l in spec['topology']['links']}:
        raise FaultError('unknown_link')
    if fault['kind'] == 'telemetry_hold':
        d = fault['durationMs']
        if isinstance(d, bool) or not isinstance(d, (int, float)) or not math.isfinite(d) or d <= 0 or d > 60000:
            raise FaultError('bad_quantity')
    at = fault['atMs']
    if isinstance(at, bool) or not isinstance(at, (int, float)) or not math.isfinite(at) or at < 0:
        raise FaultError('bad_quantity')
    if fault['kind'] == 'link_rate':
        bw = fault['bwMbit']
        if isinstance(bw, bool) or not isinstance(bw, (int, float)) or not math.isfinite(bw) or bw <= 0:
            raise FaultError('bad_quantity')
    return dict(fault)


def apply_fault(net, names, spec, fault):
    link = [l for l in spec['topology']['links'] if l['linkId'] == fault['linkId']][0]
    a, b = names[link['a']], names[link['b']]
    if fault['kind'] in ('link_down', 'link_up'):
        net.configLinkStatus(a.name, b.name, 'down' if fault['kind'] == 'link_down' else 'up')
        return {'applied': True}
    for intf_a, intf_b in a.connectionsTo(b):
        for intf in (intf_a, intf_b):
            intf.config(bw=fault['bwMbit'], delay='%gms' % link['delayMs'], max_queue_size=int(link['queuePackets']))
    return {'applied': True}
