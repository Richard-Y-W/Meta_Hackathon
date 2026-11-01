#!/usr/bin/env python3
"""LIFELINE electrical plant on pandapower steady-state AC power flow.

    python3 runtime/infra/power_pandapower.py serve                     # stdio worker (protocol.py)
    python3 runtime/infra/power_pandapower.py spike --out FILE          # capability spike (power_spike.py)

The plant state is a network spec plus explicit mutable state (switches, line/source/generator service,
load connection and scale, storage energy and command, local-control memory, pending faults, private
ledger). Checkpoints seal that state; restore rebuilds the network from the spec, so a restored or forked
plant does not depend on solver history. Canonical units at the boundary: W, var, V, J, microseconds.

Scope: balanced steady-state power flow between discrete steps. It does not model transients, protection
coordination, black start or grid-forming inverters; islands without a slack source are unsupplied.
"""
import argparse
import copy
import json
import os
import sys
import time
import warnings

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault('MPLBACKEND', 'Agg')
warnings.filterwarnings('ignore', category=FutureWarning)

import pandapower as pp  # noqa: E402
from pandapower.powerflow import LoadflowNotConverged  # noqa: E402

import checkpoints  # noqa: E402
from protocol import Rejected, serve  # noqa: E402

DOMAIN = 'power'
MODEL_VERSION = 'pandapower-%s/lifeline-power-v1' % pp.__version__
W_PER_MW = 1e6
J_PER_MWH = 3.6e9
UNITS = {'power.voltage': 'V', 'power.active': 'W', 'power.loading': '1', 'power.switch_state': 'state', 'energy.stored': 'J'}
ACTIONS = {
    'set_switch': {'switchId': 'id', 'closed': 'bool'},
    'set_load_connected': {'loadId': 'id', 'connected': 'bool'},
    'set_storage_power': {'storageId': 'id', 'dischargeW': 'W'},
}
FAULTS = {'line_trip': 'lines', 'source_loss': 'sources', 'generator_unavailable': 'generators', 'load_change': 'loads'}
TABLES = {'buses': 'bus', 'lines': 'line', 'switches': 'switch', 'loads': 'load', 'sources': 'ext_grid', 'generators': 'gen', 'storage': 'storage'}


def classify_solve(run, bisections=8):
    """Distinguish a converged point, a load level beyond the network's loadability (the solver converges
    when every load is scaled down), and numerical failure (no convergence even at zero load)."""
    if run(1.0):
        return 'converged', {}
    if not run(0.0):
        return 'solver_failure', {'zeroLoadConverged': False}
    lo, hi = 0.0, 1.0
    for _ in range(bisections):
        mid = (lo + hi) / 2
        if run(mid):
            lo = mid
        else:
            hi = mid
    return 'no_feasible_operating_point', {'loadabilityBracket': [lo, hi], 'rule': 'continuation over uniform load scale'}


def network_digest(net):
    tables = {t: json.loads(net[t].to_json(orient='split', double_precision=15)) for t in ('bus', 'line', 'trafo', 'switch', 'load', 'sgen', 'storage', 'ext_grid')}
    return checkpoints.digest(tables)


