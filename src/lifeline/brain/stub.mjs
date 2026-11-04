// Test double for the brain: fixed keyword rules over the visible reports, returning the same JSON shape
// as the live model. Used by tests and offline rehearsal only; it is not the LIFELINE brain.
const RULES = [
  { assetId: 'line-3-8', words: [/water tower/i, /up the ridge/i], windowMin: [20, 70], confidence: 0.8 },
  { assetId: 'line-2-3', words: [/river[- ]crossing/i, /at the crossing/i], windowMin: [5, 35], confidence: 0.7 },
  { assetId: 'grid-hv', words: [/both town substations/i, /regional grid/i], windowMin: [10, 60], confidence: 0.7 },
];
const CLEAR = /(nothing near|looks solid|all clear|no damage)/i;

export function stubBrain() {
  return async ({ prompt }) => {
    const reports = [...prompt.matchAll(/^\[(r\d+)\] t=\d+ min, [^:]+: (.*)$/gm)].map(m => ({ id: m[1], text: m[2] }));
    const threats = [], dismissed = [];
    for (const rule of RULES) {
      const hits = reports.filter(r => rule.words.some(w => w.test(r.text)));
      if (!hits.length) continue;
      const clear = hits.filter(r => CLEAR.test(r.text));
      if (clear.length) { dismissed.push({ evidence: clear.map(r => r.id), why: `latest field report says ${rule.assetId} is clear` }); continue; }
      threats.push({ id: `t${threats.length + 1}`, assetId: rule.assetId, windowMin: rule.windowMin, confidence: rule.confidence, evidence: hits.map(r => r.id), why: `reports mention ${rule.assetId}` });
    }
    return { code: 'ok', durationMs: 1, text: JSON.stringify({ threats, dismissed }) };
  };
}
