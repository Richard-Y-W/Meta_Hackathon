"""Independent reference scorer for infrastructure services (Python, standard library only).

Written separately from src/lifeline/kernel/measurement.mjs as a cross-check. Demand is a piecewise-
constant immutable schedule; supply holds each observed sample until the next. Integrals are canonical
unit x seconds. A missing sample makes the run capture-incomplete; it is neither service nor loss.
"""


def _rate_at(demand, t):
    for seg in demand:
        if seg['fromUs'] <= t < seg['toUs']:
            return float(seg['value'])
    return 0.0


def _sample_at(supply, t):
    current = None
    for s in sorted(supply, key=lambda x: x['atUs']):
        if s['atUs'] <= t:
            current = s
        else:
            break
    return current


def score_service(case):
    lo, hi = case['fromUs'], case['toUs']
    quality = case.get('quality')
    edges = {lo, hi}
    for seg in case['demand']:
        edges.update(t for t in (seg['fromUs'], seg['toUs']) if lo < t < hi)
    edges.update(s['atUs'] for s in case['supply'] if lo < s['atUs'] < hi)
    edges = sorted(edges)
    demanded = served = missing = 0.0
    for start, end in zip(edges, edges[1:]):
        seconds = (end - start) / 1e6
        rate = _rate_at(case['demand'], start)
        if rate == 0:
            continue
        demanded += rate * seconds
        sample = _sample_at(case['supply'], start)
        if sample is None or sample.get('value') is None or (quality and sample.get('qualityValue') is None):
            missing += rate * seconds
            continue
        usable = (not quality) or sample['qualityValue'] >= quality['min']
        served += min(sample['value'] if usable else 0.0, rate) * seconds
    if missing > 0:
        return {'demandIntegral': demanded, 'servedIntegral': served, 'missingIntegral': missing, 'deficitIntegral': None,
                'servedBounds': [served, served + missing], 'score': None, 'status': 'capture_incomplete'}
    return {'demandIntegral': demanded, 'servedIntegral': served, 'missingIntegral': 0.0, 'deficitIntegral': demanded - served,
            'servedBounds': [served, served], 'score': served / demanded if demanded > 0 else None, 'status': 'scored'}
