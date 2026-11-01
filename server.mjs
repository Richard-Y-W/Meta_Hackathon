import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SimulatedDevice, BridgeDevice } from './src/device.mjs';
import { Session } from './src/session.mjs';
import { createLifelineHandler } from './src/lifeline/http.mjs';

export async function createApp() {
  const kind = process.env.DEVICE_BRIDGE_URL ? 'hardware bridge' : 'simulation';
  const makeSession = async () => {
    const session = new Session(kind === 'simulation' ? new SimulatedDevice() : new BridgeDevice(process.env.DEVICE_BRIDGE_URL), kind);
    try { return await session.init(); } catch (error) { session.close(); throw error; }
  };
  let session = await makeSession();
  const files = {
    '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'],
    '/lifeline': ['lifeline.html', 'text/html'], '/lifeline.js': ['lifeline.js', 'text/javascript'], '/lifeline.css': ['lifeline.css', 'text/css'],
  };
  const repo = fileURLToPath(new URL('.', import.meta.url));
  const artifactsRoot = resolve(repo, process.env.LIFELINE_ARTIFACTS ?? 'artifacts/lifeline');
  // Live runs need the qualified Linux host; the key stays in this process tree and never reaches the browser.
  const lifeline = createLifelineHandler({
    repo, artifactsRoot, liveRoot: resolve(repo, 'artifacts/lifeline/live'), credentialPresent: Boolean(process.env.MODEL_API_KEY),
    spawnRun: args => spawn(process.execPath, ['--env-file-if-exists=.env', resolve(repo, 'scripts/lifeline-run.mjs'), ...args], { cwd: repo, stdio: 'ignore' }),
  });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const host = req.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return send(403, { error: 'Local access only' });
      if (await lifeline(req, res)) return;
      if (req.method === 'GET' && files[path]) {
        const [file, type] = files[path];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(await readFile(new URL(`./public/${file}`, import.meta.url)));
      }
      if (req.method === 'GET' && path === '/api/state') return send(200, session.view());
      if (req.method === 'GET' && path === '/api/evidence') {
        res.setHeader('Content-Disposition', `attachment; filename="apprentice-${session.id}.json"`);
        return send(200, session.export());
      }
      if (req.method !== 'POST' || !['/api/step', '/api/task', '/api/mutate', '/api/reset'].includes(path)) return send(404, { error: 'Not found' });
      if (req.headers.origin && ![`http://${host}`].includes(req.headers.origin)) return send(403, { error: 'Cross-origin action rejected' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'JSON required' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 8192) return send(413, { error: 'Request too large' }); }
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'Invalid JSON' }); }
      let result;
      if (path === '/api/reset') {
        if (session.busy) throw new Error('An operation is already in progress');
        const previous = session;
        previous.busy = true;
        try { session = await makeSession(); previous.close(); } catch (error) { previous.busy = false; throw error; }
        result = { reset: true };
      } else if (path === '/api/step') result = await session.step(body);
      else if (path === '/api/task') result = await session.task(body.goal);
      else result = await session.mutate();
      send(200, { result, state: session.view() });
    } catch (error) { send(400, { error: error.message }); }
  });
  server.on('close', () => session.close());
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = await createApp();
  server.listen(Number(process.env.PORT || 3210), '127.0.0.1', () => console.log(`Blackbox Apprentice → http://127.0.0.1:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
