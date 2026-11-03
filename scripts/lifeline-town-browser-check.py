"""P15 browser check of /lifeline/town against the real server and town worker.
    PLAYWRIGHT_BROWSERS_PATH=.work/cache/ms-playwright .work/environments/playwright/bin/python scripts/lifeline-town-browser-check.py --out artifacts/lifeline/infra/p15-run-0
"""
import argparse, json, os, signal, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
parser = argparse.ArgumentParser(); parser.add_argument('--out', required=True); parser.add_argument('--port', default='3417')
args = parser.parse_args()
out = os.path.join(ROOT, args.out); os.makedirs(out, exist_ok=True)
base = 'http://127.0.0.1:%s' % args.port
env = dict(os.environ, PORT=args.port, MODEL_API_KEY='')  # the town view never needs the credential
server = subprocess.Popen(['node', 'server.mjs'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
def wait_until(page, fn, timeout_ms, label):
    """Poll from Python: the page's CSP (no unsafe-eval) forbids Playwright's string predicates, and the
    check must not bypass the CSP it is meant to exercise."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        try:
            if fn(): return True
        except Exception: pass
        page.wait_for_timeout(250)
    raise TimeoutError(label)

results = {}
def check(name, ok, detail=''):
    results[name] = {'ok': bool(ok), 'detail': detail}
    print(('PASS ' if ok else 'FAIL ') + name, detail)
try:
    for _ in range(100):
        try: urllib.request.urlopen(base + '/api/town/cases', timeout=1); break
        except Exception: time.sleep(0.2)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        errors = []
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(base + '/lifeline/town'); page.wait_for_load_state('networkidle')
        check('idle state shown', page.locator('#state').inner_text().startswith('idle'))
        check('/lifeline demo still served', urllib.request.urlopen(base + '/lifeline').status == 200)
        page.select_option('#case', 'b-tie-available'); page.select_option('#controller', 'priority')
        page.keyboard.press('Tab')
        page.locator('#start').focus(); page.keyboard.press('Enter')  # keyboard operation
        wait_until(page, lambda: page.locator('#state').inner_text().startswith('running'), 30000, 'running')
        check('start by keyboard -> running', True, page.locator('#state').inner_text())
        wait_until(page, lambda: page.locator('.strip').count() >= 3, 60000, 'strips')
        page.select_option('#fault-type', 'router_fail'); page.select_option('#fault-asset', 'rt-pump'); page.click('#inject')
        wait_until(page, lambda: 'Injected' in page.locator('#fault-note').inner_text(), 15000, 'injected')
        wait_until(page, lambda: 'judge' in page.locator('#timeline').inner_text(), 15000, 'judge entry')
        check('judge fault with request and effect time', 'requested' in page.locator('#timeline').inner_text())
        wait_until(page, lambda: '%' in page.locator('.strip strong').first.inner_text(), 30000, 'measured value')
        widths = [page.locator('.bar > span').nth(i).get_attribute('style') or '' for i in range(page.locator('.bar > span').count())]
        check('measured strips rendered (CSP-safe widths)', all('width' in w and '%' in w for w in widths) and len(widths) >= 3, str(widths))
        # past the storm at 30 simulated minutes and the rule's 2-minute tie delay (one simulated minute per wall second)
        wait_until(page, lambda: 'action' in page.locator('#timeline').inner_text(), 90000, 'tie action')
        tl = page.locator('#timeline').inner_text()
        check('tie actions visible with their receipt status', any(x in tl for x in ('delivered', 'rejected', 'unconfirmed')), tl[:300].replace('\n', ' | '))
        if 'delivered' in tl:
            import re as _re
            sw = _re.search(r'"switchId":"(sw-S\d)","closed":true\} → delivered', tl)
            if sw:
                assets = page.locator('#assets').inner_text()
                check('asset table agrees with the delivered tie', _re.search('Tie %s\\s+closed' % sw.group(1), assets) is not None, sw.group(1))
        page.screenshot(path=os.path.join(out, 'town-wide.png'), full_page=True)
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(1500)
        box = page.locator('main').bounding_box()
        check('narrow layout: content fits the viewport', box is not None and box['x'] + box['width'] <= 391, str(box))
        page.screenshot(path=os.path.join(out, 'town-narrow.png'), full_page=True)
        page.set_viewport_size({'width': 1280, 'height': 900})
        run1 = json.loads(urllib.request.urlopen(base + '/api/town/live').read())['runId']
        page.click('#stop')
        wait_until(page, lambda: page.locator('#state').inner_text().startswith('stopped'), 30000, 'stopped')
        check('operator stop shown', True)
        page.select_option('#case', 'b-no-fault'); page.click('#start')
        wait_until(page, lambda: page.locator('#state').inner_text().startswith('running'), 30000, 'running')
        req = urllib.request.Request(base + '/api/town/live/fault', data=json.dumps({'runId': run1, 'fault': {'type': 'router_fail', 'assetId': 'rt-pump'}}).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        try: urllib.request.urlopen(req); stale = False
        except urllib.error.HTTPError as e: stale = e.code == 409 and json.loads(e.read())['error'] == 'stale_run'
        check('stale run id refused (409 stale_run)', stale)
        href = page.get_attribute('#export', 'href')
        export = json.loads(urllib.request.urlopen(base + href).read())
        check('evidence export of the current run', export['schema'] == 'lifeline.town-live-export.v1' and export['runId'] != run1)
        page.wait_for_timeout(3000)
        workers = subprocess.run(['pgrep', '-f', 'runtime/infra/worker.py serve'], capture_output=True, text=True).stdout.split()
        for pid in workers: os.kill(int(pid), signal.SIGKILL)
        wait_until(page, lambda: page.locator('#state').inner_text().startswith('disconnected'), 30000, 'disconnected')
        check('dead worker shown as disconnected', 'Worker lost' in page.locator('#fault-note').inner_text())
        page.screenshot(path=os.path.join(out, 'town-disconnected.png'), full_page=True)
        check('no console errors', not errors, '; '.join(errors)[:300])
        browser.close()
finally:
    server.send_signal(signal.SIGTERM)
    try: server.wait(timeout=10)
    except Exception: server.kill()
json.dump(results, open(os.path.join(out, 'browser-check.json'), 'w'), indent=1)
sys.exit(0 if all(r['ok'] for r in results.values()) else 1)
