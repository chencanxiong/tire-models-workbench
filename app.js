/* =========================================================
   轮胎素材库  (GitHub Pages + GitHub Contents API)
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
// 媒体地址：使用国内可访问的 CDN（jsDelivr）优先，GitHub Pages 与 raw 作为回退。
// 注意：raw.githubusercontent.com 在中国大陆移动网络常被拦截/限速，直连会导致手机端黑屏。
const MEDIA_BASES = [
  "https://cdn.jsdelivr.net/gh/chencanxiong/tire-models-workbench@main/", // 国内可达 CDN，优先
  "https://chencanxiong.github.io/tire-models-workbench/",               // GitHub Pages，回退
  "https://raw.githubusercontent.com/chencanxiong/tire-models-workbench/main/" // 最后兜底
];
function absMediaUrl(path, baseIdx) {
  const p = (path || "").startsWith("http") ? path : MEDIA_BASES[baseIdx || 0] + path;
  return p;
}

// ---------- 运行时状态 ----------
let data = { categories: [] };
let token = GH_TOKEN;   // 写操作凭据：内嵌，免粘贴，自动同步
let isAdmin = false;     // 管理员身份由密码解锁（UI 门禁）
let currentCatId = null;
let currentModelId = null;
let filterText = "";
let dragState = null; // 拖拽排序状态：{ catId, modelId }

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
    catEl.dataset.catId = cat.id;

    const head = document.createElement("div");
    head.className = "cat-head";
    head.innerHTML = `<span class="cat-toggle">▶</span><span class="cat-ico">🏷️</span><span class="cat-name"></span>`;
    head.querySelector(".cat-name").textContent = cat.name;
    head.addEventListener("click", (e) => {
      if (e.target.closest(".cat-del") || e.target.closest(".cat-edit")) return;
      currentCatId = (currentCatId === cat.id) ? null : cat.id;
      if (!cat.models.length) currentModelId = null;
      render();
    });
    if (isAdmin) {
      const edit = document.createElement("button");
      edit.className = "icon-btn cat-edit";
      edit.title = "重命名品牌";
      edit.textContent = "✏️";
      edit.addEventListener("click", (e) => { e.stopPropagation(); renameCategory(cat); });
      head.appendChild(edit);
      const del = document.createElement("button");
      del.className = "icon-btn cat-del";
      del.title = "删除该品牌（含下所有型号与媒体）";
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
        mEl.dataset.modelId = m.id;
        if (isAdmin) {
          mEl.draggable = true;
          mEl.classList.add("draggable");
          const handle = document.createElement("span");
          handle.className = "drag-handle";
          handle.textContent = "⠿";
          handle.title = "拖动调整顺序";
          mEl.appendChild(handle);
        }
        const name = document.createElement("span");
        name.className = "model-name";
        name.textContent = m.name;
        mEl.appendChild(name);
        mEl.addEventListener("click", () => {
          currentCatId = cat.id;
          currentModelId = m.id;
          render();
          closeDrawer();
        });
        if (isAdmin) {
          const edit = document.createElement("button");
          edit.className = "icon-btn model-edit";
          edit.title = "重命名型号";
          edit.textContent = "✏️";
          edit.addEventListener("click", (e) => { e.stopPropagation(); renameModel(cat, m); });
          mEl.appendChild(edit);
          const del = document.createElement("button");
          del.className = "icon-btn model-del";
          del.title = "删除该型号（含下所有媒体）";
          del.textContent = "🗑";
          del.addEventListener("click", (e) => { e.stopPropagation(); deleteModel(cat, m); });
          mEl.appendChild(del);

          // 拖拽排序（仅限同品牌内，避免跨品牌移动导致媒体路径失效）
          mEl.addEventListener("dragstart", (e) => {
            dragState = { catId: cat.id, modelId: m.id };
            mEl.classList.add("dragging");
            try { e.dataTransfer.setData("text/plain", m.id); e.dataTransfer.effectAllowed = "move"; } catch (_) {}
          });
          mEl.addEventListener("dragend", () => {
            mEl.classList.remove("dragging");
            document.querySelectorAll(".model-item.drag-over").forEach((el) => el.classList.remove("drag-over"));
            dragState = null;
          });
          mEl.addEventListener("dragover", (e) => {
            if (!dragState || dragState.catId !== cat.id) return;
            e.preventDefault();
            mEl.classList.add("drag-over");
          });
          mEl.addEventListener("dragleave", () => mEl.classList.remove("drag-over"));
          mEl.addEventListener("drop", (e) => {
            if (!dragState || dragState.catId !== cat.id) return;
            e.preventDefault();
            mEl.classList.remove("drag-over");
            reorderModel(cat, dragState.modelId, m.id);
          });
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

  media.forEach((item, i) => {
    const card = document.createElement("div");
    card.className = "media-card";
    const thumb = document.createElement("div");
    thumb.className = "media-thumb";
    if (item.type === "video") {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "metadata"; v.className = "media-img";
      let vbi = 0;
      v.onerror = function () {
        if (vbi < MEDIA_BASES.length - 1) { vbi++; v.src = absMediaUrl(item.path, vbi); }
      };
      // 强制渲染首帧，避免缩略图黑屏
      v.addEventListener("loadeddata", () => { try { v.currentTime = 0.1; } catch (_) {} });
      v.src = absMediaUrl(item.path, 0);
      thumb.appendChild(v);
    } else {
      const img = document.createElement("img");
      img.loading = "lazy"; img.alt = item.name;
      img.className = "media-img";
      let bi = 0;
      img.onerror = function () {
        if (bi < MEDIA_BASES.length - 1) { bi++; img.src = absMediaUrl(item.path, bi); }
        else { const t = document.createElement("div"); t.className = "load-fail"; t.textContent = "⚠ 同步中，刷新重试"; img.replaceWith(t); }
      };
      img.src = absMediaUrl(item.path, 0);
      thumb.appendChild(img);
    }
    card.appendChild(thumb);
    thumb.style.cursor = "zoom-in";
    thumb.addEventListener("click", () => openLightbox(media, i));

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

// 同品牌内拖动调整型号顺序
async function reorderModel(cat, fromId, toId) {
  if (fromId === toId || !cat) return;
  const fromIdx = cat.models.findIndex((m) => m.id === fromId);
  if (fromIdx < 0) return;
  const [moved] = cat.models.splice(fromIdx, 1);
  const toIdx = cat.models.findIndex((m) => m.id === toId);
  if (toIdx < 0) cat.models.push(moved);
  else cat.models.splice(toIdx, 0, moved);
  await saveData(`调整型号顺序：${cat.name}`);
  await loadData();
  toast("顺序已更新");
}

// 重命名品牌（仅改名称字段，媒体文件夹以 id 为准，不受影响）
async function renameCategory(cat) {
  const name = prompt("修改品牌名称：", cat.name);
  if (name === null) return;
  const t = name.trim();
  if (!t || t === cat.name) return;
  cat.name = t;
  await saveData(`重命名品牌为：${t}`);
  await loadData();
  toast("品牌已重命名");
}

// 重命名型号（仅改名称字段，媒体文件夹以 id 为准，不受影响）
async function renameModel(cat, model) {
  const name = prompt("修改型号名称：", model.name);
  if (name === null) return;
  const t = name.trim();
  if (!t || t === model.name) return;
  model.name = t;
  await saveData(`重命名型号为：${t}`);
  await loadData();
  toast("型号已重命名");
}

// ---------- 批量上传（弹窗 + 拖拽 + 进度） ----------
let pendingFiles = [];

function openUpload() {
  if (!isAdmin) return;
  const cat = currentCatId && findCat(currentCatId);
  const model = cat && currentModelId && findModel(cat.id, currentModelId);
  if (!model) { toast("请先在左侧选择一个型号", true); return; }
  $("progressWrap").classList.add("hidden");
  renderUploadList();
  $("uploadModal").classList.remove("hidden");
  pushOverlay("upload");
}

function hideUploadModal() {
  $("uploadModal").classList.add("hidden");
  pendingFiles = [];
  $("progressWrap").classList.add("hidden");
  renderUploadList();
}

function closeUpload() {
  // 若已压入历史，走 history.back()，让手机返回键也能关闭弹窗
  if (historyTag === "upload") popOverlay();
  else hideUploadModal();
}

function addFiles(fileList) {
  const ok = [];
  for (const f of fileList) {
    if (!f.type.startsWith("image") && !f.type.startsWith("video")) {
      toast(`「${f.name}」不是图片或视频，已跳过`, true); continue;
    }
    if (f.size / 1024 / 1024 > CONFIG.MAX_FILE_MB) {
      toast(`「${f.name}」超过 ${CONFIG.MAX_FILE_MB}MB，已跳过`, true); continue;
    }
    if (pendingFiles.some((p) => p.name === f.name && p.size === f.size)) continue;
    ok.push(f);
  }
  if (ok.length) pendingFiles.push(...ok);
  renderUploadList();
}

function renderUploadList() {
  const list = $("uploadList");
  list.innerHTML = "";
  pendingFiles.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "upload-row";
    const isVid = f.type.startsWith("video");
    const sizeKB = (f.size / 1024).toFixed(0);
    row.innerHTML =
      `<span class="up-ico">${isVid ? "🎬" : "🖼"}</span>` +
      `<span class="up-name"></span>` +
      `<span class="up-size">${sizeKB} KB</span>` +
      `<button class="up-del" title="移除">✕</button>`;
    row.querySelector(".up-name").textContent = f.name;
    row.querySelector(".up-del").addEventListener("click", () => {
      pendingFiles.splice(i, 1);
      renderUploadList();
    });
    list.appendChild(row);
  });
  $("uploadAllBtn").textContent = `上传 ${pendingFiles.length} 个文件`;
  $("uploadAllBtn").disabled = pendingFiles.length === 0;
}

// ---------- 视频转码（ffmpeg.wasm 单线程核心，无需 COOP/COEP 响应头） ----------
// 作用：把手机上传的 HEVC/.mov 等浏览器不友好格式，在浏览器内转为通用 H.264 MP4，
// 存到仓库后任何手机/电脑都能直接播放。组件从 jsDelivr 按需懒加载，失败时回退原样上传。
let _ffmpeg = null;
let _ffmpegLoading = null;

async function loadFFmpeg() {
  if (_ffmpeg) return _ffmpeg;
  if (_ffmpegLoading) return _ffmpegLoading;
  _ffmpegLoading = (async () => {
    const { createFFmpeg, fetchFile } = await import("https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/+esm");
    const ff = createFFmpeg({
      corePath: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js",
      log: false,
      progress: (ratio) => {
        const p = Math.max(0, Math.min(100, Math.round((ratio || 0) * 100)));
        const el = $("uploadStatus");
        if (el && el.dataset.busy === "1") el.textContent = `正在转换视频… ${p}%`;
      }
    });
    await ff.load();
    ff._fetchFile = fetchFile;
    _ffmpeg = ff;
    return ff;
  })();
  return _ffmpegLoading;
}

// 判断是否需要转码：视频、文件不太大（避免手机内存不足）、且不是标准 H.264 mp4
function needsTranscode(file) {
  if (!file.type.startsWith("video")) return false;
  if (file.size > 150 * 1024 * 1024) return false; // 过大则跳过转码，直接原样上传
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "mp4" && file.type === "video/mp4") return false; // 假定为标准 H.264 MP4
  return true;
}

async function transcodeVideoToMp4(file) {
  const ff = await loadFFmpeg();
  const inName = "in_" + Date.now() + ".tmp";
  const outName = "out.mp4";
  ff.FS("writeFile", inName, await ff._fetchFile(file));
  await ff.run(
    "-i", inName,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outName
  );
  const data = ff.FS("readFile", outName);
  ff.FS("unlink", inName); ff.FS("unlink", outName);
  const base = file.name.replace(/\.[^.]+$/, "");
  return new File([data.buffer], base + ".mp4", { type: "video/mp4" });
}

async function uploadAll() {
  if (!pendingFiles.length) return;
  const cat = findCat(currentCatId);
  const model = cat && findModel(cat.id, currentModelId);
  if (!cat || !model) return;
  $("uploadAllBtn").disabled = true;
  $("progressWrap").classList.remove("hidden");
  const total = pendingFiles.length;
  let done = 0;
  for (const file of pendingFiles) {
    let uploadFile = file;
    // 视频：先在浏览器内转为通用 H.264 MP4，确保手机/电脑都能播放
    if (needsTranscode(file)) {
      const st = $("uploadStatus");
      try {
        st.dataset.busy = "1";
        st.textContent = `正在转换视频「${file.name}」为通用格式…（首次需加载组件，请稍候）`;
        uploadFile = await transcodeVideoToMp4(file);
        st.textContent = `已转换：${file.name} → ${uploadFile.name}`;
      } catch (e) {
        toast(`视频转换失败，将按原格式上传：${file.name}`, true);
        uploadFile = file;
      } finally {
        st.dataset.busy = "0";
      }
    }
    const ext = (uploadFile.name.split(".").pop() || "bin").toLowerCase();
    const storeName = `${uid()}.${ext}`;
    const path = `media/${cat.id}/${model.id}/${storeName}`;
    const type = uploadFile.type.startsWith("video") ? "video" : "image";
    try {
      const b64 = await fileToBase64(uploadFile);
      await putFile(path, b64, `上传 ${uploadFile.name} 到 ${model.name}`);
      model.media.push({ id: uid(), name: file.name, type, path });
    } catch (e) {
      toast(`上传失败：${file.name} (${e.message})`, true);
    }
    done++;
    $("progressFill").style.width = Math.round((done / total) * 100) + "%";
    $("progressText").textContent = `${done} / ${total}`;
  }
  await saveData(`批量上传 ${total} 个文件到 ${model.name}`);
  await loadData();
  toast(`已上传 ${done} 个文件，正在同步到云端，稍候刷新即可查看`);
  pendingFiles = [];
  $("progressWrap").classList.add("hidden");
  closeUpload();
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
//  覆盖层历史栈：让手机「返回」键/手势先关闭弹层，而不是退出网址
// =========================================================
let historyTag = null;
function pushOverlay(tag) {
  if (historyTag !== null) return;
  try { history.pushState({ overlay: tag }, ""); } catch (_) {}
  historyTag = tag;
}
function popOverlay() {
  if (historyTag === null) return;
  historyTag = null;
  history.back();
}
window.addEventListener("popstate", () => {
  const t = historyTag;
  historyTag = null;
  if (t === "lightbox") hideLightbox();
  else if (t === "upload") closeUpload();
});

// =========================================================
//  灯箱：大图 / 视频查看 + 缩放 / 平移 / 捏合 / 切换 / 旋转
// =========================================================
let lbScale = 1, lbX = 0, lbY = 0, lbRot = 0;
let lbPanning = false, lbStartX = 0, lbStartY = 0, lbBaseX = 0, lbBaseY = 0;
let lbPointers = [];
let lbPinchDist = 0, lbPinchScale = 1;
let lbList = [], lbIndex = 0;
let lbSwipeX = 0, lbSwipeY = 0, lbJustSwiped = false;

function openLightbox(list, index) {
  lbList = Array.isArray(list) && list.length ? list : [];
  lbIndex = Number.isInteger(index) ? index : 0;
  showLbItem();
  pushOverlay("lightbox");
}

function showLbItem() {
  const item = lbList[lbIndex];
  if (!item) { hideLightbox(); return; }
  lbScale = 1; lbX = 0; lbY = 0; lbRot = 0;
  const img = $("lightboxImg");
  const video = $("lightboxVideo");
  $("lbLoading").classList.add("hidden");
  $("lbError").classList.add("hidden");
  if (item.type === "video") {
    img.classList.add("hidden");
    video.classList.remove("hidden");
    video.preload = "auto";
    video.muted = true; // 移动端仅允许静音自动播放，用户可用控件取消静音
    $("lbLoading").classList.remove("hidden");
    $("lbError").classList.add("hidden");
    // 移动端禁止非静音自动播放：先静音自动播放首帧，用户可用控件暂停/取消静音
    let vbi = 0;
    video.onerror = function () {
      if (vbi < MEDIA_BASES.length - 1) { vbi++; video.src = absMediaUrl(item.path, vbi); }
      else {
        $("lbLoading").classList.add("hidden");
        $("lbError").textContent = "⚠ 视频无法播放：可能是文件过大或格式特殊。新上传的视频已自动转为通用格式；若此文件仍无法播放，请在电脑端浏览器查看或重新上传。";
        $("lbError").classList.remove("hidden");
      }
    };
    video.addEventListener("loadeddata", () => {
      try { video.currentTime = 0.1; } catch (_) {}
      $("lbLoading").classList.add("hidden");
      video.play && video.play().catch(() => {});
    }, { once: true });
    video.src = absMediaUrl(item.path, 0);
  } else {
    video.pause && video.pause();
    video.removeAttribute("src");
    video.classList.add("hidden");
    img.classList.remove("hidden");
    img.removeAttribute("data-tried-pages");
    let bi = 0;
    img.onload = () => { $("lbLoading").classList.add("hidden"); };
    img.onerror = () => {
      if (bi < MEDIA_BASES.length - 1) { bi++; img.src = absMediaUrl(item.path, bi); }
      else { $("lbLoading").classList.add("hidden"); $("lbError").classList.remove("hidden"); }
    };
    $("lbLoading").classList.remove("hidden");
    img.src = absMediaUrl(item.path, 0);
  }
  $("lightbox").classList.remove("hidden");
  $("lightboxTitle").textContent = (item.type === "video" ? "🎬 " : "🖼 ") + item.name;
  const multi = lbList.length > 1;
  $("lightboxCounter").textContent = multi ? `${lbIndex + 1} / ${lbList.length}` : "";
  $("prevBtn").classList.toggle("hidden", !multi);
  $("nextBtn").classList.toggle("hidden", !multi);
  applyLbTransform();
}

// 切换：delta = -1 上一张，1 下一张（循环）
function lbStep(delta) {
  if (lbList.length < 2) return;
  lbIndex = (lbIndex + delta + lbList.length) % lbList.length;
  showLbItem();
}

function hideLightbox() {
  $("lightbox").classList.add("hidden");
  const v = $("lightboxVideo");
  v.pause && v.pause();
  v.removeAttribute("src");
  v.load && v.load();
  lbPointers = [];
  lbPanning = false;
}
function closeLightbox() {
  // 若已压入历史，走 history.back() 让返回栈回退（手机返回键也能关闭）
  if (historyTag === "lightbox") popOverlay();
  else hideLightbox();
}

function lbEl() {
  return $("lightboxImg").classList.contains("hidden") ? $("lightboxVideo") : $("lightboxImg");
}
function applyLbTransform() {
  const el = lbEl();
  el.style.transform = `translate(${lbX}px, ${lbY}px) scale(${lbScale}) rotate(${lbRot}deg)`;
  $("zoomLabel").textContent = Math.round(lbScale * 100) + "%";
}
function setLbScale(s) {
  lbScale = Math.min(8, Math.max(1, s));
  if (lbScale === 1) { lbX = 0; lbY = 0; }
  applyLbTransform();
}
function rotateLb(deg) {
  lbRot = (lbRot + deg) % 360;
  applyLbTransform();
}

(function bindLightbox() {
  const stage = $("lightboxStage");
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  stage.addEventListener("pointerdown", (e) => {
    lbJustSwiped = false;
    lbPointers.push(e);
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    if (lbPointers.length === 1) {
      lbSwipeX = e.clientX; lbSwipeY = e.clientY;
      if (lbScale > 1) {
        lbPanning = true; lbStartX = e.clientX; lbStartY = e.clientY; lbBaseX = lbX; lbBaseY = lbY;
      }
    } else if (lbPointers.length === 2) {
      lbPanning = false;
      lbPinchDist = dist(lbPointers[0], lbPointers[1]);
      lbPinchScale = lbScale;
    }
  });
  stage.addEventListener("pointermove", (e) => {
    lbPointers = lbPointers.map((p) => (p.pointerId === e.pointerId ? e : p));
    if (lbPanning && lbPointers.length === 1) {
      lbX = lbBaseX + (e.clientX - lbStartX);
      lbY = lbBaseY + (e.clientY - lbStartY);
      applyLbTransform();
    } else if (lbPointers.length === 2) {
      const d = dist(lbPointers[0], lbPointers[1]);
      if (lbPinchDist > 0) setLbScale(lbPinchScale * (d / lbPinchDist));
    }
  });
  const endPtr = (e) => {
    const wasSingle = lbPointers.length === 1;
    lbPointers = lbPointers.filter((p) => p.pointerId !== e.pointerId);
    if (lbPointers.length > 0) { lbPanning = false; return; }
    // 未放大时：左右滑动 → 上一张 / 下一张
    if (wasSingle && !lbPanning && lbScale === 1) {
      const dx = e.clientX - lbSwipeX;
      const dy = e.clientY - lbSwipeY;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        lbJustSwiped = true;
        lbStep(dx < 0 ? 1 : -1);
        lbPanning = false;
        return;
      }
    }
    lbPanning = false;
  };
  stage.addEventListener("pointerup", endPtr);
  stage.addEventListener("pointercancel", endPtr);

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    setLbScale(lbScale + (e.deltaY < 0 ? 0.25 : -0.25));
  }, { passive: false });

  // 点击空白处（未缩放时）关闭；滑动切换后不误判为点击
  stage.addEventListener("click", (e) => {
    if (lbJustSwiped) { lbJustSwiped = false; return; }
    if (e.target === stage && !lbPanning && lbScale === 1) closeLightbox();
  });

  $("zoomInBtn").addEventListener("click", () => setLbScale(lbScale + 0.5));
  $("zoomOutBtn").addEventListener("click", () => setLbScale(lbScale - 0.5));
  $("zoomResetBtn").addEventListener("click", () => setLbScale(1));
  $("rotateLeftBtn").addEventListener("click", () => rotateLb(-90));
  $("rotateRightBtn").addEventListener("click", () => rotateLb(90));
  $("prevBtn").addEventListener("click", () => lbStep(-1));
  $("nextBtn").addEventListener("click", () => lbStep(1));
  // 切换按钮的按下不要被当成滑动手势
  ["prevBtn", "nextBtn"].forEach((id) =>
    $(id).addEventListener("pointerdown", (e) => e.stopPropagation())
  );
  $("lightboxClose").addEventListener("click", closeLightbox);
  $("lightbox").addEventListener("click", (e) => {
    if (lbJustSwiped) { lbJustSwiped = false; return; }
    if (e.target === $("lightbox") && lbScale === 1) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if ($("lightbox").classList.contains("hidden")) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") lbStep(-1);
    else if (e.key === "ArrowRight") lbStep(1);
    else if (e.key === "+" || e.key === "=") setLbScale(lbScale + 0.5);
    else if (e.key === "-") setLbScale(lbScale - 0.5);
    else if (e.key === "0") setLbScale(1);
    else if (e.key === "r" || e.key === "R") rotateLb(90);
  });
})();

// =========================================================
//  事件绑定
// =========================================================
$("adminBtn").addEventListener("click", openLogin);
$("logoutBtn").addEventListener("click", doLogout);
$("loginCancel").addEventListener("click", closeLogin);
$("loginOk").addEventListener("click", doLogin);
$("addCatBtn").addEventListener("click", addCategory);
$("addModelBtn").addEventListener("click", addModel);
$("uploadBtn").addEventListener("click", openUpload);
$("menuBtn").addEventListener("click", openDrawer);
drawerMask.addEventListener("click", closeDrawer);
fabBtn.addEventListener("click", openUpload);
$("pickBtn").addEventListener("click", () => $("fileInput").click());
$("uploadCancel").addEventListener("click", closeUpload);
$("uploadAllBtn").addEventListener("click", uploadAll);
$("fileInput").addEventListener("change", (e) => {
  if (e.target.files.length) addFiles(e.target.files);
  e.target.value = "";
});
// 拖拽上传
["dragenter", "dragover"].forEach((ev) =>
  $("dropZone").addEventListener(ev, (e) => { e.preventDefault(); $("dropZone").classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  $("dropZone").addEventListener(ev, (e) => { e.preventDefault(); $("dropZone").classList.remove("dragover"); })
);
$("dropZone").addEventListener("drop", (e) => {
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
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
