/* 紫微斗数 · 智能推演 — 前端逻辑（原生 JS，无框架依赖）
 * 两屏结构：#/ 信息页（填写出生信息） → #/chart 排盘 + 推演（hash 路由跳转）
 * 交互：本命/大限/流年三视图，宫位点选联动三方四正，大限/流年时间轴，流年步进
 */
"use strict";

const S = {
  calendar: "solar",
  gender: "男",
  timeIndex: 0,
  chart: null,
  chartId: null,
  mode: "natal",          // natal | decade | year
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  decade: null,           // {palaceIdx, range:[a,b], startYear, endYear}
  horoCache: {},          // "year-month" -> horoscope
  sel: null,              // 选中宫位的地支索引 0-11
  busy: false,
  history: [],
  profile: null,          // {id, token, name} 登录档案（可选）
};

const $ = (sel) => document.querySelector(sel);
const BRANCH = ["寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥", "子", "丑"];
const MUT_CLASS = { 禄: "mut-lu", 权: "mut-quan", 科: "mut-ke", 忌: "mut-ji" };
// 十二宫简称（运限标签用）
const P_ABBR = { 命宫: "命", 兄弟: "兄", 夫妻: "夫", 子女: "子", 财帛: "财", 疾厄: "疾", 迁移: "迁", 仆役: "仆", 官禄: "官", 田宅: "田", 福德: "福", 父母: "父" };
// 天干五行（四柱干支着色）+ 五行色 class
const STEM_ELEM = { 甲: "木", 乙: "木", 丙: "火", 丁: "火", 戊: "土", 己: "土", 庚: "金", 辛: "金", 壬: "水", 癸: "水" };
const ELEM_CLS = { 木: "wx-mu", 火: "wx-huo", 土: "wx-tu", 金: "wx-jin", 水: "wx-shui" };
// 十三时辰选项（早子/晚子拆分）
const HOURS = [
  { v: 0, n: "早子", r: "00:00–01:00" },
  { v: 1, n: "丑", r: "01:00–03:00" },
  { v: 2, n: "寅", r: "03:00–05:00" },
  { v: 3, n: "卯", r: "05:00–07:00" },
  { v: 4, n: "辰", r: "07:00–09:00" },
  { v: 5, n: "巳", r: "09:00–11:00" },
  { v: 6, n: "午", r: "11:00–13:00" },
  { v: 7, n: "未", r: "13:00–15:00" },
  { v: 8, n: "申", r: "15:00–17:00" },
  { v: 9, n: "酉", r: "17:00–19:00" },
  { v: 10, n: "戌", r: "19:00–21:00" },
  { v: 11, n: "亥", r: "21:00–23:00" },
  { v: 12, n: "晚子", r: "23:00–24:00" },
];
// 4x4 网格槽位 → 地支索引（-1 为中宫，slot 5 是跨格中宫面板）
const SLOT_BRANCH = [3, 4, 5, 6, 2, -1, -1, 7, 1, -1, -1, 8, 0, 11, 10, 9];

const byIdx = () => Object.fromEntries((S.chart?.palaces || []).map((p) => [p.index, p]));
const horoKey = (y, m) => `${y}-${m}`;
const birthYear = () => parseInt((S.chart?.solarDate || "0").split("-")[0], 10) || 0;
const ZODIAC = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];
const zodiacOf = (y) => ZODIAC[((y - 4) % 12 + 12) % 12];

/* ---------------- 主题切换 ---------------- */
const themeBtn = $("#btn-theme");
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("zw-theme", t); } catch (_) {}
}
themeBtn.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

/* 被门户 iframe 内嵌时打标记：皮肤据此隐藏自带顶栏，让命盘占满容器 */
if (window.parent !== window) document.documentElement.classList.add("zw-embed");

/* ---------------- hash 路由：首页（登录/注册面板） ⇄ 总览页 ⇄ 排盘页 ---------------- */
function parseHashQuery() {
  const h = location.hash || "";
  const qi = h.indexOf("?");
  if (qi < 0) return {};
  return Object.fromEntries(new URLSearchParams(h.slice(qi + 1)));
}

function showAuthPanel(name) {
  for (const p of ["#panel-home", "#panel-register", "#panel-login", "#panel-admin", "#panel-settings"]) $(p).classList.toggle("hidden", !name.includes(p));
}

function route() {
  const h = location.hash || "#/";
  const show = (id, on) => $(id).classList.toggle("hidden", !on);
  const only = (id) => {
    for (const v of ["#view-login", "#view-overview", "#view-chart"]) show(v, v === id);
  };
  // 门户内嵌：URL 带出生信息时先排盘再渲染，期间停在本视图，不跳登录页（避免登录页闪现）
  if (h.startsWith("#/chart") && !S.chart && window.parent !== window) {
    const qp = parseHashQuery();
    if (qp.date) {
      only("#view-chart");
      window.chartFromPortal({
        date: qp.date, timeIndex: +(qp.timeIndex ?? 6),
        gender: qp.gender || "男", calendar: qp.calendar || "solar",
      });
      return;
    }
  }
  // 总览/命盘：未排盘时——登录用户可直接排；未登录一律回登录页
  const needChart = () => {
    if (S.chart) return true;
    if (S.profile) { chartFromProfile(); return false; }
    setAuthError("请先登录后再打开命盘");
    location.hash = "#/login";
    return false;
  };
  if (h.startsWith("#/chart")) {
    if (!needChart()) return;
    only("#view-chart");
    renderChart(true); renderDetail(); renderTimeline();
    window.scrollTo({ top: 0 });
  } else if (h.startsWith("#/overview")) {
    if (!needChart()) return;
    only("#view-overview");
    renderOverview();
    window.scrollTo({ top: 0 });
  } else if (h.startsWith("#/settings")) {
    only("#view-login");
    if (!S.profile) { location.hash = "#/login"; return; }
    showAuthPanel("#panel-settings");
    loadSettings();
    window.scrollTo({ top: 0 });
  } else if (h.startsWith("#/register")) {
    only("#view-login");
    if (S.profile) { location.hash = "#/overview"; return; }   // 已登录不进注册页
    clearRegisterForm();
    showAuthPanel("#panel-register");
    window.scrollTo({ top: 0 });
  } else if (h.startsWith("#/admin")) {
    only("#view-login");
    showAuthPanel("#panel-admin");
    adminTryResume();
    window.scrollTo({ top: 0 });
  } else if (h.startsWith("#/login")) {
    only("#view-login");
    if (S.profile) { location.hash = "#/"; return; }   // 已登录不需要再登录
    showAuthPanel("#panel-login");
    window.scrollTo({ top: 0 });
  } else {
    only("#view-login");
    showAuthPanel(S.profile ? "#panel-login" : "#panel-home");
    window.scrollTo({ top: 0 });
  }
}
window.addEventListener("hashchange", route);
const goChart = () => { location.hash = "#/chart"; };
const goOverview = () => { location.hash = "#/overview"; };
const goLogin = () => { location.hash = "#/"; };

