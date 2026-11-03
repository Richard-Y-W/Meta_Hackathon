"""P18 analysis: service score, paired differences, family-cluster bootstrap, claim classification and the
accounting of every declared first attempt. Pure standard library; hand-calculated data.
python3 -m unittest discover -s runtime/infra/tests -p test_analysis.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analysis import WEIGHTS, accounting, classify, cluster_bootstrap, critical_groups, paired, service_score  # noqa: E402

MJ = 1e6


def truth(jh=0.0, jf=0.0, jr=0.0, power_mj=0.0):
    """Required: JH 100, JF 50, JR 200 m3; essential power 1000 MJ."""
    return {'water': {'byNode': {'JH': {'requiredM3': 100.0, 'deficitM3': jh}, 'JF': {'requiredM3': 50.0, 'deficitM3': jf},
                                 'JR': {'requiredM3': 200.0, 'deficitM3': jr}}},
            'power': {'essentialDemandJ': 1000 * MJ, 'essentialUnservedJ': power_mj * MJ}}


def row(case, family, controller, S_truth, attempt=1, status='complete', commands=(), calls=(), trace=None):
    return {'caseId': case, 'family': family, 'controller': controller, 'attempt': attempt, 'status': status, 'truth': S_truth,
            'commands': list(commands), 'metaCalls': list(calls),
            'trace': trace if trace is not None else [{'atUs': 0, 'hospitalWaterFraction': 1, 'essentialPowerFraction': 1}]}


class Score(unittest.TestCase):
    def test_weighted_deficit_by_hand(self):
        # D: JH 10/100 = 0.1, JF 0, power 250/1000 = 0.25, JR 50/200 = 0.25 (weight 0.2).
        s = service_score(truth(jh=10, power_mj=250, jr=50))
        self.assertAlmostEqual(s['S'], 1 - (0.1 + 0.25 + 0.2 * 0.25) / 3.2)
        self.assertEqual(s['D'], {'JH': 0.1, 'JF': 0.0, 'power': 0.25, 'JR': 0.25})
        self.assertAlmostEqual(s['essentialDeficit'], 0.35)
        self.assertEqual(sum(WEIGHTS.values()), 3.2)

    def test_missing_ledger_is_not_scored_as_perfect(self):
        t = truth()
        t['power']['essentialUnservedJ'] = None  # capture_incomplete
        with self.assertRaises(ValueError):
            service_score(t)


class Pairing(unittest.TestCase):
    def setUp(self):
        self.rows = [row('a', 'f1', 'meta', truth()), row('a', 'f1', 'base', truth(jh=10)),         # +0.1/3.2
                     row('b', 'f1', 'meta', truth(jh=10)), row('b', 'f1', 'base', truth()),         # -0.1/3.2
                     row('c', 'f2', 'meta', truth(power_mj=100)), row('c', 'f2', 'base', truth(power_mj=400))]  # +0.3/3.2

    def test_paired_signs(self):
        p = paired(self.rows, 'meta', 'base')
        d = {x['caseId']: x['diff'] for x in p['pairs']}
        self.assertAlmostEqual(d['a'], 0.1 / 3.2)
        self.assertAlmostEqual(d['b'], -0.1 / 3.2)
        self.assertAlmostEqual(d['c'], 0.3 / 3.2)
        self.assertAlmostEqual(p['mean'], (0.1 - 0.1 + 0.3) / 3.2 / 3)  # each scenario group weighs equally

    def test_relative_essential_deficit_and_service_regressions(self):
        p = paired(self.rows, 'meta', 'base')
        # Essential deficit sums: meta 0 + 0.1 + 0.1 = 0.2; base 0.1 + 0 + 0.4 = 0.5 -> 60% reduction.
        self.assertAlmostEqual(p['relativeEssentialReduction'], 0.6)
        # Mean per-service change in D (method - comparator): JH (0 + 0.1 - 0... ) / 3.
        self.assertAlmostEqual(p['serviceRegression']['JH'], (-0.1 + 0.1 + 0) / 3)
        self.assertAlmostEqual(p['serviceRegression']['power'], (0 + 0 - 0.3) / 3)

    def test_a_missing_or_crashed_pair_is_counted_not_dropped(self):
        rows = self.rows + [row('d', 'f2', 'meta', truth())]  # no comparator row
        p = paired(rows, 'meta', 'base')
        self.assertEqual(p['missing'], ['d'])
        self.assertEqual(len(p['pairs']), 3)

    def test_an_infrastructure_rerun_replaces_the_attempt_but_both_are_counted(self):
        rows = [r for r in self.rows if r['caseId'] != 'c'] + [
            row('c', 'f2', 'meta', None, attempt=1, status='infrastructure_invalid'), row('c', 'f2', 'base', truth(power_mj=400), attempt=1),
            row('c', 'f2', 'meta', truth(power_mj=100), attempt=2), row('c', 'f2', 'base', truth(power_mj=400), attempt=2)]
        p = paired(rows, 'meta', 'base')
        self.assertAlmostEqual({x['caseId']: x['diff'] for x in p['pairs']}['c'], 0.3 / 3.2)
        a = accounting(rows, ['a', 'b', 'c'], ['meta', 'base'])
        self.assertEqual(a['declaredFirstAttempts'], 6)
        self.assertEqual(a['firstAttemptsRun'], 6)
        self.assertEqual(a['infrastructureInvalid'], 1)
        self.assertEqual(a['reruns'], 2)


    def test_an_invalid_attempt_without_its_rerun_leaves_the_group_missing(self):
        rows = [r for r in self.rows if not (r['caseId'] == 'c' and r['controller'] == 'meta')] + [
            row('c', 'f2', 'meta', truth(power_mj=0), status='infrastructure_invalid')]
        self.assertEqual(paired(rows, 'meta', 'base')['missing'], ['c'])


class Bootstrap(unittest.TestCase):
    def test_families_are_resampled_as_clusters(self):
        # Family f1 has two groups with identical diffs; f2 one group. A family-level resample can only produce
        # means of whole families: every bootstrap mean is a combination of the family values.
        pairs = [{'caseId': 'a', 'family': 'f1', 'diff': 0.02}, {'caseId': 'b', 'family': 'f1', 'diff': 0.02}, {'caseId': 'c', 'family': 'f2', 'diff': -0.04}]
        b = cluster_bootstrap(pairs, reps=2000, seed=1)
        # Possible draws (f1,f1): 0.02; (f2,f2): -0.04; mixed: (0.02*2 - 0.04)/3 = 0.0. Nothing else.
        self.assertTrue(set(round(m, 10) for m in b['means']) <= {0.02, -0.04, 0.0})
        self.assertAlmostEqual(b['estimate'], 0.0)  # group-weighted point estimate
        self.assertLessEqual(b['low'], b['estimate'])
        self.assertGreaterEqual(b['high'], b['estimate'])

    def test_constant_positive_effect_excludes_zero(self):
        pairs = [{'caseId': str(i), 'family': 'f%d' % (i % 4), 'diff': 0.01} for i in range(8)]
        b = cluster_bootstrap(pairs, reps=500, seed=2)
        self.assertAlmostEqual(b['low'], 0.01)
        self.assertAlmostEqual(b['high'], 0.01)


class Classification(unittest.TestCase):
    RULE = {'marginS': 0.005, 'relativeReduction': 0.10, 'regressionLimit': 0.005}

    def test_supported_only_when_every_criterion_passes(self):
        good = {'boot': {'estimate': 0.02, 'low': 0.01, 'high': 0.03}, 'relativeEssentialReduction': 0.5, 'serviceRegression': {'JH': -0.01, 'JF': 0, 'power': 0, 'JR': 0.001}, 'missing': []}
        self.assertEqual(classify(good, self.RULE)['verdict'], 'supported')
        harm = dict(good, serviceRegression={'JH': -0.05, 'JF': 0, 'power': 0, 'JR': 0.02})  # hides damage to another group
        self.assertEqual(classify(harm, self.RULE)['verdict'], 'inconclusive')
        small = dict(good, boot={'estimate': 0.004, 'low': 0.001, 'high': 0.007})
        self.assertEqual(classify(small, self.RULE)['verdict'], 'inconclusive')
        incomplete = dict(good, missing=['x'])
        self.assertEqual(classify(incomplete, self.RULE)['verdict'], 'incomplete')

    def test_contradicted_when_the_margin_is_excluded(self):
        worse = {'boot': {'estimate': -0.01, 'low': -0.02, 'high': 0.001}, 'relativeEssentialReduction': -0.2, 'serviceRegression': {}, 'missing': []}
        self.assertEqual(classify(worse, self.RULE)['verdict'], 'contradicted')
        tied = {'boot': {'estimate': 0.0, 'low': 0.0, 'high': 0.0}, 'relativeEssentialReduction': None, 'serviceRegression': {}, 'missing': []}
        self.assertEqual(classify(tied, self.RULE)['verdict'], 'contradicted')  # an exact tie excludes the 0.5 pp benefit


class CriticalGroups(unittest.TestCase):
    def test_b5_bounds_each_critical_service_separately(self):
        # The method helps power a lot but loses hospital water in every group: the aggregate gains, B5 fails on JH.
        rows = []
        for i, fam in enumerate(['f1', 'f2', 'f3', 'f4']):
            rows += [row(str(i), fam, 'meta', truth(jh=2, power_mj=0)), row(str(i), fam, 'base', truth(jh=0, power_mj=300))]
        b = critical_groups(paired(rows, 'meta', 'base')['pairs'], limit=0.005, reps=500, seed=3)
        self.assertAlmostEqual(b['groups']['JH']['low'], -0.02)
        self.assertFalse(b['groups']['JH']['pass'])
        self.assertTrue(b['groups']['power']['pass'])
        self.assertFalse(b['pass'])


class Accounting(unittest.TestCase):
    def test_failed_actions_timeouts_and_unrecovered_episodes_are_counted(self):
        rows = [row('a', 'f', 'meta', truth(), commands=[{'status': 'rejected'}, {'status': 'delivered'}],
                    calls=[{'code': 'provider_timeout'}, {'code': 'ok', 'parse': 'ok'}, {'skipped': 'no_opportunity'}],
                    trace=[{'atUs': 0, 'hospitalWaterFraction': 1, 'essentialPowerFraction': 1}, {'atUs': 9, 'hospitalWaterFraction': 0.4, 'essentialPowerFraction': 1}]),
                row('a', 'f', 'base', truth())]
        a = accounting(rows, ['a'], ['meta', 'base'])
        self.assertEqual(a['byController']['meta']['refusedCommands'], 1)
        self.assertEqual(a['byController']['meta']['providerCalls'], 2)
        self.assertEqual(a['byController']['meta']['providerTimeouts'], 1)
        self.assertEqual(a['byController']['meta']['unrecoveredEpisodes'], 1)
        self.assertEqual(a['byController']['base']['unrecoveredEpisodes'], 0)

    def test_an_undeclared_missing_first_attempt_is_reported(self):
        a = accounting([row('a', 'f', 'meta', truth())], ['a', 'b'], ['meta'])
        self.assertEqual(a['declaredFirstAttempts'], 2)
        self.assertEqual(a['firstAttemptsRun'], 1)
        self.assertEqual(a['notRun'], [['b', 'meta']])


if __name__ == '__main__':
    unittest.main()
