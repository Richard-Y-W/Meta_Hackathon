import { mkdir, writeFile } from 'node:fs/promises';
import { Session } from '../src/session.mjs';
import { SimulatedDevice } from '../src/device.mjs';

const session = await new Session(new SimulatedDevice()).init();
try {
  while (!session.view().settled && session.learner.history.length < 64) await session.step();
  if (!session.view().identified) throw new Error('Discovery did not identify the mechanism');
  const discoveryActions = session.learner.history.length;
  const firstTask = await session.task('run');
  if (firstTask.status !== 'verified') throw new Error('Initial task failed');
  await session.mutate();
  const changeBoundary = session.learner.history.length;
  let recovered = false;
  for (let i = 0; i < 96; i++) {
    await session.step({ verify: true, newSweep: i === 0 });
    if (session.learner.revisions > 0 && session.view().settled) { recovered = true; break; }
  }
  if (!recovered) throw new Error('Recovery budget exhausted');
  const detection = session.learner.history.find(e => e.surprise && e.step > changeBoundary);
  const recoveryActions = session.learner.history.length - changeBoundary;
  // Shut down first so the recovered run task must perform an action.
  const shutdown = await session.task('shutdown');
  if (shutdown.status !== 'verified') throw new Error('Post-recovery shutdown failed');
  const recoveredTask = await session.task('run');
  if (recoveredTask.status !== 'verified') throw new Error('Post-recovery motor task failed');
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/demo-evidence.json', JSON.stringify(session.export(), null, 2));
  console.log(JSON.stringify({ scope: 'Virtual device, local active learner; no Meta API call or visual grounding',
    discoveryActions, initialTask: firstTask.status,
    changeDetectionActions: detection.step - changeBoundary,
    postDetectionLearningActions: recoveryActions - (detection.step - changeBoundary),
    recoveryActions, recoveredTask: recoveredTask.status, recoveredTaskActions: recoveredTask.steps,
    evidence: 'artifacts/demo-evidence.json' }, null, 2));
} finally { session.close(); }
