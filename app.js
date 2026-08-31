/* =========================================================
   轮胎型号工作台  (GitHub Pages + GitHub Contents API)
   - 公开用户：查看 / 下载
   - 管理员：输入 GitHub Token 后可 新增 / 删除
   - 数据结构：分类(一级) → 型号(二级) → 图片/视频
   ========================================================= */

const CONFIG = {
  OWNER: "chencanxiong",
  REPO: "tire-models-workbench",
  BRANCH: "main",
  DATA_PATH: "tires.json",
  MAX_FILE_MB: 25, // GitHub Contents API 单次上传上限（约）
};

const API = `https://api.github.com/repos/${CONFIG.OWNER}/${CONFIG.REPO}`;

// 写操作凭据：优先走后端代理(PROXY_URL)，由代理注入 Token（客户端不持有密钥）。
// 仅当 PROXY_URL 为空时，回退到内嵌的 GITHUB_TOKEN（临时方案，代理上线后应移除）。
const GH_TOKEN = (window.APP_CONFIG && window.APP_CONFIG.GITHUB_TOKEN) || "";
const PROXY_URL = (window.APP_CONFIG && window.APP_CONFIG.PROXY_URL) || "";
const ADMIN_PASSWORD = (window.APP_CONFIG && window.APP_CONFIG.ADMIN_PASSWORD) || "";

// ---------- 运行时状态 ----------
let data = { categories: [] };
let token = GH_TOKEN;   // 写操作凭据：内嵌，免粘贴，自动同步
let isAdmin = false;     // 管理员身份由密码解锁（UI 门禁）
let currentCatId = null;
let currentModelId = null;
let filterText = "";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const sidebarList = $("sidebarList");
const sidebarEmpty = $("sidebarEmpty");
const contentEmpty = $("contentEmpty");
const contentPanel = $("contentPanel");
const mediaGrid = $("mediaGrid");
const mediaEmpty = $("mediaEmpty");
const sidebarEl = $("sidebar");
const drawerMask = $("drawerMask");
const fabBtn = $("fabBtn");

// =========================================================
//  工具函数
// =========================================================
function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function safeName(name) {
  return name.replace(/[^\w.\-一-龥]+/g, "_").slice(0, 80);
}

function findCat(id) { return data.categories.find((c) => c.id === id); }
function findModel(catId, modelId) {
  const c = findCat(catId);
  return c ? c.models.find((m) => m.id === modelId) : null;
}

