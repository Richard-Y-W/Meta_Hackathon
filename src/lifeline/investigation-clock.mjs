// Total-time budget for one investigation, measured on the episode's monotonic clock. Retries and
// per-call timeouts all draw from it, so a decision can never outlive its declared deadline.
export function createInvestigationBudget({ startedAtMs, deadlineMs, nowMs }) {
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  if (!finite(startedAtMs) || startedAtMs < 0 || !finite(deadlineMs) || deadlineMs <= 0 || typeof nowMs !== 'function') throw new Error('invalid_budget');
  const deadlineAtMs = startedAtMs + deadlineMs;
  const remainingMs = () => Math.max(0, deadlineAtMs - nowMs());
  return {
    startedAtMs, deadlineAtMs,
    remainingMs,
    expired: () => remainingMs() === 0,
    callTimeoutMs: perCallMs => Math.floor(Math.min(perCallMs, remainingMs())), // AbortSignal.timeout needs an integer
  };
}
