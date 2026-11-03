"""P13: perfect-information ceiling on small finite schedule spaces (town environment).
.work/environments/town/bin/python -m unittest discover -s runtime/infra/tests -p test_baselines.py"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, os.path.dirname(HERE))

try:
    import pandapower  # noqa: F401
    import wntr  # noqa: F401
    HAVE = True
except ImportError:
    HAVE = False

if HAVE:
    from baselines import oracle_ceiling

S = 1000000
with open(os.path.join(ROOT, 'fixtures/lifeline/infra/town/baseline-policy.json')) as handle:
    POLICY = json.load(handle)
CASES = {c['caseId']: c for c in POLICY['cases']}


@unittest.skipUnless(HAVE, 'needs the town environment')
class OracleCeiling(unittest.TestCase):
    def test_no_fault_optimum_takes_no_action(self):
        best = oracle_ceiling(CASES['b-no-fault'], 1860 * S, 4 * 3600 * S, slots=2)
        self.assertEqual((best['dispatch'], best['modes']), (None, ['auto', 'auto']))
        self.assertEqual(best['objective'][:3], (0.0, 0.0, 0.0))

    def test_high_storage_optimum_dispatches_at_once_and_serves_all_essential_water(self):
        best = oracle_ceiling(CASES['b-high-storage'], 1860 * S, 4 * 3600 * S, slots=3)
        self.assertEqual(best['dispatch'], 0)
        self.assertEqual(best['objective'][0], 0.0)
        self.assertEqual(best['evaluated'], 24)

    def test_more_capabilities_are_never_worse(self):
        full = oracle_ceiling(CASES['b-high-storage'], 1860 * S, 4 * 3600 * S, slots=3)
        withheld = oracle_ceiling(CASES['b-high-storage'], 1860 * S, 4 * 3600 * S, slots=3, capabilities=('allocate_generator',))
        self.assertLessEqual(full['objective'], withheld['objective'])


if __name__ == '__main__':
    unittest.main()