function setAuthError(msg, loginPage = false) {
  const el = $(loginPage ? "#login-error" : "#form-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function hideAuthError() {
  $("#form-error").classList.add("hidden");
  $("#login-error").classList.add("hidden");
}
/* 注册表单清空：避免上次注册的内容残留到下一次 */
function clearRegisterForm() {
  $("#auth-name").value = "";
  $("#auth-pass").value = "";
  $("#auth-pass2").value = "";
  $("#pass-hint").textContent = "";
  $("#pass-hint").className = "pass-hint";
  $("#auth-pass2").classList.remove("err", "good");
  hideAuthError();
}

/* ---------------- 排盘执行（登录档案驱动） ---------------- */
async function chartFromProfile() {
  const errEl = $("#login-error");
  errEl.classList.add("hidden");
  try {
    // 拉档案出生信息
    const pr = await fetch(`/api/profile/get?id=${S.profile.id}&token=${S.profile.token}`);
    const pj = await pr.json();
    if (!pj.ok) throw new Error(pj.error || "档案读取失败，请重新登录");
    const b = pj.profile.birth || {};
    if (!b.date) throw new Error("档案缺少出生信息，请重新注册");
    const params = new URLSearchParams({
      date: b.date, timeIndex: b.timeIndex ?? 0,
      gender: b.gender || "男", calendar: b.calendar || "solar", fixLeap: "true",
      profile_id: S.profile.id, token: S.profile.token,
    });
    const res = await fetch(`/api/chart?${params}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "排盘失败");
    S.chart = data.chart;
    S.chartId = data.id;
    S.history = []; S.horoCache = {}; S.sel = null; S.decade = null;
    await initTodayView();
    $("#chat").innerHTML = "";
    renderProfileChip();
    restoreProfileChat();
    // 登录链路同样启用对话输入（HTML 初始 disabled，注册链路有启用、此前登录链路漏了）
    $("#question").disabled = false;
    $("#btn-ask").disabled = false;
    if (!location.hash || location.hash === "#/" || location.hash.startsWith("#/login") || location.hash.startsWith("#/register")) {
      location.hash = "#/overview";
    } else {
      route();
    }
  } catch (e) {
    errEl.textContent = e.message || "排盘失败";
    errEl.classList.remove("hidden");
    if (!location.hash.startsWith("#/login")) location.hash = "#/login";
  }
}

/* ---------------- 控件绑定 ---------------- */
function bindSeg(id, key, after) {
  $(id).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    [...$(id).children].forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    S[key] = btn.dataset.v;
    if (after) after();
  });
}
bindSeg("#gender-seg", "gender");

/* 时辰下拉选择栏（含时间范围提示） */
function renderHours() {
  $("#hour-select").innerHTML = HOURS.map((h) => {
    const label = h.n.endsWith("子") ? `${h.n}时` : `${h.n}时`;
    return `<option value="${h.v}"${h.v === S.timeIndex ? " selected" : ""}>${label} · ${h.r}</option>`;
  }).join("");
}
function syncHours() {
  $("#hour-select").value = String(S.timeIndex);
}
$("#hour-select").addEventListener("change", (e) => {
  S.timeIndex = parseInt(e.target.value, 10);
});
renderHours();

/* ---------------- 出生日期三列选择（年/月/日，移动端可直接选年份） ---------------- */
function fillSel(sel, values, placeholder) {
  sel.innerHTML = `<option value="" disabled selected>${placeholder}</option>` +
    values.map((v) => `<option value="${v}">${v}</option>`).join("");
}
function renderBirthSelects() {
  const ySel = $("#birth-year");
  if (!ySel.options.length) {
    const nowY = new Date().getFullYear();
    const years = [];
    for (let y = nowY; y >= 1900; y--) years.push(y);
    fillSel(ySel, years, "出生年");
  }
  const mSel = $("#birth-month");
  const curM = mSel.value;
  fillSel(mSel, Array.from({ length: 12 }, (_, i) => i + 1), "月");
  if (curM) mSel.value = curM;
  // 日数随年月联动（含闰年）
  const dSel = $("#birth-day");
  const curD = dSel.value;
  const y = parseInt(ySel.value, 10) || 2000;
  const m = parseInt(mSel.value, 10) || 1;
  const days = new Date(y, m, 0).getDate();
  fillSel(dSel, Array.from({ length: days }, (_, i) => i + 1), "日");
  if (curD && parseInt(curD, 10) <= days) dSel.value = curD;
}
$("#birth-year").addEventListener("change", renderBirthSelects);
$("#birth-month").addEventListener("change", renderBirthSelects);
renderBirthSelects();

function selectedDateStr() {
  const y = $("#birth-year").value, m = $("#birth-month").value, d = $("#birth-day").value;
  if (!y || !m || !d) return "";
  return `${y}-${parseInt(m, 10)}-${parseInt(d, 10)}`;
}

/* ---------------- 用户档案（强制注册制：注册=账号+出生信息，登录=仅账号） ----------------
 * 注册：注册即自动登录并排盘；登录：直接用档案出生信息排盘，跳过表单
 * 登录态下问答自动落盘并定期压缩为长期摘要
 */
function currentBirthPayload() {
  const dateStr = selectedDateStr();
  if (!dateStr) return null;
  return { date: dateStr, timeIndex: S.timeIndex, gender: S.gender, calendar: S.calendar };
}
function renderProfileChip() {
  for (const id of ["#profile-chip", "#profile-chip-ov"]) {
    const el = $(id);
    if (S.profile) {
      el.innerHTML = `${S.profile.name} <i>⚙</i>`;
      el.title = "我的档案";
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }
}
async function doRegister() {
  const errEl = $("#form-error");
  errEl.classList.add("hidden");
  const name = $("#auth-name").value.trim();
  const pass = $("#auth-pass").value;
  const pass2 = $("#auth-pass2").value;
  const birth = currentBirthPayload();
  const fail = (msg) => { errEl.textContent = msg; errEl.classList.remove("hidden"); };
  if (!/^[A-Za-z0-9_]{2,24}$/.test(name)) return fail("用户名仅支持 2~24 位字母、数字或下划线");
  if (pass.length < 6) return fail("密码至少 6 位");
  if (pass !== pass2) return fail("两次输入的密码不一致");
  if (!birth) return fail("请选好完整的出生年月日（将作为档案出生信息）");
  const btn = $("#btn-register");
  btn.disabled = true; btn.textContent = "创建档案并排盘中…";
  try {
    const res = await fetch("/api/profile/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password: pass, birth }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "注册失败");
    S.profile = { id: data.profile_id, token: data.token, name: data.name };
    persistSession();   // 同步登录态到门户（全站通用）
    // 注册成功 → 立即用注册的出生信息排盘
    const params = new URLSearchParams({
      date: birth.date, timeIndex: birth.timeIndex, gender: birth.gender,
      calendar: birth.calendar, fixLeap: "true",
      profile_id: S.profile.id, token: S.profile.token,
    });
    const cr = await fetch(`/api/chart?${params}`);
    const cd = await cr.json();
    if (!cd.ok) throw new Error(cd.error || "排盘失败");
    S.chart = cd.chart;
    S.chartId = cd.id;
    S.history = []; S.horoCache = {}; S.sel = null; S.decade = null;
    clearRegisterForm();
    await initTodayView();
    $("#chat").innerHTML = "";
    renderProfileChip();
    $("#question").disabled = false;
    $("#btn-ask").disabled = false;
    location.hash = "#/overview";
  } catch (e) {
    fail(e.message || "网络异常，请重试");
  } finally {
    btn.disabled = false; btn.textContent = "注册并排出命盘";
  }
}
async function doLogin() {
  const errEl = $("#login-error");
  errEl.classList.add("hidden");
  const name = $("#login-name").value.trim();
  const pass = $("#login-pass").value;
  const fail = (msg) => { errEl.textContent = msg; errEl.classList.remove("hidden"); };
  if (!name || !pass) return fail("请填写用户名与密码");
  const btn = $("#btn-login");
  btn.disabled = true; btn.textContent = "登录中…";
  try {
    const res = await fetch("/api/profile/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password: pass }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "登录失败");
    S.profile = { id: data.profile_id, token: data.token, name: data.name };
    persistSession();   // 同步登录态到门户（全站通用）
    renderProfileChip();
    // 直接用档案出生信息排盘，跳过任何表单
    await chartFromProfile();
  } catch (e) {
    fail(e.message || "网络异常，请重试");
  } finally {
    btn.disabled = false; btn.textContent = "登录并进入命盘";
  }
}
function doLogout() {
  S.profile = null;
  S.chart = null;
  S.chartId = null;
  S.history = [];
  S.horoCache = {};
  renderProfileChip();
  persistSession();
  location.hash = "#/";
}

/* ---------------- 全站会话桥：与门户共享 localStorage["zw-profile"] ----------------
   门户与本服务同源；登录态以 zw-profile 为唯一真相。门户登录/退出会写该键，
   本服务通过 storage 事件实时跟随；本服务内登录/退出也回写该键，反向同步到门户。 */
const SESSION_KEY = "zw-profile";
function persistSession() {
  try {
    if (S.profile) localStorage.setItem(SESSION_KEY, JSON.stringify(S.profile));
    else localStorage.removeItem(SESSION_KEY);
  } catch (_) {}
}
function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return (p && p.id && p.token) ? { id: p.id, token: p.token, name: p.name } : null;
  } catch (_) { return null; }
}

// 供门户（父页面）在 iframe 内嵌场景下主动同步会话并自动排盘（同源）
function syncSessionFromPortal(p) {
  const next = p && p.id && p.token ? { id: p.id, token: p.token, name: p.name } : null;
  if (JSON.stringify(next) === JSON.stringify(S.profile)) return;   // 无变化
  S.profile = next;
  if (next) {
    persistSession();
    renderProfileChip();
    chartFromProfile();
  } else {
    S.chart = null; S.chartId = null;
    renderProfileChip();
    persistSession();
    if (location.hash.startsWith("#/chart") || location.hash.startsWith("#/overview") || location.hash.startsWith("#/settings")) {
      location.hash = "#/";
    }
  }
}

// 门户紫微页：未登录用户以出生信息直接排盘（不建档案）；排盘失败回传父页面
window.chartFromPortal = async function (b) {
  const params = new URLSearchParams({
    date: b.date, timeIndex: b.timeIndex ?? 6,
    gender: b.gender || "男", calendar: b.calendar || "solar", fixLeap: "true",
  });
  try {
    const res = await fetch(`/api/chart?${params}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "排盘失败");
    S.chart = data.chart;
    S.chartId = data.id;
    S.history = []; S.horoCache = {}; S.sel = null; S.decade = null;
    await initTodayView();
    $("#chat").innerHTML = "";
    renderProfileChip();
    // 未登录同样开放对话输入（AI 解读按命盘个性化，档案维度降级）
    $("#question").disabled = false;
    $("#btn-ask").disabled = false;
    if (location.hash.startsWith("#/chart")) route(); else location.hash = "#/chart";
    // 通知门户：命盘已就绪，可撤掉"正在起盘…"
    try { window.parent.postMessage({ type: "zw-chart-ready" }, "*"); } catch (_) {}
  } catch (e) {
    console.error("chartFromPortal:", e);
    try { window.parent.postMessage({ type: "zw-chart-error", message: e.message || "排盘失败" }, "*"); } catch (_) {}
  }
};
// 门户侧登录/退出触发的 storage 事件（写入方自身不触发，故不会自激）
window.addEventListener("storage", (e) => {
  if (e.key !== SESSION_KEY) return;
  const p = restoreSession();
  const changed = JSON.stringify(p) !== JSON.stringify(S.profile);
  if (!changed) return;
  S.profile = p;
  if (p) {
    renderProfileChip();
    chartFromProfile();          // 用档案出生信息自动排盘（档案结构由后端规范化）
  } else {
    S.chart = null; S.chartId = null;
    renderProfileChip();
    if (location.hash.startsWith("#/chart") || location.hash.startsWith("#/overview")) location.hash = "#/";
  }
});

/* ---------------- 数据管理（管理员：仅用户名与注册时间，不见个人资料） ---------------- */
const adminKey = () => { try { return sessionStorage.getItem("zw-admin") || ""; } catch (_) { return ""; } };
function adminShowGate(msg) {
  $("#admin-gate").classList.remove("hidden");
  $("#admin-body").classList.add("hidden");
  const err = $("#admin-error");
  if (msg) { err.textContent = msg; err.classList.remove("hidden"); } else err.classList.add("hidden");
}
async function adminLoad() {
  try {
    const res = await fetch("/api/admin/list", { headers: { "X-Admin-Key": adminKey() } });
    if (res.status === 401) { adminShowGate("管理员密码不正确"); return; }
    const data = await res.json();
    if (!data.ok) { adminShowGate(data.error || "读取失败"); return; }
    $("#admin-gate").classList.add("hidden");
    $("#admin-body").classList.remove("hidden");
    $("#admin-error").classList.add("hidden");
    const list = $("#admin-list");
    if (!data.users.length) { list.innerHTML = `<div class="adm-empty">暂无用户档案</div>`; return; }
    list.innerHTML = data.users.map((u) => `
      <div class="adm-row" data-name="${u.name}">
        <b>${u.name}</b><span>${u.created}</span>
        <button type="button" class="adm-del">删除</button>
      </div>`).join("");
  } catch (_) { adminShowGate("网络异常，请重试"); }
}
function adminTryResume() { if (adminKey()) adminLoad(); else adminShowGate(""); }
$("#btn-admin-login").addEventListener("click", async () => {
  const key = $("#admin-pass").value;
  if (!key) return;
  try { sessionStorage.setItem("zw-admin", key); } catch (_) {}
  await adminLoad();
});
$("#admin-pass").addEventListener("keypress", (e) => { if (e.key === "Enter") $("#btn-admin-login").click(); });
$("#admin-list").addEventListener("click", async (e) => {
  const btn = e.target.closest(".adm-del");
  if (!btn) return;
  const row = btn.closest(".adm-row");
  const name = row.dataset.name;
  if (!confirm(`确认删除用户「${name}」的全部档案与推演记录？此操作不可恢复。`)) return;
  const res = await fetch("/api/admin/delete", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey() },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (data.ok) { row.remove(); if (!$("#admin-list").children.length) $("#admin-list").innerHTML = `<div class="adm-empty">暂无用户档案</div>`; }
  else alert(data.error || "删除失败");
});
$("#admin-back").addEventListener("click", () => { location.hash = "#/"; });

async function restoreProfileChat() {
  try {
    const res = await fetch(`/api/profile/get?id=${S.profile.id}&token=${S.profile.token}`);
    const data = await res.json();
    if (!data.ok) return;
    const p = data.profile;
    if (p.summary) {
      const note = addBubble("ai", "");
      note.classList.add("profile-note");
      note.innerHTML = `<div class="pn-cap">档案 · 既往推演摘要</div><div class="pn-body"></div>`;
      renderMD(note.querySelector(".pn-body"), p.summary, false);
    }
    const msgs = p.messages || [];
    if (msgs.length) {
      // 按时间间隔分组：相邻消息 >2 小时视为不同场次
      const groups = [];
      let cur = null, prevTs = 0;
      for (const m of msgs) {
        const t = m.ts ? new Date(m.ts.replace(" ", "T")).getTime() : 0;
        if (!cur || t - prevTs > 2 * 3600 * 1000) { cur = []; groups.push(cur); }
        cur.push(m); prevTs = t;
      }
      const wrap = document.createElement("div");
      wrap.className = "bubble ai past-chat";
      wrap.innerHTML =
        `<div class="pc-cap">往期推演 · ${groups.length} 场对话</div>` +
        (p.archived_count ? `<div class="pc-archived">更早 ${p.archived_count} 条对话已归档至「既往推演摘要」</div>` : "") +
        groups.map((g, i) => {
          const firstUser = g.find((m) => m.role === "user") || g[0];
          const when = (firstUser.ts || "").slice(5, 16);
          const gist = firstUser.content.replace(/\s+/g, " ").slice(0, 26) + (firstUser.content.length > 26 ? "…" : "");
          return `<details class="pc-session" data-g="${i}"><summary><span class="pc-when">${when}</span><span class="pc-gist">${gist}</span><span class="pc-arrow">▾</span></summary><div class="pc-body"></div></details>`;
        }).join("") +
        `<div class="pc-now">— 本次推演 —</div>`;
      $("#chat").appendChild(wrap);
      // 懒渲染：展开时才把该场消息渲染成完整气泡
      wrap.querySelectorAll(".pc-session").forEach((det) => {
        det.addEventListener("toggle", () => {
          if (!det.open || det.dataset.done) return;
          det.dataset.done = "1";
          const body = det.querySelector(".pc-body");
          const g = groups[+det.dataset.g];
          // 问答成组渲染：一组一问一答，视觉上与相邻组、操作按钮明确分隔
          let ex = null, lastQ = null;
          for (const m of g) {
            if (m.role === "user" || !ex) {
              ex = document.createElement("div");
              ex.className = "pc-ex";
              body.appendChild(ex);
            }
            if (m.role === "user") {
              const u = document.createElement("div");
              u.className = "pc-msg pc-user";
              u.textContent = m.content;
              u.dataset.q = m.content;      // 供 jumpToHistory 定位原文
              lastQ = m.content;
              ex.appendChild(u);
            } else {
              const a = document.createElement("div");
              a.className = "pc-msg pc-ai";
              renderMD(a, m.content, false);
              addBubbleActions(a, m.content, histRegen(lastQ, m.key));
              ex.appendChild(a);
            }
          }
        });
      });
      wrap.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    // 恢复进对话历史，保证追问连续性（无论是否折叠展示）
    for (const m of msgs) S.history.push({ role: m.role, content: m.content });
  } catch (_) { /* 忽略 */ }
}

/* ---------------- 排盘（信息页提交 → 总览页） ----------------
 * 默认定位：进入即处于当前流年视图，当前大限同步高亮（时间轴标「今」）
 */
async function initTodayView() {
  const by = birthYear();
  const nowY = new Date().getFullYear();
  switchMode("year");
  S.year = nowY;
  $("#year-label").textContent = nowY;
  const age = by ? nowY - by + 1 : null;
  const decPalace = S.chart.palaces.find(
    (p) => p.decadal?.range && age != null && age >= p.decadal.range[0] && age <= p.decadal.range[1]
  );
  if (decPalace) {
    const [a, b] = decPalace.decadal.range;
    S.decade = { palaceIdx: decPalace.index, range: [a, b], startYear: by + a - 1, endYear: by + b - 1 };
  }
  await loadHoro(S.year, S.month);
}

/* ---------------- 面板导航与档案按钮 ---------------- */
$("#go-register").addEventListener("click", () => { location.hash = "#/register"; });
$("#go-login").addEventListener("click", () => { location.hash = "#/login"; });
$("#go-admin").addEventListener("click", () => { location.hash = "#/admin"; });
$("#reg-back").addEventListener("click", () => { location.hash = "#/"; });
$("#login-back").addEventListener("click", () => { location.hash = "#/"; });
$("#btn-register").addEventListener("click", doRegister);
$("#btn-login").addEventListener("click", doLogin);
/* 确认密码实时校验：输入即比对，不一致红、一致绿 */
$("#auth-pass2").addEventListener("input", () => {
  const p1 = $("#auth-pass").value, p2 = $("#auth-pass2").value;
  const hint = $("#pass-hint"), el = $("#auth-pass2");
  if (!p2) { hint.textContent = ""; hint.className = "pass-hint"; el.classList.remove("err", "good"); return; }
  if (p1 === p2) { hint.textContent = "两次输入一致"; hint.className = "pass-hint good"; el.classList.remove("err"); el.classList.add("good"); }
  else { hint.textContent = "两次输入的密码不一致"; hint.className = "pass-hint bad"; el.classList.remove("good"); el.classList.add("err"); }
});
$("#auth-pass").addEventListener("input", () => {
  const p1 = $("#auth-pass").value, p2 = $("#auth-pass2").value;
  if (p2) $("#auth-pass2").dispatchEvent(new Event("input"));
});
/* 命盘/总览页 chip 点击 = 档案设置（昵称 / 出生信息 / 密码 / 退出） */
for (const id of ["#profile-chip", "#profile-chip-ov"]) {
  $(id).addEventListener("click", () => { location.hash = "#/settings"; });
}

/* ---------------- 我的档案（只读展示 + 点行就地编辑） ---------------- */
function ganzhiLine(b) {
  // 命造身份：乾造/坤造 · 干支年月日 · 时辰（有盘面时用农历干支，否则用公历）
  const zao = (b.gender === "女") ? "坤造" : "乾造";
  const hour = HOURS[b.timeIndex ?? 0]?.n ? `${HOURS[b.timeIndex ?? 0].n}时` : "";
  const cd = (S.chart?.chineseDate || "").replace(/\s+/g, "");
  if (cd) return `${zao} · ${cd}${cd.includes("日") ? "" : "日"} · ${hour}`;
  if (b.date) return `${zao} · 公历 ${b.date.replace(/-/g, ".")} · ${hour}`;
  return zao;
}
function fillSettings(p) {
  const b = p.birth || {};
  $("#st-name").textContent = p.name;
  $("#st-avatar").textContent = (p.name || "?").slice(0, 1);
  $("#st-ganzhi").textContent = ganzhiLine(b);
  $("#v-name").textContent = p.name;
  $("#v-gender").textContent = b.gender || "男";
  $("#v-date").textContent = b.date ? b.date.replace(/-/, " 年 ").replace(/-/, " 月 ") + " 日" : "—";
  $("#v-hour").textContent = HOURS[b.timeIndex ?? 0] ? `${HOURS[b.timeIndex ?? 0].n}时 · ${HOURS[b.timeIndex ?? 0].r}` : "—";
  // 编辑控件复位
  $("#set-name").value = "";
  if (b.date) {
    const [y, m, d] = b.date.split("-").map((n) => String(+n).padStart(2, "0"));
    $("#set-date").value = `${y}-${m}-${d}`;
  }
  $("#set-hour").innerHTML = HOURS.map((h) =>
    `<option value="${h.v}">${h.n}时 · ${h.r}</option>`).join("");
  $("#set-hour").value = String(b.timeIndex ?? 0);
  $("#set-gender").querySelectorAll("button").forEach((btn) =>
    btn.classList.toggle("on", btn.dataset.v === (b.gender || "男")));
  $("#set-oldpass").value = ""; $("#set-newpass").value = "";
}
async function loadSettings() {
  try {
    const res = await fetch(`/api/profile/get?id=${S.profile.id}&token=${S.profile.token}`);
    const data = await res.json();
    if (!data.ok) { doLogout(); return; }
    S.profile.name = data.profile.name;
    fillSettings(data.profile);
    renderProfileChip();
  } catch (_) { /* 档案读取失败保持现状 */ }
}
function rowHint(rowId, msg, cls = "") {
  const el = $(`#${rowId} .e-hint`);
  el.textContent = msg;
  el.className = `e-hint ${cls}`;
}
async function saveProfilePatch(rowId, payload, okMsg, onOk) {
  try {
    const res = await fetch("/api/profile/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: S.profile.id, token: S.profile.token, ...payload }),
    });
    const data = await res.json();
    if (!data.ok) return rowHint(rowId, data.error || "保存失败", "bad");
    rowHint(rowId, okMsg, "ok");
    if (onOk) onOk();
    setTimeout(() => {
      closeRow(rowId);
      rowHint(rowId, "");
    }, 900);
    return true;
  } catch (_) { rowHint(rowId, "网络异常，保存失败", "bad"); }
}
/* 行交互：互斥展开 / 收起复位 */
function closeRow(rowId) { $(`#${rowId}`).classList.remove("open"); }
document.querySelectorAll("#panel-settings .row-show").forEach((el) => {
  el.addEventListener("click", () => {
    const id = el.dataset.open;
    const already = $(`#${id}`).classList.contains("open");
    document.querySelectorAll("#panel-settings .row.open").forEach((r) => r.classList.remove("open"));
    if (!already) $(`#${id}`).classList.add("open");
  });
});
document.querySelectorAll("#panel-settings .btn-cancel").forEach((el) => {
  el.addEventListener("click", () => { closeRow(el.dataset.close); loadSettings(); });
});
document.querySelectorAll("#panel-settings .seg").forEach((seg) => {
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    seg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    btn.classList.add("on");
  });
});
document.querySelectorAll("#panel-settings .btn-save").forEach((btn) => {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.save;
    const rowId = btn.closest(".row").id;
    if (kind === "name") {
      const name = $("#set-name").value.trim();
      if (!name) return rowHint(rowId, "请输入新昵称", "bad");
      saveProfilePatch(rowId, { name }, "昵称已更新", () => {
        S.profile.name = name;
        $("#st-name").textContent = name;
        $("#st-avatar").textContent = name.slice(0, 1);
        $("#v-name").textContent = name;
        renderProfileChip();
      });
    } else if (kind === "birth") {
      const dv = $("#set-date").value;
      if (!dv) return rowHint(rowId, "请选择出生日期", "bad");
      const [y, m, d] = dv.split("-").map((n) => +n);
      const gender = $("#set-gender").querySelector("button.on")?.dataset.v || "男";
      saveProfilePatch(
        rowId,
        { birth: { date: `${y}-${m}-${d}`, timeIndex: +$("#set-hour").value, gender } },
        "已更新 · 下次登录重新排盘",
        loadSettings
      );
    } else if (kind === "pass") {
      const oldPass = $("#set-oldpass").value, newPass = $("#set-newpass").value;
      if (!oldPass || !newPass) return rowHint(rowId, "请填写当前密码与新密码", "bad");
      saveProfilePatch(rowId, { new_password: newPass, old_password: oldPass }, "密码已更新", () => {
        $("#set-oldpass").value = ""; $("#set-newpass").value = "";
      });
    }
  });
});
$("#btn-settings-logout").addEventListener("click", doLogout);
$("#settings-back").addEventListener("click", () => { location.hash = S.chart ? "#/overview" : "#/"; });

