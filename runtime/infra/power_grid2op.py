"""Grid2Op benchmark profile (P07): a separate electrical operations profile, not the coupled-town backend.

Runs in its own environment (.work/environments/grid2op) with the package's bundled test data, so nothing
is downloaded to the home directory. Exposes line-status actions, a restricted observation (loading, line
status, cooldowns, load/generation in W), Grid2Op legality mapped to receipt reasons, and captured episode
termination. A terminal episode is final: Grid2Op does not simulate restoration, so this profile refuses
further steps instead of continuing as if it did. Results carry the profile id.
"""
import os
import sys
import warnings

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
warnings.filterwarnings('ignore')

import grid2op  # noqa: E402
from grid2op.Parameters import Parameters  # noqa: E402

from protocol import Rejected  # noqa: E402

PROFILE_ID = 'grid2op-l2rpn-case14-sandbox-v1'
ENVIRONMENT = 'l2rpn_case14_sandbox'
STEP_US = 300000000
W_PER_MW = 1e6


class Grid2OpProfile:
    def __init__(self, seed=0, chronic=0, cooldown_steps=None, _env=None, _obs=None):
        if _env is None:
            params = Parameters()
            if cooldown_steps is not None:
                params.NB_TIMESTEP_COOLDOWN_LINE = cooldown_steps
            _env = grid2op.make(ENVIRONMENT, test=True, param=params)
            _obs = _env.reset(seed=seed, options={'time serie id': chronic})
        self._env, self._obs = _env, _obs
        self._lines = {name: i for i, name in enumerate(_env.name_line)}
        self._step = 0 if _obs is None else int(_obs.current_step)
        self._terminal = None
        self._seed, self._chronic = seed, chronic

    def describe(self):
        env = self._env
        return {
            'profileId': PROFILE_ID, 'environment': ENVIRONMENT, 'testData': True, 'grid2op': grid2op.__version__,
            'backend': type(env.backend).__name__, 'actionClass': type(env.action_space({})).__name__, 'observationClass': type(self._obs).__name__,
            'stepUs': int(env.delta_time_seconds * 1e6), 'maxSteps': int(env.max_episode_duration()),
            'parameters': {'cooldownLineSteps': int(env.parameters.NB_TIMESTEP_COOLDOWN_LINE), 'maxLineChangesPerStep': int(env.parameters.MAX_LINE_STATUS_CHANGED),
                           'overflowAllowedSteps': int(env.parameters.NB_TIMESTEP_OVERFLOW_ALLOWED), 'hardOverflowThreshold': float(env.parameters.HARD_OVERFLOW_THRESHOLD)},
            'actions': {'set_line_status': {'lineId': 'id', 'connected': 'bool'}},
            'units': {'rho': '1 (flow / thermal limit)', 'loadsW': 'W', 'generatorsW': 'W'},
            'restoration': 'not_simulated', 'restart': 'reset(seed, chronic) replays deterministically; fork() copies the environment',
            'seed': self._seed, 'chronic': self._chronic,
        }

    def _alive(self):
        if self._terminal is not None:
            raise Rejected('episode_terminal', self._terminal['terminalReason'])

    def observe(self):
        self._alive()
        o = self._obs
        return {
            'profile': PROFILE_ID, 'step': self._step, 'timeUs': self._step * STEP_US,
            'lines': {name: {'rho': round(float(o.rho[i]), 9), 'connected': bool(o.line_status[i]), 'cooldownSteps': int(o.time_before_cooldown_line[i])}
                      for name, i in self._lines.items()},
            'loadsW': {name: float(o.load_p[i]) * W_PER_MW for i, name in enumerate(self._env.name_load)},
            'generatorsW': {name: float(o.gen_p[i]) * W_PER_MW for i, name in enumerate(self._env.name_gen)},
        }

    def _convert(self, actions):
        changes = []
        for action in actions:
            if action.get('type') != 'set_line_status':
                raise Rejected('unsupported_action', str(action.get('type')))
            line = action['params']['lineId']
            if line not in self._lines:
                raise Rejected('unknown_asset', line)
            changes.append((self._lines[line], 1 if action['params']['connected'] else -1, line))
        return changes

    def step(self, actions, precheck=True):
        """One Grid2Op step (5 simulated minutes). Returns a labeled result; an illegal action is a rejected
        receipt (Grid2Op then applies do-nothing for that step, as its rules specify)."""
        self._alive()
        changes = self._convert(actions)
        if precheck:
            for index, _, name in changes:
                if self._obs.time_before_cooldown_line[index] > 0:
                    return {'profile': PROFILE_ID, 'status': 'rejected', 'reason': 'cooldown_active', 'detail': name, 'submitted': False, 'terminal': False,
                            'observation': self.observe()}
        act = self._env.action_space({'set_line_status': [(i, v) for i, v, _ in changes]}) if changes else self._env.action_space({})
        obs, _, done, info = self._env.step(act)
        self._step += 1
        if done:
            reasons = [type(e).__name__ for e in info.get('exception', [])]
            self._terminal = {'terminalReason': reasons[0] if reasons else ('episode_complete' if self._step >= self._env.max_episode_duration() else 'game_over'),
                              'atStep': self._step, 'detail': [str(e)[:200] for e in info.get('exception', [])]}
            return dict(self._terminal, profile=PROFILE_ID, status='applied' if not info.get('is_illegal') else 'rejected', terminal=True, submitted=True, observation=None)
        self._obs = obs
        illegal = bool(info.get('is_illegal')) or bool(info.get('is_ambiguous'))
        return {'profile': PROFILE_ID, 'status': 'rejected' if illegal else 'applied', 'reason': ('illegal_action' if info.get('is_illegal') else 'ambiguous_action') if illegal else 'applied',
                'detail': [str(e)[:200] for e in info.get('exception', [])], 'submitted': True, 'terminal': False, 'observation': self.observe()}

    def fork(self):
        self._alive()
        twin = Grid2OpProfile(_env=self._env.copy(), _obs=self._obs.copy())
        twin._step, twin._seed, twin._chronic = self._step, self._seed, self._chronic
        return twin


