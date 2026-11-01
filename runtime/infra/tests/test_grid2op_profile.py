"""P07 Grid2Op benchmark profile (separate environment .work/environments/grid2op). Run:
.work/environments/grid2op/bin/python -m unittest discover -s runtime/infra/tests -p test_grid2op_profile.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import grid2op  # noqa: F401
    HAVE_GRID2OP = True
except ImportError:
    HAVE_GRID2OP = False

if HAVE_GRID2OP:
    from power_grid2op import Grid2OpProfile, PROFILE_ID
    from protocol import Rejected

OPEN = lambda line: {'type': 'set_line_status', 'params': {'lineId': line, 'connected': False}}
CLOSE = lambda line: {'type': 'set_line_status', 'params': {'lineId': line, 'connected': True}}


@unittest.skipUnless(HAVE_GRID2OP, 'grid2op is installed only in .work/environments/grid2op')
class Grid2OpProfileTests(unittest.TestCase):
    def test_acceptance_record_pins_environment_backend_and_classes(self):
        p = Grid2OpProfile(seed=0, chronic=0)
        record = p.describe()
        self.assertEqual(record['profileId'], PROFILE_ID)
        self.assertEqual(record['environment'], 'l2rpn_case14_sandbox')
        self.assertTrue(record['backend'].startswith('PandaPowerBackend'))
        self.assertTrue(record['actionClass'].startswith('PlayableAction'))
        self.assertEqual(record['grid2op'], grid2op.__version__)
        self.assertEqual(record['restoration'], 'not_simulated')
        self.assertEqual(record['stepUs'], 300000000)

    def test_two_line_changes_in_one_step_map_to_illegal(self):
        p = Grid2OpProfile(seed=0, chronic=0)
        result = p.step([OPEN('1_2_2'), OPEN('1_3_3')])
        self.assertEqual(result['status'], 'rejected')
        self.assertEqual(result['reason'], 'illegal_action')
        self.assertFalse(result['terminal'])

    def test_cooldown_is_refused_before_submission_and_grid2op_agrees(self):
        p = Grid2OpProfile(seed=0, chronic=0, cooldown_steps=3)
        self.assertEqual(p.step([OPEN('2_3_5')])['status'], 'applied')
        self.assertEqual(p.observe()['lines']['2_3_5']['cooldownSteps'], 3)
        refused = p.step([CLOSE('2_3_5')])
        self.assertEqual((refused['status'], refused['reason'], refused['submitted']), ('rejected', 'cooldown_active', False))
        raw = p.step([CLOSE('2_3_5')], precheck=False)
        self.assertEqual((raw['status'], raw['reason'], raw['submitted']), ('rejected', 'illegal_action', True))

    def test_terminal_failure_is_captured_and_the_episode_cannot_continue(self):
        p = Grid2OpProfile(seed=0, chronic=0)
        result = None
        for line in ('5_12_9', '5_10_7', '1_4_4'):
            result = p.step([OPEN(line)])
        self.assertTrue(result['terminal'])
        self.assertEqual(result['terminalReason'], 'BackendError')
        self.assertEqual(result['profile'], PROFILE_ID)
        with self.assertRaises(Rejected) as caught:
            p.step([CLOSE('1_4_4')])
        self.assertEqual(caught.exception.code, 'episode_terminal')
        with self.assertRaises(Rejected):
            p.observe()

    def test_observation_is_restricted(self):
        p = Grid2OpProfile(seed=0, chronic=0)
        obs = p.observe()
        self.assertEqual(sorted(obs), ['generatorsW', 'lines', 'loadsW', 'profile', 'step', 'timeUs'])
        self.assertEqual(sorted(obs['lines']['0_1_0']), ['connected', 'cooldownSteps', 'rho'])
        self.assertFalse(hasattr(p, 'env'))

    def test_fork_reproduces_the_original_step_for_step(self):
        p = Grid2OpProfile(seed=1, chronic=0)
        for _ in range(3):
            p.step([])
        twin = p.fork()
        a, b = p.step([OPEN('1_3_3')]), twin.step([OPEN('1_3_3')])
        self.assertEqual(a['observation'], b['observation'])
        replay = Grid2OpProfile(seed=1, chronic=0)
        for _ in range(3):
            replay.step([])
        self.assertEqual(replay.step([OPEN('1_3_3')])['observation'], a['observation'])

    def test_unknown_line_and_action_are_rejected(self):
        p = Grid2OpProfile(seed=0, chronic=0)
        with self.assertRaises(Rejected) as caught:
            p.step([OPEN('nope')])
        self.assertEqual(caught.exception.code, 'unknown_asset')
        with self.assertRaises(Rejected) as caught:
            p.step([{'type': 'redispatch', 'params': {}}])
        self.assertEqual(caught.exception.code, 'unsupported_action')


if __name__ == '__main__':
    unittest.main()