/* ---------------- 模式切换（时间轴为唯一入口） ---------------- */
function switchMode(m) {
  S.mode = m;
  S.sel = null;
  setModeUI();
}
function setModeUI() {
  $("#year-nav").classList.toggle("hidden", S.mode !== "year");
  $("#year-label").textContent = S.year;
  $("#btn-natal").classList.toggle("hidden", S.mode === "natal");
  const hints = {
    natal: "本命视图：点选宫位查看详情；下方时间轴标「今」为当前大限 / 流年",
    decade: "大限视图：叠加运曜与大限四化；点其他大限切换，再次点击选中的大限回到本命盘",
    year: "流年视图：‹ › 步进年份，叠加流曜与流年四化；点其他流年切换，再次点击选中的流年回到本命盘",
  };
  $("#mode-hint").textContent = hints[S.mode];
}

$("#btn-natal").addEventListener("click", () => {
  switchMode("natal");
  renderChart(true); renderDetail(); renderTimeline();
});

$("#year-prev").addEventListener("click", () => stepYear(-1));
$("#year-next").addEventListener("click", () => stepYear(1));
function stepYear(d) {
  const by = birthYear();
  // 允许步进跨大限：时间轴与运限层随浏览年份自动联动；边界 = 出生年 ~ 末个大限末年
  const ny = S.year + d;
  if (!by || ny < by) return;
  const lastB = Math.max(0, ...S.chart.palaces
    .filter((p) => p.decadal?.range)
    .map((p) => p.decadal.range[1]));
  if (ny > by + lastB - 1) return;
  S.year = ny;
  $("#year-label").textContent = S.year;
  S.sel = null;
  const p = decadeOfAge(S.year - by + 1);
  if (p?.decadal?.range) {
    const [a, b] = p.decadal.range;
    S.decade = { palaceIdx: p.index, range: [a, b], startYear: by + a - 1, endYear: by + b - 1 };
  } else {
    S.decade = null;   // 未入限：运限层由 palaceHTML 的 hasDecade 门控隐藏
  }
  loadHoro(S.year, S.month).then(() => { renderChart(); renderDetail(); renderTimeline(); });
}