def build_network(spec):
    """pandapower net plus id -> row index maps. Explicit specs are built element by element; reference
    specs call a named pandapower builder and map declared ids onto its element names."""
    if 'builder' in spec:
        import pandapower.networks as networks
        builder = spec['builder']
        if builder['function'] != 'pandapower.networks.create_cigre_network_mv':
            raise Rejected('unsupported_builder', builder['function'])
        net = networks.create_cigre_network_mv(**builder.get('args', {}))
        expected = spec.get('provenance', {}).get('builtNetworkSha256')
        if expected and network_digest(net) != expected:
            raise Rejected('reference_network_drift', 'built network does not match the recorded provenance hash')
        index = {}
        for kind, table in TABLES.items():
            index[kind] = {}
            for asset_id, ref in spec.get('assetMap', {}).get(kind, {}).items():
                rows = [ref['index']] if isinstance(ref, dict) else list(net[table].index[net[table].name == ref])
                if len(rows) != 1:
                    raise Rejected('asset_map_mismatch', '%s=%s' % (asset_id, ref))
                index[kind][asset_id] = int(rows[0])
        for i in net.bus.index:  # unmapped buses still need stable ids for constraint events
            if i not in index['buses'].values():
                index['buses']['bus:%d' % i] = int(i)
        for i in net.line.index:
            if i not in index['lines'].values():
                index['lines']['line:%d' % i] = int(i)
        for sid, cfg in spec.get('storageState', {}).items():
            net.storage.at[index['storage'][sid], 'p_mw'] = 0.0
        return net, index
    net = pp.create_empty_network(sn_mva=spec.get('baseMva', 1.0), f_hz=spec['frequencyHz'])
    index = {kind: {} for kind in TABLES}
    for b in spec['buses']:
        index['buses'][b['id']] = int(pp.create_bus(net, vn_kv=b['kv'], name=b['id']))
    bus = index['buses']
    for s in spec['sources']:
        index['sources'][s['id']] = int(pp.create_ext_grid(net, bus[s['bus']], vm_pu=s.get('vmPu', 1.0), name=s['id']))
    for line in spec['lines']:
        index['lines'][line['id']] = int(pp.create_line_from_parameters(
            net, bus[line['from']], bus[line['to']], line['lengthKm'], r_ohm_per_km=line['rOhmPerKm'], x_ohm_per_km=line['xOhmPerKm'],
            c_nf_per_km=line.get('cNfPerKm', 0.0), max_i_ka=line['maxIKa'], name=line['id']))
    for sw in spec['switches']:
        index['switches'][sw['id']] = int(pp.create_switch(net, bus[sw['bus']], index['lines'][sw['line']], et='l', closed=sw['closed'], name=sw['id']))
    for load in spec['loads']:
        index['loads'][load['id']] = int(pp.create_load(net, bus[load['bus']], p_mw=load['pW'] / W_PER_MW, q_mvar=load['qVar'] / W_PER_MW, name=load['id']))
    for g in spec['generators']:
        index['generators'][g['id']] = int(pp.create_gen(net, bus[g['bus']], p_mw=g.get('pW', 0) / W_PER_MW, vm_pu=g.get('vmPu', 1.0),
                                                         slack=g.get('slack', False), max_p_mw=g['pMaxW'] / W_PER_MW, name=g['id']))
    for st in spec['storage']:
        index['storage'][st['id']] = int(pp.create_storage(net, bus[st['bus']], p_mw=0.0, max_e_mwh=st['capacityJ'] / J_PER_MWH, name=st['id']))
    return net, index


def initial_state(spec, faults):
    """Mutable plant state at t=0 from the spec and the (private) fault schedule. A fixture's scenario
    block (fault schedule, scripted actions) is evaluator input and never becomes part of plant state,
    because the spec is copied into admitted models."""
    spec = {key: value for key, value in spec.items() if key != 'scenario'}
    net, index = build_network(spec)
    storage_specs = spec.get('storageState') or {s['id']: s for s in spec.get('storage', [])}
    actuators = spec.get('actuators') or [s['id'] for s in spec.get('switches', []) if s.get('actuator')]
    state = {
        'kind': 'true', 'modelVersion': MODEL_VERSION, 'spec': spec, 'nowUs': 0, 'revision': 0,
        'stepUs': spec.get('defaultStepUs', 1000000),
        'switches': {sid: bool(net.switch.at[i, 'closed']) for sid, i in index['switches'].items() if sid in actuators},
        'lines': {lid: True for lid in index['lines'] if not lid.startswith('line:')},
        'sources': {sid: True for sid in index['sources']},
        'generators': {gid: True for gid in index['generators']},
        'loads': {lid: {'connected': True, 'scale': 1.0} for lid in index['loads']},
        'storage': {sid: {'energyJ': float(cfg['energyJ']), 'dischargeW': 0.0} for sid, cfg in storage_specs.items()},
        'memory': {},
        'faults': sorted(faults, key=lambda f: (f['atUs'], f['faultId'])),
        'appliedFaults': [],
        'ledger': [],
        'receipts': {},
    }
    return state


