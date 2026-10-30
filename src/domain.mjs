export const ACTIONS = ['A', 'B', 'C'];
export const INITIAL = { power: false, direction: false, motor: false };
export const key = s => `${+s.power}${+s.direction}${+s.motor}`;
export const same = (a, b) => key(a) === key(b);
export const describe = s => `power ${s.power ? 'on' : 'off'}, amber ${s.direction ? 'on' : 'off'}, motor ${s.motor ? 'running' : 'stopped'}`;

// A declared hypothesis family, not a hidden-device lookup table.
// These are the possible causal mechanisms the learner is allowed to consider.
export function hypotheses() {
  const result = [];
  for (const power of ACTIONS) for (const direction of ACTIONS.filter(a => a !== power)) {
    const drive = ACTIONS.find(a => a !== power && a !== direction);
    for (const gate of [null, false, true]) for (const directionStops of [false, true]) {
      result.push({ id: `${power}${direction}${drive}:${gate}:${directionStops}`, power, direction, drive, gate, directionStops });
    }
  }
  return result;
}

export function transition(model, state, action) {
  const next = { ...state };
  if (action === model.power) {
    next.power = !next.power;
    if (!next.power) next.motor = false;
  } else if (action === model.direction) {
    next.direction = !next.direction;
    if (model.directionStops) next.motor = false;
  } else if (action === model.drive && next.power && (model.gate === null || next.direction === model.gate)) {
    next.motor = !next.motor;
  }
  return next;
}

export const GOALS = {
  run: { label: 'Run the motor', target: { motor: true } },
  stop: { label: 'Stop the motor', target: { motor: false } },
  shutdown: { label: 'Power down', target: { power: false, motor: false } },
  signal: { label: 'Amber on · motor stopped', target: { direction: true, motor: false } }
};
export const meets = (state, target) => Object.entries(target).every(([k, v]) => state[k] === v);

export function partition(models, state, action) {
  const groups = new Map();
  for (const m of models) {
    const next = transition(m, state, action), k = key(next);
    if (!groups.has(k)) groups.set(k, { state: next, models: [] });
    groups.get(k).models.push(m);
  }
  return [...groups.values()];
}
export function entropy(groups, total) {
  return groups.reduce((h, g) => { const p = g.models.length / total; return h - p * Math.log2(p); }, 0);
}
