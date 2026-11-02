"""Independent reference scorer for infrastructure services (Python, standard library only).

Written separately from src/lifeline/kernel/measurement.mjs as a cross-check. Demand is a piecewise-
constant immutable schedule; supply holds each observed sample until the next. Integrals are canonical
unit x seconds. A missing sample makes the run capture-incomplete; it is neither service nor loss.
"""


import bisect


def _rate_at(demand, t):
    for seg in demand:
        if seg['fromUs'] <= t < seg['toUs']:
            return float(seg['value'])
    return 0.0


class _Supply:
    """Supply samples sorted once by time; the latest sample at or before t, by binary search."""

    def __init__(self, supply):
        self.samples = sorted(supply, key=lambda x: x['atUs'])
        self.times = [s['atUs'] for s in self.samples]

    def at(self, t):
        i = bisect.bisect_right(self.times, t)
        return self.samples[i - 1] if i else None


class _Demand:
    """Demand segments indexed by start time; the segment covering t, or zero demand."""

    def __init__(self, demand):
        self.segments = sorted(demand, key=lambda x: x['fromUs'])
        self.starts = [d['fromUs'] for d in self.segments]

    def at(self, t):
        i = bisect.bisect_right(self.starts, t)
        if i and self.segments[i - 1]['fromUs'] <= t < self.segments[i - 1]['toUs']:
            return float(self.segments[i - 1]['value'])
        return 0.0


def score_service(case):
    lo, hi = case['fromUs'], case['toUs']
    quality = case.get('quality')
    edges = {lo, hi}
    for seg in case['demand']:
        edges.update(t for t in (seg['fromUs'], seg['toUs']) if lo < t < hi)
    edges.update(s['atUs'] for s in case['supply'] if lo < s['atUs'] < hi)
    edges = sorted(edges)
    supply_index, demand_index = _Supply(case['supply']), _Demand(case['demand'])
    demanded = served = missing = 0.0
    for start, end in zip(edges, edges[1:]):
        seconds = (end - start) / 1e6
        rate = demand_index.at(start)
        if rate == 0:
            continue
        demanded += rate * seconds
        sample = supply_index.at(start)
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
