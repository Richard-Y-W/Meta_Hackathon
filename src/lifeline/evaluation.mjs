// Frozen-protocol pilot evaluation: schedule, run validity and paired comparison. Pure functions; the
// runner script performs the episodes. Every scheduled episode stays in the index, including invalid ones.
import { createHash } from 'node:crypto';

// Mulberry32: small seeded PRNG so the controller order is reproducible from the protocol seed.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Arms: V1 protocols list controllers; later revisions list arms ({id, controller, providerFault?}).
export const armsOf = protocol => protocol.arms ?? protocol.controllers.map(c => ({ id: c, controller: c }));

export function buildSchedule(protocol) {
  const random = prng(protocol.orderSeed);
  const episodes = [];
  for (let repetition = 1; repetition <= protocol.repetitions; repetition++) {
    for (const c of protocol.cases) {
      const order = [...armsOf(protocol)];
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      for (const arm of order) {
        const n = episodes.length;
        const controller = arm.controller;
        episodes.push({
          episodeId: `${c.caseId}.r${repetition}.${arm.id}`, caseId: c.caseId, path: c.path, arm: arm.id, controller,
          providerFault: arm.providerFault ?? (controller === 'meta' ? c.metaProviderFault ?? null : null), repetition,
          block: `${c.caseId}.r${repetition}`, order: n + 1, recoverable: c.recoverable, noFault: c.noFault,
          tag: `lf${TAG_ALPHABET[Math.floor(n / 36) % 36]}${TAG_ALPHABET[n % 36]}`,
        });
      }
    }
  }
  return episodes;
}

export function verifyProtocol(protocol, readFile) {
  if (protocol.version !== 'ProtocolV1' || !String(protocol.status).startsWith('frozen')) return { ok: false, code: 'protocol_not_frozen' };
  for (const c of protocol.cases) {
    const digest = createHash('sha256').update(readFile(c.path)).digest('hex');
    if (digest !== c.sha256) return { ok: false, code: 'case_identity_mismatch', caseId: c.caseId };
  }
  return { ok: true, code: 'ok' };
}

// Infrastructure-invalid runs are rerun for every controller in the paired block. Model timeouts,
// invalid decisions, rejected proposals and failed recoveries are method outcomes and stay valid.
export function classifyRun({ manifest, replay, summary }) {
  if (!manifest) return { status: 'infrastructure_invalid', reason: 'manifest_missing' };
  if (manifest.terminal !== 'completed' && manifest.failure?.code === 'worker_unavailable') return { status: 'infrastructure_invalid', reason: 'worker_crash' };
  if (!summary || summary.status !== 'scored') return { status: 'infrastructure_invalid', reason: 'capture_incomplete' };
  if ((summary.controllerViewAudit?.findings ?? []).length) return { status: 'infrastructure_invalid', reason: 'controller_view_leak' };
  if (!replay) return { status: 'infrastructure_invalid', reason: 'replay_missing' };
  if (!replay.checks.score?.ok) return { status: 'infrastructure_invalid', reason: 'scorer_disagreement' };
  if (!replay.ok) return { status: 'infrastructure_invalid', reason: Object.entries(replay.checks).find(([, v]) => !v.ok)?.[0] ?? 'replay_failed' };
  if (manifest.terminal !== 'completed') return { status: 'infrastructure_invalid', reason: manifest.failure?.code ?? 'run_incomplete' };
  return { status: 'valid' };
}

const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const diff = (a, b) => (a === null || b === null ? null : a - b);