class PowerPlant:
    def __init__(self, spec, faults=(), state=None):
        self.state = state if state is not None else initial_state(spec, list(faults))
        self.spec = self.state['spec']
        if self.state['modelVersion'] != MODEL_VERSION:
            raise Rejected('model_version_mismatch', self.state['modelVersion'])
        self.net, self.index = build_network(self.spec)
        self.envelope = self.spec['envelope']
        self.limits = self.spec['limits']
        self.nominal = {lid: (float(self.net.load.at[i, 'p_mw']), float(self.net.load.at[i, 'q_mvar'])) for lid, i in self.index['loads'].items()}
        self.essential = set(self.spec.get('essentialLoads') or [l['id'] for l in self.spec.get('loads', []) if l.get('essential')])
        self.storage_cfg = self.spec.get('storageState') or {s['id']: s for s in self.spec.get('storage', [])}
        for fault in self.state['faults']:
            self._check_fault(fault)
        self.solution = None
        self.solve_status = None
        self.dirty = True

    # ---- construction / restart ---------------------------------------------------------------
    @classmethod
    def from_checkpoint(cls, record):
        return cls(None, state=checkpoints.unseal(record))

    def checkpoint(self):
        return checkpoints.seal(self.state)

    def checkpoint_hash(self):
        return checkpoints.digest(self.state)

    def restore(self, record):
        state = checkpoints.unseal(record)
        if checkpoints.digest(state['spec']) != checkpoints.digest(self.spec):
            raise Rejected('checkpoint_network_mismatch')
        self.state = state
        self.dirty = True

    def admitted_model(self):
        """Estimated model a controller may fork: current configuration and storage as observed, with no
        fault schedule, ledger or receipts."""
        state = copy.deepcopy(self.state)
        state.update(kind='admitted', faults=[], appliedFaults=[], ledger=[], receipts={})
        return checkpoints.seal(state)

    @property
    def now_us(self):
        return self.state['nowUs']

    @property
    def revision(self):
        return self.state['revision']

    # ---- validation ---------------------------------------------------------------------------
    def _check_fault(self, fault):
        kind = FAULTS.get(fault.get('type'))
        if kind is None:
            raise Rejected('unknown_fault', str(fault.get('type')))
        if fault['assetId'] not in self.index[kind]:
            raise Rejected('unknown_asset', fault['assetId'])
        if not isinstance(fault.get('atUs'), int) or fault['atUs'] < 0:
            raise Rejected('invalid_time', fault.get('faultId', ''))
        if fault['type'] == 'load_change':
            lo, hi = self.envelope['loadScale']
            if not lo <= fault['scale'] <= hi:
                raise Rejected('outside_model_envelope', 'load scale %s' % fault['scale'])

    # ---- state -> network ---------------------------------------------------------------------
    def _apply(self, scale):
        st, net, idx = self.state, self.net, self.index
        for sid, closed in st['switches'].items():
            net.switch.at[idx['switches'][sid], 'closed'] = closed
        for lid, up in st['lines'].items():
            net.line.at[idx['lines'][lid], 'in_service'] = up
        for sid, up in st['sources'].items():
            net.ext_grid.at[idx['sources'][sid], 'in_service'] = up
        for gid, up in st['generators'].items():
            net.gen.at[idx['generators'][gid], 'in_service'] = up
        for lid, load in st['loads'].items():
            i, (p, q) = idx['loads'][lid], self.nominal[lid]
            net.load.at[i, 'in_service'] = load['connected']
            net.load.at[i, 'p_mw'] = p * load['scale'] * scale
            net.load.at[i, 'q_mvar'] = q * load['scale'] * scale
        for sid, s in st['storage'].items():
            net.storage.at[idx['storage'][sid], 'p_mw'] = -self._storage_command(sid) / W_PER_MW

    def _storage_command(self, sid):
        s, cap = self.state['storage'][sid], self.storage_cfg[sid]['capacityJ']
        if (s['dischargeW'] > 0 and s['energyJ'] <= 0) or (s['dischargeW'] < 0 and s['energyJ'] >= cap):
            return 0.0
        return s['dischargeW']

    def _run(self, scale):
        self._apply(scale)
        for init in ('flat', 'dc'):
            try:
                pp.runpp(self.net, init=init, max_iteration=self.envelope['maxIterations'], numba=False, calculate_voltage_angles=True)
                return True
            except LoadflowNotConverged:
                continue
        return False

    def solve(self):
        started = time.perf_counter()
        status, diagnostics = classify_solve(self._run)
        if status != 'converged':
            self._apply(1.0)  # leave the network at the commanded state; its result tables are not used
        self.solve_status = {'status': status, 'diagnostics': diagnostics, 'atUs': self.now_us, 'solveSeconds': round(time.perf_counter() - started, 6)}
        if status == 'converged':
            self.solution = self._extract()
        self.dirty = False
        return self.solve_status

    def _extract(self):
        net, idx = self.net, self.index
        vm = net.res_bus.vm_pu
        lo, hi = self.envelope['vmPu']
        energized = {b: vm.at[i] == vm.at[i] for b, i in idx['buses'].items()}  # NaN marks an unsupplied bus
        bad = [b for b, i in idx['buses'].items() if energized[b] and not lo <= vm.at[i] <= hi]
        if bad:
            self.solve_status.update(status='outside_model_envelope', diagnostics={'buses': bad})
        events = []
        vlo, vhi = self.limits['vmPu']
        for b, i in idx['buses'].items():
            if energized[b] and not vlo <= vm.at[i] <= vhi:
                events.append({'type': 'voltage_limit', 'assetId': b, 'value': float(vm.at[i]), 'unit': 'pu'})
        loading = {}
        for lid, i in idx['lines'].items():
            value = net.res_line.loading_percent.at[i]
            loading[lid] = 0.0 if value != value else float(value) / 100
            if loading[lid] > self.limits['maxLoading']:
                events.append({'type': 'thermal_limit', 'assetId': lid, 'value': loading[lid], 'unit': '1'})
        bus_of_load = {lid: int(net.load.at[i, 'bus']) for lid, i in idx['loads'].items()}
        loads = {}
        for lid, i in idx['loads'].items():
            # Supplied only when connected and its bus is energized; the solved result, not the setpoint.
            supplied = net.load.at[i, 'in_service'] and vm.at[bus_of_load[lid]] == vm.at[bus_of_load[lid]]
            loads[lid] = float(net.res_load.p_mw.at[i]) * W_PER_MW if supplied else 0.0
        storage = {}
        for sid, i in idx['storage'].items():
            value = net.res_storage.p_mw.at[i]
            storage[sid] = 0.0 if value != value else -float(value) * W_PER_MW
        gens = {gid: (0.0 if net.res_gen.p_mw.at[i] != net.res_gen.p_mw.at[i] else float(net.res_gen.p_mw.at[i]) * W_PER_MW) for gid, i in idx['generators'].items()}
        for gid, i in idx['generators'].items():
            if gens[gid] > float(net.gen.at[i, 'max_p_mw']) * W_PER_MW:
                events.append({'type': 'generator_limit', 'assetId': gid, 'value': gens[gid], 'unit': 'W'})
        voltage = {b: (float(vm.at[i]) * float(net.bus.at[i, 'vn_kv']) * 1000 if energized[b] else 0.0) for b, i in idx['buses'].items()}
        return {
            'atUs': self.now_us, 'busVoltageV': voltage, 'busVmPu': {b: (float(vm.at[i]) if energized[b] else 0.0) for b, i in idx['buses'].items()},
            'lineLoading': loading, 'lineLossW': {lid: (0.0 if net.res_line.pl_mw.at[i] != net.res_line.pl_mw.at[i] else float(net.res_line.pl_mw.at[i]) * W_PER_MW) for lid, i in idx['lines'].items()},
            'loadsW': loads, 'storageW': storage, 'generatorsW': gens,
            'sourcesW': {sid: (0.0 if net.res_ext_grid.p_mw.at[i] != net.res_ext_grid.p_mw.at[i] else float(net.res_ext_grid.p_mw.at[i]) * W_PER_MW) for sid, i in idx['sources'].items()},
            'constraintEvents': events, 'loadBus': bus_of_load,
        }

    def _ensure_solved(self):
        if self.dirty or self.solution is None and self.solve_status is None:
            self.solve()

    def _usable(self):
        return self.solve_status and self.solve_status['status'] == 'converged'

    # ---- world events and actions ----------------------------------------------------------------
    def _apply_due_faults(self):
        st = self.state
        while st['faults'] and st['faults'][0]['atUs'] <= st['nowUs']:
            fault = st['faults'].pop(0)
            kind = FAULTS[fault['type']]
            if kind == 'loads':
                st['loads'][fault['assetId']]['scale'] = float(fault['scale'])
            else:
                st[kind][fault['assetId']] = False
                st['revision'] += 1
            st['appliedFaults'].append(fault['faultId'])
            self.dirty = True

    def change(self, action, base_revision):
        params = action.get('params', {})
        schema = ACTIONS.get(action.get('type'))
        if schema is None:
            raise Rejected('unknown_action', str(action.get('type')))
        if sorted(params) != sorted(schema):
            raise Rejected('invalid_parameters', ','.join(sorted(params)))
        st = self.state
        if base_revision != st['revision']:
            raise Rejected('stale_command', 'based on revision %s, plant is at %s' % (base_revision, st['revision']))
        if action['type'] == 'set_switch':
            if params['switchId'] not in st['switches']:
                raise Rejected('unknown_actuator', params['switchId'])
            target = ('switches', params['switchId'], bool(params['closed']))
        elif action['type'] == 'set_load_connected':
            if params['loadId'] not in st['loads']:
                raise Rejected('unknown_actuator', params['loadId'])
            target = ('loads', params['loadId'], bool(params['connected']))
        else:
            if params['storageId'] not in st['storage']:
                raise Rejected('unknown_actuator', params['storageId'])
            value = params['dischargeW']
            if not isinstance(value, (int, float)) or value != value or abs(value) > self.storage_cfg[params['storageId']]['pMaxW']:
                raise Rejected('limit_exceeded', str(value))
            target = ('storage', params['storageId'], float(value))
        kind, asset, value = target
        if kind == 'switches':
            st['switches'][asset] = value
        elif kind == 'loads':
            st['loads'][asset]['connected'] = value
        else:
            st['storage'][asset]['dischargeW'] = value
        st['revision'] += 1
        self.dirty = True
        return {'kind': kind, 'assetId': asset, 'value': value, 'revision': st['revision']}

    # ---- time ---------------------------------------------------------------------------------
    def advance(self, to_us):
        st = self.state
        if not isinstance(to_us, int):
            raise Rejected('invalid_time', str(to_us))
        if to_us < st['nowUs']:
            raise Rejected('clock_regression', '%d < %d' % (to_us, st['nowUs']))
        lo_step, hi_step = self.envelope['stepUs']
        step = min(max(st['stepUs'], lo_step), hi_step)
        while st['nowUs'] < to_us:
            self._apply_due_faults()
            self._ensure_solved()
            end = min(to_us, st['nowUs'] + step)
            if st['faults']:
                end = min(end, max(st['faults'][0]['atUs'], st['nowUs'] + 1))
            usable = self._usable()
            # Storage reaching empty/full ends the step there, so energy is never overdrawn.
            for sid, s in st['storage'].items():
                p = self.solution['storageW'][sid] if usable else 0.0
                if p > 0 and s['energyJ'] > 0:
                    end = min(end, st['nowUs'] + max(1, int(-(-s['energyJ'] * 1e6 // p))))
                cap = self.storage_cfg[sid]['capacityJ']
                if p < 0 and s['energyJ'] < cap:
                    end = min(end, st['nowUs'] + max(1, int(-(-(cap - s['energyJ']) * 1e6 // -p))))
            self._record(usable)
            seconds = (end - st['nowUs']) / 1e6
            for sid, s in st['storage'].items():
                p = self.solution['storageW'][sid] if usable else 0.0
                before = s['energyJ']
                s['energyJ'] = min(self.storage_cfg[sid]['capacityJ'], max(0.0, before - p * seconds))
                if (before > 0 and s['energyJ'] == 0) or (before < self.storage_cfg[sid]['capacityJ'] == s['energyJ']):
                    self.dirty = True
            st['nowUs'] = end
        self._apply_due_faults()
        return {'atUs': st['nowUs'], 'revision': st['revision'], 'solveStatus': (self.solve_status or {}).get('status')}

    def _record(self, usable):
        st = self.state
        demand = {lid: self.nominal[lid][0] * W_PER_MW * load['scale'] for lid, load in st['loads'].items()}
        st['ledger'].append({
            'atUs': st['nowUs'], 'status': self.solve_status['status'], 'demand': demand,
            'loads': {lid: (self.solution['loadsW'][lid] if usable else None) for lid in st['loads']},
            'storage': {sid: {'dischargeW': (self.solution['storageW'][sid] if usable else None), 'energyJ': s['energyJ']} for sid, s in st['storage'].items()},
        })

    # ---- controller-facing views ----------------------------------------------------------------
    def observe(self):
        self._ensure_solved()
        usable = self._usable()
        sol = self.solution if usable else None
        readings = []
        for sensor in self.spec['sensors']:
            metric, asset = sensor['metric'], sensor['assetId']
            value, reason = None, 'solution_unavailable'
            if metric == 'power.switch_state':
                value, reason = (1 if self.state['switches'][asset] else 0), None
            elif metric == 'energy.stored':
                value, reason = self.state['storage'][asset]['energyJ'], None
            elif sol is not None:
                reason = None
                value = {'power.voltage': sol['busVoltageV'], 'power.active': sol['loadsW'], 'power.loading': sol['lineLoading']}[metric][asset]
            entry = {'sensorId': sensor['id'], 'assetId': asset, 'metric': metric, 'value': value, 'unit': UNITS[metric]}
            if value is None:
                entry['missingReason'] = reason
            readings.append(entry)
        return {'atUs': self.now_us, 'configurationRevision': self.revision, 'solveStatus': self.solve_status['status'], 'readings': readings}

    def preview(self, plan, model_record):
        state = checkpoints.unseal(model_record)
        if state.get('kind') != 'admitted':
            raise Rejected('model_not_admitted')
        start = state['nowUs']
        fork = PowerPlant(None, state=state)
        for action in plan.get('actions', []):
            fork.change(action, fork.revision)
        horizon = plan['horizonUs']
        fork.advance(fork.now_us + horizon)
        summary = fork.service_summary(from_us=start)
        statuses = sorted({s['status'] for s in fork.state['ledger']})
        return {'kind': 'preview', 'modelHash': model_record['hash'], 'modelVersion': MODEL_VERSION, 'horizonUs': horizon, 'solveStatuses': statuses,
                'essential_unserved_j': summary['essentialUnservedJ'], 'essential_demand_j': summary['essentialDemandJ'], 'status': summary['status'],
                'constraintEvents': (fork.solution or {}).get('constraintEvents', []) if fork._usable() else []}

    # ---- private evaluator views ----------------------------------------------------------------
    def service_record(self):
        return {'networkId': self.spec['networkId'], 'toUs': self.now_us, 'samples': copy.deepcopy(self.state['ledger']), 'essential': sorted(self.essential)}

    def service_cases(self, from_us=0):
        """Per-load scoring inputs in the reference scorer's format (W, microseconds)."""
        samples = [s for s in self.state['ledger'] if s['atUs'] >= from_us]
        ends = [s['atUs'] for s in samples[1:]] + [self.now_us]
        cases = {}
        for lid in self.state['loads']:
            cases[lid] = {'fromUs': samples[0]['atUs'] if samples else from_us, 'toUs': self.now_us,
                          'demand': [{'fromUs': s['atUs'], 'toUs': e, 'value': s['demand'][lid]} for s, e in zip(samples, ends) if e > s['atUs']],
                          'supply': [{'atUs': s['atUs'], 'value': s['loads'][lid]} for s in samples]}
        return cases

    def service_summary(self, from_us=0):
        from scoring import score_service
        by_load = {}
        for lid, case in self.service_cases(from_us).items():
            r = score_service(case)
            by_load[lid] = {'demandJ': r['demandIntegral'], 'servedJ': r['servedIntegral'], 'deficitJ': r['deficitIntegral'], 'score': r['score'], 'status': r['status']}
        essential = [by_load[l] for l in sorted(self.essential)]
        complete = all(r['status'] == 'scored' for r in essential)
        return {'byLoad': by_load, 'status': 'scored' if complete else 'capture_incomplete',
                'essentialDemandJ': sum(r['demandJ'] for r in essential),
                'essentialUnservedJ': sum(r['deficitJ'] for r in essential) if complete else None}


# ---- stdio worker --------------------------------------------------------------------------------
def describe():
    return {'domainId': DOMAIN, 'modelVersion': MODEL_VERSION, 'units': UNITS, 'actions': ACTIONS, 'faultTypes': sorted(FAULTS),
            'operations': {op: True for op in ('describe', 'initialize', 'observe', 'preview', 'validate', 'execute', 'readback', 'checkpoint', 'restore', 'advance', 'close')},
            'limitations': ['Balanced steady-state AC power flow at discrete steps; no transients, protection coordination, black start or switching surges.',
                            'Islands without a slack source (ext_grid or slack generator) are unsupplied; storage is grid-following.',
                            'Storage is lossless within its declared energy capacity.',
                            'A load level beyond loadability or a numerical failure yields no solution; service is then missing, never full.']}


def worker_handlers():
    session = {'plant': None, 'runId': None, 'checkpoints': {}, 'models': {}}

    def plant():
        if session['plant'] is None:
            raise Rejected('not_initialized')
        return session['plant']

    def store(table, record, prefix):
        key = '%s-%d' % (prefix, len(session[table]) + 1)
        session[table][key] = record
        return key

    def initialize(args):
        session['plant'] = PowerPlant(args['network'], faults=args.get('faults', []))
        session['runId'] = args.get('runId')
        if 'stepUs' in args:
            session['plant'].state['stepUs'] = int(args['stepUs'])
        return {'atUs': 0, 'configurationRevision': 0, 'networkId': args['network']['networkId'], 'modelVersion': MODEL_VERSION}

    def execute(args):
        action, p = args['action'], plant()
        prior = p.state['receipts'].get(action['actionId'])
        if prior is not None:
            return dict(prior, duplicate=True)
        requested = p.now_us
        try:
            effect = p.change(action, action['baseRevision'])
            receipt = {'actionId': action['actionId'], 'status': 'success', 'reason': 'applied', 'requestedAtUs': requested, 'startedAtUs': requested,
                       'completedAtUs': p.now_us, 'actualSettings': [effect], 'configurationRevision': p.revision}
        except Rejected as error:
            receipt = {'actionId': action['actionId'], 'status': 'rejected', 'reason': error.code, 'detail': error.detail, 'requestedAtUs': requested,
                       'startedAtUs': None, 'completedAtUs': None, 'actualSettings': [], 'configurationRevision': p.revision}
        p.state['receipts'][action['actionId']] = receipt
        return receipt

    def validate(args):
        p = plant()
        trial = PowerPlant(None, state=copy.deepcopy(p.state))
        try:
            trial.change(args['action'], args['action']['baseRevision'])
            return {'ok': True, 'code': 'ok'}
        except Rejected as error:
            return {'ok': False, 'code': error.code, 'detail': error.detail}

    def readback(args):
        receipt = plant().state['receipts'].get(args['actionId'])
        if receipt is None:
            raise Rejected('unknown_action', args['actionId'])
        return receipt

    def checkpoint(args):
        record = plant().checkpoint()
        return {'checkpointId': store('checkpoints', record, 'cp'), 'hash': record['hash'], 'atUs': plant().now_us}

    def restore(args):
        record = session['checkpoints'].get(args.get('checkpointId'))
        if record is None:
            raise Rejected('unknown_checkpoint', str(args.get('checkpointId')))
        plant().restore(record)
        return {'atUs': plant().now_us, 'hash': record['hash'], 'configurationRevision': plant().revision}

    def admitted_model(args):
        record = plant().admitted_model()
        return {'modelId': store('models', record, 'model'), 'hash': record['hash'], 'atUs': plant().now_us}

    def preview(args):
        record = session['models'].get(args.get('modelId'))
        if record is None:
            raise Rejected('unknown_model', str(args.get('modelId')))
        return plant().preview(args['plan'], record)

    def service(args):
        p = plant()
        return {'record': p.service_record(), 'cases': p.service_cases(), 'summary': p.service_summary()}

    def close(args):
        session.update(plant=None, checkpoints={}, models={})
        return {'closed': True}

    return {
        'hello': lambda a: dict(describe(), protocol=1),
        'describe': lambda a: describe(),
        'initialize': initialize,
        'observe': lambda a: plant().observe(),
        'validate': validate,
        'execute': execute,
        'readback': readback,
        'checkpoint': checkpoint,
        'checkpoint_hash': lambda a: {'hash': plant().checkpoint_hash()},
        'restore': restore,
        'admitted_model': admitted_model,
        'preview': preview,
        'advance': lambda a: plant().advance(a['toUs']),
        'service_record': service,
        'close': close,
        'shutdown': lambda a: {'stopping': True},
    }


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=('serve', 'spike'))
    parser.add_argument('--out', default=None, help='spike: report path')
    args = parser.parse_args(argv)
    if args.command == 'serve':
        serve(worker_handlers())
        return 0
    import power_spike
    return power_spike.run(args.out)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
