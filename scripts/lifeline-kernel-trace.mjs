// P04 evidence: a scripted contention scenario through the real kernel (arbiter, authority, coordinator)
// with in-memory adapters, plus control-tick lateness while model calls hang and a solver loads the loop.
//   node scripts/lifeline-kernel-trace.mjs --out artifacts/lifeline/infra/p04-run-0/kernel-trace.json
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createArbiter } from '../src/lifeline/kernel/arbiter.mjs';
import { createCoordinator } from '../src/lifeline/kernel/coordinator.mjs';

function adapter(failing = new Set()) {
  const receipts = new Map();
  return {
    async execute(a) {
      if (receipts.has(a.actionId)) return { ok: true, duplicate: true, receipt: receipts.get(a.actionId) };
      const receipt = { actionId: a.actionId, status: failing.has(a.actionId) ? 'rejected' : 'success', reason: failing.has(a.actionId) ? 'injected' : 'ok' };
      receipts.set(a.actionId, receipt);
      return { ok: receipt.status === 'success', receipt };
    },
    async readback(id) { return receipts.has(id) ? { ok: true, receipt: receipts.get(id) } : { ok: false, code: 'unknown_action' }; },
  };
}

const out = resolve(process.argv[process.argv.indexOf('--out') + 1]);
let nowUs = 0;
const arbiter = createArbiter({ slots: 2 });
const grants = [{ grantId: 'g-water', mode: 'bounded_auto', domainId: 'water', assets: ['pump-1', 'pump-2', 'valve-3'], actionTypes: ['set_pump', 'set_valve'], limits: {}, fromUs: 0, toUs: 1e12, approver: 'sim', environment: 'simulation' }];
const coordinator = createCoordinator({ adapters: { water: adapter(new Set(['sup-b'])) }, arbiter, grants, now: () => nowUs, environment: 'simulation', revisions: () => ({ water: 1 }) });
const act = (id, assets, dependsOn = []) => ({ actionId: id, domainId: 'water', actionType: 'set_pump', assets, parameters: {}, dependsOn });
const plan = (planId, proposer, actions, extra = {}) => ({ planId, runId: 'trace-1', proposer, expectedConfigurationRevisions: { water: 1 }, expiresAtUs: 60_000_000, actions, compensations: {}, ...extra });

const steps = [];
arbiter.beginInvestigation({ owner: 'meta', nowUs });                                                    // holds no locks
nowUs = 1_000; steps.push(arbiter.acquire({ owner: 'meta', planId: 'reserve-1', priority: 'supervisory', lockSet: ['pump-1'], nowUs }));
nowUs = 2_000; steps.push(await coordinator.submit(plan('recovery-1', 'adaptive', [act('rec-a', ['pump-1'])]), { priority: 'recovery' }));
nowUs = 3_000; steps.push(await coordinator.submit(plan('meta-2', 'meta', [act('sup-a', ['pump-2']), act('sup-b', ['valve-3'], ['sup-a'])], { compensations: { 'sup-a': act('sup-a-undo', ['pump-2']) } }), { priority: 'supervisory' }));
nowUs = 4_000; steps.push(arbiter.override({ operator: 'op-1', assets: ['valve-3'], nowUs }));
nowUs = 5_000; steps.push(await coordinator.submit(plan('meta-3', 'meta', [act('sup-c', ['valve-3'])]), { priority: 'supervisory' }));

// Control-tick lateness: a 100 ms tick while 50 model calls hang and a solver runs in 5 ms slices.
const hanging = Array.from({ length: 50 }, () => new Promise(() => {}));
let solverSlices = 0;
const solver = async () => { const end = performance.now() + 2000; while (performance.now() < end) { const t = performance.now(); while (performance.now() - t < 5); solverSlices++; await new Promise(r => setImmediate(r)); } };
const lateness = [];
const ticks = new Promise(resolveTicks => {
  let n = 0, next = performance.now() + 100;
  const tick = () => { lateness.push(performance.now() - next); next += 100; if (++n < 20) setTimeout(tick, Math.max(0, next - performance.now())); else resolveTicks(); };
  setTimeout(tick, 100);
});
await Promise.all([ticks, solver()]);
const sorted = [...lateness].sort((a, b) => a - b);
const report = {
  version: 'lifeline.kernel-trace.v1', outcomes: steps, trace: coordinator.trace(),
  scheduling: { tickMs: 100, ticks: lateness.length, pendingModelCalls: hanging.length, solverSlices, latenessMs: { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1) } },
};
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ outcomes: steps.map(s => s.status ?? (s.ok === undefined ? `cancelled:${s.cancelled}` : `${s.ok}:${s.code}`)), scheduling: report.scheduling }));