// Percentile bootstrap of the mean over independent case-level values (cases, not packets, are the unit).
export function bootstrapMeanCI(values, { seed = 20261101, reps = 2000 } = {}) {
  if (!values.length) return null;
  const random = prng(seed);
  const means = [];
  for (let b = 0; b < reps; b++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((x, y) => x - y);
  const at = q => means[Math.min(means.length - 1, Math.max(0, Math.floor(q * means.length)))];
  return [at(0.025), at(0.975)];
}

// Every scheduled first attempt must be present, carry the frozen protocol and arm identity, and paired
// runs of a case must share one offered denominator.
export function auditIndex(protocol, schedule, rows) {
  const problems = [];
  const byEpisode = new Map(rows.filter(r => r.attempt === 1).map(r => [r.episodeId, r]));
  for (const e of schedule) {
    const r = byEpisode.get(e.episodeId);
    if (!r) { problems.push({ code: 'missing_first_attempt', episodeId: e.episodeId }); continue; }
    if (r.protocolRevision !== protocol.protocolRevision) problems.push({ code: 'protocol_mismatch', episodeId: e.episodeId });
    if (r.controller !== e.controller || (r.arm ?? r.controller) !== (e.arm ?? e.controller)) problems.push({ code: 'arm_identity_mismatch', episodeId: e.episodeId });
  }
  for (const caseId of new Set(schedule.map(e => e.caseId))) {
    const offered = new Set(rows.filter(r => r.caseId === caseId && r.status === 'valid' && r.primary).map(r => r.primary.offered));
    if (offered.size > 1) problems.push({ code: 'denominator_mismatch', caseId, offered: [...offered] });
  }
  return { ok: problems.length === 0, problems };
}

export function compare(rows, { arms: armIds, pairs } = {}) {
  const valid = rows.filter(r => r.status === 'valid');
  const caseIds = [...new Set(rows.map(r => r.caseId))].sort();
  const armOf = r => r.arm ?? r.controller;
  const controllers = armIds ?? ['priority', 'adaptive', 'meta'];
  const pairList = pairs ?? [['meta', 'adaptive'], ['meta', 'priority'], ['adaptive', 'priority']];
  const cases = {}, incomplete = [];
  for (const caseId of caseIds) {
    const runs = valid.filter(r => r.caseId === caseId);
    const m = {};
    for (const c of controllers) {
      const rates = runs.filter(r => armOf(r) === c).map(r => r.primary.deliveryRate);
      m[c] = mean(rates);
      if (m[c] === null) incomplete.push(`${caseId}/${c}`);
    }
    const sample = rows.find(r => r.caseId === caseId);
    cases[caseId] = {
      recoverable: sample.recoverable, noFault: sample.noFault, mean: m,
      runs: Object.fromEntries(controllers.map(c => [c, runs.filter(r => armOf(r) === c).map(r => ({ repetition: r.repetition, deliveryRate: r.primary.deliveryRate }))])),
      diff: {
        metaMinusAdaptive: diff(m.meta ?? null, m.adaptive ?? null), metaMinusPriority: diff(m.meta ?? null, m.priority ?? null), adaptiveMinusPriority: diff(m.adaptive ?? null, m.priority ?? null),
        ...Object.fromEntries(pairList.map(([a, b]) => [`${a}-${b}`, diff(m[a] ?? null, m[b] ?? null)])),
      },
    };
  }
  const recoverableCases = caseIds.filter(id => cases[id].recoverable && !cases[id].noFault);
  const paired = recoverableCases.map(id => cases[id].diff.metaMinusAdaptive).filter(d => d !== null);
  const noFault = caseIds.filter(id => cases[id].noFault);
  const cost = Object.fromEntries(controllers.map(c => {
    const own = valid.filter(r => armOf(r) === c);
    const sum = k => own.reduce((s, r) => s + (r.cost?.[k] ?? 0), 0);
    return [c, { runs: own.length, modelCalls: sum('modelCalls'), modelFailures: sum('modelFailures'), modelSeconds: sum('modelSeconds'), outputTokens: sum('outputTokens'), probeBytes: sum('probeBytes'), interventions: sum('interventions'), rejected: sum('rejected') }];
  }));
  return {
    episodes: { total: rows.length, valid: valid.length, infrastructureInvalid: rows.filter(r => r.status === 'infrastructure_invalid').length },
    cases, recoverableCases, incomplete, cost,
    summary: {
      meanPairedDiffMetaMinusAdaptive: mean(paired),
      meanPairedDiffMetaMinusPriority: mean(recoverableCases.map(id => cases[id].diff.metaMinusPriority).filter(d => d !== null)),
      worstCaseDiffMetaMinusAdaptive: paired.length ? Math.min(...paired) : null,
      bestCaseDiffMetaMinusAdaptive: paired.length ? Math.max(...paired) : null,
      noFaultRegressionMetaVsAdaptive: mean(noFault.map(id => diff(cases[id].mean.adaptive, cases[id].mean.meta)).filter(d => d !== null)),
      pairs: Object.fromEntries(pairList.map(([a, b]) => {
        const values = recoverableCases.map(id => cases[id].diff[`${a}-${b}`]).filter(d => d !== null);
        return [`${a}-${b}`, { cases: values.length, mean: mean(values), worst: values.length ? Math.min(...values) : null, best: values.length ? Math.max(...values) : null, ci95: bootstrapMeanCI(values) }];
      })),
      note: 'Exploratory development pilot (G4a). Two repetitions per case; no uncertainty interval is claimed.',
    },
  };
}
