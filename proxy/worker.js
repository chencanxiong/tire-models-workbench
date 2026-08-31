// Cloudflare Worker —— GitHub API 代理
// 作用：持有 GITHUB_TOKEN（细粒度，仅授权 tire-models-workbench，Contents: Read and Write），
//       前端只调用本 Worker，由本 Worker 注入 Token 后转发给 GitHub。客户端永远拿不到真实 Token。
//
// 部署步骤见同目录 README.md。GITHUB_TOKEN 通过 `wrangler secret put GITHUB_TOKEN` 设置，不写进代码。

const ALLOWED_PREFIX = "/repos/chencanxiong/tire-models-workbench/";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: CORS });
    }

    let payload;
    try {
      payload = await request.json();
    } catch (_) {
      return new Response("Invalid JSON", { status: 400, headers: CORS });
    }

    const { method = "GET", path, body } = payload;
    if (!path || typeof path !== "string" || !path.startsWith(ALLOWED_PREFIX)) {
      return new Response("Forbidden: path not allowed", { status: 403, headers: CORS });
    }

    const ghResp = await fetch("https://api.github.com" + path, {
      method,
      headers: {
        "Authorization": "Bearer " + env.GITHUB_TOKEN,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "tire-workbench-proxy",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await ghResp.text();
    return new Response(text, {
      status: ghResp.status,
      headers: {
        ...CORS,
        "Content-Type": ghResp.headers.get("Content-Type") || "application/json",
      },
    });
  },
};
