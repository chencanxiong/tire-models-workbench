// 写操作凭据（GITHUB_TOKEN）：请填入「细粒度 Personal Access Token」
//   创建步骤：GitHub → 头像 → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
//     - Resource owner: chencanxiong
//     - Repository access: Only select repositories → 选 tire-models-workbench
//     - Permissions → Repository permissions → Contents: Read and Write
//   不要使用全账号 repo 权限的 Token（会随公开站点暴露，危及整个 GitHub 账号）。
// ADMIN_PASSWORD 仅为界面门禁（源码可见），用于防止普通访客误删，请自行修改。
window.APP_CONFIG = {
  GITHUB_TOKEN: "{{填入细粒度Token}}",
  ADMIN_PASSWORD: "tire2026"
};
