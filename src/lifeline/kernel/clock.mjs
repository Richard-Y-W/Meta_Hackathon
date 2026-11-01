// Episode clock: integer microseconds of simulated time since the episode origin, derived from a
// monotonic source. Acceleration > 1 maps wall time (including model and solver waiting) onto more
// simulated time; the plant never pauses for a slow decision.
export function msToUs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new Error('invalid_time');
  return Math.round(ms * 1000);
}

export function createEpisodeClock({ originNs, monotonicNs = () => process.hrtime.bigint(), acceleration = 1 }) {
  if (typeof acceleration !== 'number' || !Number.isFinite(acceleration) || acceleration <= 0) throw new Error('invalid_acceleration');
  const origin = BigInt(originNs);
  let last = origin;
  return {
    acceleration,
    nowUs() {
      const ns = BigInt(monotonicNs());
      if (ns < last) throw new Error('clock_regression');
      last = ns;
      return Math.floor((Number(ns - origin) / 1000) * acceleration);
    },
    simDurationUs: wallMs => msToUs(wallMs * acceleration),
    wallMsForSimUs: simUs => simUs / 1000 / acceleration,
  };
}