def acceptance(out_path):
    """Acceptance record: pinned profile, a full do-nothing episode, a forced terminal contingency and a
    fork/replay check. Written as JSON evidence."""
    import json
    import time
    record = {'schema': 'lifeline.grid2op-acceptance.v1', 'describe': Grid2OpProfile(seed=0, chronic=0).describe()}
    started = time.perf_counter()
    p, steps, worst = Grid2OpProfile(seed=0, chronic=0), 0, 0.0
    while True:
        r = p.step([])
        steps += 1
        if r['terminal']:
            break
        worst = max(worst, max(l['rho'] for l in r['observation']['lines'].values()))
    record['doNothing'] = {'steps': steps, 'terminalReason': r['terminalReason'], 'maxRho': worst, 'wallSeconds': round(time.perf_counter() - started, 3)}
    p = Grid2OpProfile(seed=0, chronic=0)
    trace = []
    for line in ('5_12_9', '5_10_7', '1_4_4'):
        r = p.step([{'type': 'set_line_status', 'params': {'lineId': line, 'connected': False}}])
        trace.append({'line': line, 'terminal': r['terminal'], 'maxRho': None if r['terminal'] else max(l['rho'] for l in r['observation']['lines'].values()),
                      'terminalReason': r.get('terminalReason'), 'detail': r.get('detail')})
    try:
        p.step([])
        after = 'continued'
    except Rejected as error:
        after = error.code
    record['forcedContingency'] = {'trace': trace, 'stepAfterTerminal': after}
    a = Grid2OpProfile(seed=1, chronic=0)
    for _ in range(3):
        a.step([])
    b = a.fork()
    act = [{'type': 'set_line_status', 'params': {'lineId': '1_3_3', 'connected': False}}]
    record['fork'] = {'identical': a.step(act)['observation'] == b.step(act)['observation']}
    with open(out_path, 'w') as handle:
        json.dump(record, handle, indent=2, allow_nan=False)
        handle.write('\n')
    print(json.dumps({'doNothing': record['doNothing'], 'stepAfterTerminal': after, 'fork': record['fork']}))
    return 0


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Grid2Op profile acceptance record')
    parser.add_argument('--out', required=True)
    sys.exit(acceptance(parser.parse_args().out))
