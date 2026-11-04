"""Host-suspension check for latency-charged runs. Decision latency is charged from the wall clock, so an
episode that overlaps host sleep has time asleep counted as decision time. Reads macOS `pmset -g log` and
reports, per episode in each rows.json, the seconds of host sleep inside the episode window.
  python3 scripts/lifeline-host-sleep-check.py artifacts/lifeline/infra/research-v1/rows.json [...]"""
import datetime
import json
import subprocess
import sys


def sleep_intervals(log_text):
    out, cur = [], None
    for line in log_text.splitlines():
        if len(line) < 19 or not line[:4].isdigit():
            continue
        try:
            t = datetime.datetime.strptime(line[:19], '%Y-%m-%d %H:%M:%S').timestamp()
        except ValueError:
            continue
        if 'Entering Sleep' in line and cur is None:
            cur = t
        elif ('DarkWake from' in line or 'Wake from' in line) and cur is not None:
            out.append((cur, t))
            cur = None
    return out


def overlaps(rows, intervals):
    hits = []
    for r in rows:
        start = r['startedAtUnixMs'] / 1000
        end = start + r['wallSeconds']
        s = sum(max(0.0, min(end, b) - max(start, a)) for a, b in intervals)
        if s > 0:
            hits.append({'caseId': r['caseId'], 'controller': r['controller'], 'attempt': r['attempt'], 'sleepSeconds': round(s)})
    return hits


if __name__ == '__main__':
    intervals = sleep_intervals(subprocess.run(['pmset', '-g', 'log'], capture_output=True, text=True).stdout)
    report = {}
    for path in sys.argv[1:]:
        rows = json.load(open(path))['rows']
        hits = overlaps(rows, intervals)
        report[path] = {'episodes': len(rows), 'overlapped': len(hits), 'hits': hits}
    json.dump({'sleepIntervals': len(intervals), 'report': report}, sys.stdout, indent=1)
