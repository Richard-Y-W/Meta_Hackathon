// LIFELINE v2: the brain's answers are checked before use, reflexes fire the right pre-planned response at
// once, act-now interventions need a verified benefit and no false-alarm harm, and a failed brain leaves
// the reflexes and rules running. A fake town stands in for the worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBrainPrompt, parseBrain } from '../../../src/lifeline/brain/brain.mjs';
import { brainLayer, preArm, reflexLayer, reflexTies } from '../../../src/lifeline/brain/lifeline.mjs';
import { stubBrain } from '../../../src/lifeline/brain/stub.mjs';

const S = 1_000_000, MIN = 60 * S;
const POLICY = JSON.parse(readFileSync(new URL('../../../fixtures/lifeline/infra/town/baseline-policy.json', import.meta.url), 'utf8'));
const STORIES = JSON.parse(readFileSync(new URL('../../../fixtures/lifeline/infra/town/storylines.json', import.meta.url), 'utf8')).storylines;
const reports = [{ id: 'r1', atUs: 5 * MIN, source: 'crew', text: 'tree on the line past the water tower' }];
const ctx = buildBrainPrompt({ nowUs: 10 * MIN, reports, telemetry: 'none' });
const answer = o => JSON.stringify({ threats: [], dismissed: [], ...o });
const threat = (x = {}) => ({ id: 't1', assetId: 'line-3-8', windowMin: [20, 60], confidence: 0.8, evidence: ['r1'], why: 'tree', ...x });

test('RED: a brain answer is used only if every asset, window, confidence and citation checks out', () => {
  assert.equal(parseBrain(answer({ threats: [threat()] }), ctx).ok, true);
  assert.equal(parseBrain('```json\n' + answer({ threats: [threat()] }) + '\n```', ctx).ok, true);
  for (const [bad, code] of [[threat({ assetId: 'line-9-9' }), 'asset_unknown'], [threat({ windowMin: [60, 20] }), 'invalid_window'], [threat({ confidence: 1.5 }), 'invalid_confidence'],
    [threat({ evidence: ['r9'] }), 'evidence_unknown'], [{ ...threat(), action: 'close sw-S1' }, 'unexpected_field']]) {
    assert.equal(parseBrain(answer({ threats: [bad] }), ctx).code, code, JSON.stringify(bad));
  }
  assert.equal(parseBrain('Line 3-8 looks risky.', ctx).code, 'invalid_json');
  assert.equal(parseBrain('{"threats":[],"dismissed":[],"threats":[]}', ctx).code, 'invalid_json');
});

test('the prompt carries the warning signs and the map, and no evaluator fault data', () => {
  const c = STORIES.find(s => s.id === 'storm-north-ridge');
  const p = buildBrainPrompt({ nowUs: 20 * MIN, reports: c.reports.filter(r => r.atUs <= 20 * MIN), telemetry: 'none' });
  assert.match(p.text, /spruce leaning/);
  assert.match(p.text, /line-3-8: the long overhead span/);
  for (const f of c.faults) assert.ok(!p.text.includes(f.faultId), f.faultId);
  assert.ok(!/3300|55 min/.test(p.text), 'no fault time');
});

test('RED: reflexes pick the tie that re-energizes the pump station for the dark set, and only useful ties', () => {
  assert.deepEqual(reflexTies(['bus-10', 'bus-11', 'bus-9'], { pumpStationBus: 'bus-10' }), ['sw-S3']);
  assert.deepEqual(reflexTies(['bus-13', 'bus-14']), ['sw-S1']);
  assert.deepEqual(reflexTies(['bus-1', 'bus-2']), []);
});

function fakeTown({ dead = [], refuse = [] } = {}) {
  const fired = [];
  return { fired,
    state: async () => ({ nowUs: 0, worldRevision: 1, stationMode: 'auto', resources: { 'gen-portable': { allocatedTo: null, fuelJ: 120e6 } }, layout: { pumpStationBus: 'bus-7' } }),
    observe: async () => ({ atUs: 0, staleAfterUs: 120 * S, routers: {}, clock: { acceleration: 60 }, readings: ['bus-7', 'bus-8', 'bus-9', 'bus-3'].map(b => ({ sensorId: `power:v-${b}`, assetId: b, value: dead.includes(b) ? 0 : 19000, observedAtUs: 0 })) }),
    admittedModel: async () => ({ modelId: 'm' }), refuse };
}

test('RED: on a dark pump-station bus the reflex fires the first tie at once, the next if it fails, then the generator', async () => {
  const town = fakeTown({ dead: ['bus-7', 'bus-8', 'bus-9'] });
  const r = reflexLayer({ gridUs: POLICY.gridUs });
  const fired = [];
  for (let i = 0; i < 5; i++) { const p = await r.decide({ town, nowUs: i * MIN, obs: await town.observe() }); fired.push(...p.steps.map(s => s.action.params.switchId ?? s.action.type)); assert.equal(p.redecideAtUs, (i + 1) * MIN); }
  // dark set bus-7..9 without 10/11 matches no single line exactly: ties with one end dark, then the generator
  assert.deepEqual(fired, ['sw-S1', 'sw-S2', 'allocate_generator']);
  const quiet = fakeTown();
  assert.deepEqual((await reflexLayer().decide({ town: quiet, nowUs: 0, obs: await quiet.observe() })).steps, []);
});

