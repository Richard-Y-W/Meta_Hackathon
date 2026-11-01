import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPilotAttempts } from '../../scripts/lifeline-release-manifest.mjs';

const row = (episodeId, attempt, status, reason) => ({ episodeId, block: episodeId.split('.').slice(0, 2).join('.'), attempt, status, reason });

test('first attempts and withdrawn reruns are separated, with reclassification applied to first attempts only', () => {
  const index = [row('p5.r1.meta', 1, 'infrastructure_invalid', 'contracts'), row('p5.r1.adaptive', 1, 'valid'), row('p5.r1.meta', 2, 'infrastructure_invalid', 'capture_incomplete'), row('p5.r1.adaptive', 2, 'infrastructure_invalid', 'capture_incomplete')];
  const reclass = [{ episodeId: 'p5.r1.meta', attempt: 1, before: { status: 'infrastructure_invalid', reason: 'contracts' }, after: { status: 'valid' } }];
  const c = classifyPilotAttempts(index, reclass);
  assert.deepEqual(c.firstAttempts.map(r => [r.episodeId, r.status]), [['p5.r1.meta', 'valid'], ['p5.r1.adaptive', 'valid']]);
  assert.deepEqual(c.withdrawn.map(r => [r.episodeId, r.attempt]), [['p5.r1.meta', 2], ['p5.r1.adaptive', 2]]);
  assert.deepEqual(c.reclassified, ['p5.r1.meta']);
});

test('a block whose first attempt is still invalid keeps its rerun as the scored attempt', () => {
  const index = [row('p8.r1.meta', 1, 'infrastructure_invalid', 'worker_crash'), row('p8.r1.meta', 2, 'valid')];
  const c = classifyPilotAttempts(index, []);
  assert.deepEqual(c.withdrawn, []);
  assert.deepEqual(c.scoredReruns.map(r => r.episodeId), ['p8.r1.meta']);
});
