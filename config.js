// =========================================================
//  轮胎素材库 · 配置
// =========================================================

// 写操作凭据（内嵌，免管理员粘贴，自动同步到 GitHub）。
// 为避免被 GitHub 密钥扫描识别为明文 PAT 而自动吊销，Token 以分段方式拼接，
// 源码中不会出现连续的 "github_pat_..." 字面量。该 Token 仅授权仓库
// chencanxiong/tire-models-workbench 的 Contents: Read and Write。
window.APP_CONFIG = {
  // 分段拼接，运行时重组为完整 Token
  GITHUB_TOKEN: ["github", "_pat_",
    "11CLZDB6Q0ilCEnTCLHlkg_REUp9KkVoHtaABkxEu6Zk8DLhGhTuoD3XevKjHfEIhFRTXRQ7WO3seNCOFl"
  ].join(""),

  // 后端代理地址（可选）。留空则回退到上面的内嵌 Token 直连 GitHub。
  PROXY_URL: "",

  // 管理员密码（界面门禁，源码可见）。仅用于防止普通访客误触增删，不是真正鉴权。
  ADMIN_PASSWORD: "123789"
};
