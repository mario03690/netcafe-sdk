// 从 ainetcafe.com 的公开接口取成本数据,重建数据集卡片,推到 Hugging Face。
//
// 全部数据走公开接口,所以这个脚本里没有任何服务器凭据 —— 唯一的秘密是 HF_TOKEN。
// 任何人都可以拿它复核我们发布的数字对不对,这正是我们希望的。
const BASE = process.env.NETCAFE_BASE || 'https://ainetcafe.com';
const REPO = process.env.HF_DATASET_REPO || 'mario0369/llm-cost-same-prompt';
const TOKEN = process.env.HF_TOKEN;
if (!TOKEN) { console.error('缺少 HF_TOKEN'); process.exit(1); }

const get = async (path, json = true) => {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return json ? r.json() : r.text();
};

const [costs, csv, tasksJs] = await Promise.all([
  get('/api/model-costs'),
  get('/api/model-costs/raw.csv', false),
  // 提示词随数据一起发。不发它,"同一道题"这个说法就无法被任何人验证。
  get('/t/model_costs?days=30').then(() => null).catch(() => null),
]);

const bench = costs.standard_bench;
if (!bench?.tasks?.length) { console.log('还没有可发布的同题样本,跳过'); process.exit(0); }

const T = {
  short_answer: 'Two-sentence explanation of a concept',
  summarize: 'Compress a technical passage into three bullets',
  structured_json: 'Extract fields, return JSON only',
};

const taskSections = bench.tasks.map((t) => {
  const rows = t.models.map((m) => `| \`${m.model}\` | ${m.avg_usd.toFixed(6)} | `
    + `${m.avg_tokens_in} / ${m.avg_tokens_out} | ${m.avg_latency_ms} | ${m.runs} |`).join('\n');
  return `### ${T[t.task] || t.task} (\`${t.task}\`)\n\n`
    + `Cheapest: **${t.models[0].model}**. The most expensive costs **${t.spread}x** more for the same question.\n\n`
    + `| model | USD per call | tokens in / out | latency (ms) | runs |\n|---|---|---|---|---|\n${rows}\n`;
}).join('\n');

const pre = bench.preamble_channels || [];
const preSection = !pre.length ? '' : `
## A routing artefact worth knowing about

Some requests arrive on a channel serving a large cached preamble: sending the single word \`hi\` comes
back reporting ~4,400 prompt tokens, 3,840 of them cached. It is **not stable** — the same model and
the same question sometimes hits it and sometimes does not, so it is a property of routing, not of the
model. Those runs are excluded from the comparison above and reported here instead. They are still in
\`probe_runs.csv\` (\`cached_prompt_tokens >= 1000\`), so you can check the exclusion rule yourself.

| model | share of runs hitting it | USD when hit | USD when clean |
|---|---|---|---|
${pre.map((p) => `| \`${p.model}\` | ${Math.round(p.hit_rate * 100)}% | ${p.avg_usd_when_hit.toFixed(6)} | `
  + `${p.avg_usd_when_clean != null ? p.avg_usd_when_clean.toFixed(6) : '—'} |`).join('\n')}
`;

const card = `---
license: cc-by-4.0
language:
  - en
tags:
  - llm
  - cost
  - benchmark
  - inference-cost
  - model-selection
pretty_name: Measured per-call LLM cost (same prompt, every model)
configs:
  - config_name: default
    data_files: probe_runs.csv
---

# Measured per-call LLM cost — same prompt, every model

Vendors publish prices per million tokens. Nobody publishes what **one call** actually costs, because
that depends on how many tokens the model chooses to emit — and on the same question models differ by
more than an order of magnitude. One model finishes a JSON extraction in 23 tokens; another writes 300.

This dataset sends a **fixed set of prompts to every model at temperature 0**, every night, and records
the cost computed from the token usage each provider actually reported. Because the question is
identical, the difference is the model, not the workload.

## Current results (window: ${bench.window_days} days, as of ${bench.measured_at.slice(0, 10)})

Median spread across tasks: **${bench.median_spread}x**. Clean runs in window: ${bench.total_runs}.

${taskSections}
${preSection}
## Method

- Identical prompt per task, \`temperature: 0\`, capped \`max_tokens\`. The prompts are in \`tasks.js\` and
  are deliberately timeless — they never change, so numbers stay comparable across months.
- Cost = tokens reported by the provider x the price actually paid. Responses without a \`usage\` field
  are **discarded, not estimated** — an estimate inside a "measured cost" dataset is a lie.
- One run per model per task per night; samples accumulate.
- \`probe_runs.csv\` contains every run, including failures and preamble hits, so the published averages
  can be recomputed from scratch.

## What this does not tell you

Cost, not quality. Cheapest here says nothing about whether the answer is good. It also reflects these
three prompts specifically — your prompts have a different input/output ratio, and that ratio is exactly
what drives the difference. Use it as a starting point for bulk work, then measure your own.

## Live version, updated nightly

- Human-readable, per-task pages: ${BASE}/costs
- JSON API, no key, CORS open: ${BASE}/api/model-costs
- Raw runs as CSV: ${BASE}/api/model-costs/raw.csv
- Callable from a bare URL by any agent: ${BASE}/t/model_costs?days=30

## Citation

\`\`\`
AI NetCafe real model cost dataset. ${BASE}/costs (CC BY 4.0)
\`\`\`
`;

const files = [{ path: 'README.md', content: card }, { path: 'probe_runs.csv', content: csv }];
const ndjson = [
  JSON.stringify({ key: 'header', value: { summary: `nightly cost data ${bench.measured_at.slice(0, 10)}` } }),
  ...files.map((f) => JSON.stringify({ key: 'file', value: { path: f.path, encoding: 'base64',
    content: Buffer.from(f.content, 'utf8').toString('base64') } })),
].join('\n');

const r = await fetch(`https://huggingface.co/api/datasets/${REPO}/commit/main`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-ndjson' },
  body: ndjson, signal: AbortSignal.timeout(120_000),
});
const body = await r.text();
if (!r.ok) { console.error(`同步失败 ${r.status}: ${body.slice(0, 300)}`); process.exit(1); }
console.log(`✅ https://huggingface.co/datasets/${REPO} 已更新 —— `
  + `${bench.total_runs} 次干净样本,中位倍差 ${bench.median_spread}x`);
