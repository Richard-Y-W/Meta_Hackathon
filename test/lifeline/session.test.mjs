import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionState } from '../../src/lifeline/session.mjs';

test('the full lifecycle follows the design progression and is recorded', () => {
  const s = new SessionState(() => 1000);
  for (const next of ['investigating', 'proposed', 'evaluating', 'executing', 'verifying', 'observing']) s.transition(next, 'test');
  assert.equal(s.state, 'observing');
  assert.deepEqual(s.history.map(h => h.to), ['investigating', 'proposed', 'evaluating', 'executing', 'verifying', 'observing']);
});

test('rejections and interruptions return to observing from any active stage', () => {
  for (const stage of [['proposed'], ['proposed', 'evaluating'], ['proposed', 'evaluating', 'executing'], ['investigating']]) {
    const s = new SessionState(() => 0);
    for (const next of stage) s.transition(next, 'setup');
    s.transition('observing', 'rejected or interrupted');
    assert.equal(s.state, 'observing');
  }
});

test('degraded and unavailable are distinct states, never success', () => {
  const s = new SessionState(() => 0);
  s.transition('degraded', 'provider_timeout');
  assert.equal(s.state, 'degraded');
  s.transition('proposed', 'deterministic takeover');
  s.transition('evaluating', 'guard');
  s.transition('executing', 'admitted');
  s.transition('verifying', 'effects');
  s.transition('observing', 'verified');
  s.transition('unavailable', 'no path');
  assert.equal(s.isSuccess(), false);
});

test('an invalid transition is refused and recorded', () => {
  const s = new SessionState(() => 0);
  assert.throws(() => s.transition('executing', 'skip the guard'), /invalid_transition/);
  assert.equal(s.state, 'observing');
  assert.equal(s.violations.length, 1);
});
