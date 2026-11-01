"""Independent service-accounting check against the hand-calculated analytic cases."""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))

import scoring  # noqa: E402

with open(os.path.join(REPO, 'fixtures/lifeline/infra/analytic-service-cases.json')) as handle:
    CASES = json.load(handle)


def close(a, b):
    if a is None or b is None:
        return a is b
    return abs(a - b) <= 1e-9 * max(1.0, abs(b))


class AnalyticCases(unittest.TestCase):
    def test_every_case_matches_the_hand_calculation(self):
        for case in CASES['cases']:
            with self.subTest(case=case['id']):
                result = scoring.score_service(case)
                for key, value in case['expected'].items():
                    if isinstance(value, list):
                        for i, v in enumerate(value):
                            self.assertTrue(close(result[key][i], v), (case['id'], key, result[key], value))
                    elif isinstance(value, str):
                        self.assertEqual(result[key], value, case['id'])
                    else:
                        self.assertTrue(close(result[key], value), (case['id'], key, result[key], value))

    def test_missing_supply_is_never_delivered_or_lost(self):
        r = scoring.score_service({'demand': [{'fromUs': 0, 'toUs': 1000000, 'value': 5}], 'supply': [], 'fromUs': 0, 'toUs': 1000000})
        self.assertEqual((r['status'], r['score'], r['servedIntegral']), ('capture_incomplete', None, 0))

    def test_shed_flag_does_not_change_the_denominator(self):
        case = [c for c in CASES['cases'] if c['id'] == 'shed-demand-stays-in-denominator'][0]
        self.assertTrue(close(scoring.score_service(case)['demandIntegral'], 10000))


if __name__ == '__main__':
    unittest.main()
