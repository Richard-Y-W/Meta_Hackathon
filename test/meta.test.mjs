import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseWithMuse } from '../src/meta.mjs';
import { Session } from '../src/session.mjs';
import { INITIAL } from '../src/domain.mjs';

test('Meta adapter sends grounded candidates and validates a real-shaped Responses envelope', async t => {
  const saved = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = 'test-only-secret';
  t.after(() => { if (saved === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = saved; });
  const candidates = [{ action: 'A', information: 1 }, { action: 'B', information: 0.9 }];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.meta.ai/v1/responses');
    const body = JSON.parse(options.body);
    assert.ok(body.input[0].content.includes('"action":"B"'));
    return { ok: true, json: async () => ({ id: 'mock-response', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"candidate":1,"reason":"Separate the remaining predictions."}' }] }] }) };
  });
  const choice = await chooseWithMuse({ observation: INITIAL }, candidates);
  assert.equal(choice.action, 'B'); assert.equal(choice.provider, 'Muse Spark');
  assert.equal(choice.responseId, 'mock-response');
});

test('invalid model choice cannot actuate a device or silently fall back', async t => {
  const saved = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = 'test-only-secret';
  t.after(() => { if (saved === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = saved; });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ output_text: '{"candidate":999,"reason":"Invalid"}' }) }));
  let presses = 0;
  const session = await new Session({ observe: async () => ({ observation: INITIAL }), press: async () => { presses++; }, close() {} }).init();
  await assert.rejects(() => session.step({ provider: 'meta' }), /invalid experiment/);
  assert.equal(presses, 0); assert.equal(session.learner.history.length, 0); assert.equal(session.busy, false);
});
