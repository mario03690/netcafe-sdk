"""
netcafe.py — 给 AI agent 用的一套工具,单文件、零依赖(只用标准库)。

不需要注册、不需要密钥就能开始用:匿名有免费额度,每次调用都会告诉你花了多少钱。
额度不够时,拿一把 AllRouter Key 传进来即可,调用方式完全不变。

    from netcafe import NetCafe
    nc = NetCafe()                      # 匿名,免费额度
    nc = NetCafe(key="sk-...")          # 带 Key,额度更大 + 跨设备记忆

    nc.search("MCP 协议 2026")           # 联网搜索
    nc.read("https://example.com")       # 网页转干净 Markdown
    nc.diagram("graph TD; A-->B")        # 图表 → 图片 URL(可直接嵌 Markdown)
    nc.transcribe("https://x.com/a.mp3") # 语音转文字
    nc.grammar("He go to school")        # 语法检查
    nc.pdf(url="https://example.com")    # 网页转 PDF
    nc.ask("一句话解释 MCP")              # 单模型问答,返回答案+精确花费
    nc.compare("同一个问题", models=[...]) # 多模型对比:答案/成本/延迟
    nc.remember("我偏好用便宜模型跑批量")   # 跨会话记忆
    nc.recall("我偏好什么模型")
    nc.build("一个番茄钟,可自定义时长")     # ★ 一句话造一个真正在线的应用

主页与全部工具文档:https://ainetcafe.com/mcp.html
"""

import json
import time
import urllib.parse
import urllib.request

__version__ = "1.0.0"
BASE = "https://ainetcafe.com"


class NetCafeError(RuntimeError):
    """调用失败。quota_exhausted 时 .how_to_continue 里有继续使用的办法。"""

    def __init__(self, message, payload=None):
        super().__init__(message)
        self.payload = payload or {}
        self.how_to_continue = self.payload.get("how_to_continue")
        self.tell_your_human = self.payload.get("tell_your_human")


class NetCafe:
    def __init__(self, key=None, base=BASE, timeout=120, source="pysdk"):
        self.key = key
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.source = source

    # —— 内部 ——
    def _headers(self):
        h = {"user-agent": f"netcafe-python/{__version__}", "accept": "application/json"}
        if self.key:
            h["authorization"] = f"Bearer {self.key}"
        return h

    def _get(self, tool, **params):
        params = {k: v for k, v in params.items() if v is not None}
        params.setdefault("s", self.source)
        url = f"{self.base}/t/{tool}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                payload = json.loads(body)
            except ValueError:
                payload = {"error": body[:300]}
            raise NetCafeError(payload.get("error", f"HTTP {e.code}"), payload) from None

    def _rpc(self, tool, args):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                           "params": {"name": tool, "arguments": args}}).encode()
        headers = dict(self._headers())
        headers["content-type"] = "application/json"
        headers["accept"] = "application/json, text/event-stream"
        req = urllib.request.Request(f"{self.base}/mcp", data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            d = json.loads(r.read().decode("utf-8"))
        result = d.get("result", {})
        payload = result.get("structuredContent")
        if payload is None:
            content = (result.get("content") or [{}])[0].get("text", "{}")
            try:
                payload = json.loads(content)
            except ValueError:
                payload = {"text": content}
        if payload.get("error"):
            raise NetCafeError(payload["error"], payload)
        return payload

    # —— 读取类:一个 GET 就够 ——
    def search(self, query, max_results=8):
        """联网搜索,返回 [{title, url, snippet}]。"""
        return self._get("web_search", query=query, max_results=max_results).get("results", [])

    def read(self, url):
        """任意公开网页 → 干净 Markdown。"""
        return self._get("fetch_page", url=url).get("markdown", "")

    def diagram(self, source, type="mermaid", format="svg"):
        """图表代码 → 图片 URL,可直接写进 Markdown 的 ![](...)。"""
        return self._get("render_diagram", source=source, type=type, format=format).get("image_url")

    def diagram_url(self, source, type="mermaid", format="svg"):
        """不发请求,直接拼出无状态图片 URL(适合写死在 README 里)。"""
        import base64
        b64 = base64.urlsafe_b64encode(source.encode()).decode().rstrip("=")
        return f"{self.base}/i/{type}/{b64}?format={format}"

    def grammar(self, text, language="auto"):
        """语法/拼写/风格检查,返回逐条问题与修改建议。"""
        return self._get("check_grammar", text=text, language=language).get("issues", [])

    def transcribe(self, url, language=None):
        """音频 URL → 文字稿(自托管 Whisper)。"""
        return self._get("transcribe_audio", url=url, language=language).get("text", "")

    def pdf(self, url=None, html=None):
        """网页或 HTML → PDF,返回下载链接。"""
        return self._get("convert_to_pdf", url=url, html=html).get("pdf_url")

    def translate(self, text, target="zh"):
        return self._get("translate_text", text=text, target=target).get("translated", "")

    def models(self, tier=None):
        """全部可调模型 + 每百万 token 单价,按成本选型用。"""
        return self._get("list_models", tier=tier).get("models", [])

    def ask(self, prompt, model=None, max_tokens=None):
        """单模型问答。返回 dict:answer / cost_usd / latency_ms。"""
        return self._get("ask_model", prompt=prompt, model=model, max_tokens=max_tokens)

    def compare(self, prompt, models=None):
        """同一个提示词跑多个模型,返回各自答案 + 真实计量成本 + 延迟。"""
        return self._get("compare_models", prompt=prompt,
                         models=",".join(models) if models else None)

    # —— 写入/长任务类:走 MCP ——
    def remember(self, content, kind="note", project=None):
        """存一条会跨会话保留的记忆。带 Key 时跨设备、跨 agent 共享。"""
        return self._rpc("remember", {"content": content, "kind": kind, "project": project})

    def recall(self, query=None, project=None):
        return self._rpc("recall", {k: v for k, v in
                                    {"query": query, "project": project}.items() if v}).get("memories", [])

    def build(self, description, refine=None, visibility="public", wait=True, poll=10):
        """★ 一句话造一个真正在线的应用。约 100 秒后返回 app_url;wait=False 则立刻返回 job_id。"""
        job = self._rpc("build_app", {k: v for k, v in
                                      {"description": description, "refine": refine,
                                       "visibility": visibility}.items() if v})
        if not wait:
            return job
        return self.wait_job(job["job_id"], poll=poll)

    def wait_job(self, job_id, poll=10, timeout=600):
        """轮询长任务直到结束。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            view = self._get("check_job", job_id=job_id)
            if view.get("status") == "done":
                return view.get("structured_result") or view
            if view.get("status") == "error":
                raise NetCafeError(view.get("error", "job failed"), view)
            time.sleep(poll)
        raise NetCafeError(f"job {job_id} did not finish in {timeout}s")


if __name__ == "__main__":
    nc = NetCafe()
    print("可用模型:", [m["id"] for m in nc.models()][:5])
    print("图表 URL:", nc.diagram_url("graph TD; 想法-->应用"))