async function loadHoro(year, month) {
  const key = horoKey(year, month);
  if (S.horoCache[key]) return S.horoCache[key];
  try {
    const res = await fetch(`/api/horoscope?id=${S.chartId}&year=${year}&month=${month}`);
    const data = await res.json();
    if (data.ok) { S.horoCache[key] = data.horoscope; return data.horoscope; }
  } catch (_) { /* 忽略 */ }
  return null;
}

/* ---------------- 星盘渲染 ---------------- */
/* 四化数据归一化：数组（按禄权科忌序）或对象 → [[化别, 星名], ...] */
function mutPairs(m) {
  if (Array.isArray(m)) {
    const names = ["禄", "权", "科", "忌"];
    return m.map((s, i) => [names[i] || "?", s]);
  }
  if (m && typeof m === "object") return Object.entries(m);
  return [];
}
/* 星曜四化徽标：固定三格槽位（第一格=本命实心、第二格=大限描边、第三格=流年浅底），
   缺层用等宽空槽占位，使「位置」本身也能区分层次 */
function mutBadgesHTML(s, dMut, yMut) {
  const d = mutPairs(dMut).find(([, v]) => v === s.name);
  const y = mutPairs(yMut).find(([, v]) => v === s.name);
  const natal = s.mutagen && MUT_CLASS[s.mutagen]
    ? `<span class="mut ${MUT_CLASS[s.mutagen]}">${s.mutagen}</span>` : "";
  if (!natal && !d && !y) return "";
  const slot = (html) => html || '<span class="mut-slot"></span>';
  const dBadge = d ? `<span class="mut ${MUT_CLASS[d[0]] || ""} m-d">${d[0]}</span>` : "";
  const yBadge = y ? `<span class="mut ${MUT_CLASS[y[0]] || ""} m-y">${y[0]}</span>` : "";
  // 占位只补「中间/前部」缺层：末尾缺省不占位，避免本命单化时出现尾部空隙
  if (yBadge) return slot(natal) + slot(dBadge) + yBadge;
  if (dBadge) return slot(natal) + dBadge;
  return natal;
}
function starHTML(s, cls, dMut, yMut) {
  const bright = s.brightness ? `<span class="star-bright">${s.brightness}</span>` : "";
  return `<div class="${cls}">${s.name}${bright}${mutBadgesHTML(s, dMut, yMut)}</div>`;
}
function flowHTML(arr, cls) {
  return (arr || []).map((s) => `<div class="${cls}">${s.name}</div>`).join("");
}

function palaceHTML(p, slot) {
  const bi = p.index;
  const horo = S.horoCache[horoKey(S.year, S.month)];
  // 浏览上下文是否真的处于某个大限内：未入限（年龄 < 首限起始）时不显示任何大限层
  const by = birthYear();
  const yrAge = by ? S.year - by + 1 : null;
  const hasDecade = S.mode === "decade"
    ? !!S.decade
    : S.mode === "year" ? !!(yrAge != null && decadeOfAge(yrAge))
    : false;
  const dMut = hasDecade ? horo?.decadal?.mutagen : null;
  const yMut = S.mode === "year" ? horo?.yearly?.mutagen : null;
  const majors = p.majorStars.map((s) => starHTML(s, "star-major", dMut, yMut)).join("");
  const minors = p.minorStars.map((s) => starHTML(s, "star-minor", dMut, yMut)).join("");
  const adj = p.adjectiveStars.slice(0, 4).map((s) => starHTML(s, "star-adj", dMut, yMut)).join("");
  let flow = "";
  if (horo && hasDecade && S.mode === "decade") flow = flowHTML((horo.decadal?.stars || [])[bi], "star-flow-d");
  if (horo && S.mode === "year") flow = flowHTML((horo.yearly?.stars || [])[bi], "star-flow-y");

  const dec = p.decadal || {};
  const rng = dec.range ? `${dec.range[0]}-${dec.range[1]}` : "";
  const badges = [];
  if (p.isBodyPalace) badges.push('<span class="badge">身</span>');
  if (p.isOriginalPalace) badges.push('<span class="badge gray">来因</span>');
  // 对宫标记：选中宫位的对宫显示醒目徽标
  if (S.sel !== null && bi === (S.sel + 6) % 12 && S.sel !== bi) {
    badges.push('<span class="badge opp-badge">对宫</span>');
  }

  let cls = "palace";
  // 运限双层标签：大限宫位（金）+ 流年宫位（蓝），命宫实心高亮
  const pills = [];
  if (horo?.decadal?.palaceNames && hasDecade) {
    const nm = P_ABBR[horo.decadal.palaceNames[bi]] || horo.decadal.palaceNames[bi];
    const soul = horo.decadal.index === bi;
    pills.push(`<span class="fl fl-d${soul ? " soul" : ""}">运${nm}</span>`);
    if (soul) cls += " hl-decade";
  }
  if (S.mode === "year" && horo?.yearly?.palaceNames) {
    const nm = P_ABBR[horo.yearly.palaceNames[bi]] || horo.yearly.palaceNames[bi];
    const soul = horo.yearly.index === bi;
    pills.push(`<span class="fl fl-y${soul ? " soul" : ""}">年${nm}</span>`);
    if (soul) cls += " hl-year";
  }
  // 运命/流命三方四正：流年视图双层叠加（大限黛青 + 流年靛蓝）；大限视图单层黛青。
  // 未点选，或点选的正是运命/流命宫本身时显示；点选其他宫则切换为朱砂联动
  const dSoul = hasDecade ? (horo?.decadal?.index ?? null) : null;
  const ySoul = S.mode === "year" ? (horo?.yearly?.index ?? null) : null;
  const keepFlow = S.sel === null || S.sel === dSoul || S.sel === ySoul;
  if (keepFlow) {
    if (dSoul != null) {
      const t1 = (dSoul + 4) % 12, t2 = (dSoul + 8) % 12, opp = (dSoul + 6) % 12;
      if (bi === t1 || bi === t2) cls += " f-trine-d";
      if (bi === opp) cls += " f-opp-d";
    }
    if (ySoul != null) {
      const t1 = (ySoul + 4) % 12, t2 = (ySoul + 8) % 12, opp = (ySoul + 6) % 12;
      if (bi === t1 || bi === t2) cls += " f-trine-y";
      if (bi === opp) cls += " f-opp-y";
    }
  }
  // 选中态：统一朱砂；运命/流命被点选时三方四正已由运限色表达，不再朱砂联动
  if (S.sel === bi) cls += " sel";
  else if (S.sel !== null && !keepFlow) {
    const t1 = (S.sel + 4) % 12, t2 = (S.sel + 8) % 12, opp = (S.sel + 6) % 12;
    if (bi === t1 || bi === t2) cls += " trine";
    if (bi === opp) cls += " opp";
  }
  return `<div class="${cls}" style="--i:${slot}" data-idx="${bi}">
    <div class="palace-top"><span>${BRANCH[bi]}</span><span>${rng}</span></div>
    <div class="palace-name">${p.name}${badges.join("")}</div>
    <div class="palace-stem"><span class="wx ${ELEM_CLS[STEM_ELEM[p.heavenlyStem]] || ""}">${p.heavenlyStem}</span>${p.earthlyBranch}</div>
    <div class="stars">${majors}${minors}${adj}${flow}</div>
    ${pills.length ? `<div class="fl-row">${pills.join("")}</div>` : ""}
  </div>`;
}

