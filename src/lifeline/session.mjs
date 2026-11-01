// Run lifecycle: observing -> investigating -> proposed -> evaluating -> executing -> verifying -> observing.
// Any active stage may return to observing on rejection or interruption. `degraded` means deterministic
// control after AI failure; `unavailable` means the service cannot be delivered. Neither is success.
const NEXT = {
  observing: ['investigating', 'proposed', 'degraded', 'unavailable', 'stopped'],
  investigating: ['proposed', 'observing', 'degraded', 'unavailable', 'stopped'],
  proposed: ['evaluating', 'observing', 'stopped'],
  evaluating: ['executing', 'observing', 'stopped'],
  executing: ['verifying', 'observing', 'stopped'],
  verifying: ['observing', 'degraded', 'unavailable', 'stopped'],
  degraded: ['observing', 'proposed', 'investigating', 'unavailable', 'stopped'],
  unavailable: ['observing', 'proposed', 'investigating', 'degraded', 'stopped'],
  stopped: [],
};

export class SessionState {
  constructor(now) {
    this.now = now;
    this.state = 'observing';
    this.history = [];
    this.violations = [];
  }

  transition(to, reason) {
    if (to === this.state) return;
    if (!NEXT[this.state]?.includes(to)) {
      this.violations.push({ from: this.state, to, reason, atMs: this.now() });
      throw new Error(`invalid_transition ${this.state} -> ${to}`);
    }
    this.history.push({ from: this.state, to, reason, atMs: this.now() });
    this.state = to;
  }

  isSuccess() { return false; } // the session never certifies recovery; the receipt scorer does
}
