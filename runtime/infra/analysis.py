"""P18 analysis of the frozen research-v1 comparison (fixtures/lifeline/infra/protocol-research-v1.json).

Service score per scenario group: S = 1 - sum(w_s * D_s) / sum(w_s), D_s = unmet / requested over the episode,
from the evaluator's own ledgers. A comparison pairs the method and comparator on each group (each group
weighs equally), resamples families as clusters for a percentile interval, and classifies the claim:

- supported: the interval excludes zero, the mean gain reaches the margin, the essential deficit falls by
  the relative target, and no service's mean D worsens by more than the regression limit;
- contradicted: the interval's upper bound is below the margin (the claimed benefit is excluded);
- incomplete: a declared group lacks a valid pair;
- inconclusive: anything else.

Every declared first attempt, infrastructure rerun, refused or unconfirmed command, provider timeout and
unrecovered episode is counted. Standard library only.
"""
import json
import random
import sys

WEIGHTS = {'JH': 1.0, 'JF': 1.0, 'power': 1.0, 'JR': 0.2}
ESSENTIAL = ('JH', 'JF', 'power')


def service_score(truth):
    nodes, power = truth['water']['byNode'], truth['power']
    if power.get('essentialUnservedJ') is None or any(nodes[n].get('deficitM3') is None for n in ('JH', 'JF', 'JR')):
        raise ValueError('capture_incomplete: a service ledger is missing; the episode cannot be scored')
    D = {n: nodes[n]['deficitM3'] / nodes[n]['requiredM3'] if nodes[n]['requiredM3'] else 0.0 for n in ('JH', 'JF', 'JR')}
    D['power'] = power['essentialUnservedJ'] / power['essentialDemandJ'] if power['essentialDemandJ'] else 0.0
    D = {k: D[k] for k in ('JH', 'JF', 'power', 'JR')}
    S = 1 - sum(WEIGHTS[k] * D[k] for k in D) / sum(WEIGHTS.values())
    return {'S': S, 'D': D, 'essentialDeficit': sum(D[k] for k in ESSENTIAL)}


def final(rows, controller):
    """The valid attempt per group: the latest complete attempt (an infrastructure rerun replaces the first)."""
    out = {}
    for r in sorted((r for r in rows if r['controller'] == controller and r['status'] == 'complete'), key=lambda r: r['attempt']):
        out[r['caseId']] = r
    return out


def paired(rows, method, comparator):
    m, c = final(rows, method), final(rows, comparator)
    cases = sorted({r['caseId'] for r in rows if r['controller'] in (method, comparator)})
    pairs, missing = [], []
    for case in cases:
        if case not in m or case not in c:
            missing.append(case)
            continue
        sm, sc = service_score(m[case]['truth']), service_score(c[case]['truth'])
        pairs.append({'caseId': case, 'family': m[case]['family'], 'diff': sm['S'] - sc['S'], 'method': sm, 'comparator': sc})
    n = len(pairs)
    ess_m, ess_c = sum(p['method']['essentialDeficit'] for p in pairs), sum(p['comparator']['essentialDeficit'] for p in pairs)
    return {'method': method, 'comparator': comparator, 'pairs': pairs, 'missing': missing,
            'mean': sum(p['diff'] for p in pairs) / n if n else None,
            'relativeEssentialReduction': 1 - ess_m / ess_c if ess_c > 0 else None,
            'serviceRegression': {k: sum(p['method']['D'][k] - p['comparator']['D'][k] for p in pairs) / n for k in WEIGHTS} if n else {}}


def cluster_bootstrap(pairs, reps=5000, seed=20261103):
    families = sorted({p['family'] for p in pairs})
    by = {f: [p['diff'] for p in pairs if p['family'] == f] for f in families}
    rng, means = random.Random(seed), []
    for _ in range(reps):
        draw = [d for f in (rng.choice(families) for _ in families) for d in by[f]]
        means.append(sum(draw) / len(draw))
    ordered = sorted(means)
    q = lambda p: ordered[min(len(ordered) - 1, max(0, int(round(p * (len(ordered) - 1)))))]
    return {'estimate': sum(p['diff'] for p in pairs) / len(pairs), 'low': q(0.025), 'high': q(0.975), 'reps': reps, 'seed': seed,
            'families': len(families), 'means': means}