function centerHTML(c) {
  const horo = S.horoCache[horoKey(S.year, S.month)];
  const horoBits = [];
  if (S.mode === "decade") {
    if (S.decade) {
      const dp = (c.palaces || [])[S.decade.palaceIdx];
      horoBits.push(`<div><b>大限</b> ${S.decade.range[0]}–${S.decade.range[1]} 岁（约 ${S.decade.startYear}–${S.decade.endYear}）${dp ? `· 命宫落${dp.name}` : ""}</div>`);
      if (horo?.decadal) horoBits.push(`<div class="center-mut"><span class="mchip">大限四化</span>${mutChipsHTML(horo.decadal.mutagen)}</div>`);
    }
  }
  if (S.mode === "year") {
    const yp = horo?.yearly ? (c.palaces || [])[horo.yearly.index] : null;
    horoBits.push(`<div><b>当前流年</b> ${S.year} ${zodiacOf(S.year)}年${yp ? ` · 命宫落${yp.name}` : ""}</div>`);
    if (horo?.yearly) horoBits.push(`<div class="center-mut"><span class="mchip">流年四化</span>${mutChipsHTML(horo.yearly.mutagen)}</div>`);
  }
  // 四柱：干支竖排，天干按五行着色
  const pillars = (c.chineseDate || "").trim().split(/\s+/).filter(Boolean);
  const plNames = ["年", "月", "日", "时"];
  const pillarRow = pillars.slice(0, 4).map((t, i) => {
    return `<div class="pillar2"><i>${plNames[i] || ""}</i><b class="wx ${ELEM_CLS[STEM_ELEM[t[0]]] || ""}">${t[0]}</b><span>${t.slice(1)}</span></div>`;
  }).join("");
  // 阴阳男女：年干阴阳 + 性别
  const yearStem = pillars[0]?.[0] || "";
  const yangYear = "甲丙戊庚壬".includes(yearStem);
  const yy = (yangYear ? "阳" : "阴") + (S.gender || "男");
  return `<div class="center" style="grid-column:2/span 2;grid-row:2/span 2;--i:5">
    <div class="center-title2">${yy} · ${c.fiveElementsClass}</div>
    <div class="center-time">北京时间 ${c.solarDate.replace(/-/g, ".")} ${c.timeRange || ""}</div>
    <div class="center-lunar">农历 ${c.lunarDate || ""}</div>
    <div class="center-pillars2">${pillarRow}</div>
    <div class="center-kv">
      <span><i>命主</i><b>${c.soul}</b></span>
      <span><i>身主</i><b>${c.body}</b></span>
      <span><i>命宫</i><b>${c.earthlyBranchOfSoulPalace}</b></span>
    </div>
    <div class="center-legend">
      <span class="lg-chip lg-lu">禄</span><span class="lg-chip lg-quan">权</span>
      <span class="lg-chip lg-ke">科</span><span class="lg-chip lg-ji">忌</span>
    </div>
    ${S.mode !== "natal" ? `<div class="mut-legend-note">四化分层<span class="mut mut-lu">禄</span>生年<span class="mut mut-quan m-d">权</span>大限<span class="mut mut-ke m-y">科</span>流年</div>` : ""}
    ${horoBits.length ? `<div class="center-mode">${{ natal: "基本信息", decade: "大限视图", year: "流年视图" }[S.mode]}</div><div class="center-horo">${horoBits.join("")}</div>` : ""}
  </div>`;
}

/* anim=true 时重播入场动画（视图/模式切换）；点选更新等局部刷新传 false 避免整盘闪动 */
function renderChart(anim = false) {
  if (!S.chart) return;
  const palaces = byIdx();
  let html = "";
  for (let slot = 0; slot < 16; slot++) {
    const bi = SLOT_BRANCH[slot];
    if (bi === -1) {
      if (slot === 5) html += centerHTML(S.chart);   // 中宫 2x2 跨格单面板
      continue;
    }
    const p = palaces[bi];
    if (p) html += palaceHTML(p, slot);
  }
  const box = $("#astrolabe");
  box.classList.toggle("still", !anim);
  box.classList.toggle("horomode", S.mode !== "natal");
  box.innerHTML = html;
}

async function enterDecade(idx) {
  const p = byIdx()[idx];
  const by = birthYear();
  if (p?.decadal?.range) {
    S.decade = {
      palaceIdx: idx, range: p.decadal.range,
      startYear: by + p.decadal.range[0] - 1,
      endYear: by + p.decadal.range[1] - 1,
    };
    await loadHoro(Math.floor((S.decade.startYear + S.decade.endYear) / 2), S.month);
  }
  S.sel = null;
  renderChart(true); renderDetail(); renderTimeline();
}

async function selectPalace(bi, anim = false) {
  // 再次点击已选中的宫位 → 取消选中，退回点击前视图（本命盘/大限盘/流年盘默认态）
  if (S.sel === bi) {
    S.sel = null;
    renderChart(anim);
    renderDetail();
    renderTimeline();
    return;
  }
  // 仅选中查看，不改 S.decade / 不切盘——大限视图下宫位自带的大限范围标注
  // 只是本命信息，点选不应把浏览大限跳到该宫对应的年份区间
  S.sel = bi;
  renderChart(anim);
  renderDetail();
  renderTimeline();
}

$("#astrolabe").addEventListener("click", (e) => {
  // 点击中宫 → 回本命视图（任何运限模式下的快捷返回）
  if (e.target.closest(".center")) {
    if (S.mode !== "natal") {
      switchMode("natal");
      renderChart(); renderDetail(); renderTimeline();
    }
    return;
  }
  const el = e.target.closest(".palace");
  if (!el) return;
  selectPalace(parseInt(el.dataset.idx, 10));
});

/* ---------------- 大限 / 流年时间轴（联动） ----------------
 * 大限 active 始终跟随当前浏览年份（S.year）所在大限，杜绝点击流年后残留旧大限高亮
 * 流年行：非本命视图显示当前浏览年份所在大限的 10 个年份；本命显示当前年 ±6
 */
function decadeOfAge(age) {
  return S.chart.palaces.find(
    (p) => p.decadal?.range && age >= p.decadal.range[0] && age <= p.decadal.range[1]
  );
}
function renderTimeline() {
  const el = $("#timeline");
  if (!S.chart) { el.innerHTML = ""; return; }
  const by = birthYear();
  const nowY = new Date().getFullYear();
  const nowAge = by ? nowY - by + 1 : null;
  const decades = S.chart.palaces
    .filter((p) => p.decadal?.range)
    .sort((a, b) => a.decadal.range[0] - b.decadal.range[0]);
  // 当前浏览的大限（三叠盘基准）：
  // 大限视图 → S.decade 所指大限；流年视图 → 浏览年份所在大限；本命 → 当前年所在大限
  const browseDecade =
    S.mode === "decade"
      ? (S.decade ? decades.find((p) => p.index === S.decade.palaceIdx) || null : null)
      : S.mode === "year"
        ? (by ? decadeOfAge(S.year - by + 1) : null)
        : (nowAge != null ? decadeOfAge(nowAge) : null);
  const decChips = decades.map((p) => {
    const [a, b] = p.decadal.range;
    const active = S.mode !== "natal" && browseDecade?.index === p.index;
    const isNow = nowAge != null && nowAge >= a && nowAge <= b;
    return `<button class="tl-chip ${active ? "active" : ""}${isNow && !active ? " now" : ""}" data-dec="${p.index}">
      <b>${a}–${b} 岁</b><span>${by + a - 1}–${by + b - 1}</span></button>`;
  }).join("");
  // 流年行：浏览年份所在大限的 10 个年份；本命视图为当前年 ±6；负岁（未出生）不显示；
  // 未入限（当前年龄小于首限起始）时只显示到入限前一年，不混入首限年份
  const firstA = decades[0]?.decadal?.range?.[0] ?? null;
  const years = [];
  if (S.mode !== "natal" && browseDecade) {
    for (let y = by + browseDecade.decadal.range[0] - 1; y <= by + browseDecade.decadal.range[1] - 1; y++) years.push(y);
  } else {
    for (let y = nowY - 5; y <= nowY + 6; y++) years.push(y);
  }
  const yrChips = years.filter((y) => {
    if (!by) return true;
    const age = y - by + 1;
    if (age < 1) return false;
    if (S.mode !== "natal" && browseDecade) {
      return age >= browseDecade.decadal.range[0] && age <= browseDecade.decadal.range[1];
    }
    return firstA == null || age < firstA;
  }).map((y) => {
    const active = S.mode === "year" && S.year === y;
    const age = by ? `${y - by + 1} 岁` : "　";
    return `<button class="tl-chip ${active ? "active" : ""}${y === nowY && !active ? " now" : ""}" data-yr="${y}">
      <b>${y}</b><span>${age}</span></button>`;
  }).join("");
  el.innerHTML = `
    <div class="tl-row"><span class="tl-label">大限</span><div class="tl-chips">${decChips}</div></div>
    <div class="tl-row"><span class="tl-label">流年</span><div class="tl-chips">${yrChips}</div></div>`;
  // 选中的大限/流年 chip 滚动到滑动区正中间
  el.querySelectorAll(".tl-chips").forEach((wrap) => {
    const chip = wrap.querySelector(".tl-chip.active");
    if (!chip) return;
    const cr = wrap.getBoundingClientRect(), br = chip.getBoundingClientRect();
    const target = wrap.scrollLeft + (br.left - cr.left) - (cr.width - br.width) / 2;
    wrap.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  });
}

$("#timeline").addEventListener("click", async (e) => {
  const chip = e.target.closest(".tl-chip");
  if (!chip) return;
  const by = birthYear();
  const nowY = new Date().getFullYear();
  const nowAge = by ? nowY - by + 1 : null;   // 修复：此前未定义，返回本命后点大限会抛错
  const decades = (S.chart?.palaces || []).filter((p) => p.decadal?.range);
  // 同步 S.decade 到指定年份所在大限（供详情/快照使用）
  const syncDecadeForYear = (y) => {
    const age = by ? y - by + 1 : null;
    const p = age != null ? decadeOfAge(age) : null;
    if (p?.decadal?.range) {
      const [a, b] = p.decadal.range;
      S.decade = { palaceIdx: p.index, range: [a, b], startYear: by + a - 1, endYear: by + b - 1 };
    }
  };
  if (chip.dataset.dec !== undefined) {
    const idx = parseInt(chip.dataset.dec, 10);
    const browseDecade =
      S.mode === "decade"
        ? (S.decade ? decades.find((p) => p.index === S.decade.palaceIdx) || null : null)
        : S.mode === "year"
          ? (by ? decadeOfAge(S.year - by + 1) : null)
          : (nowAge != null ? decadeOfAge(nowAge) : null);
    // 取消层级：大限视图下再点当前大限 chip → 回本命；
    // 流年视图下点大限 chip 一律切入该大限（取消流年走流年 chip 的二次点击）
    if (S.mode === "decade" && browseDecade?.index === idx) {
      switchMode("natal");
      renderChart(); renderDetail(); renderTimeline();
      return;
    }
    switchMode("decade");
    await enterDecade(idx);   // 点大限只切换浏览，不选中宫位（避免朱砂联动红框）
    return;
  }
  if (chip.dataset.yr !== undefined) {
    const y = parseInt(chip.dataset.yr, 10);
    // 取消层级：再次点击当前流年 chip → 退回所属大限视图（而非直接跳本命）
    if (S.mode === "year" && S.year === y) {
      syncDecadeForYear(y);
      switchMode("decade");
      if (S.decade) await enterDecade(S.decade.palaceIdx);
      renderChart(); renderDetail(); renderTimeline();
      return;
    }
    switchMode("year");
    S.year = y;
    $("#year-label").textContent = S.year;
    S.sel = null;
    syncDecadeForYear(y);
    await loadHoro(S.year, S.month);
    renderChart(true); renderDetail(); renderTimeline();
  }
});

