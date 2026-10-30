const $ = id => document.getElementById(id);
let state, running = false, working = false, toastTimer;
const buttons = ['step', 'explore', 'task', 'mutate', 'verify', 'reset'];
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
function notify(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 7000);
}
function lock(value) {
  working = value;
  for (const id of buttons) $(id).disabled = value || (running && id !== 'explore');
  if (state?.kind !== 'simulation') $('mutate').disabled = true;
  $('provider').disabled = value || running;
  $('goal').disabled = value || running;
  if (running) { $('explore').disabled = false; $('explore').textContent = 'Ⅱ Pause discovery'; }
  else $('explore').textContent = '▶ Start discovery';
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function consensus(field, format = v => String(v)) {
  const values = [...new Set(state.models.map(m => m[field]))];
  return values.length === 1 ? format(values[0]) : 'Unresolved';
}
function render() {
  const s = state.state;
  $('connection').textContent = state.kind === 'simulation' ? 'Simulator connected' : 'Hardware connected';
  $('device-mode').textContent = state.kind.toUpperCase();
  if (state.kind !== 'simulation') $('mode-detail').textContent = 'Observations and control actions come from the configured hardware bridge.';
  $('experiments').textContent = String(state.experiments).padStart(2, '0');
  $('hypotheses').innerHTML = `${state.hypotheses}<span> / 36</span>`;
  $('tasks').textContent = String(state.tasks.filter(t => t.status === 'verified').length).padStart(2, '0');
  $('revision-count').textContent = `${state.revisions} model revision${state.revisions === 1 ? '' : 's'}`;
  $('model-status').textContent = state.identified ? 'One mechanism fits the evidence' : state.settled ? 'Equivalent on reachable observations' : 'Learning from observed outcomes';
  $('power-light').classList.toggle('on', s.power); $('direction-light').classList.toggle('on', s.direction);
  $('motor').classList.toggle('running', s.motor);
  for (const [name, value] of [['power', s.power], ['amber', s.direction], ['motor', s.motor]]) {
    $(`${name}-state`).textContent = name === 'motor' ? value ? 'RUNNING' : 'STOPPED' : value ? 'ON' : 'OFF';
    $(`${name}-dot`).classList.toggle('on', value);
  }
  $('phase').textContent = state.identified ? 'IDENTIFIED' : state.settled ? 'SETTLED' : state.experiments ? 'EXPLORING' : 'UNEXPLORED';
  const candidate = state.candidates[0];
  $('next-action').innerHTML = candidate ? `Press <span>${candidate.action}</span>` : 'Ready to <span>verify.</span>';
  $('reason').textContent = candidate ? (candidate.path.length > 1 ? `Navigate ${candidate.path.join(' → ')}. The final test separates hypotheses; each navigation action is checked along the way.` : `Different mechanisms predict ${candidate.outcomes.length} distinct outcomes for control ${candidate.action}. Observe which prediction survives.`) : 'No further distinguishing test is reachable within the declared model family. Try a task or challenge the learned predictions.';
  $('gain').textContent = `${(candidate?.information || 0).toFixed(2)} bits`;
  $('gain-bar').style.width = `${Math.min(100, (candidate?.information || 0) / 2 * 100)}%`;
  $('candidate-count').textContent = `${state.hypotheses} candidate${state.hypotheses === 1 ? '' : 's'}`;
  const rules = [['Power control', consensus('power', v => `Button ${v}`)], ['Amber control', consensus('direction', v => `Button ${v}`)], ['Motor control', consensus('drive', v => `Button ${v}`)], ['Motor interlock', consensus('gate', v => v === null ? 'Power only' : `Power + amber ${v ? 'on' : 'off'}`)], ['Amber stops motor', consensus('directionStops', v => v ? 'Yes' : 'No')]];
  $('rules').innerHTML = rules.map(([label, value]) => `<div class="rule-row"><span>${label}</span><b>${escape(value)}</b></div>`).join('');
  $('ledger-count').textContent = state.history.length;
  $('empty').hidden = state.history.length > 0;
  $('ledger').innerHTML = [...state.history].reverse().map(e => `<tr><td>${String(e.step).padStart(3, '0')}</td><td><strong>Press ${e.action}</strong> <span class="mono">/ ${escape(e.provider || 'local')}</span><small>${escape(e.reason || '')}</small></td><td class="outcome">POWER ${e.after.power ? 'ON' : 'OFF'} · AMBER ${e.after.direction ? 'ON' : 'OFF'}<br>MOTOR ${e.after.motor ? 'RUNNING' : 'STOPPED'}</td><td>${e.prior} → ${e.remaining}</td><td><span class="badge ${e.surprise ? 'surprise' : ''}">${e.surprise ? 'MODEL REVISED' : e.remaining < e.prior ? 'NARROWED' : 'CONSISTENT'}</span></td></tr>`).join('');
  $('session-id').textContent = `SESSION ${state.id.slice(0, 8).toUpperCase()}`;
  $('mutate').disabled = working || running || state.kind !== 'simulation';
  const lastTask = state.tasks.at(-1);
  if (lastTask) {
    const verified = lastTask.status === 'verified';
    $('task-result').className = `result-box ${verified ? 'success' : 'warning'}`;
    $('task-result').textContent = verified ? `${lastTask.label}: verified from device observation · ${lastTask.steps} action${lastTask.steps === 1 ? '' : 's'}.` : `${lastTask.label}: ${lastTask.status === 'model-changed' ? 'prediction failed; model revised. Relearn before retrying.' : 'no agreed plan yet. Continue discovery, then retry.'}`;
  }
}
async function operation(fn) {
  lock(true);
  try { await fn(); } catch (error) { notify(error.message); running = false; }
  finally { lock(false); }
}
async function step(verify = false, newSweep = false) {
  const data = await api('step', { provider: $('provider').value, verify, newSweep });
  state = data.state; render();
  const event = data.result.event;
  if (event) {
    const button = [...document.querySelectorAll('.physical-button')].find(b => b.textContent === event.action);
    button.classList.add('pressed'); setTimeout(() => button.classList.remove('pressed'), 350);
    if (event.surprise) {
      $('recovery-result').className = 'result-box warning';
      $('recovery-result').textContent = `Prediction contradicted at experiment ${event.step}. Reopened hypotheses from this observation; revision ${state.revisions}.`;
    }
  }
  return data.result;
}
$('step').onclick = () => operation(() => step());
$('explore').onclick = async () => {
  if (running) { running = false; lock(working); return; }
  running = true; lock(false);
  await operation(async () => {
    for (let i = 0; i < 64 && running; i++) {
      const result = await step();
      if (result.done || state.settled) { running = false; notify('Discovery complete. Try a task or test recovery.'); break; }
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    running = false;
  });
};
$('task').onclick = () => operation(async () => { const data = await api('task', { goal: $('goal').value }); state = data.state; render(); });
$('mutate').onclick = () => operation(async () => {
  await api('mutate', {});
  $('recovery-result').className = 'result-box warning';
  $('recovery-result').textContent = 'Operator changed the mechanism. The learner still holds its previous model. Check & relearn to test it.';
});
$('verify').onclick = () => operation(async () => {
  const initial = state.revisions;
  for (let i = 0; i < 96; i++) {
    const result = await step(true, i === 0);
    if (state.revisions > initial && state.settled) {
      $('recovery-result').className = 'result-box success';
      $('recovery-result').textContent = `Recovered: prediction failure detected and model relearned in ${i + 1} actions. Execute a task to verify recovery.`;
      return;
    }
    if (result.done) {
      $('recovery-result').className = 'result-box success';
      $('recovery-result').textContent = 'All reachable state-action predictions passed this verification sweep. No contradiction observed.';
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  notify('Verification budget reached after 96 actions. Continue checking the model.');
});
$('reset').onclick = () => operation(async () => {
  const data = await api('reset', {}); state = data.state;
  $('task-result').textContent = 'No task executed yet.'; $('task-result').className = 'result-box';
  $('recovery-result').textContent = 'The learner gets no rule-change notification.'; $('recovery-result').className = 'result-box';
  render();
});
try { state = await api('state'); render(); } catch (error) { $('connection').textContent = 'Disconnected'; notify(error.message); }
