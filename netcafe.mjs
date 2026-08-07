/**
 * netcafe.mjs — 给 AI agent 用的一套工具,单文件、零依赖(只用内置 fetch)。
 *
 * 不用注册、不用密钥就能开始:匿名有免费额度,每次调用都会告诉你花了多少钱。
 * 额度不够时传一把 AllRouter Key 进来即可,调用方式完全不变。
 *
 *   import { NetCafe } from './netcafe.mjs';
 *   const nc = new NetCafe();                  // 匿名
 *   const nc = new NetCafe({ key: 'sk-...' }); // 带 Key:额度更大 + 跨设备记忆
 *
 *   await nc.search('MCP 协议 2026');
 *   await nc.read('https://example.com');
 *   nc.diagramUrl('graph TD; A-->B');          // 不发请求,直接拼出可嵌 Markdown 的图片 URL
 *   await nc.build('一个番茄钟,可自定义时长');   // ★ 一句话造一个真正在线的应用
 *
 * 全部工具:https://ainetcafe.com/mcp.html
 */
export const VERSION = '1.1.1';
const BASE = 'https://ainetcafe.com';

export class NetCafeError extends Error {
  constructor(message, payload = {}) {
    // message 里带上给人看的出路:撞墙后 agent 的默认行为是默默重试,
    // 结构化字段人看不到,异常打印的那一行是唯一保证到人眼前的位置。
    const extra = payload.tell_your_human;
    super(extra && !String(message).includes(extra) ? `${message}\n>>> ${extra}` : message);
    this.name = 'NetCafeError';
    this.payload = payload;
    this.pairUrl = payload.pair_url;
    this.howToContinue = payload.how_to_continue;
    this.tellYourHuman = payload.tell_your_human;
  }
}

export class NetCafe {
  constructor({ key = null, base = BASE, timeout = 120000, source = 'jssdk' } = {}) {
    this.key = key; this.base = base.replace(/\/$/, ''); this.timeout = timeout; this.source = source;
  }
  #headers(extra = {}) {
    return { 'user-agent': `netcafe-js/${VERSION}`, accept: 'application/json',
      ...(this.key ? { authorization: `Bearer ${this.key}` } : {}), ...extra };
  }
  async #get(tool, params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
    if (!q.has('s')) q.set('s', this.source);
    const r = await fetch(`${this.base}/t/${tool}?${q}`, { headers: this.#headers(),
      signal: AbortSignal.timeout(this.timeout) });
    const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok || d.error) throw new NetCafeError(d.error || `HTTP ${r.status}`, d);
    return d;
  }
  async #rpc(tool, args) {
    const r = await fetch(`${this.base}/mcp`, { method: 'POST',
      headers: this.#headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(this.timeout) });
    const d = await r.json();
    const res = d.result || {};
    let payload = res.structuredContent;
    if (!payload) { try { payload = JSON.parse(res.content?.[0]?.text || '{}'); } catch { payload = {}; } }
    if (payload.error) throw new NetCafeError(payload.error, payload);
    return payload;
  }
  // —— 读取类 ——
  async search(query, maxResults = 8) { return (await this.#get('web_search', { query, max_results: maxResults })).results || []; }
  async read(url) { return (await this.#get('fetch_page', { url })).markdown || ''; }
  async diagram(source, type = 'mermaid', format = 'svg') { return (await this.#get('render_diagram', { source, type, format })).image_url; }
  /** 不发请求,直接拼出无状态图片 URL —— 适合写死在 README / 文档里 */
  diagramUrl(source, type = 'mermaid', format = 'svg') {
    const b64 = Buffer.from(source, 'utf8').toString('base64url');
    return `${this.base}/i/${type}/${b64}?format=${format}`;
  }
  async grammar(text, language = 'auto') { return (await this.#get('check_grammar', { text, language })).issues || []; }
  async transcribe(url, language) { return (await this.#get('transcribe_audio', { url, language })).text || ''; }
  async pdf({ url, html } = {}) { return (await this.#get('convert_to_pdf', { url, html })).pdf_url; }
  async translate(text, target = 'zh') { return (await this.#get('translate_text', { text, target })).translated || ''; }
  async models(tier) { return (await this.#get('list_models', { tier })).models || []; }
  /** 每个模型「一次调用」的真实美元成本(来自平台账单,非厂商标价)。CC BY 4.0。 */
  async costs(days = 30) { return (await this.#get('model_costs', { days })).models || []; }
  async ask(prompt, { model, maxTokens } = {}) { return this.#get('ask_model', { prompt, model, max_tokens: maxTokens }); }
  async compare(prompt, models) { return this.#get('compare_models', { prompt, models: models?.join(',') }); }
  // —— 写入/长任务 ——
  async remember(content, { kind = 'note', project } = {}) { return this.#rpc('remember', { content, kind, project }); }
  async recall(query, project) { return (await this.#rpc('recall', { ...(query ? { query } : {}), ...(project ? { project } : {}) })).memories || []; }
  /** ★ 一句话造一个真正在线的应用。约 100 秒;wait:false 则立刻返回 job_id */
  async build(description, { refine, visibility = 'public', wait = true, poll = 10000 } = {}) {
    const job = await this.#rpc('build_app', { description, ...(refine ? { refine } : {}), visibility });
    return wait ? this.waitJob(job.job_id, { poll }) : job;
  }
  async waitJob(jobId, { poll = 10000, timeout = 600000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await this.#get('check_job', { job_id: jobId });
      if (v.status === 'done') return v.structured_result || v;
      if (v.status === 'error') throw new NetCafeError(v.error || 'job failed', v);
      await new Promise((r) => setTimeout(r, poll));
    }
    throw new NetCafeError(`job ${jobId} did not finish in time`);
  }
}
export default NetCafe;
