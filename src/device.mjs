import { fork } from 'node:child_process';
import { ACTIONS } from './domain.mjs';

export class SimulatedDevice {
  constructor() {
    this.worker = fork(new URL('./device-worker.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    this.pending = new Map(); this.sequence = 0;
    this.worker.on('message', message => {
      const pending = this.pending.get(message.id);
      if (pending) { clearTimeout(pending.timer); pending.resolve(message); this.pending.delete(message.id); }
    });
    this.worker.on('exit', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Device process exited')); }
      this.pending.clear();
    });
  }
  request(command, action) {
    if (command === 'press' && !ACTIONS.includes(action)) throw new Error('Invalid control');
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Device timeout')); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.send({ id, command, action });
    });
  }
  observe() { return this.request('observe'); }
  press(action) { return this.request('press', action); }
  mutate() { return this.request('mutate'); }
  close() { this.worker.kill(); }
}

export class BridgeDevice {
  constructor(url) {
    this.url = new URL(url);
    if (!['http:', 'https:'].includes(this.url.protocol)) throw new Error('Bridge requires HTTP(S)');
  }
  async request(path, body) {
    const response = await fetch(new URL(path, this.url), {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Hardware bridge returned ${response.status}`);
    const data = await response.json();
    if (!data.observation || !['power', 'direction', 'motor'].every(k => typeof data.observation[k] === 'boolean')) throw new Error('Invalid hardware observation');
    return { observation: data.observation, commitment: null };
  }
  observe() { return this.request('/observe'); }
  press(action) {
    if (!ACTIONS.includes(action)) throw new Error('Invalid control');
    return this.request('/press', { action });
  }
  mutate() { throw new Error('Change physical rules on the device itself'); }
  close() {}
}