// 带鉴权的 API 请求
// 若配置了后端代理(PROXY_URL)，请求经代理转发，由代理注入 Token（客户端不持有密钥）。
// 否则回退到内嵌的 GITHUB_TOKEN（临时方案，代理上线后应移除）。
async function apiFetch(path, opts = {}) {
  let res;
  if (PROXY_URL) {
    const method = opts.method || "GET";
    let bodyObj;
    if (opts.body) {
      try { bodyObj = JSON.parse(opts.body); } catch (_) { bodyObj = opts.body; }
    }
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, path, body: bodyObj }),
    });
  } else {
    const headers = Object.assign({ "Accept": "application/vnd.github+json" }, opts.headers || {});
    if (token) headers["Authorization"] = "Bearer " + token;
    res = await fetch(API + path, { ...opts, headers });
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).message; } catch (_) {}
    throw new Error(`GitHub API ${res.status}: ${detail || res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

async function getSha(path) {
  try {
    const r = await apiFetch(`/contents/${encodeURI(path)}`);
    return r.sha;
  } catch (e) {
    return null; // 文件不存在
  }
}

async function putFile(path, contentB64, message, sha) {
  const body = { message, content: contentB64, branch: CONFIG.BRANCH };
  if (sha) body.sha = sha;
  const existing = sha || (await getSha(path));
  if (existing) body.sha = existing;
  return apiFetch(`/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deleteFile(path, message) {
  const sha = await getSha(path);
  if (!sha) return; // 已不存在
  return apiFetch(`/contents/${encodeURI(path)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch: CONFIG.BRANCH }),
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result.split(",")[1]);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

// 写入索引文件 tires.json
async function saveData(message) {
  const json = JSON.stringify(data, null, 2);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  await putFile(CONFIG.DATA_PATH, b64, message);
}

// =========================================================
//  读取数据（公开，无需 Token）
// =========================================================
async function loadData() {
  // 优先从 GitHub API 读取最新提交（提交后立即可见，避免 Pages 缓存导致的覆盖丢失）
  try {
    const r = await apiFetch(`/contents/${CONFIG.DATA_PATH}`);
    const json = JSON.parse(decodeURIComponent(escape(atob(r.content))));
    if (json && Array.isArray(json.categories)) { data = json; render(); return; }
  } catch (e) { /* 回退到 Pages */ }
  // 回退：直接从站点读取
  try {
    const res = await fetch(CONFIG.DATA_PATH + "?t=" + Date.now());
    if (res.ok) {
      const json = await res.json();
      if (json && Array.isArray(json.categories)) data = json;
      else data = { categories: [] };
    }
  } catch (e) {
    data = { categories: [] };
  }
  render();
}

// =========================================================
//  渲染
// =========================================================
function render() {
  renderSidebar();
  renderContent();
  // 管理员按钮显隐
  $("addCatBtn").classList.toggle("hidden", !isAdmin);
  $("adminBtn").classList.toggle("hidden", isAdmin);
  $("logoutBtn").classList.toggle("hidden", !isAdmin);
  updateFab();
}

// 手机端抽屉开关
function openDrawer() {
  sidebarEl.classList.add("open");
  drawerMask.classList.remove("hidden");
}
function closeDrawer() {
  sidebarEl.classList.remove("open");
  drawerMask.classList.add("hidden");
}
// 悬浮上传按钮：仅在管理员且已选中型号时显示
function updateFab() {
  fabBtn.classList.toggle("hidden", !(isAdmin && !!currentModelId));
}

function renderSidebar() {
  const ft = filterText.trim().toLowerCase();
  const cats = data.categories.filter(
    (c) => !ft || c.name.toLowerCase().includes(ft) ||
      c.models.some((m) => m.name.toLowerCase().includes(ft))
  );
  sidebarEmpty.classList.toggle("hidden", cats.length > 0);
  sidebarList.innerHTML = "";

  cats.forEach((cat) => {
    const open = currentCatId === cat.id;
    const catEl = document.createElement("div");
    catEl.className = "cat-item" + (open ? " open" : "");

    const head = document.createElement("div");
    head.className = "cat-head";
    head.innerHTML = `<span class="cat-toggle">▶</span><span class="cat-name"></span>`;
    head.querySelector(".cat-name").textContent = cat.name;
    head.addEventListener("click", (e) => {
      if (e.target.closest(".cat-del")) return;
      currentCatId = (currentCatId === cat.id) ? null : cat.id;
      if (!cat.models.length) currentModelId = null;
      render();
    });
    if (isAdmin) {
      const del = document.createElement("button");
      del.className = "icon-btn cat-del";
      del.title = "删除该分类（含下所有型号与媒体）";
      del.textContent = "🗑";
      del.addEventListener("click", (e) => { e.stopPropagation(); deleteCategory(cat); });
      head.appendChild(del);
    }
    catEl.appendChild(head);

    const models = document.createElement("div");
    models.className = "models";
    cat.models
      .filter((m) => !ft || m.name.toLowerCase().includes(ft))
      .forEach((m) => {
        const mEl = document.createElement("div");
        mEl.className = "model-item" + (currentModelId === m.id ? " active" : "");
        mEl.innerHTML = `<span class="model-name"></span>`;
        mEl.querySelector(".model-name").textContent = m.name;
        mEl.addEventListener("click", () => {
          currentCatId = cat.id;
          currentModelId = m.id;
          render();
          closeDrawer();
        });
        if (isAdmin) {
          const del = document.createElement("button");
          del.className = "icon-btn model-del";
          del.title = "删除该型号（含下所有媒体）";
          del.textContent = "🗑";
          del.addEventListener("click", (e) => { e.stopPropagation(); deleteModel(cat, m); });
          mEl.appendChild(del);
        }
        models.appendChild(mEl);
      });
    catEl.appendChild(models);
    sidebarList.appendChild(catEl);
  });
}

function renderContent() {
  const cat = currentCatId && findCat(currentCatId);
  const model = cat && currentModelId && findModel(cat.id, currentModelId);

  if (!cat) {
    contentPanel.classList.add("hidden");
    contentEmpty.classList.remove("hidden");
    return;
  }
  contentEmpty.classList.add("hidden");
  contentPanel.classList.remove("hidden");
  $("crumbCat").textContent = cat.name;
  $("crumbModel").textContent = model ? model.name : "（未选择型号）";
  $("addModelBtn").classList.toggle("hidden", !isAdmin);

  if (!model) {
    // 已选中分类但还没选型号
    $("uploadBtn").classList.add("hidden");
    $("mediaCount").textContent = "";
    mediaEmpty.classList.add("hidden");
    mediaGrid.innerHTML = "";
    const tip = document.createElement("div");
    tip.className = "empty-hint big";
    tip.innerHTML = `<p>该分类下还没有型号</p>` +
      (isAdmin ? `<p class="sub">点击右上角「＋ 添加型号」开始录入</p>` : `<p class="sub">等待管理员录入型号</p>`);
    // 替换媒体区占位
    mediaGrid.parentNode.insertBefore(tip, mediaGrid);
    const old = mediaGrid.previousElementSibling;
    if (old && old !== tip && old.classList.contains("empty-hint")) old.remove();
    return;
  }
  // 清理可能的占位
  const ph = mediaGrid.previousElementSibling;
  if (ph && ph.classList && ph.classList.contains("empty-hint") && ph !== mediaEmpty) ph.remove();

  $("uploadBtn").classList.toggle("hidden", !isAdmin);

  const media = model.media || [];
  $("mediaCount").textContent = `共 ${media.length} 个文件`;
  mediaEmpty.classList.toggle("hidden", media.length > 0);
  mediaGrid.innerHTML = "";

  media.forEach((item) => {
    const card = document.createElement("div");
    card.className = "media-card";
    const thumb = document.createElement("div");
    thumb.className = "media-thumb";
    if (item.type === "video") {
      const v = document.createElement("video");
      v.src = item.path; v.muted = true; v.playsInline = true; v.preload = "metadata";
      thumb.appendChild(v);
    } else {
      const img = document.createElement("img");
      img.src = item.path; img.loading = "lazy"; img.alt = item.name;
      thumb.appendChild(img);
    }
    card.appendChild(thumb);

    const body = document.createElement("div");
    body.className = "media-body";
    const fname = document.createElement("span");
    fname.className = "media-fname";
    fname.textContent = (item.type === "video" ? "🎬 " : "🖼 ") + item.name;
    body.appendChild(fname);
    card.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "media-actions";
    const dl = document.createElement("a");
    dl.className = "btn dl-btn";
    dl.textContent = "⬇ 下载";
    dl.href = item.path; dl.download = item.name;
    actions.appendChild(dl);
    if (isAdmin) {
      const del = document.createElement("button");
      del.className = "btn btn-danger";
      del.textContent = "🗑 删除";
      del.addEventListener("click", () => deleteMedia(cat, model, item));
      actions.appendChild(del);
    }
    card.appendChild(actions);
    mediaGrid.appendChild(card);
  });
}

// =========================================================
//  管理员操作
// =========================================================
async function addCategory() {
  const name = prompt("请输入新分类名称：");
  if (!name) return;
  data.categories.push({ id: uid(), name: name.trim(), models: [] });
  await saveData(`添加分类：${name}`);
  await loadData();
  toast("分类已添加");
}

async function addModel() {
  const cat = findCat(currentCatId);
  if (!cat) return;
  const name = prompt("请输入新型号名称：");
  if (!name) return;
  cat.models.push({ id: uid(), name: name.trim(), media: [] });
  await saveData(`添加型号：${name}`);
  await loadData();
  toast("型号已添加");
}

async function uploadMedia(files) {
  const cat = findCat(currentCatId);
  const model = cat && findModel(cat.id, currentModelId);
  if (!cat || !model) return;
  for (const file of files) {
    const sizeMB = file.size / 1024 / 1024;
    if (sizeMB > CONFIG.MAX_FILE_MB) {
      toast(`「${file.name}」超过 ${CONFIG.MAX_FILE_MB}MB，已跳过（GitHub API 限制）`, true);
      continue;
    }
    const ext = (file.name.split(".").pop() || "bin").toLowerCase();
    const storeName = `${uid()}.${ext}`;
    const path = `media/${cat.id}/${model.id}/${storeName}`;
    const type = file.type.startsWith("video") ? "video" : "image";
    try {
      const b64 = await fileToBase64(file);
      await putFile(path, b64, `上传 ${file.name} 到 ${model.name}`);
      model.media.push({ id: uid(), name: file.name, type, path });
      toast(`已上传：${file.name}`);
    } catch (e) {
      toast(`上传失败：${file.name} (${e.message})`, true);
    }
  }
  await saveData(`更新媒体索引`);
  await loadData();
}

async function deleteMedia(cat, model, item) {
  if (!confirm(`确定删除「${item.name}」？`)) return;
  try {
    await deleteFile(item.path, `删除媒体：${item.name}`);
    model.media = model.media.filter((m) => m.id !== item.id);
    await saveData(`删除媒体：${item.name}`);
    await loadData();
    toast("已删除");
  } catch (e) { toast("删除失败：" + e.message, true); }
}

async function deleteModel(cat, model) {
  if (!confirm(`确定删除型号「${model.name}」及其下全部图片/视频？`)) return;
  try {
    for (const m of model.media) {
      await deleteFile(m.path, `删除媒体：${m.name}`).catch(() => {});
    }
    cat.models = cat.models.filter((x) => x.id !== model.id);
    if (currentModelId === model.id) currentModelId = null;
    await saveData(`删除型号：${model.name}`);
    await loadData();
    toast("型号已删除");
  } catch (e) { toast("删除失败：" + e.message, true); }
}

async function deleteCategory(cat) {
  const count = cat.models.reduce((s, m) => s + m.media.length, 0) + cat.models.length;
  if (!confirm(`确定删除分类「${cat.name}」？其下 ${cat.models.length} 个型号、${count} 个文件将全部移除。`)) return;
  try {
    for (const m of cat.models) {
      for (const media of m.media) {
        await deleteFile(media.path, `删除媒体：${media.name}`).catch(() => {});
      }
    }
    data.categories = data.categories.filter((c) => c.id !== cat.id);
    if (currentCatId === cat.id) { currentCatId = null; currentModelId = null; }
    await saveData(`删除分类：${cat.name}`);
    await loadData();
    toast("分类已删除");
  } catch (e) { toast("删除失败：" + e.message, true); }
}

// =========================================================
//  管理员登录 / 退出
// =========================================================
function openLogin() {
  $("adminPwd").value = "";
  $("loginErr").textContent = "";
  $("loginModal").classList.remove("hidden");
  $("adminPwd").focus();
}
function closeLogin() { $("loginModal").classList.add("hidden"); }

async function doLogin() {
  if (!GH_TOKEN && !PROXY_URL) {
    $("loginErr").textContent = "站点未配置写操作凭据，无法启用管理功能";
    return;
  }
  const pwd = $("adminPwd").value;
  if (ADMIN_PASSWORD && pwd !== ADMIN_PASSWORD) {
    $("loginErr").textContent = "管理员密码错误";
    return;
  }
  isAdmin = true;
  closeLogin();
  render();
  toast("已进入管理员模式");
}

function doLogout() {
  isAdmin = false;
  render();
  toast("已退出管理员模式");
}

// =========================================================
//  事件绑定
// =========================================================
$("adminBtn").addEventListener("click", openLogin);
$("logoutBtn").addEventListener("click", doLogout);
$("loginCancel").addEventListener("click", closeLogin);
$("loginOk").addEventListener("click", doLogin);
$("addCatBtn").addEventListener("click", addCategory);
$("addModelBtn").addEventListener("click", addModel);
$("uploadBtn").addEventListener("click", () => $("fileInput").click());
$("menuBtn").addEventListener("click", openDrawer);
drawerMask.addEventListener("click", closeDrawer);
fabBtn.addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => {
  if (e.target.files.length) uploadMedia(e.target.files);
  e.target.value = "";
});
$("search").addEventListener("input", (e) => {
  filterText = e.target.value;
  renderSidebar();
});

// 暴露给调试
window.__tire = { CONFIG, loadData };

// =========================================================
//  启动
// =========================================================
loadData();
