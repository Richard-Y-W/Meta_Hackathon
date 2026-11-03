// Coupled-town worker client (runtime/infra/worker.py in the town environment). Controllers get observe,
// command, admitted models and previews; `truth` is evaluator-only and is not part of this interface.
import { join } from 'node:path';
import { spawnStdioWorker } from '../kernel/stdio-worker.mjs';

export function spawnTownWorker({ root, python = join(root, '.work/environments/town/bin/python'), timeoutMs = 600_000 }) {
  const worker = spawnStdioWorker({
    command: python, args: [join(root, 'runtime/infra/worker.py'), 'serve'], cwd: root, timeoutMs,
    env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: join(root, '.work/cache/matplotlib'), TMPDIR: join(root, '.work/tmp'), PYTHONDONTWRITEBYTECODE: '1' },
  });
  const call = (cmd, args = {}) => worker.request(cmd, args);
  return {
    initialize: args => call('initialize', args),
    advance: toUs => call('advance', { toUs }),
    observe: () => call('observe'),
    capabilities: () => call('capabilities'),
    receipts: (last = 12) => call('receipts', { last }),
    inject: fault => call('inject', { fault }),
    trace: () => call('trace'),
    state: () => call('state'),
    command: (domain, action, baseRevision) => call('command', { domain, action, baseRevision }),
    admittedModel: () => call('admitted_model'),
    preview: (plan, modelId, assume = []) => call('preview', { plan, modelId, assume }),
    evaluatorTruth: () => call('truth'),
    close: () => worker.shutdown(),
  };
}
