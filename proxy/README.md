# 后端代理（Cloudflare Worker）

把 GitHub 写凭据（Token）从前端移到这个 Worker 里。前端只调用 Worker，由 Worker 注入 Token 转发给 GitHub，**客户端永远拿不到 Token**。

## 前置
- 一个 Cloudflare 账号（免费版即可）
- 本地安装 Node.js（已具备）

## 部署步骤
```bash
# 1. 安装 wrangler
npm install -g wrangler

# 2. 登录 Cloudflare（浏览器授权）
wrangler login

# 3. 把细粒度 Token 设为 Worker Secret（交互式粘贴，不会写进代码）
wrangler secret put GITHUB_TOKEN
#   交互提示时粘贴你的细粒度 Token（形如 github_pat_xxx...，仅授权本仓库、Contents: Read and Write）
#   注意：Token 只存在 Cloudflare 的 Secret 里，不会写进任何仓库文件。

# 4. 部署
wrangler deploy
```
部署成功后会输出地址，形如：
`https://tire-workbench-proxy.<你的子域>.workers.dev`

## 5. 在前端启用
把上面这个地址填进 `config.js` 的 `PROXY_URL`：
```js
window.APP_CONFIG = {
  PROXY_URL: "https://tire-workbench-proxy.<你的子域>.workers.dev",
  ...
};
```
提交推送后，所有增删/上传都走代理，前端不再持有任何密钥。

## 6. 彻底移除前端 Token（可选但推荐）
代理上线并验证可用后，删掉 `config.js` 里的 `GITHUB_TOKEN` 整段，使前端 100% 不含密钥。

## 安全说明
- Worker 仅放行 `/repos/chencanxiong/tire-models-workbench/` 开头的请求，其它路径一律 403。
- GITHUB_TOKEN 必须是「细粒度 Token」且仅授权本仓库、Contents: Read and Write。
- Worker 开放了 CORS（`*），仅适合这种公开前端调用；若需更强限制可改为校验自定义请求头。