def critical_groups(pairs, limit=0.005, reps=5000, seed=20261103):
    """B5: per critical service, the cluster-bootstrap lower bound of the service change (comparator D minus
    method D; negative is a regression) must stay above -limit."""
    groups = {}
    for k in ESSENTIAL:
        b = cluster_bootstrap([{'caseId': p['caseId'], 'family': p['family'], 'diff': p['comparator']['D'][k] - p['method']['D'][k]} for p in pairs], reps, seed)
        groups[k] = {'estimate': b['estimate'], 'low': b['low'], 'pass': b['low'] > -limit}
    return {'groups': groups, 'pass': all(g['pass'] for g in groups.values()), 'limit': limit}


def classify(result, rule):
    b = result['boot']
    checks = {'intervalExcludesZero': b['low'] > 0, 'marginReached': b['estimate'] >= rule['marginS'],
              'relativeReduction': result['relativeEssentialReduction'] is not None and result['relativeEssentialReduction'] >= rule['relativeReduction'],
              'noServiceRegression': all(v <= rule['regressionLimit'] for v in result['serviceRegression'].values())}
    if result['missing']:
        verdict = 'incomplete'
    elif all(checks.values()):
        verdict = 'supported'
    elif b['high'] < rule['marginS']:
        verdict = 'contradicted'
    else:
        verdict = 'inconclusive'
    return {'verdict': verdict, 'checks': checks}


def unrecovered(row):
    last = row['trace'][-1] if row['trace'] else None
    return bool(last) and (last['hospitalWaterFraction'] < 1 or last['essentialPowerFraction'] < 1)


def accounting(rows, cases, controllers):
    declared = [(c, k) for c in cases for k in controllers]
    first = {(r['caseId'], r['controller']) for r in rows if r['attempt'] == 1}
    by = {}
    for k in controllers:
        valid = final(rows, k).values()
        calls = [x for r in rows if r['controller'] == k for x in r.get('metaCalls', []) if x.get('code')]
        cmds = [x for r in valid for x in r['commands']]
        by[k] = {'episodes': len(valid), 'refusedCommands': sum(x['status'] == 'rejected' for x in cmds),
                 'unconfirmedCommands': sum(x['status'] == 'unconfirmed' for x in cmds), 'expiredSteps': sum(x['status'] == 'expired' for x in cmds),
                 'deliveredCommands': sum(x['status'] == 'delivered' for x in cmds),
                 'providerCalls': len(calls), 'providerTimeouts': sum(x['code'] == 'provider_timeout' for x in calls),
                 'providerFailures': sum(x['code'] != 'ok' for x in calls), 'parsedAnswers': sum(x.get('parse') == 'ok' for x in calls),
                 'participated': sum(bool(x.get('participated')) for x in calls),
                 'outputTokens': sum((x.get('usage') or {}).get('output_tokens', 0) for x in calls),
                 'unrecoveredEpisodes': sum(unrecovered(r) for r in valid)}
    return {'declaredFirstAttempts': len(declared), 'firstAttemptsRun': sum(d in first for d in declared),
            'notRun': [list(d) for d in declared if d not in first],
            'infrastructureInvalid': sum(r['status'] == 'infrastructure_invalid' for r in rows), 'reruns': sum(r['attempt'] > 1 for r in rows),
            'byController': by}


