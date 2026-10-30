import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

test('HTTP discovery, verified tasks, evidence export and input validation', async t => {
  const server = await createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(base + path);
  const post = (path, body, origin) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  assert.equal((await get('/')).status, 200);
  let state = await (await get('/api/state')).json();
  assert.equal(state.hypotheses, 36);
  assert.equal(state.metaConfigured, !!process.env.MODEL_API_KEY);
  for (let i = 0; i < 64 && !state.settled; i++) {
    const res = await post('/api/step', {});
    assert.equal(res.status, 200);
    state = (await res.json()).state;
  }
  assert.ok(state.identified);
  const task = await (await post('/api/task', { goal: 'run' })).json();
  assert.equal(task.result.status, 'verified'); assert.ok(task.result.observation.motor);
  const evidence = await (await get('/api/evidence')).json();
  assert.ok(evidence.audit[0].commitment);
  assert.ok(evidence.audit.some(e => e.type === 'task'));
  assert.ok(!JSON.stringify(evidence).includes('MODEL_API_KEY'));
  const count = state.experiments;
  const mutation = await (await post('/api/mutate', {})).json();
  assert.equal(mutation.state.revisions, 0);
  assert.equal(mutation.state.experiments, count + task.result.steps);
  state = mutation.state;
  for (let i = 0; i < 96 && !(state.revisions > 0 && state.settled); i++) {
    const res = await post('/api/step', { verify: true, newSweep: i === 0 });
    assert.equal(res.status, 200);
    state = (await res.json()).state;
  }
  assert.ok(state.revisions > 0 && state.identified, 'HTTP verification detects change and relearns');
  const recoveredTask = await (await post('/api/task', { goal: 'run' })).json();
  assert.equal(recoveredTask.result.status, 'verified');
  assert.equal((await post('/api/task', { goal: 'invented' })).status, 400);
  assert.equal((await post('/api/step', { provider: 'invented' })).status, 400);
  assert.equal((await post('/api/reset', {}, 'https://evil.example')).status, 403);
  const reset = await (await post('/api/reset', {})).json();
  assert.equal(reset.state.experiments, 0);
});
