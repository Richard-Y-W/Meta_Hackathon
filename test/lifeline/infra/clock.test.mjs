import test from 'node:test';
import assert from 'node:assert/strict';
import { createEpisodeClock, msToUs } from '../../../src/lifeline/kernel/clock.mjs';

test('episode time is integer microseconds since the origin on the monotonic source', () => {
  let ns = 5_000_000_000n;
  const c = createEpisodeClock({ originNs: 5_000_000_000n, monotonicNs: () => ns });
  assert.equal(c.nowUs(), 0);
  ns += 1_500_000_123n;
  assert.equal(c.nowUs(), 1_500_000);
  assert.ok(Number.isInteger(c.nowUs()));
});

test('acceleration maps wall waiting onto simulated time: a 15 s call at 60x costs 15 simulated minutes', () => {
  let ns = 0n;
  const c = createEpisodeClock({ originNs: 0n, monotonicNs: () => ns, acceleration: 60 });
  ns = 15_000_000_000n;
  assert.equal(c.nowUs(), 900_000_000);
  assert.equal(c.simDurationUs(15_000), 900_000_000);
  assert.equal(c.wallMsForSimUs(900_000_000), 15_000);
});

test('a monotonic source that runs backwards is a recorded clock fault, not silently accepted', () => {
  let ns = 2_000_000_000n;
  const c = createEpisodeClock({ originNs: 0n, monotonicNs: () => ns });
  c.nowUs();
  ns = 1_000_000_000n;
  assert.throws(() => c.nowUs(), /clock_regression/);
});

test('conversions round to whole microseconds and refuse non-finite input', () => {
  assert.equal(msToUs(1.2345), 1235);
  assert.throws(() => msToUs(NaN), /invalid_time/);
  assert.throws(() => createEpisodeClock({ originNs: 0n, monotonicNs: () => 0n, acceleration: 0 }), /invalid_acceleration/);
});