/* ---------------- 详情抽屉（只做「看盘」；推演在对话区输出） ---------------- */
/* 四化对象/数组 → 纯文本 */
function fmtMutagen(m) {
  if (Array.isArray(m)) {
    const names = ["禄", "权", "科", "忌"];
    return m.map((s, i) => `${s}化${names[i] || "?"}`).join("　");
  }
  if (m && typeof m === "object") return Object.entries(m).map(([k, v]) => `${v}化${k}`).join("　");
  return "";
}

/* 四化对象/数组 → 「星名+彩色化别徽标」chips（中宫用） */
function mutChipsHTML(m) {
  return mutPairs(m).map(([k, v]) => `<span class="mchip">${v}<span class="mut ${MUT_CLASS[k] || ""}">${k}</span></span>`).join("");
}

function detailDefault() {
  const horo = S.horoCache[horoKey(S.year, S.month)];
  let title, body, cta = "";
  if (S.mode === "decade" && S.decade) {
    const [a, b] = S.decade.range;
    title = `大限 · ${a}–${b} 岁`;
    body = `<div class="d-sub">${S.decade.startYear}–${S.decade.endYear} 年</div>
      ${horo?.decadal ? `<div class="d-line">大限四化：${fmtMutagen(horo.decadal.mutagen)}</div>` : ""}`;
    cta = `<button class="btn-outline" id="btn-deduce-view">推演此大限整体运势</button>`;
  } else if (S.mode === "year") {
    title = `流年 · ${S.year} ${zodiacOf(S.year)}年`;
    body = `${horo?.yearly ? `<div class="d-line">流年四化：${fmtMutagen(horo.yearly.mutagen)}</div>` : ""}`;
    cta = `<button class="btn-outline" id="btn-deduce-view">推演此流年整体运势</button>`;
  } else {
    title = "本命盘";
    body = `<div class="d-sub">点选宫位查看星曜与三方四正联动</div>`;
  }
  const hint = S.mode === "natal"
    ? `<div class="d-sub" style="margin-top:10px">点下方时间轴进入大限 / 流年视图</div>`
    : `<div class="d-sub" style="margin-top:10px">点选任意宫位查看该宫运限叠加</div>`;
  return `<h3>${title}</h3>${body}${hint}${cta}`;
}
const sStar = (n) => `<b>${n}</b>`;

/* 详情按钮绑定后异步查历史：命中则按钮换为「查看历史推演结果」，点击跳原文 */
function bindViewDeduceBtn(btn) {
  const v = viewQuestion();
  if (!v) return;
  const labelCached = S.mode === "year" ? "♻ 查看此流年历史推演结果" : "♻ 查看此大限历史推演结果";
  bindDeduceBtn(btn, () => deduceView(), v.q, labelCached);
}

function renderDetail() {
  const el = $("#detail");
  if (!S.chart) { el.innerHTML = ""; return; }
  el.classList.toggle("d-decade", S.mode === "decade");
  el.classList.toggle("d-year", S.mode === "year");
  if (S.sel === null) {
    el.innerHTML = detailDefault();
    const vb = $("#btn-deduce-view");       // 修复：此分支此前提前 return，按钮从未绑定事件
    if (vb) bindViewDeduceBtn(vb);
    return;
  }
  const p = byIdx()[S.sel];
  const horo = S.horoCache[horoKey(S.year, S.month)];
  let html = `<h3>${p.name}宫 · ${BRANCH[S.sel]}</h3>
    <div class="d-sub">宫干 ${p.heavenlyStem}${p.earthlyBranch}${p.isBodyPalace ? " · 身宫" : ""}${p.isOriginalPalace ? " · 来因宫" : ""}</div>`;

  html += `<div class="d-section">本命星曜</div>`;
  const allStars = [...p.majorStars, ...p.minorStars];
  html += allStars.length
    ? allStars.map((s) => `<span class="d-star">${sStar(s.name)}${s.brightness ? `<span class="star-bright">${s.brightness}</span>` : ""}${s.mutagen ? `<span class="mut ${MUT_CLASS[s.mutagen]}">${s.mutagen}</span>` : ""}</span>`).join("")
    : '<div class="d-line">无主星，借对宫星曜参断</div>';
  if (p.adjectiveStars?.length) {
    html += `<div class="d-line" style="margin-top:4px;color:var(--ink-3)"><span style="color:var(--ink-2)">杂曜：</span>${p.adjectiveStars.map((s) => s.name).join(" · ")}</div>`;
  }

  if (S.mode === "decade" && horo?.decadal) {
    const names = horo.decadal.palaceNames || [];
    const flow = (horo.decadal.stars || [])[S.sel] || [];
    html += `<div class="d-section">大限叠加</div>
      <div class="d-line">此宫为该大限之 <b>${names[S.sel] || "?"}</b></div>
      <div class="d-line">运曜：${flow.length ? flow.map((s) => `<span style="color:var(--flow-d)">${s.name}</span>`).join("、") : "无"}</div>`;
  }
  if (S.mode === "year" && horo?.yearly) {
    const names = horo.yearly.palaceNames || [];
    const flow = (horo.yearly.stars || [])[S.sel] || [];
    html += `<div class="d-section">流年叠加（${S.year}）</div>
      <div class="d-line">此宫为流年之 <b>${names[S.sel] || "?"}</b></div>
      <div class="d-line">流曜：${flow.length ? flow.map((s) => `<span style="color:var(--flow-y)">${s.name}</span>`).join("、") : "无"}</div>`;
  }

  const btnLabel = { natal: "就此宫提问推演", decade: "推演此宫 · 大限十年运势", year: "推演此宫 · 流年运势" }[S.mode];
  html += `<button class="btn-outline" id="btn-deduce-palace">${btnLabel}</button>`;
  el.innerHTML = html;
  const vq = palaceQuestion();
  bindDeduceBtn($("#btn-deduce-palace"), () => deducePalace(), vq.q, "♻ 查看此宫历史推演结果");
  const viewBtn = $("#btn-deduce-view");
  if (viewBtn) bindViewDeduceBtn(viewBtn);
}

/* 视图/宫位推演问题模板：发起推演与「查看历史推演」共用同一来源，保证去重 key 一致 */
function viewQuestion() {
  if (S.mode === "year") {
    return { q: `请推演 ${S.year} 年流年整体运势：流年四化引动本命何宫、流年命宫三方四正格局、全年十二宫重点领域吉凶概述与关键应期提示。`,
             year: S.year, focus: ["流年", "四化"] };
  }
  if (S.mode === "decade" && S.decade) {
    const [a, b] = S.decade.range;
    const mid = Math.floor((S.decade.startYear + S.decade.endYear) / 2);
    return { q: `请推演 ${a}–${b} 岁大限（约 ${S.decade.startYear}–${S.decade.endYear} 年）整体运势：大限命宫三方四正格局、大限四化引动本命何宫、十年重点领域与起伏节奏。`,
             year: mid, focus: ["大限", "四化"] };
  }
  return null;
}

function palaceQuestion() {
  const p = byIdx()[S.sel];
  if (!p) return null;
  const starNames = [...p.majorStars, ...p.minorStars].map((s) => s.name);
  const stars = starNames.join("、");
  const focus = [p.name, ...starNames.slice(0, 4)];   // RAG 检索聚焦词：宫位 + 主星
  let q, year = null;
  if (S.mode === "decade" && S.decade) {
    year = Math.floor((S.decade.startYear + S.decade.endYear) / 2);
    q = `请推演 ${p.name}宫大限（${S.decade.range[0]}–${S.decade.range[1]} 岁，约 ${S.decade.startYear}–${S.decade.endYear} 年）的十年整体运势：大限命宫三方四正格局、大限四化引动本命何宫、重点应事领域与起伏节点。本宫星曜：${stars}。`;
  } else if (S.mode === "year") {
    year = S.year;
    const horo = S.horoCache[horoKey(S.year, S.month)];
    const ynames = horo?.yearly?.palaceNames || [];
    const role = ynames[S.sel] ? `，此宫为流年${ynames[S.sel]}` : "";
    q = `请按流年推断法则（太岁起流年命宫、流年四化引动、三叠盘、流曜吉凶）推演 ${S.year} 年流年运势，重点分析${p.name}宫（${p.heavenlyStem}${p.earthlyBranch}${role}，星曜：${stars || "无主星"}）在今年的表现，给出该宫领域的应期与机会/风险提示。`;
  } else {
    q = `请围绕我的${p.name}宫（${p.heavenlyStem}${p.earthlyBranch}，星曜：${stars || "无主星"}）展开推演：这一宫位反映的人生领域格局如何？结合三方四正与大限给出趋势与建议。`;
  }
  return { q, year, focus };
}

/* 去重键：档案 + 视图模式 + 大限/流年 + 宫位 + 问题原文——同键推演服务端直接复用上次回答。
   首段用档案 id 而非 chartId：chartId 每次排盘都会重新生成，用它做键会导致缓存跨会话永不命中 */
function dedupeKeyFor(question) {
  if (!S.profile) return null;
  return [`p${S.profile.id}`, S.mode, S.mode === "year" ? S.year : "",
          S.mode === "decade" ? (S.decade?.range?.join("-") || "") : "",
          S.sel ?? "", question].join("|");
}

/* 查询同题推演是否已存在：命中则按钮换成「查看历史推演结果」，点击跳转原文而非重复生成 */
async function cachedHitFor(question) {
  const key = dedupeKeyFor(question);
  if (!key) return null;
  try {
    const res = await fetch(`/api/deduce/check?key=${encodeURIComponent(key)}&profile_id=${S.profile.id}&token=${encodeURIComponent(S.profile.token)}`);
    const d = await res.json();
    if (d.ok && d.cached) return d;
  } catch (_) {}
  return null;
}

/* 绑定推演按钮：默认发起推演；若服务端确认已有同题历史，点击改为跳转到原文 */
function bindDeduceBtn(btn, action, question, labelCached) {
  if (!btn) return;
  let hit = null;
  btn.addEventListener("click", () => { hit ? jumpToHistory(question, hit) : action(); });
  cachedHitFor(question).then((h) => {
    if (h && btn.isConnected) { hit = h; btn.textContent = labelCached; }
  });
}