test('RED: act-now needs a verified benefit under the threat and no harm under a false alarm', async () => {
  const out = (w, p, extra = {}) => ({ waterEssentialUnmetM3: w, powerEssentialUnservedJ: p, waterNonessentialUnmetM3: 0, constraintSeconds: 0, fuelUsedJ: {}, events: [], ...extra });
  const mk = ({ tieHelps = true, tieHarms = false }) => ({ preview: async (plan, m, assume) => {
    const tie = plan.steps.some(s => s.action.type === 'set_switch'), gen = plan.steps.some(s => s.action.type === 'allocate_generator');
    if (assume.length) return tie && tieHelps ? out(0, 0) : gen ? out(5, 7e9) : out(50, 7e9);
    return tie && tieHarms ? out(0, 0, { constraintSeconds: 120 }) : out(0, 0, { fuelUsedJ: gen ? { g: 1e7 } : {} });
  } });
  const spread = { tripAtUs: 55 * MIN, waterEssentialUnmetM3: 50, powerEssentialUnservedJ: 7e9 };
  const args = (town, conf = 0.8) => ({ town, modelId: 'm', nowUs: 15 * MIN, threat: threat({ confidence: conf, reflex: ['sw-S1'] }), spread, horizonUs: 150 * MIN, quiet: out(0, 0), allocated: false });
  assert.equal((await preArm(args(mk({})))).label, 'pre-close sw-S1');
  assert.equal((await preArm(args(mk({ tieHarms: true })))).label, 'pre-dispatch the portable generator to the pump station');
  assert.equal(await preArm(args(mk({}), 0.3)), null, 'low confidence: reflex only, no act-now');
});

test('a failed or rejected brain leaves the threats as they were and the plant running', async () => {
  const town = fakeTown();
  const shared = { threats: [{ id: 'old' }], advisory: null, calls: [], log: [] };
  const down = brainLayer({ policy: POLICY, callModel: async () => ({ code: 'provider_timeout', durationMs: 45000 }), reports, shared, log: e => shared.log.push(e) });
  assert.deepEqual((await down.decide({ town, nowUs: 10 * MIN, obs: await town.observe() })).steps, []);
  const junk = brainLayer({ policy: POLICY, callModel: async () => ({ code: 'ok', text: 'nope' }), reports, shared, log: e => shared.log.push(e) });
  await junk.decide({ town, nowUs: 10 * MIN, obs: await town.observe() });
  assert.deepEqual(shared.threats, [{ id: 'old' }]);
  assert.deepEqual(shared.calls.map(c => c.parse ?? c.code), ['provider_timeout', 'invalid_json']);
});

test('the stub brain reads the storylines as intended (offline rehearsal only)', async () => {
  const story = STORIES.find(s => s.id === 'false-alarm');
  const p = buildBrainPrompt({ nowUs: 30 * MIN, reports: story.reports, telemetry: 'none' });
  const r = parseBrain((await stubBrain()({ prompt: p.text })).text, p);
  assert.deepEqual([r.threats.length, r.dismissed.length], [0, 1]);
});

test('RED: in a live session the town keeps running during the model call; act-now plans from the model snapshot time', async () => {
  // Live regression (Nov 3): the brain previewed "act now" at the request time, which the running town had
  // already passed, and the worker rejected the plan as in the past.
  const story = STORIES.find(s => s.id === 'storm-north-ridge');
  const requestedUs = 15 * MIN, snapshotUs = 27 * MIN;
  const loss = { waterEssentialUnmetM3: 20, powerEssentialUnservedJ: 5e9, waterNonessentialUnmetM3: 0, constraintSeconds: 0, fuelUsedJ: {}, events: [], firstEssentialLossUs: 55 * MIN };
  const none = { ...loss, waterEssentialUnmetM3: 0, powerEssentialUnservedJ: 0, firstEssentialLossUs: null };
  const town = { ...fakeTown(), admittedModel: async () => ({ modelId: 'm', atUs: snapshotUs }),
    preview: async (plan, m, assume) => {
      for (const s of plan.steps) if (s.atUs < snapshotUs || s.atUs % MIN) throw Object.assign(new Error('invalid_plan: step is off the coupling grid or in the past'), { code: 'invalid_plan' });
      for (const a of assume) if (a.atUs <= snapshotUs) throw new Error('assumption in the past');
      const tie = plan.steps.some(s => s.action.type === 'set_switch');
      return assume.length && !tie ? loss : none;
    } };
  const shared = { threats: [], advisory: null, calls: [], log: [] };
  const brain = brainLayer({ policy: POLICY, callModel: stubBrain(), reports: story.reports, shared, log: e => shared.log.push(e) });
  const plan = await brain.decide({ town, nowUs: requestedUs, obs: await town.observe() });
  assert.equal(plan.planId, 'brain-act-now');
  assert.ok(plan.steps.every(s => s.atUs >= snapshotUs));
});