def analyze(protocol, rows):
    cases = [c['caseId'] for c in protocol['cases']]
    family = {c['caseId']: c['family'] for c in protocol['cases']}
    rule = {'marginS': 0.005, 'relativeReduction': 0.10, 'regressionLimit': 0.005}
    boot = protocol['inference']['bootstrap']
    controllers = sorted({r['controller'] for r in rows})
    out = {'schema': 'lifeline.research-analysis.v1', 'protocolId': protocol['protocolId'], 'suiteSha256': protocol['freeze']['suiteSha256'], 'rule': rule,
           'accounting': accounting(rows, cases, controllers), 'comparisons': {}, 'perGroup': {}}

    def compare(name, method, comparator, subset=None):
        sel = [r for r in rows if subset is None or family[r['caseId']] in subset]
        p = paired(sel, method, comparator)
        if not p['pairs']:
            out['comparisons'][name] = {'method': method, 'comparator': comparator, 'verdict': 'incomplete', 'missing': p['missing']}
            return
        b = cluster_bootstrap(p['pairs'], boot['reps'], boot['seed'])
        res = {'boot': {k: b[k] for k in ('estimate', 'low', 'high', 'reps', 'seed', 'families')}, 'relativeEssentialReduction': p['relativeEssentialReduction'],
               'serviceRegression': p['serviceRegression'], 'missing': p['missing']}
        worst = {}
        for x in p['pairs']:
            worst.setdefault(x['family'], []).append(x['diff'])
        fam = {f: sum(v) / len(v) for f, v in worst.items()}
        out['comparisons'][name] = {'method': method, 'comparator': comparator, 'groups': len(p['pairs']), **res, **classify(res, rule),
                                    'familyMeans': fam, 'worstFamily': min(fam, key=fam.get), 'pairs': [{'caseId': x['caseId'], 'family': x['family'], 'diff': x['diff']} for x in p['pairs']]}

    if 'meta-complete' in controllers:
        compare('B2-vs-independent', 'meta-complete', 'independent')
        compare('B2-vs-hybrid', 'meta-complete', 'hybrid')
        p = paired(rows, 'meta-complete', 'hybrid')
        if p['pairs']:
            b5 = critical_groups(p['pairs'], rule['regressionLimit'], boot['reps'], boot['seed'])
            out['comparisons']['B5-critical-groups-vs-hybrid'] = {**b5, 'missing': p['missing'],
                'verdict': 'incomplete' if p['missing'] else ('supported' if b5['pass'] else 'contradicted'),
                'note': 'regression bound only; continued local control and no stale execution are checked from the episode logs'}
    compare('B1-anticipatory', 'hybrid', 'independent', subset={'developing-threat'})
    compare('coordination-hybrid-vs-independent', 'hybrid', 'independent')
    for k in controllers:
        for case, r in final(rows, k).items():
            s = service_score(r['truth'])
            out['perGroup'].setdefault(case, {'family': family[case]})[k] = {'S': s['S'], 'D': s['D']}
    return out


# P19 attribution contrasts: (name, method, comparator, method from the base batch?, comparator from the base batch?)
CONTRASTS = [('latency', 'meta-latency-matched', 'hybrid', False, False), ('modelContent', 'meta-complete', 'meta-latency-matched', True, False),
             ('narration', 'meta-narrator', 'meta-latency-matched', False, False), ('forecast', 'hybrid', 'hybrid-no-forecast', False, False),
             ('coordination', 'hybrid', 'independent', False, False), ('cadence', 'meta-fixed-cadence', 'meta-complete', False, True),
             ('runToRun', 'hybrid', 'hybrid', False, True)]


def ablation_contrasts(rows, base_rows, family, reps=5000, seed=20261103):
    """Paired S contrasts on the ablation groups. Base-batch controllers are renamed so a contrast can pair
    a controller with its own earlier run (run-to-run variation)."""
    ids = {r['caseId'] for r in rows}
    tagged = [dict(r, family=family[r['caseId']]) for r in rows] + [dict(r, controller='base:' + r['controller'], family=family[r['caseId']]) for r in base_rows if r['caseId'] in ids]
    out = {}
    for name, m, c, m_base, c_base in CONTRASTS:
        p = paired(tagged, ('base:' if m_base else '') + m, ('base:' if c_base else '') + c)
        if not p['pairs']:
            out[name] = {'method': m, 'comparator': c, 'missing': p['missing'], 'estimate': None}
            continue
        b = cluster_bootstrap(p['pairs'], reps, seed)
        out[name] = {'method': m, 'comparator': c, 'crossBatch': m_base != c_base, 'groups': len(p['pairs']), 'missing': p['missing'],
                     'estimate': b['estimate'], 'low': b['low'], 'high': b['high'], 'serviceChange': p['serviceRegression'],
                     'pairs': [{'caseId': x['caseId'], 'diff': x['diff']} for x in p['pairs']]}
    return out


if __name__ == '__main__':
    protocol = json.load(open(sys.argv[1]))
    rows = json.load(open(sys.argv[2]))['rows']
    if protocol.get('basedOn'):  # P19: analysis.py ABLATION_PROTOCOL ABLATION_ROWS BASE_PROTOCOL BASE_ROWS
        base = json.load(open(sys.argv[3]))
        family = {c['caseId']: c['family'] for c in base['cases']}
        b = base['inference']['bootstrap']
        json.dump({'schema': 'lifeline.ablation-analysis.v1', 'protocolId': protocol['protocolId'], 'contrasts': ablation_contrasts(rows, json.load(open(sys.argv[4]))['rows'], family, b['reps'], b['seed']),
                   'accounting': accounting(rows, [c['caseId'] for c in protocol['cases']], sorted(protocol['variants']))}, sys.stdout, indent=1)
    else:
        json.dump(analyze(protocol, rows), sys.stdout, indent=1)
