export async function chooseWithMuse(context, candidates) {
  if (!process.env.MODEL_API_KEY) throw new Error('MODEL_API_KEY is not configured. Select local mode or configure .env.');
  const response = await fetch('https://api.meta.ai/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      model: process.env.META_MODEL || 'muse-spark-1.3',
      input: [{ role: 'user', content: `You are Blackbox Apprentice's experiment planner. You cannot access device rules. Choose an experiment using only these observations and hypotheses. Return ONLY JSON {"candidate": <zero-based index>, "reason": <one sentence explaining the discriminating test>}. Candidates contain an immediate action and possibly a navigation path; pick the most useful experiment. Never invent outcomes.\n${JSON.stringify({ context, candidates })}` }],
      max_output_tokens: 700
    })
  });
  if (!response.ok) throw new Error(`Meta Model API returned HTTP ${response.status}. Check credentials, credits, and model access.`);
  const result = await response.json();
  const output = result.output_text ?? (result.output ?? []).flatMap(item => item.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('');
  let choice;
  try { choice = JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); }
  catch { throw new Error('Muse returned an invalid decision; no action was taken.'); }
  if (!Number.isInteger(choice.candidate) || choice.candidate < 0 || choice.candidate >= candidates.length || typeof choice.reason !== 'string') throw new Error('Muse selected an invalid experiment; no action was taken.');
  return { ...candidates[choice.candidate], reason: choice.reason.slice(0, 700), provider: 'Muse Spark', model: process.env.META_MODEL || 'muse-spark-1.3', responseId: result.id ?? null };
}