/* 跳转到历史推演原文：优先定位对话区已有气泡并高亮；已被压缩归档时就地展示原文（不重新调模型） */
function jumpToHistory(question, hit) {
  const targets = [...document.querySelectorAll("#chat [data-q]")].filter((el) => el.dataset.q === question);
  if (targets.length) {
    const el = targets[targets.length - 1];
    const det = el.closest("details.pc-session");
    if (det && !det.open) det.open = true;
    setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 2400);
    }, det ? 120 : 0);
    return;
  }
  const uEl = addBubble("user", question);
  uEl.dataset.q = question;
  const aiEl = addBubble("ai", "");
  aiEl.innerHTML = `<div class="cache-tag">♻ 历史推演 · ${(hit.ts || "").slice(5, 16)}（原文已归档，点击「重新生成」可换一份）</div><div class="hist-body"></div>`;
  renderMD(aiEl.querySelector(".hist-body"), hit.answer, false);
  addBubbleActions(aiEl, hit.answer, histRegen(question, hit.key));
  aiEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* 从去重键/问题文本推断推演年份（历史重新生成时注入对应运限盘） */
function regenYearOf(key, question) {
  if (key) {
    const parts = key.split("|");
    if (parts[1] === "year" && parts[2]) return +parts[2] || null;
  }
  const dec = (question || "").match(/约\s*(\d{4})[–—-](\d{4})\s*年/);
  if (dec) return Math.floor((+dec[1] + +dec[2]) / 2);
  const y = (question || "").match(/(\d{4})\s*年/);
  return y ? +y[1] : null;
}

/* 历史推演重新生成：与新的推演对话一样，在对话区末尾追加新的一问一答（force=1 不读缓存） */
function histRegen(question, key) {
  if (!question) return null;
  const year = regenYearOf(key, question);
  return () => ask(question, year, null, true);
}

/* 视图导览内的一键整体推演：流年/大限模式可用 */
function deduceView() {
  if (S.busy) return;
  const v = viewQuestion();
  if (v) ask(v.q, v.year, v.focus);
}

function deducePalace() {
  const v = palaceQuestion();
  if (v) ask(v.q, v.year, v.focus);
}

/* ---------------- 推演对话 ---------------- */
const THINKING_HTML = '<div class="think-row"><span class="think-star">✦</span><span class="think-text">命理师起盘推演中</span><span class="think-dots"><i></i><i></i><i></i></span></div>';

/* 导出/复制推演 */
function downloadText(name, text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function pad2(n) { return String(n).padStart(2, "0"); }
function exportChat() {
  if (!S.history.length) return;
  const c = S.chart || {};
  const lines = [
    "# 紫微斗数推演记录", "",
    `- 公历：${c.solarDate || ""}　农历：${c.lunarDate || ""}`,
    `- 性别：${c.gender || ""}　五行局：${c.fiveElementsClass || ""}　命主：${c.soul || ""}　身主：${c.body || ""}`,
    `- 导出时间：${new Date().toLocaleString("zh-CN")}`, "",
    "---", "",
  ];
  for (const m of S.history) {
    if (m.role === "user") lines.push(`## 问：${m.content}`, "");
    else lines.push(m.content, "");
  }
  const d = new Date();
  downloadText(`紫微推演_${c.solarDate || "命盘"}_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.md`, lines.join("\n"));
}
/* 复制文本：优先 clipboard API（HTTPS/localhost），HTTP 环境降级 execCommand */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-999px;top:0;opacity:0";
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}
/* 单条 AI 回复尾部动作（复制 / 下载本条 / 可选重新生成） */
function addBubbleActions(el, raw, regen) {
  const foot = document.createElement("div");
  foot.className = "bubble-actions";
  const copy = document.createElement("button");
  copy.type = "button"; copy.className = "bact"; copy.textContent = "复制";
  copy.addEventListener("click", async () => {
    try {
      await copyText(raw);
      copy.textContent = "已复制";
      setTimeout(() => { copy.textContent = "复制"; }, 1600);
    } catch (_) { copy.textContent = "复制失败"; }
  });
  const dl = document.createElement("button");
  dl.type = "button"; dl.className = "bact"; dl.textContent = "下载本条";
  dl.addEventListener("click", () => {
    const d = new Date();
    downloadText(`紫微推演_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.md`, raw);
  });
  foot.append(copy, dl);
  if (regen) {
    const rg = document.createElement("button");
    rg.type = "button"; rg.className = "bact"; rg.textContent = "重新生成";
    rg.addEventListener("click", () => {
      if (S.busy) return;
      rg.textContent = "生成中…"; rg.disabled = true;
      regen().finally(() => { rg.disabled = false; });
    });
    foot.append(rg);
  }
  el.appendChild(foot);
}

function addBubble(cls, text) {
  const div = document.createElement("div");
  div.className = `bubble ${cls}`;
  if (text) div.textContent = text;
  $("#chat").appendChild(div);
  smartScroll(div);
  return div;
}
/* 智能滚动：仅在用户本就接近底部时跟随；用户上滑回看时不强行拉回（修手机端"无法下滑"） */
function nearBottom() {
  const margin = window.innerHeight * 0.35;
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - margin;
}
function smartScroll(el) {
  if (nearBottom()) el.scrollIntoView({ behavior: "smooth", block: "end" });
}
function renderMD(el, raw, cursor) {
  if (window.marked) {
    let html = marked.parse(raw);
    // 包裹表格以便窄屏横向滚动
    html = html.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, "</table></div>");
    el.innerHTML = html + (cursor ? '<span class="cursor"></span>' : "");
  } else el.textContent = raw;
}

async function ask(question, year = null, focus = null, force = false) {
  if (!question.trim() || S.busy || !S.chart) return;
  S.busy = true;
  $("#btn-ask").disabled = true;
  // RAG 上下文增强：无论问题来自哪里，都把当前视图状态（选中宫位 / 大限 / 流年）并入检索聚焦词
  const ctx = [];
  if (S.mode === "year") ctx.push("流年", "四化");
  else if (S.mode === "decade") ctx.push("大限", "四化");
  if (S.sel != null) {
    const p = byIdx()[S.sel];
    if (p) {
      ctx.push(p.name);
      ctx.push(...p.majorStars.map((s) => s.name).slice(0, 2));
    }
  }
  focus = [...new Set([...(focus || []), ...ctx])].slice(0, 8);
  // 去重键与「查看历史推演」共用 dedupeKeyFor，保证两端 key 一致
  const dedupeKey = dedupeKeyFor(question);
  $("#chat").closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
  const uEl = addBubble("user", question);
  uEl.dataset.q = question;             // 供 jumpToHistory 定位原文
  S.history.push({ role: "user", content: question });

  const aiEl = addBubble("ai", "");
  aiEl.innerHTML = THINKING_HTML;      // 推演中动效（CLI 启动有数秒无输出）
  aiEl.classList.add("thinking");
  let raw = "", cachedHit = false;
  try {
    const yp = year ? `&year=${year}` : "";
    const fp = focus?.length ? `&focus=${encodeURIComponent(focus.join(","))}` : "";
    const kp = dedupeKey ? `&key=${encodeURIComponent(dedupeKey)}` : "";
    const ap = S.profile ? `&profile_id=${S.profile.id}&token=${encodeURIComponent(S.profile.token)}` : "";
    const frc = force ? "&force=1" : "";
    const res = await fetch(`/api/deduce?id=${S.chartId}&q=${encodeURIComponent(question)}${yp}${fp}${kp}${ap}${frc}`);
    if (res.status === 429) throw new Error("推演请求太频繁，请稍候几秒再试");
    if (!res.ok || !res.body) throw new Error("服务异常，请稍后重试");
    // JSON 错误响应（如命盘缓存失效）不是 SSE：读出真实错误信息上屏，而非误报"未返回内容"
    if ((res.headers.get("content-type") || "").includes("application/json")) {
      const j = await res.json().catch(() => null);
      throw new Error(j?.error || "服务异常，请稍后重试");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        try {
          const o = JSON.parse(payload);
          if (o.cached) { cachedHit = true; continue; }
          if (o.delta) {
            if (!raw) aiEl.classList.remove("thinking");
            raw += o.delta;
            renderMD(aiEl, raw, true);
            smartScroll(aiEl);
          }
        } catch (_) { /* 忽略不完整分片 */ }
      }
    }
  } catch (e) {
    raw = raw || `> ⚠️ ${e.message}`;
  }
  if (!raw.trim()) raw = "> ⚠️ 推演未返回内容，请重试。";
  aiEl.classList.remove("thinking");
  if (cachedHit) {
    const tag = document.createElement("div");
    tag.className = "cache-tag";
    tag.textContent = "♻ 已复用上次推演结果 · 点击「重新生成」可换一份";
    aiEl.prepend(tag);
  }
  renderMD(aiEl, raw, false);
  const regen = () => ask(question, year, focus, true);
  addBubbleActions(aiEl, raw, regen);
  S.history.push({ role: "assistant", content: raw });
  S.busy = false;
  $("#btn-ask").disabled = false;
}

$("#btn-export").addEventListener("click", exportChat);

$("#btn-ask").addEventListener("click", () => {
  const q = $("#question").value.trim();
  if (!q) return;
  $("#question").value = "";
  ask(q, S.mode === "year" ? S.year : null);
});
$("#question").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const q = $("#question").value.trim();
    if (!q) return;
    $("#question").value = "";
    ask(q, S.mode === "year" ? S.year : null);
  }
});
$("#chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) ask(chip.dataset.q, S.mode === "year" ? S.year : null);
});

/* ---------------- 命盘总览页 ---------------- */
/* 四大命格启发式（命宫主星系定盘，空宫借对宫）；cls = 名片主题色类 */
const MING_GE = [
  { stars: ["七杀", "破军", "贪狼"], name: "杀破狼格", type: "开创型", cls: "ge-sha", desc: "人生主旋律是开新局、破旧局，变动中成事。" },
  { stars: ["紫微", "天府", "廉贞", "武曲", "天相"], name: "紫府相格", type: "领导型", cls: "ge-zi", desc: "稳中掌局，善统御资源、组织人事，以守成与经营见长。" },
  { stars: ["太阳", "巨门", "天机"], name: "巨日格", type: "支援型", cls: "ge-ju", desc: "以言才与专业策动他人，宜传播、参谋与专业路线。" },
  { stars: ["天同", "天梁", "太阴"], name: "机月同梁格", type: "合作型", cls: "ge-ji", desc: "温和周全，长于协调稳健，细水长流。" },
];
function mingGeOf(soul, pal) {
  let names = soul.majorStars.map((s) => s.name);
  if (!names.length) names = pal[(soul.index + 6) % 12].majorStars.map((s) => s.name);
  const ge = MING_GE.find((g) => names.some((n) => g.stars.includes(n))) || MING_GE[3];
  return { ...ge, starNames: names };
}

/* 星曜含义 / 四化含义 / 宫位领域（格局解析 · 一句话说明用） */
const STAR_MEAN = {
  紫微: "帝座主尊贵领导", 天府: "库星主稳健守成", 武曲: "财星主刚毅执行", 天相: "印星主辅佐公正",
  廉贞: "主事业心与原则", 七杀: "主变革冲劲", 破军: "主破旧立新", 贪狼: "主多才交际",
  太阳: "主博爱名声", 太阴: "主细腻蓄藏", 天梁: "荫星主原则庇荫", 天同: "福星主安逸亲和",
  天机: "智星主谋略机变", 巨门: "主口才思辨",
};
const MUT_MEAN = { 禄: "财禄顺遂", 权: "掌控主导", 科: "名誉贵人", 忌: "执念阻滞" };
/* 生年四化小卡扩写：星曜别称 + 四化入宫的影响描述 */
const STAR_NICK = {
  紫微: "帝座", 天府: "库星", 武曲: "财星", 天相: "印星", 廉贞: "事业之星",
  七杀: "将星", 破军: "耗星", 贪狼: "桃花星", 太阳: "光明星", 太阴: "富星",
  天梁: "荫星", 天同: "福星", 天机: "智星", 巨门: "口舌星",
};
const MUT_TAIL = {
  禄: "机遇在此流通，进益顺遂，易得实质好处与人脉助力",
  权: "能量强势主导，掌控与成就欲在此放大，有成亦有压力",
  科: "名声显扬于此，贵人多助，处事得体有分寸",
  忌: "执念与阻滞较重，易纠结内耗，需防反复与是非",
};
const PALACE_DOMAIN = {
  命宫: "性格本质", 兄弟: "平辈情缘", 夫妻: "感情婚姻", 子女: "子嗣晚辈",
  财帛: "理财进财", 疾厄: "健康体质", 迁移: "在外机遇", 仆役: "人脉合作",
  官禄: "事业模式", 田宅: "家运不动产", 福德: "精神生活", 父母: "长上缘",
};
/* 主星亮度权重（含义句选取主星排序用） */
const BR_W = { 庙: 3, 旺: 2.5, 得: 2, 利: 1.5, 平: 1, 不: 0.5, 陷: 0 };
/* 宫位含义句：取最亮的前两颗主星 + 亮度弱化 + 四化含义 */
function palaceMeaning(p) {
  const majors = [...p.majorStars].sort((a, b) => (BR_W[b.brightness] ?? 1.5) - (BR_W[a.brightness] ?? 1.5));
  if (!majors.length) return "无主星，格局随对宫与夹宫流动，断事需借参。";
  return majors.slice(0, 2).map((s) => {
    let t = `${s.name}${STAR_MEAN[s.name] || ""}`;
    if (s.brightness === "陷" || s.brightness === "不") t += `（落${s.brightness}力弱）`;
    if (s.mutagen && MUT_MEAN[s.mutagen]) t += `，化${s.mutagen}主${MUT_MEAN[s.mutagen]}`;
    return t;
  }).join("；") + "。";
}

/* 四化对象/数组 → HTML（星名 + 四色化别徽标，与全站四化体系一致） */
function fmtMutagenHTML(m) {
  return mutPairs(m).map(([k, v]) => `<b>${v}</b><span class="mut ${MUT_CLASS[k] || ""}">${k}</span>`).join("　");
}

/* 亮度 → 三档色标（庙旺=吉 / 得利平=中 / 不陷=凶） */
function brTag(b) {
  if (!b) return "";
  const cls = { 庙: "br-good", 旺: "br-good", 得: "br-mid", 利: "br-mid", 平: "br-mid", 不: "br-bad", 陷: "br-bad" }[b] || "br-mid";
  return `<span class="br ${cls}">${b}</span>`;
}
const mutDot = (m) => (m && MUT_CLASS[m] ? `<span class="mut ${MUT_CLASS[m]}">${m}</span>` : "");

async function renderOverview() {
  try {
  const c = S.chart;
  const pal = S.chart.palaces;   // 数组，按 index 排序
  const soul = pal.find((p) => p.name === "命宫");
  if (!soul) { $("#overview-body").innerHTML = ""; return; }
  const soulIdx = soul.index;
  const tri = [soulIdx, (soulIdx + 4) % 12, (soulIdx + 8) % 12, (soulIdx + 6) % 12];
  // 头部：命格（四大格局启发式）
  const ge = mingGeOf(soul, pal);
  const soulStars = soul.majorStars.map((s) => s.name + (s.brightness || "")).join("·") || `空宫（借对宫${ge.starNames.join("·")}）`;
  const yearStem = (c.chineseDate || "").trim()[0] || "";
  const yy = ("甲丙戊庚壬".includes(yearStem) ? "阳" : "阴") + (S.gender || "男");

  // 当下运势：以真实当前年计算（"你现在在哪"），与大限数据同源
  const nowY = new Date().getFullYear();
  const by = birthYear();
  const age = by ? nowY - by + 1 : null;
  const decP = age != null ? decadeOfAge(age) : null;
  const decades = pal.filter((p) => p.decadal?.range).sort((a, b) => a.decadal.range[0] - b.decadal.range[0]);
  const horo = await loadHoro(nowY, S.month);

  // 格局解析：命宫三方四正四宫卡（星曜 + 亮度 + 化标 + 一句含义）
  const trineCards = tri.map((i, k) => {
    const p = pal[i];
    const badges =
      (p.isBodyPalace ? '<span class="seal gray">身</span>' : "") +
      (p.isOriginalPalace ? '<span class="badge-o">来因</span>' : "");
    const stars = [...p.majorStars, ...p.minorStars].map((s) =>
      `<span class="ps">${s.name}</span>${s.brightness ? `<i>${s.brightness}</i>` : ""}${mutDot(s.mutagen)}`
    ).join(" ") || '<span class="ps" style="color:var(--ink-3);font-weight:400">无主星</span>';
    return `<div class="p-card${k === 0 ? " life" : ""}" data-pidx="${i}">
      <div class="p-hd"><b>${p.name}${k === 0 ? " · " + BRANCH[i] : ""}</b>${badges}<span>${p.heavenlyStem}${p.earthlyBranch}</span></div>
      <div class="p-stars">${stars}</div>
      <div class="p-mean"><b>${PALACE_DOMAIN[p.name] || ""}</b>：${palaceMeaning(p)}</div>
    </div>`;
  }).join("");

  // 生年四化一行（并入格局解析）
  const found = {};
  for (const p of pal) {
    for (const s of [...(p.majorStars || []), ...(p.minorStars || [])]) {
      if (s.mutagen && !found[s.mutagen]) found[s.mutagen] = { star: s.name, palace: p.name };
    }
  }
  const mutLine = ["禄", "权", "科", "忌"].filter((m) => found[m]).map((m) => {
    const f = found[m];
    const domain = PALACE_DOMAIN[f.palace] || "人生领域";
    const nick = STAR_NICK[f.star] ? `${STAR_NICK[f.star]}化${m}，` : "";
    return `<span class="mut-item">
      <span class="mi-hd"><b>${f.star}</b><span class="mut ${MUT_CLASS[m]}">${m}</span><span class="mi-pal">落${f.palace}宫 · ${domain}</span></span>
      <i>${nick}${MUT_TAIL[m]}。</i></span>`;
  }).join("");

  // 当下运势 · 大限卡（未入限给出明确提示）
  let decHTML;
  if (decP && horo?.decadal) {
    const [a, b] = decP.decadal.range;
    const dpal = pal[decP.index];
    decHTML = `<div class="now-card dec">
      <div class="now-hd">当前大限<span>第 ${decades.indexOf(decP) + 1} 大限</span></div>
      <div class="now-big">${a}–${b} 岁</div>
      <div class="now-scope">${by + a - 1} – ${by + b - 1} · 现在 ${age} 岁</div>
      <div class="now-mut">大限四化：${fmtMutagenHTML(horo.decadal.mutagen)}</div>
      <div class="now-desc">大限命宫落本命${dpal.name}，这十年以「${PALACE_DOMAIN[dpal.name] || "人生"}」为轴。</div>
    </div>`;
  } else if (decades.length) {
    const first = decades[0];
    decHTML = `<div class="now-card dec">
      <div class="now-hd">当前大限<span>未入限</span></div>
      <div class="now-big">尚未进入大限</div>
      <div class="now-scope">现在 ${age ?? "—"} 岁 · ${first.decadal.range[0]} 岁起入限（${by + first.decadal.range[0] - 1} 年起）</div>
      <div class="now-desc">童年阶段以本命格局为底盘，暂无大限引动。</div>
    </div>`;
  } else {
    decHTML = "";
  }

  // 当下运势 · 流年卡（流年以立春为界，展示真实公历起讫）
  const yrHTML = horo?.yearly ? (() => {
    const ypal = pal[horo.yearly.index];
    const sr = horo.yearly.solarRange;
    return `<div class="now-card yr">
      <div class="now-hd">今年流年<span>${nowY} ${zodiacOf(nowY)}年</span></div>
      <div class="now-big">流年命宫 · ${BRANCH[horo.yearly.index]}</div>
      <div class="now-scope">叠本命${ypal.name}宫${sr ? ` · 公历 ${sr[0]} ~ ${sr[1]}（立春界）` : ""}</div>
      <div class="now-mut">流年四化：${fmtMutagenHTML(horo.yearly.mutagen)}</div>
      <div class="now-desc">今年主题以「${PALACE_DOMAIN[ypal.name] || "人生"}」为轴。</div>
    </div>`;
  })() : "";

  $("#overview-body").innerHTML = `
    <section class="ov-hero ${ge.cls}">
      <div class="ge-name">${ge.name}<span class="ge-note">· ${ge.type}</span></div>
      <div class="ge-desc">${ge.desc}</div>
      <div class="ge-meta"><b>${soulStars}</b> 坐命${BRANCH[soulIdx]}宫 · ${yy} · ${c.fiveElementsClass} · 命主${c.soul} 身主${c.body}</div>
    </section>

    <div class="ov-sec">格局解析<span>命宫三方四正 · 每宫含义</span></div>
    <div class="p-grid">${trineCards}</div>
    <div class="mut-line"><span class="cap">生年四化</span><div class="mut-items">${mutLine}</div></div>

    <div class="ov-sec">当下运势<span>你现在在哪 · 今年主题</span></div>
    <div class="now-grid">${decHTML}${yrHTML}</div>`;
  } catch (e) {
    console.error("renderOverview:", e);
    $("#overview-body").innerHTML = `<div style="padding:40px;text-align:center;color:var(--ink-2);font-size:13px">总览渲染出错：${(e && e.message) || e}</div>`;
  }
}

$("#overview-body").addEventListener("click", (e) => {
  const card = e.target.closest(".p-card");
  if (!card) return;
  switchMode("natal");
  goChart();
  selectPalace(parseInt(card.dataset.pidx, 10));
});
$("#btn-enter-chart").addEventListener("click", goChart);
$("#btn-overview").addEventListener("click", goOverview);

/* 初始路由：若门户已登录，恢复会话并用档案出生信息自动排盘（全站一次登录） */
(function bootstrap() {
  const p = restoreSession();
  if (p) {
    S.profile = p;
    renderProfileChip();
    chartFromProfile();   // 内部会切到 #/overview 并渲染命盘
  } else {
    route();
  }
})();
