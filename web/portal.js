/* 命理馆门户逻辑：hash 路由 + 登录 + 四功能（八字/梅花/塔罗/黄历）+ 历史。
   设计：确定性计算先展示（可核对），再按需请求 AI 流式解读；全程复用后端 /api/。 */
(function () {
  "use strict";

  var S = {
    feature: "home",
    profile: null,       // {id, token, name}
    busy: false,
    stageCache: {},      // feature -> 持久 DOM 容器；切页只隐藏/显示，不销毁
  };
  // 每个功能持有自己的舞台容器。切到别的功能时只隐藏，正在进行的 AI 流式解读
  // 仍写到原容器里继续跑；切回来时提问框、解读结果、追问链都原样还在。
  function stageEl() {
    var f = S.feature;
    var el = S.stageCache[f];
    if (!el) {
      el = document.createElement("div");
      el.className = "p-wrap";
      el.id = "p-stage-" + f;
      el.dataset.feature = f;
      $("#p-content").appendChild(el);
      S.stageCache[f] = el;
    }
    return el;
  }
  try {
    var raw = localStorage.getItem("zw-profile");
    if (raw) S.profile = JSON.parse(raw);
  } catch (e) {}

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
  }); };

  /* ---------------- 工具 ---------------- */
  function toast(msg) {
    var t = $("#p-toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }
  function authParam() {
    return S.profile ? "&profile_id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token) : "";
  }
  /* AI 功能登录门禁：各功能的门文案 */
  var AI_GATES = {
    bazi:   { title: "AI 八字问答", desc: "基于您的八字，可就具体问题继续提问，答复仅供参考。" },
    meihua: { title: "AI 梅花解卦", desc: "基于本次卦象，可就所问之事继续提问，答复仅供参考。" },
    tarot:  { title: "AI 塔罗解读", desc: "基于本次牌阵，可就所问之事继续提问，答复仅供参考。" },
    huangli:{ title: "AI 黄历答疑", desc: "基于当日历注，可就择日事项继续提问，答复仅供参考。" },
    ziwei:  { title: "AI 紫微推演", desc: "基于本次命盘，可就格局与运限继续提问，答复仅供参考。" }
  };
  /* 未登录时的门禁块：模糊的假提问框 + 锁 + 标题说明 + 登录按钮（对齐参考图） */
  function aiGateBlock(feature) {
    var cfg = AI_GATES[feature] || AI_GATES.bazi;
    return '<div class="ai-gate">' +
      '<div class="ag-fake" aria-hidden="true">' +
        '<div class="ag-fake-chip"></div><div class="ag-fake-chip ag-fake-short"></div>' +
        '<div class="ag-fake-row"><span></span><b></b></div></div>' +
      '<div class="ag-front">' +
        '<svg class="ag-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>' +
        '<div class="ag-title">' + esc(cfg.title) + '</div>' +
        '<p class="ag-desc">' + esc(cfg.desc) + '</p>' +
        '<button type="button" class="ag-btn">立即登录 / 注册</button>' +
      '</div></div>';
  }
  function bindAIGate(root) {
    var b = root && $(".ag-btn", root);
    if (b) b.onclick = openAuth;
  }
  /* 统一门禁守卫：未登录则拦下 AI 解读/追问并弹出登录框。返回 true 表示已拦截。 */
  function requireLogin() {
    if (S.profile) return false;
    toast("请先登录或使用 AI 解读与追问");
    openAuth();
    return true;
  }
  /* 在每个功能舞台渲染后调用：未登录时在表单与结果之间插入门禁卡，
     并给舞台加 stage-locked（CSS 隐藏真正的 AI 提问框/按钮），登录后自动移除。 */
  function applyGate(feature) {
    var st = stageEl();
    st.classList.toggle("stage-locked", !S.profile);
    var old = $(".ai-gate-host", st);
    if (old) old.remove();
    if (S.profile) return;
    var host = document.createElement("div");
    host.className = "ai-gate-host";
    host.innerHTML = aiGateBlock(feature);
    // 门禁卡放在确定性结果（卦象/牌面/历注/命盘）之后、「关于」说明之前，
    // 即与登录后 AI 提问框出现的位置一致（结果卡下方），宽度也与结果卡对齐。
    var about = $(".about-details", st);
    if (about) st.insertBefore(host, about);
    else st.appendChild(host);
    bindAIGate(host);
  }
  /* 档案出生信息变更后：清掉本地命盘缓存（否则旧盘仍被复用），并刷新档案副本 */
  function profileBirthChanged() {
    try { sessionStorage.removeItem("zw-chart-v1"); } catch (e) {}
    if (S.zw) { S.zw.chart = null; S.zw.id = null; S.zw.key = null; S.zw.horo = null; }
    if (S.profile) {
      fetch("/api/profile/get?id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token))
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok && d.profile) S.profileBirth = d.profile.birth || null;
        }).catch(function () {});
    }
  }
  /* 销毁所有功能舞台缓存（提问/解读/追问/门禁 DOM）。登录或退出都必须调用：
     否则其它功能里"未登录态"缓存的舞台（带门禁）在登录后切回去仍是门禁。 */
  function dropStages() {
    Object.keys(S.stageCache).forEach(function (k) {
      var el = S.stageCache[k];
      if (el && el.parentNode) el.parentNode.removeChild(el);
      delete S.stageCache[k];
    });
    S.busyKeys = {};
  }
  /* 退出登录时清空本账号全部前端缓存：各功能舞台上的提问/解读/追问、命盘、
     紫微 session 缓存、个人中心的历史与出生信息。避免退出后仍能翻到上一个人的对话。 */
  function clearUserData() {
    dropStages();
    S.profileBirth = null;
    S.zw = null; S.zwFromProfile = false;
    try { sessionStorage.removeItem("zw-chart-v1"); } catch (e) {}
    pfState = { filter: "", date: "", items: [], dates: [], editBirth: false, editAccount: false, birth: null };
  }
  function setProfile(p) {
    var wasLogged = !!S.profile;
    var changed = wasLogged !== !!p;
    S.profile = p;
    try { p ? localStorage.setItem("zw-profile", JSON.stringify(p)) : localStorage.removeItem("zw-profile"); } catch (e) {}
    if (changed) {
      if (!p) clearUserData();
      else dropStages();   // 登录：清掉"未登录态"的舞台，切到任何功能都按已登录重建
    }
    renderUser();
    // 登录/退出后立刻刷新当前视图：个人中心刷新统计，其它页强制重建（门禁 ↔ 档案带入）
    if (changed && S.feature === "profile") renderProfile();
    else if (changed) navigate(S.feature, true);
  }
  function renderUser() {
    var el = $("#p-user");
    el.innerHTML = S.profile
      ? esc(S.profile.name) + ' <a id="p-logout">退出</a>'
      : '<a id="p-login-link">登录</a>';
    var lo = $("#p-logout");
    if (lo) lo.onclick = function () { setProfile(null); toast("已退出"); };
    var li = $("#p-login-link");
    if (li) li.onclick = openAuth;
    // 底部同一个按钮：未登录=登录/注册；已登录=个人中心，就地切换，不留冗余占位
    var ab = $("#p-auth-btn");
    var lab = $("#p-auth-label");
    if (ab) {
      if (S.profile) {
        if (lab) lab.textContent = "个人中心 · " + S.profile.name;
        ab.classList.add("is-profile");
        ab.onclick = function () { go("profile"); };
      } else {
        if (lab) lab.textContent = "登录 / 注册";
        ab.classList.remove("is-profile");
        ab.onclick = openAuth;
      }
    }
  }

  /* ---------------- 路由 ---------------- */
  function parseHash() {
    var h = (location.hash || "").replace(/^#\/?/, "");
    var feat = h.split("?")[0] || "home";
    return feat;
  }
  /* 移动端抽屉导航 */
  function closeNav() {
    if (!document.body.classList.contains("nav-open")) return;
    document.body.classList.remove("nav-open");
    var b = $("#p-burger");
    if (b) b.setAttribute("aria-expanded", "false");
  }
  function toggleNav() {
    var open = document.body.classList.toggle("nav-open");
    var b = $("#p-burger");
    if (b) b.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function go(feat) {
    var locked = ["liuyao", "qimen"].indexOf(feat) >= 0;
    if (locked) { toast("该功能在二期上线，敬请期待"); return; }
    location.hash = "/meihua" === ("/" + feat) ? feat : feat; // 统一 #/xxx
  }
  function navigate(feat, force) {
    var changed = S.feature !== feat;
    S.feature = feat;
    closeNav();
    $$(".p-navitem").forEach(function (b) { b.classList.toggle("active", b.dataset.feature === feat); });
    var ab = $("#p-auth-btn");
    if (ab) ab.classList.toggle("current", feat === "profile");
    var names = { home:"首页",bazi:"八字排盘",ziwei:"紫微斗数",meihua:"梅花易数",liuyao:"六爻",qimen:"奇门遁甲",
      tarot:"塔罗牌",huangli:"黄历",profile:"个人中心" };
    $("#p-crumb").textContent = names[feat] || feat;
    // 隐藏所有已建舞台，只显示当前功能的；DOM 不销毁 → 提问框/解读/追问/进行中的 SSE 全部保留
    Object.keys(S.stageCache).forEach(function (k) { S.stageCache[k].style.display = "none"; });
    var st = stageEl();
    st.style.display = "";
    // 个人中心每次进入都刷新（历史/统计可能已变）；其余功能首次渲染或强制时才重建
    if (feat === "profile") { renderProfile(); return; }
    if (st.dataset.ready === "1" && !force) return;  // 已有内容，切回来直接复用
    st.dataset.ready = "1";
    if (feat === "home") { renderHome(); return; }
    if (feat === "ziwei") { renderZiweiEntry(); return; }
    var fn = { bazi: renderBazi, meihua: renderMeihua, tarot: renderTarot, huangli: renderHuangli }[feat];
    if (fn) { fn(); }
  }

  /* ---------------- 通用渲染块 ---------------- */
  function hero(tag, title, desc) {
    return '<div class="p-hero"><span class="p-hero-tag">' + tag + '</span>' +
      '<h1>' + title + '</h1><p>' + desc + '</p></div>';
  }
  function sec(no, title, body) {
    return '<section class="p-sec"><div class="p-sec-h"><span class="p-sec-no">' + no + '</span><h2>' + title + '</h2></div>' + body + '</section>';
  }
  function term(name, desc) {
    return '<div class="p-term"><b>' + name + '</b><span>' + desc + '</span></div>';
  }
  // 参考站工具页风格：居中的标题 + 一行副标题，不使用编号叙事块
  function toolHero(title, sub) {
    return '<div class="tool-hero"><h1>' + esc(title) + '</h1><p>' + esc(sub) + '</p></div>';
  }
  // 结果区简洁标题（无编号圆圈）
  function resultTitle(t) {
    return '<div class="result-title">' + esc(t) + '</div>';
  }
  // 折叠的使用说明，放在表单下方，默认收起（用原生 details，浏览器自带开合，不依赖脚本）
  /* 折叠说明：不能用原生 <details>——实测在用户的 Chrome 环境里 open 属性生效但内容不渲染；
     用按钮 + .open 类驱动（display 由 CSS 显式控制，不依赖 hidden 属性与 details 机制） */
  function aboutDetails(title, bullets, note) {
    return '<div class="about-details">' +
      '<button class="ad-toggle" type="button" aria-expanded="false"><span class="ad-sign"></span>关于本功能 · 原理与边界</button>' +
      '<div class="ad-body"><h4>' + esc(title) + '</h4><ul>' +
      bullets.map(function (b) { return '<li>' + b + '</li>'; }).join("") +
      '</ul>' + (note ? '<p class="ad-note">' + esc(note) + '</p>' : '') + '</div></div>';
  }
  function steps(items) {
    return '<div class="p-steps">' + items.map(function (it, i) {
      return '<div class="p-step"><span class="p-step-n">' + (i + 1) + '</span><div class="p-step-body">' + it + '</div></div>';
    }).join("") + "</div>";
  }

  /* ---------------- 登录弹层 ---------------- */
  function openAuth() {
    var box = $("#p-auth-content");
    box.innerHTML =
      '<div class="p-auth-head"><h2>欢迎使用 Destiny Master</h2><p>登录或注册账号以使用完整功能</p></div>' +
      '<div class="p-auth-tabs"><button class="on" data-t="login">登录</button><button data-t="reg">注册档案</button></div>' +
      '<div id="p-auth-form"></div>';
    function showForm(t) {
      $$(".p-auth-tabs button", box).forEach(function (b) { b.classList.toggle("on", b.dataset.t === t); });
      var f = $("#p-auth-form", box);
      if (t === "login") {
        f.innerHTML =
          '<div class="p-frow"><label class="p-flabel">用户名</label><input class="p-input" id="au-name" autocomplete="off" /></div>' +
          '<div class="p-frow" style="margin-top:12px"><label class="p-flabel">密码</label><input class="p-input" id="au-pass" type="password" /></div>' +
          '<div class="p-err" id="au-err"></div>' +
          '<button class="auth-submit" id="au-submit">登录 / 注册</button>' +
          '<p class="p-note" style="text-align:center">登录后可保存出生档案、历史提问，获得跨功能的个性化解读。</p>';
      } else {
        f.innerHTML =
          '<div class="p-frow"><label class="p-flabel">用户名（2~24 位字母数字下划线）</label><input class="p-input" id="au-name" maxlength="24" /></div>' +
          '<div class="p-inline" style="margin-top:12px">' +
            '<div class="p-frow"><label class="p-flabel">密码（≥6位）</label><input class="p-input" id="au-pass" type="password" /></div>' +
            '<div class="p-frow"><label class="p-flabel">确认密码</label><input class="p-input" id="au-pass2" type="password" /></div>' +
          '</div>' +
          '<div class="p-frow" style="margin-top:16px">' + birthFieldsHTML("au", { title: "出生信息", compact: true }) + '</div>' +
          '<div class="p-frow" style="margin-top:12px"><label class="p-flabel">性别</label><div class="p-seg" id="au-gender"><button class="on" data-v="男">男</button><button data-v="女">女</button></div></div>' +
          '<div class="p-err" id="au-err"></div>' +
          '<button class="auth-submit" id="au-submit">注册并登录</button>';
        birthFieldsBind("au");
        segBind($("#au-gender", f));
      }
      $("#au-submit", f).onclick = function () { submitAuth(t); };
    }
    $$(".p-auth-tabs button", box).forEach(function (b) { b.onclick = function () { showForm(b.dataset.t); }; });
    showForm("login");
    closeNav();   // 移动端：从抽屉点开登录后先收起抽屉，否则会压住弹窗
    $("#p-modal").classList.remove("hidden");
  }
  function segBind(seg) {
    if (!seg) return;
    $$("button", seg).forEach(function (b) { b.onclick = function () {
      $$("button", seg).forEach(function (x) { x.classList.remove("on"); }); b.classList.add("on");
    }; });
  }
  function segVal(seg) { var b = $(".on", seg || document); return b ? b.dataset.v : ""; }

  /* ---------------- 出生信息控件组（八字页与注册弹窗共用） ----------------
     排版严格按参考样式：标题行右侧「输入方式：日期/八字」，左列出生日期，
     右列「我知道出生时间」开关 + 时/分下拉；日期经「选择日期」弹窗挑选。 */
  var LN_DAYS = (function () {
    var cn = ["一","二","三","四","五","六","七","八","九","十"], out = [];
    for (var i = 1; i <= 30; i++) {
      if (i === 10) out.push("初十");
      else if (i === 20) out.push("二十");
      else if (i === 30) out.push("三十");
      else if (i < 10) out.push("初" + cn[i - 1]);
      else if (i < 20) out.push("十" + cn[i - 11]);
      else out.push("廿" + cn[i - 21]);
    }
    return out;
  })();
  var GZ60 = (function () {
    var G = "甲乙丙丁戊己庚辛壬癸".split(""), Z = "子丑寅卯辰巳午未申酉戌亥".split(""), a = [];
    for (var i = 0; i < 60; i++) a.push(G[i % 10] + Z[i % 12]);
    return a;
  })();
  var CAL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  function birthFieldsHTML(pfx, opts) {
    opts = opts || {};
    var hours = "", mins = "";
    for (var h = 0; h < 24; h++) hours += '<option value="' + h + '">' + h + '时</option>';
    for (var m2 = 0; m2 < 60; m2++) mins += '<option value="' + m2 + '">' + m2 + '分</option>';
    var gzOpts = GZ60.map(function (g) { return '<option>' + g + '</option>'; }).join("");
    var head = opts.title ?
      '<div class="bf-head"><span class="bf-title">' + opts.title + '</span>' +
        '<span class="bf-modes">输入方式：<span class="p-seg bf-mode" id="' + pfx + '-mode">' +
          '<button class="on" data-v="date">日期</button><button data-v="bazi">八字</button></span></span></div>' : "";
    var pillars = [["py","年柱"],["pm","月柱"],["pd","日柱"],["pt","时柱"]].map(function (it) {
      return '<div class="tf-field"><label>' + it[1] + '</label><select class="ti" id="' + pfx + '-' + it[0] + '">' + gzOpts + '</select></div>';
    }).join("");
    return '' +
      '<div class="bf-wrap' + (opts.compact ? " bf-compact" : "") + '">' + head +
        '<div id="' + pfx + '-mdate">' +
          '<div class="bf-grid">' +
            '<div class="bf-a1"><label class="bf-lab">出生日期</label></div>' +
            '<div class="bf-b1"><label id="' + pfx + '-tlabel" class="bf-lab" for="' + pfx + '-hour">出生时间</label></div>' +
            '<div class="bf-a2"><div class="p-seg bf-cal" id="' + pfx + '-cal"><button class="on" data-v="solar">阳历</button><button data-v="lunar">农历</button></div></div>' +
            '<div class="bf-b2"><label class="p-switch"><input type="checkbox" id="' + pfx + '-knowtime" checked /><span>我知道出生时间</span></label>' +
              '<p class="p-note bf-hint" id="' + pfx + '-kthint">如果不知道确切出生时间，可以不选择</p></div>' +
            '<div class="bf-a3">' +
              '<button type="button" class="bf-datebtn" id="' + pfx + '-datebtn"><span id="' + pfx + '-datebtn-t">1990年6月15日</span><i>' + CAL_ICON + '</i></button>' +
              '<input type="hidden" id="' + pfx + '-date" value="1990-06-15" />' +
              '<input type="hidden" id="' + pfx + '-ly" value="1990" />' +
              '<input type="hidden" id="' + pfx + '-lm" value="1" />' +
              '<input type="hidden" id="' + pfx + '-ld" value="1" />' +
            '</div>' +
            '<div class="bf-b3"><div class="bf-time" id="' + pfx + '-time">' +
              '<select class="ti" id="' + pfx + '-hour">' + hours + '</select>' +
              '<select class="ti" id="' + pfx + '-minute">' + mins + '</select>' +
            '</div></div>' +
          '</div>' +
        '</div>' +
        '<div id="' + pfx + '-mbazi" style="display:none">' +
          '<div class="bf-pillars">' + pillars + '</div>' +
          '<p class="p-note">直接输入已知的四柱干支，系统将反查对应的出生日期后排盘。</p>' +
        '</div>' +
      '</div>';
  }
  var LN_MONTHS = ["正月","二月","三月","四月","五月","六月","七月","八月","九月","十月","冬月","腊月"];
  var CN_DIGITS = ["〇","一","二","三","四","五","六","七","八","九"];
  function cnYear(y) { return String(y).split("").map(function (c) { return CN_DIGITS[+c]; }).join(""); }
  function refreshBirthBtn(pfx) {
    var cal = segVal($("#" + pfx + "-cal")) || "solar";
    var t;
    if (cal === "solar") {
      var v = ($("#" + pfx + "-date").value || "1990-06-15").split("-");
      t = (+v[0]) + "年" + (+v[1]) + "月" + (+v[2]) + "日";
    } else {
      t = "农历 " + cnYear(+$("#" + pfx + "-ly").value || 1990) + "年" +
        LN_MONTHS[(+$("#" + pfx + "-lm").value || 1) - 1] + LN_DAYS[(+$("#" + pfx + "-ld").value || 1) - 1];
    }
    $("#" + pfx + "-datebtn-t").textContent = t;
  }
  function birthSetDate(pfx, y, m, d) {
    $("#" + pfx + "-date").value = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    refreshBirthBtn(pfx);
  }
  function birthSetLunar(pfx, y, m, d) {
    $("#" + pfx + "-ly").value = y; $("#" + pfx + "-lm").value = m; $("#" + pfx + "-ld").value = d;
    refreshBirthBtn(pfx);
  }
  // 绑定控件组行为；init = {mode, calendar, year, month, day, hour, minute, know_time, pillars}
  function birthFieldsBind(pfx, init) {
    var cal = (init && init.calendar) || "solar";
    function applyCal() { refreshBirthBtn(pfx); }
    $$("#" + pfx + "-cal button").forEach(function (b) {
      b.onclick = function () { segSet($("#" + pfx + "-cal"), b.dataset.v); applyCal(); };
    });
    $("#" + pfx + "-datebtn").onclick = function () {
      if (segVal($("#" + pfx + "-cal")) === "lunar") openLunarPicker(pfx);
      else openDatePicker(pfx);
    };
    function applyTime() {
      var kt = $("#" + pfx + "-knowtime").checked;
      $("#" + pfx + "-time").style.display = kt ? "grid" : "none";
      $("#" + pfx + "-tlabel").style.display = kt ? "" : "none";
      $("#" + pfx + "-kthint").style.display = kt ? "none" : "";
    }
    $("#" + pfx + "-knowtime").onchange = applyTime;
    function applyMode() {
      var v = segVal($("#" + pfx + "-mode")) || "date";
      $("#" + pfx + "-mdate").style.display = v === "date" ? "" : "none";
      $("#" + pfx + "-mbazi").style.display = v === "bazi" ? "" : "none";
    }
    $$("#" + pfx + "-mode button").forEach(function (b) {
      b.onclick = function () { segSet($("#" + pfx + "-mode"), b.dataset.v); applyMode(); };
    });
    if (init) {
      if (init.mode) segSet($("#" + pfx + "-mode"), init.mode);
      segSet($("#" + pfx + "-cal"), cal);
      if (init.year) {
        if (cal === "lunar") birthSetLunar(pfx, init.year, init.month, init.day);
        else birthSetDate(pfx, init.year, init.month, init.day);
      }
      if (init.pillars) {
        $("#" + pfx + "-py").value = init.pillars.year;
        $("#" + pfx + "-pm").value = init.pillars.month;
        $("#" + pfx + "-pd").value = init.pillars.day;
        $("#" + pfx + "-pt").value = init.pillars.time;
      }
      if (init.hour != null) $("#" + pfx + "-hour").value = String(init.hour);
      if (init.minute != null) $("#" + pfx + "-minute").value = String(init.minute);
      $("#" + pfx + "-knowtime").checked = init.know_time !== false;
    }
    applyCal(); applyTime(); applyMode();
  }
  // 收集控件组数值；日期方式 {mode:"date", calendar, year, month, day, hour, minute, know_time}
  // 八字方式 {mode:"bazi", pillar_year, pillar_month, pillar_day, pillar_time}
  function birthCollect(pfx) {
    var mode = segVal($("#" + pfx + "-mode")) || "date";
    if (mode === "bazi") {
      return { mode: "bazi",
        pillar_year: $("#" + pfx + "-py").value, pillar_month: $("#" + pfx + "-pm").value,
        pillar_day: $("#" + pfx + "-pd").value, pillar_time: $("#" + pfx + "-pt").value };
    }
    var cal = segVal($("#" + pfx + "-cal")) || "solar";
    var out = { mode: "date", calendar: cal };
    if (cal === "solar") {
      var d = $("#" + pfx + "-date").value.split("-");
      out.year = +d[0]; out.month = +d[1]; out.day = +d[2];
    } else {
      out.year = +$("#" + pfx + "-ly").value || 1990;
      out.month = +$("#" + pfx + "-lm").value || 1;
      out.day = +$("#" + pfx + "-ld").value || 1;
    }
    var kt = $("#" + pfx + "-knowtime").checked;
    out.know_time = kt;
    out.hour = kt ? (+$("#" + pfx + "-hour").value || 0) : 12;
    out.minute = kt ? (+$("#" + pfx + "-minute").value || 0) : 0;
    return out;
  }

  /* ---------------- 「选择日期」弹窗（年月下拉 + 周一起始月历网格） ---------------- */
  var DP_CN_M = ["一月","二月","三月","四月","五月","六月","七月","八月","九月","十月","十一月","十二月"];
  var dpEl = null, dpPfx = null, dpY = 0, dpM = 1, dpOnPick = null, dpPickVal = "";
  function dpSync() {
    $("#dp-y", dpEl).value = String(dpY);
    $("#dp-m", dpEl).value = String(dpM);
  }
  function dpRender() {
    $("#dp-cap", dpEl).textContent = DP_CN_M[dpM - 1] + " " + dpY;
    var lead = (new Date(dpY, dpM - 1, 1).getDay() + 6) % 7;   // 周一起始
    var dim = new Date(dpY, dpM, 0).getDate();
    var prevDim = new Date(dpY, dpM - 1, 0).getDate();
    var total = Math.ceil((lead + dim) / 7) * 7;
    var sel = dpOnPick ? String(dpPickVal || "").split("-").map(Number)
                       : (($("#" + dpPfx + "-date") || { value: "" }).value || "").split("-").map(Number);
    var td = new Date();
    var html = "";
    for (var i = 0; i < total; i++) {
      var dnum, mm, yy, cls = "dp-cell";
      if (i < lead) { dnum = prevDim - lead + 1 + i; mm = dpM - 1; yy = dpY; cls += " dim"; if (mm < 1) { mm = 12; yy--; } }
      else if (i >= lead + dim) { dnum = i - lead - dim + 1; mm = dpM + 1; yy = dpY; cls += " dim"; if (mm > 12) { mm = 1; yy++; } }
      else { dnum = i - lead + 1; mm = dpM; yy = dpY; }
      if (sel.length === 3 && sel[0] === yy && sel[1] === mm && sel[2] === dnum) cls += " sel";
      else if (yy === td.getFullYear() && mm === td.getMonth() + 1 && dnum === td.getDate()) cls += " today";
      html += '<div class="' + cls + '" data-y="' + yy + '" data-m="' + mm + '" data-d="' + dnum + '">' + dnum + '</div>';
    }
    $("#dp-grid", dpEl).innerHTML = html;
  }
  function dpEnsure() {
    if (dpEl) return;
    dpEl = document.createElement("div");
    dpEl.className = "dp-mask hidden";
    dpEl.innerHTML =
      '<div class="dp-modal">' +
        '<div class="dp-head"><b>选择日期</b><button type="button" class="dp-x">✕</button></div>' +
        '<div class="dp-ym"><select class="ti" id="dp-y"></select><select class="ti" id="dp-m">' +
          DP_CN_M.map(function (t, i) { return '<option value="' + (i + 1) + '">' + t + '</option>'; }).join("") +
        '</select></div>' +
        '<div class="dp-card">' +
          '<div class="dp-title"><button type="button" class="dp-nav" id="dp-prev">‹</button><b id="dp-cap"></b><button type="button" class="dp-nav" id="dp-next">›</button></div>' +
          '<div class="dp-wk">' + ["一","二","三","四","五","六","日"].map(function (t) { return "<span>" + t + "</span>"; }).join("") + '</div>' +
          '<div class="dp-grid" id="dp-grid"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dpEl);
    var years = "";
    for (var y = 1901; y <= 2099; y++) years += '<option value="' + y + '">' + y + '年</option>';
    $("#dp-y", dpEl).innerHTML = years;
    $("#dp-y", dpEl).onchange = function () { dpY = +this.value; dpRender(); };
    $("#dp-m", dpEl).onchange = function () { dpM = +this.value; dpRender(); };
    $("#dp-prev", dpEl).onclick = function () { dpM--; if (dpM < 1) { dpM = 12; dpY--; } dpSync(); dpRender(); };
    $("#dp-next", dpEl).onclick = function () { dpM++; if (dpM > 12) { dpM = 1; dpY++; } dpSync(); dpRender(); };
    $(".dp-x", dpEl).onclick = dpClose;
    dpEl.addEventListener("mousedown", function (e) { if (e.target === dpEl) dpClose(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") dpClose(); });
    $("#dp-grid", dpEl).addEventListener("click", function (e) {
      var c = e.target.closest(".dp-cell");
      if (!c) return;
      if (dpOnPick) {
        dpOnPick(+c.dataset.y, +c.dataset.m, +c.dataset.d);
      } else {
        birthSetDate(dpPfx, +c.dataset.y, +c.dataset.m, +c.dataset.d);
      }
      dpClose();
    });
  }
  function openDatePicker(pfx) {
    dpEnsure();
    dpPfx = pfx; dpOnPick = null;
    var v = ($("#" + pfx + "-date").value || "").split("-");
    var td = new Date();
    dpY = +v[0] || td.getFullYear();
    dpM = +v[1] || td.getMonth() + 1;
    dpSync(); dpRender();
    dpEl.classList.remove("hidden");
  }
  // 通用「选日期」弹窗（个人中心按日期查找）：复用出生日期同款日历，选完回调，不写入任何出生字段
  function openDateLookup(initial, onPick) {
    dpEnsure();
    dpOnPick = onPick;
    dpPickVal = initial || "";
    var v = dpPickVal.split("-");
    var td = new Date();
    dpY = +v[0] || td.getFullYear();
    dpM = +v[1] || td.getMonth() + 1;
    dpSync(); dpRender();
    dpEl.classList.remove("hidden");
  }
  function dpClose() { if (dpEl) dpEl.classList.add("hidden"); dpOnPick = null; }

  /* ---------------- 「选择农历日期」弹窗（年份/月份/日期 三下拉 + 确认） ---------------- */
  var lpEl = null, lpPfx = null;
  function openLunarPicker(pfx) {
    if (!lpEl) {
      lpEl = document.createElement("div");
      lpEl.className = "dp-mask hidden";
      var yOpts = "";
      for (var y = 1901; y <= 2099; y++) yOpts += '<option value="' + y + '">' + y + '年</option>';
      var mOpts = LN_MONTHS.map(function (t, i) { return '<option value="' + (i + 1) + '">' + t + '</option>'; }).join("");
      var dOpts = LN_DAYS.map(function (t, i) { return '<option value="' + (i + 1) + '">' + t + '</option>'; }).join("");
      lpEl.innerHTML =
        '<div class="dp-modal">' +
          '<div class="dp-head"><b>选择农历日期</b><button type="button" class="dp-x">✕</button></div>' +
          '<div class="lp-grid">' +
            '<div class="lp-f"><label>年份</label><select class="ti" id="lp-y">' + yOpts + '</select></div>' +
            '<div class="lp-f"><label>月份</label><select class="ti" id="lp-m">' + mOpts + '</select></div>' +
            '<div class="lp-f"><label>日期</label><select class="ti" id="lp-d">' + dOpts + '</select></div>' +
          '</div>' +
          '<div class="lp-foot"><button type="button" class="dp-ok" id="lp-ok">确认</button></div>' +
        '</div>';
      document.body.appendChild(lpEl);
      $(".dp-x", lpEl).onclick = lpClose;
      lpEl.addEventListener("mousedown", function (e) { if (e.target === lpEl) lpClose(); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") lpClose(); });
      $("#lp-ok", lpEl).onclick = function () {
        birthSetLunar(lpPfx, +$("#lp-y", lpEl).value, +$("#lp-m", lpEl).value, +$("#lp-d", lpEl).value);
        lpClose();
      };
    }
    lpPfx = pfx;
    $("#lp-y", lpEl).value = $("#" + pfx + "-ly").value || "1990";
    $("#lp-m", lpEl).value = $("#" + pfx + "-lm").value || "1";
    $("#lp-d", lpEl).value = $("#" + pfx + "-ld").value || "1";
    lpEl.classList.remove("hidden");
  }
  function lpClose() { if (lpEl) lpEl.classList.add("hidden"); }

  function doAuth(url, body, okMsg, err) {
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { err.textContent = d.error || "操作失败"; return; }
        setProfile({ id: d.profile_id, token: d.token, name: d.name });
        $("#p-modal").classList.add("hidden");
        toast(okMsg);
        // 登录后强制重建当前页：移除 AI 门禁、带入档案出生信息、个人中心刷新统计
        if (S.feature === "profile") renderProfile();
        else navigate(S.feature, true);
      })
      .catch(function (e) { err.textContent = "网络错误：" + e.message; });
  }
  function submitAuth(t) {
    var name = $("#au-name").value.trim(), pass = $("#au-pass").value;
    var err = $("#au-err"); err.textContent = "";
    if (t === "login") {
      doAuth("/api/profile/login", { name: name, password: pass }, "登录成功", err);
      return;
    }
    if (pass !== $("#au-pass2").value) { err.textContent = "两次密码不一致"; return; }
    var gender = segVal($("#au-gender"));
    var bc = birthCollect("au");
    if (bc.mode === "bazi") {
      // 八字方式：先由四柱反查出生公历日期，再建立档案
      fetch("/api/bazi/pillars_to_date?pillar_year=" + encodeURIComponent(bc.pillar_year) +
        "&pillar_month=" + encodeURIComponent(bc.pillar_month) +
        "&pillar_day=" + encodeURIComponent(bc.pillar_day) +
        "&pillar_time=" + encodeURIComponent(bc.pillar_time))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) { err.textContent = d.error || "无法由该八字推算出生日期"; return; }
          doAuth("/api/profile/register", { name: name, password: pass,
            birth: { calendar: "solar", year: d.year, month: d.month, day: d.day,
              hour: d.hour, minute: 0, know_time: true, gender: gender } }, "档案已建立", err);
        })
        .catch(function (e) { err.textContent = "网络错误：" + e.message; });
      return;
    }
    if (!bc.year || !bc.month || !bc.day) { err.textContent = "请选择出生日期"; return; }
    doAuth("/api/profile/register", { name: name, password: pass,
      birth: { calendar: bc.calendar, year: bc.year, month: bc.month, day: bc.day,
        hour: bc.hour, minute: bc.minute, know_time: bc.know_time, gender: gender } }, "档案已建立", err);
  }

  // 八字日期部分查询串：日期方式带 calendar/year/...；八字方式带四柱干支
  function baziQS(p) {
    if (p.mode === "bazi")
      return "pillar_year=" + encodeURIComponent(p.pillar_year) + "&pillar_month=" + encodeURIComponent(p.pillar_month) +
        "&pillar_day=" + encodeURIComponent(p.pillar_day) + "&pillar_time=" + encodeURIComponent(p.pillar_time);
    return "calendar=" + p.calendar + "&year=" + p.year + "&month=" + p.month + "&day=" + p.day +
      "&hour=" + p.hour + "&minute=" + p.minute;
  }

  /* ================= 落地首页 ================= */
  function renderHome() {
    var FEATURES = [
      { feat: "bazi",   tag: "八字命理", name: "八字排盘", desc: "四柱十神、五行喜忌、大运流年，就一张盘继续追问。",
        icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>' },
      { feat: "ziwei",  tag: "紫微斗数", name: "紫微斗数", desc: "十二宫格局、四化飞星、大限流年，命盘可点宫提问。",
        icon: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>' },
      { feat: "meihua", tag: "周易占卜", name: "梅花易数", desc: "时间或手动起卦，本卦互卦变卦与动爻，逐层解读。",
        icon: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2.1 5-5 2.1 2.1-5 5-2.1z"/>' },
      { feat: "tarot",  tag: "塔罗牌", name: "塔罗牌", desc: "三张或凯尔特十字牌阵，先写问题再抽牌，按牌位成文。",
        icon: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/><path d="M5 20h14"/>' },
      { feat: "huangli",tag: "其他功能", name: "老黄历", desc: "宜忌、值神、冲煞与物候，结合所选日期作择日答疑。",
        icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01"/>' }
    ];
    var cards = FEATURES.map(function (f) {
      return '<button type="button" class="home-card" data-feature="' + f.feat + '">' +
        '<span class="home-card-ic"><svg class="ic" viewBox="0 0 24 24">' + f.icon + '</svg></span>' +
        '<span class="home-card-tag">' + esc(f.tag) + '</span>' +
        '<span class="home-card-name">' + esc(f.name) + '</span>' +
        '<span class="home-card-desc">' + esc(f.desc) + '</span>' +
        '<span class="home-card-go" aria-hidden="true">→</span>' +
        '</button>';
    }).join("");
    stageEl().innerHTML =
      '<div class="home-page">' +
        '<div class="home-hero">' +
          '<span class="home-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 12c-1.889-2.554-3.77-4-6-4a4 4 0 0 0 0 8c2.23 0 4.111-1.446 6-4 1.889-2.554 3.77-4 6-4a4 4 0 0 1 0 8c-2.23 0-4.111-1.446-6-4Z"/></svg></span>' +
          '<h1>观象 · 知变 · 自省</h1>' +
          '<p>以传统命理与象征体系为镜，照见当下、理解自己。选择一个入口开始，所有推演都可继续追问。</p>' +
        '</div>' +
        '<div class="home-grid">' + cards + '</div>' +
        '<p class="home-footnote">所有解读仅供自我探索与文化娱乐，不构成现实决策建议。</p>' +
      '</div>';
    $$(".home-card", stageEl()).forEach(function (c) {
      c.onclick = function () { go(c.dataset.feature); };
    });
  }

  /* ================= 八字排盘 ================= */
  function renderBazi() {
    S.bzFromProfile = false;
    stageEl().innerHTML =
      toolHero("八字排盘", "八字以四柱定命局，以大运流年观其变化；AI 提供解读与连续问答。") +
      '<div class="tool-card" id="bz-form-card"><div class="tool-form" id="bazi-form">' +
        '<div class="tf-group"><div class="tf-gt">基本信息</div>' +
          '<div class="tf-grid">' +
            '<div class="tf-field"><label>性别</label><select class="ti" id="bz-gender"><option>男</option><option>女</option></select></div>' +
            '<div class="tf-field"><label>出生地（可选）</label><input class="ti" id="bz-place" placeholder="请输入出生地" /></div>' +
          '</div>' +
        '</div>' +
        '<div class="tf-group">' + birthFieldsHTML("bz", { title: "时间信息" }) + '</div>' +
        '<button class="tool-submit" id="bz-calc">开始计算八字</button>' +
        '<div class="p-err" id="bz-err"></div>' +
      '</div></div>' +
      '<div id="bz-result"></div>' +
      aboutDetails("关于八字排盘", [
        '<b>四柱</b>：年、月、日、时各一柱，每柱一天干一地支，共八字。日柱天干为「日主」，代表命主自身。',
        '<b>十神</b>：以日主与其他天干的生克关系定正官、七杀、正印、比肩、食神、正财等，描述不同的人生力量。',
        '<b>纳音</b>：六十甲子配五行之音，如「沙中金」「杨柳木」，辅助判断气质与格局。',
        '<b>大运</b>：十年一运，依性别与年干阴阳顺逆排布，提示不同阶段的整体趋势。'
      ], "年柱以立春为界、月柱以节气为界；全部字段由程序确定性计算，同一出生信息永远得到同一盘面。登录后可直接带入档案里的出生资料。");

    birthFieldsBind("bz");
    var params = function () {
      var b = birthCollect("bz");
      b.gender = $("#bz-gender").value;
      b.birth_place = $("#bz-place").value.trim();
      return b;
    };
    var lastQS = "";   // 本次排盘的出生参数，供下方提问复用
    var autoCalcFlag = false;   // 自动带入排盘时不滚动，避免一进页面就跳过标题与表单
    $("#bz-calc").onclick = function () {
      var isAuto = autoCalcFlag; autoCalcFlag = false;
      var p = params();
      var qs = baziQS(p) +
        "&gender=" + encodeURIComponent(p.gender) + "&birth_place=" + encodeURIComponent(p.birth_place);
      // 用户主动改过出生信息 → 排盘成功后写回档案（档案是全站唯一数据源）
      var saveBirth = S.bzSaveBirth && S.profile;
      if (saveBirth) qs += "&save=1" + authParam();
      lastQS = qs;
      fetch("/api/bazi/calc?" + qs).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { $("#bz-err").textContent = d.error || "排盘失败"; return; }
        if (d.birth_saved) {
          S.bzSaveBirth = false;
          toast("出生信息已同步到个人档案，其它功能将使用新信息");
          // 档案变了：清掉各功能的本地命盘缓存，避免旧盘继续被复用
          profileBirthChanged();
        }
        var note = d.pillar_lookup ?
          '<p class="p-note" style="margin:0 0 12px">已按四柱反查出生时间：公历 ' + d.pillar_lookup.year + '年' +
          d.pillar_lookup.month + '月' + d.pillar_lookup.day + '日 ' + d.pillar_lookup.hour + '时' +
          (d.pillar_lookup.multiple ? '（同一八字可对应多个日期，取最早）' : '') + '。</p>' : "";
        var kv = '<div class="p-kv bz-kv">' + ["year","month","day","hour"].map(function (k, i) {
          var lbl = ["年柱","月柱","日柱","时柱"][i];
          var hg = ((d.ten_god_zhi || {})[k] || []).map(function (x) { return x.gan + x.shi_shen; }).join("·");
          return '<div class="p-kv-item"><div class="k">' + lbl + ' · ' + d.ten_gods[k] + '</div><div class="v">' + d.pillars[k] + '</div>' +
            '<div class="k" style="margin-top:4px">' + d.nayin[k] + '</div>' +
            (hg ? '<div class="k bz-hg">藏干 ' + hg + '</div>' : '') + '</div>';
        }).join("") + '</div>';

        // 五行分布（条形长度按本盘最大值归一，便于横向比较）
        var wx = d.wuxing || {};
        var wxMax = 1;
        ["木","火","土","金","水"].forEach(function (g) { if ((wx[g] || 0) > wxMax) wxMax = wx[g] || 0; });
        var wxHtml = '<div class="bz-wx">' + ["木","火","土","金","水"].map(function (g) {
          var n = wx[g] || 0;
          return '<span class="bz-wx-i"><b>' + g + '</b><i style="width:' + Math.round((n / wxMax) * 40) + 'px"></i><em>' + n + '</em></span>';
        }).join("") + '</div>';

        // 神煞
        var ssHtml = (d.shensha || []).length
          ? '<div class="bz-tags">' + d.shensha.map(function (s) {
              return '<span class="bz-tag" title="' + esc(s.desc) + '"><b>' + esc(s.name) + '</b><i>' + esc(s.pillars.join("/")) + '柱</i></span>';
            }).join("") + '</div>'
          : '<p class="p-note" style="margin:6px 0 0">本盘未见常用神煞。</p>';

        // 大运（10 步，标出当前，可点选后提问）
        var cur = d.current || {};
        var dyHtml = '<div class="bz-strip"><div class="bz-scroll">' + (d.dayun || []).map(function (y) {
          var on = cur.dayun && y.ganzhi === cur.dayun ? " on" : "";
          return '<button type="button" class="bz-step' + on + '" data-kind="dy" data-gz="' + esc(y.ganzhi) + '"' +
            ' data-from="' + y.start_year + '" data-to="' + y.end_year + '" data-age="' + y.age + '-' + y.end_age + '">' +
            '<b>' + esc(y.ganzhi) + '</b><span>' + y.age + '-' + y.end_age + '岁</span>' +
            '<i>' + y.start_year + '</i><em>' + esc(y.shi_shen) + '</em></button>';
        }).join("") + '</div></div>';

        // 流年（今年起 10 年，可点选后提问）
        var lnHtml = '<div class="bz-strip"><div class="bz-scroll">' + (d.liunian || []).map(function (x) {
          var on = x.year === cur.year ? " on" : "";
          return '<button type="button" class="bz-step' + on + '" data-kind="ln" data-gz="' + esc(x.ganzhi) + '"' +
            ' data-year="' + x.year + '" data-age="' + x.age + '">' +
            '<b>' + esc(x.ganzhi) + '</b><span>' + x.year + '</span>' +
            '<i>' + x.age + '岁</i><em>' + esc(x.shi_shen) + '</em></button>';
        }).join("") + '</div></div>';

        var curLine = cur.dayun
          ? '<p class="bz-cur">当前 ' + cur.year + ' 年 · ' + cur.age + ' 岁 · 行 ' + esc(cur.dayun) + ' 大运（' +
            (cur.dayun_range || []).join("-") + '）</p>'
          : '';

        var chips = [
          { t: "整体格局", q: "整体格局的优缺点是什么？" },
          { t: "事业与财运", q: "事业与财运如何？有哪些风险？" },
          { t: "性格与修习", q: "性格特点与需要修习的地方？" },
          { t: "感情婚姻", q: "感情与婚姻的走向如何？" }
        ];

        $("#bz-result").innerHTML = '<div class="p-result">' +
          '<div class="result-head"><div class="result-title">四柱盘面</div>' + profileAside() + '</div>' +
          '<div class="p-card">' + note + kv + wxHtml +
            '<div class="bz-sec"><div class="bz-sec-h">神煞</div>' + ssHtml + '</div>' +
            '<div class="bz-sec"><div class="bz-sec-h">大运<span>十年一运 · 点选可据此提问</span></div>' + curLine + dyHtml + '</div>' +
            '<div class="bz-sec"><div class="bz-sec-h">流年<span>今年起十年 · 点选可据此提问</span></div>' + lnHtml + '</div>' +
          '</div>' +
          '<div class="bz-ask">' +
            '<div class="bz-ask-h">就这张盘提问<span id="bz-pick">未选择大运或流年</span></div>' +
            '<div class="p-suggest zw-chips">' + chips.map(function (c) {
              return '<button type="button" data-q="' + esc(c.q) + '">' + esc(c.t) + '</button>';
            }).join("") + '</div>' +
            '<div class="zw-ask-row"><input class="ti" id="bz-q" placeholder="例如：事业与财运的格局，有哪些优势与需要警惕的短板？" />' +
              '<button class="tool-ai zw-ask-btn" id="bz-ai" type="button">AI 解读</button></div>' +
            '<div id="bz-ai-out"></div>' +
          '</div>' +
        '</div>';

        // 大运 / 流年点选：高亮并可一键带入提问
        var pick = { kind: "", gz: "", from: "", to: "", year: "", age: "" };
        var pickTip = $("#bz-pick");
        $$("#bz-result .bz-step").forEach(function (b) {
          b.onclick = function () {
            var same = pick.kind === b.dataset.kind && (pick.gz === b.dataset.gz);
            $$("#bz-result .bz-step").forEach(function (x) {
              if (x.dataset.kind === b.dataset.kind && !same) x.classList.remove("on");
            });
            var on = b.classList.toggle("on", !same);
            if (!on) { pick.kind = ""; pickTip.textContent = "未选择大运或流年"; return; }
            pick = { kind: b.dataset.kind, gz: b.dataset.gz, from: b.dataset.from,
              to: b.dataset.to, year: b.dataset.year, age: b.dataset.age };
            if (pick.kind === "dy") {
              pickTip.textContent = "已选大运 " + pick.gz + "（" + pick.from + "-" + pick.to + "，虚岁 " + pick.age + "）";
              $("#bz-q").value = "在 " + pick.gz + " 大运（" + pick.from + "-" + pick.to + "）期间，我的事业与财运趋势如何？";
            } else {
              pickTip.textContent = "已选流年 " + pick.year + " " + pick.gz + "（" + pick.age + "岁）";
              $("#bz-q").value = pick.year + " 年 " + pick.gz + " 流年，我的运势重点与需要留意的地方是什么？";
            }
            $("#bz-q").focus();
          };
        });
        $$("#bz-result .zw-chips button").forEach(function (b) {
          b.onclick = function () { $("#bz-q").value = b.dataset.q; $("#bz-q").focus(); };
        });
        var askBz = function () {
          var q = ($("#bz-q").value || "").trim();
          if (!q) { toast("请先写下想问的问题"); $("#bz-q").focus(); return; }
          var scope = "";
          if (pick.kind === "dy") scope = "（只看 " + pick.gz + " 大运 " + pick.from + "-" + pick.to + "）";
          if (pick.kind === "ln") scope = "（只看 " + pick.year + " " + pick.gz + " 流年）";
          streamAI("bazi", lastQS + "&q=" + encodeURIComponent(scope + q) + authParam(), q, $("#bz-ai-out"));
        };
        $("#bz-ai").onclick = askBz;
        $("#bz-q").onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); askBz(); } };

        if (!isAuto) $("#bz-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    };
    // 登录后不再展示基本信息与时间信息：直接用档案出生信息排盘，只留提问与 AI 对话
    function collapseBirth() {
      S.bzFromProfile = true;
      var card = $("#bz-form-card"); if (card) card.style.display = "none";
    }
    /* 结果标题行右侧的档案来源提示 */
    function profileAside() {
      if (!S.bzFromProfile) return "";
      return '<span class="result-aside" id="bz-edit">已使用档案中的出生信息 · ' +
        '<button type="button" class="link-btn" data-bz-edit="1">修改出生信息</button></span>';
    }
    // 「修改出生信息」：展开表单卡并收起提示（结果标题可能在多处重绘，用事件委托）
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-bz-edit]");
      if (!b) return;
      S.bzFromProfile = false;
      // 标记「本次排盘后写回档案」：用户在档案态改过出生信息，档案要跟着更新
      S.bzSaveBirth = true;
      var card = $("#bz-form-card"); if (card) card.style.display = "";
      var aside = $("#bz-edit"); if (aside) aside.remove();
      var g = $("#bazi-form .tf-group"); if (g) g.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    // 登录后自动带入档案出生信息，并直接排出盘（无需再手动点计算）
    if (S.profile) {
      fetch("/api/profile/get?id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token))
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok && d.profile && d.profile.birth) {
            var b = d.profile.birth;
            var yyyy = b.year, mm = b.month, dd = b.day;
            if ((yyyy == null || mm == null || dd == null) && b.date) {
              var seg = String(b.date).split("-"); yyyy = +seg[0]; mm = +seg[1]; dd = +seg[2];
            }
            birthFieldsBind("bz", { calendar: "solar", year: yyyy, month: mm, day: dd,
              hour: b.hour != null ? b.hour : 12, minute: b.minute != null ? b.minute : 0,
              know_time: b.know_time !== false });
            if (b.gender) $("#bz-gender").value = (b.gender === "male" ? "男" : b.gender === "female" ? "女" : b.gender);
            // 自动排盘：填好档案出生信息后直接出结果
            if ($("#bz-date").value) { autoCalcFlag = true; $("#bz-calc").click(); }
            collapseBirth();
          }
        }).catch(function () {});
    }
    applyGate("bazi");
  }
  function segSet(seg, v) { $$("button", seg).forEach(function (b) { b.classList.toggle("on", b.dataset.v === v); }); }

  /* ================= 梅花易数 ================= */
  function renderMeihua() {
    stageEl().innerHTML =
      toolHero("梅花易数 · 每日决策", "梅花易数取象于当下，观变于一事；卦成之后，由 AI 结合《周易》原文解读。") +
      '<div class="tool-card"><div class="tool-form" id="mh-form">' +
        '<div class="tf-group"><div class="tf-gt">提出您的决策问题</div>' +
          '<p class="p-note" style="margin:0 0 10px">请输入一个明确的问题，系统将自动为您起卦</p>' +
          '<input class="ti" id="mh-q" placeholder="例如：我是否应该接受这个工作机会？" />' +
          '<div class="p-suggest"><button data-q="事业上顺势推进还是另寻他途？">事业去向</button><button data-q="这段关系下一步如何？">感情走向</button><button data-q="眼下这个决定是否明智？">当下决策</button></div>' +
        '</div>' +
        '<div class="tf-group"><div class="tf-gt">起卦方式</div>' +
          '<div class="p-seg" id="mh-method">' +
            '<button class="on" data-v="time">时间起卦</button><button data-v="number">数字起卦</button><button data-v="random">随机数起卦</button><button data-v="manual">手动起卦</button></div>' +
          '<div id="mh-inputs"></div>' +
        '</div>' +
        '<button class="tool-submit" id="mh-calc">生成卦象</button>' +
        '<div class="p-err" id="mh-err"></div>' +
      '</div></div>' +
      '<div id="mh-result"></div>' +
      '<div id="mh-ai-box"></div>' +
      aboutDetails("起卦规则", [
        '<b>时间起卦</b>：根据起卦时刻的农历年月日时起卦。上卦 =（年支数＋月数＋日数）mod 8，下卦 =（年支数＋月数＋日数＋时辰数）mod 8，动爻 = 总数 mod 6。',
        '<b>数字起卦</b>：第一个数字取下卦，第二个数字取上卦，动爻 =（两数之和）mod 6。',
        '先天八卦数：乾1 · 兑2 · 离3 · 震4 · 巽5 · 坎6 · 艮7 · 坤8；年数以立春为界的年支序数计（子1…亥12），不是公历年份；余数为 0 时按第 8 卦 / 第 6 爻处理。',
        '<b>手动起卦</b>：点击爻位设置阴阳，再选择变爻位置；本卦、动爻、变卦随之确定。'
      ], "每一次起卦结果与所问之事绑定：本卦、动爻与变卦在同一轮解读和追问中保持不变；换了问题请点「换个问题重新提问」重新开始。AI 解读引用的卦爻辞是《周易》真实文本。");

    $$(".p-suggest button", stageEl()).forEach(function (b) { b.onclick = function () { $("#mh-q").value = b.dataset.q; updateBtn(); }; });
    var GUA_NAMES = ["乾","兑","离","震","巽","坎","艮","坤"];
    var GUA_SYMBOL = { "乾":"☰","兑":"☱","离":"☲","震":"☳","巽":"☴","坎":"☵","艮":"☶","坤":"☷" };
    var GUA_BITS = { "乾":"111","兑":"011","离":"101","震":"001","巽":"110","坎":"010","艮":"100","坤":"000" };
    var manualYaos = [1,1,1,1,1,1];   // 自下而上，1=阳；手动起卦编辑器状态
    var manualMoving = 0;             // 0=未选变爻
    var lastGua = null;               // 最近一次起卦结果，供 AI 解卦用

    /* 爻线图形：阳爻一条长横，阴爻两段 */
    function yaoGlyph(yang, moving) {
      return '<span class="yao-line' + (yang ? ' yang' : ' yin') + (moving ? ' moving' : '') + '">' +
        (yang ? '<i></i>' : '<i></i><i></i>') + '</span>';
    }
    function posName(i) { return i === 1 ? "初爻" : (i === 6 ? "上爻" : "二爻 三爻 四爻 五爻".split(" ")[i - 2]); }
    function trigramName(bits3) {   // bits3: 自下而上三爻
      var key = bits3[2] + bits3[1] + bits3[0];
      for (var n in GUA_BITS) if (GUA_BITS[n] === key) return n;
      return "乾";
    }
    function drawEditor() {
      $("#mh-editor").innerHTML = [6,5,4,3,2,1].map(function (i) {
        var yang = manualYaos[i - 1] === 1, mv = manualMoving === i;
        return '<div class="mh-yao-row"><span class="pos">' + posName(i) + '</span>' +
          '<button class="yao-toggle" data-i="' + i + '" aria-label="切换阴阳">' + yaoGlyph(yang, mv) + '</button>' +
          '<span class="yy">' + (yang ? '阳爻' : '阴爻') + '</span>' +
          '<button class="mv-toggle' + (mv ? ' on' : '') + '" data-i="' + i + '">' + (mv ? '动爻' : '不变') + '</button></div>';
      }).join("");
      var up = trigramName(manualYaos.slice(3)), lo = trigramName(manualYaos.slice(0, 3));
      // 上下卦名并入说明行，不再单独占一块预览（六爻本身已直观表达卦象）
      var hint = $("#mh-mhint");
      if (hint) hint.textContent = "本卦 " + up + "上 " + lo + "下 · 点爻线切换阴阳，点“不变/动爻”指定变爻";
    }
    // 起卦输入区统一事件委托：避免动态重渲染后绑定丢失导致"点了没反应"
    $("#mh-inputs").addEventListener("click", function (e) {
      var tb = e.target.closest("#mh-ttabs button");
      if (tb) { segSet($("#mh-ttabs"), tb.dataset.v); var w = $("#mh-when"); if (w) w.style.display = tb.dataset.v === "spec" ? "" : "none"; return; }
      var yt = e.target.closest(".yao-toggle");
      if (yt) { var i = +yt.dataset.i; manualYaos[i - 1] = manualYaos[i - 1] === 1 ? 0 : 1; drawEditor(); return; }
      var mt = e.target.closest(".mv-toggle");
      if (mt) { var j = +mt.dataset.i; manualMoving = manualMoving === j ? 0 : j; drawEditor(); return; }
    });

    function renderInputs() {
      var m = segVal($("#mh-method")), box = $("#mh-inputs");
      if (m === "number") {
        box.innerHTML = '<div class="tf-grid" style="margin-top:12px">' +
          '<div class="tf-field"><label>下卦之数（第一个数字）</label><input class="ti" id="mh-n1" type="number" value="23" /></div>' +
          '<div class="tf-field"><label>上卦之数（第二个数字）</label><input class="ti" id="mh-n2" type="number" value="45" /></div></div>';
      } else if (m === "time") {
        // 指定时间默认填入当前时刻，避免出现空白输入框
        var nw = new Date(), pd = function (n) { return (n < 10 ? "0" : "") + n; };
        var dflt = nw.getFullYear() + "-" + pd(nw.getMonth() + 1) + "-" + pd(nw.getDate()) +
          "T" + pd(nw.getHours()) + ":" + pd(nw.getMinutes());
        box.innerHTML = '<div class="tf-field" style="margin-top:12px"><div class="mh-tt-line"><label>起卦时间</label>' +
          '<div class="mh-ttabs" id="mh-ttabs"><button class="on" data-v="now">此刻</button><button data-v="spec">指定时间</button></div></div>' +
          '<input class="ti" id="mh-when" type="datetime-local" value="' + dflt + '" style="display:none;margin-top:8px" /></div>';
      } else if (m === "manual") {
        box.innerHTML = '<div class="tf-group" style="margin-top:12px"><div class="tf-gt">卦象预览</div>' +
          '<p class="p-note" id="mh-mhint" style="margin:0 0 8px">点爻线切换阴阳，点“不变/动爻”指定变爻</p>' +
          '<div class="mh-yaos" id="mh-editor"></div></div>';
        drawEditor();
      } else {
        box.innerHTML = '<p class="p-note">系统随机给出两个数：第一数取下卦，第二数取上卦，动爻以两数之和除 6 取余。</p>';
      }
    }
    renderInputs();
    $$("#mh-method button").forEach(function (b) {
      b.onclick = function () { segSet($("#mh-method"), b.dataset.v); renderInputs(); };
    });
    // 生成卦象始终可点：未填问题时点击给出明确提示，避免"点了没反应"的观感
    function updateBtn() {}
    $("#mh-q").addEventListener("input", updateBtn);

    function mhParams() {
      var m = segVal($("#mh-method")), p = "method=" + m;
      if (m === "number") p += "&num1=" + ($("#mh-n1").value || 1) + "&num2=" + ($("#mh-n2").value || 1);
      if (m === "time" && segVal($("#mh-ttabs")) === "spec" && $("#mh-when").value) p += "&when=" + encodeURIComponent($("#mh-when").value);
      if (m === "manual") {
        var bits = manualYaos.map(String).join("");
        var upBits = bits.slice(3).split("").reverse().join(""), loBits = bits.slice(0, 3).split("").reverse().join("");
        var name2 = {}; for (var n in GUA_BITS) name2[GUA_BITS[n]] = n;
        p += "&upper=" + encodeURIComponent(name2[upBits] || "乾") + "&lower=" + encodeURIComponent(name2[loBits] || "乾") + "&moving=" + (manualMoving || 1);
      }
      return p;
    }
    function guaCard(tag, gua, upper, lower, isBian, movingLabel) {
      return '<div class="mh-gua-card' + (isBian ? ' bian' : '') + '">' +
        '<div class="tag">' + tag + '</div>' +
        '<div class="sym">' + esc(upper.symbol || "") + '<span>' + esc(lower.symbol || "") + '</span></div>' +
        '<div class="nm">' + esc(gua.name) + '</div>' +
        '<div class="sub">' + esc((gua.index || "—")) + '卦 · 上' + esc(upper.name) + '下' + esc(lower.name) + '</div>' +
        (movingLabel ? '<div class="mv">' + esc(movingLabel) + '</div>' : '') +
      '</div>';
    }
    var mhDrawing = false;
    function castMeihua(autoAskQ) {
      if (mhDrawing) return;
      // 并发保护：本轮 AI 解卦仍在流式输出时，禁止重新起卦（否则会清空正在写入的容器导致卡死）
      if (S.busyKeys && S.busyKeys["mh-result"]) { toast("当前解卦进行中，请等解读完成后再起新卦"); return; }
      var q0 = $("#mh-q").value.trim();
      if (!q0) { toast("请先写下你的决策问题"); $("#mh-q").focus(); return; }
      mhDrawing = true;
      $("#mh-err").textContent = "";
      fetch("/api/meihua/calc?" + mhParams()).then(function(r){return r.json();}).then(function(d){
        mhDrawing = false;
        if (!d.ok) { $("#mh-err").textContent = d.error || "起卦失败"; return; }
        var bianUpper = (d.bian_gua && d.bian_gua.upper) || d.upper;
        var bianLower = (d.bian_gua && d.bian_gua.lower) || d.lower;
        // 每次起卦 = 新一轮：先折叠归档上一整轮（卦象+解读+追问链），再渲染新卦象。
        archiveRound($("#mh-result"), $("#mh-result").dataset.roundQ || $("#mh-result").dataset.lastQ || "上一轮起卦");
        $("#mh-result").innerHTML = '<div class="p-result">' + resultTitle("卦象") +
          '<div class="p-card"><div style="text-align:center;margin-bottom:14px"><div class="p-hero-tag">第' + d.ben_gua.index + '卦</div>' +
          '<div style="font-family:var(--serif);font-size:26px;margin:8px 0">' + esc(d.ben_gua.name) + '</div>' +
          '<div style="color:var(--cinnabar);font-size:13px">第 ' + d.moving + ' 爻动 · 变卦 ' + esc(d.bian_gua.name) + '</div></div>' +
          '<div class="mh-gua-row">' +
            guaCard("本卦", d.ben_gua, d.upper, d.lower, false, "第 " + d.moving + " 爻动") +
            guaCard("互卦", d.hu_gua || d.ben_gua, (d.hu_gua || d).upper, (d.hu_gua || d).lower, false) +
            guaCard("变卦", d.bian_gua, bianUpper, bianLower, true, "第 " + d.moving + " 爻动") +
          '</div>' +
          '<button class="tool-ai" id="mh-ai" style="margin-top:16px">AI 解卦</button>' +
          '</div></div>';
        lastGua = d;
        $("#mh-result").dataset.roundQ = q0;
        $("#mh-ai").onclick = function () {
          var q = $("#mh-q").value.trim();
          if (!q) { toast("请先写下所问之事"); return; }
          // 问题文本变了 = 新提问 → 重新起卦并按新问题解卦
          if (q !== $("#mh-result").dataset.roundQ) { toast("问题已更改，正在按新问题重新起卦"); castMeihua(q); return; }
          streamAI("meihua", mhParams() + "&q=" + encodeURIComponent(q) + authParam(), q, $("#mh-result"));
        };
        if (autoAskQ) streamAI("meihua", mhParams() + "&q=" + encodeURIComponent(autoAskQ) + authParam(), autoAskQ, $("#mh-result"));
        $("#mh-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
      }).catch(function () { mhDrawing = false; });
    }
    $("#mh-calc").onclick = function () { castMeihua(null); };
    applyGate("meihua");
  }

  /* ================= 塔罗牌 ================= */
  function renderTarot() {
    stageEl().innerHTML =
      toolHero("塔罗牌占卜", "以图像与象征映照问题的不同侧面。写下明确的问题，程序随机抽牌；确认牌面后，由 AI 按牌位和正逆位组织成一条与你有关的叙事——包含主线，也指出盲点。") +
      '<div class="tool-card"><div class="tool-form" id="tr-form">' +
        '<div class="tf-group"><div class="tf-gt">提出您的问题</div>' +
          '<p class="p-note" style="margin:0 0 10px">请输入一个明确的问题，程序会随机抽取三张牌；确认牌面后，可让 AI 按牌位和正逆位解读</p>' +
          '<input class="ti" id="tr-q" placeholder="例如：创业还是留在大公司更适合我？" />' +
          '<div class="p-suggest tr-chips"><button data-q="创业还是留在大公司更适合我？">创业还是留在大公司更适合我？</button><button data-q="对方不喜欢我，我该如何让自己放下？">对方不喜欢我，我该如何让自己放下？</button><button data-q="为何我在社交场中难以做真实的自己？">为何我在社交场中难以做真实的自己？</button><button data-q="异地恋还要坚持吗？">异地恋还要坚持吗？</button></div>' +
        '</div>' +
        '<div class="tf-group"><div class="tf-gt">牌阵</div>' +
          '<div class="p-seg" id="tr-spread"><button class="on" data-v="three">三张牌 · 过去现在未来</button><button data-v="celtic_cross">凯尔特十字（十张）</button></div>' +
        '</div>' +
        '<button class="tool-submit" id="tr-draw">抽取塔罗牌</button>' +
        '<div class="p-err" id="tr-err"></div>' +
      '</div></div>' +
      '<div id="tr-result"></div>' +
      aboutDetails("关于塔罗牌", [
        '完整牌组 78 张：大阿卡纳 22 张如人生章节，小阿卡纳 56 张把主题落到行动（权杖）、情绪（圣杯）、思虑（宝剑）与现实（星币）。本站采用 Rider-Waite-Smith 体系，牌面取自经典 RWS 图像。',
        '正位 / 逆位会改变牌的表达方式；牌面（牌名、牌位、正逆位）在解读前全部确定，不随语气切换而改变。',
        '「过去·现在·未来」是帮助叙事的时间框架，不是三句预言；牌与牌之间的重复、冲突与转折，比单张吉凶更有信息。'
      ], "塔罗像一面带象征语言的镜子，帮助看见期待、恐惧与尚未承认的选择；它是自我探索工具，不是心理诊断或命运判决。");

    segBind($("#tr-spread"));
    $$(".p-suggest button", stageEl()).forEach(function (b) { b.onclick = function () { $("#tr-q").value = b.dataset.q; }; });
    // 牌义清单（78 张：中英文名 / 牌面图 / 正逆位关键词 / 简介），一次加载全站复用
    if (!S.tarotCards) {
      fetch("/tarot-cards.json").then(function (r) { return r.json(); }).then(function (j) { S.tarotCards = j; }).catch(function () {});
    }
    function trParam() { return "spread=" + segVal($("#tr-spread")); }
    /* 单张牌面（十字布局用小图 + 序号角标） */
    function xcard(c, num, over) {
      return '<div class="x-card xc' + (over ? ' x-over' : '') + '">' +
        '<div class="imgwrap"><img src="/tarot-img/' + c.slug + '.jpg" alt="' + esc(c.name) + '" /><span class="x-num">' + num + '</span></div>' +
      '</div>';
    }
    /* 牌义注释：序号 · 牌位 · 牌名 · 正逆位 + 完整简介（象征 + 代表，与卡面序号一一对应） */
    function noteItem(c, i) {
      var meta = (S.tarotCards || {}) || {};
      meta = meta[c.slug] || {};
      var intro = String(meta.intro || "");
      return '<div class="tc-note"><div class="nm"><i class="no">' + (i + 1) + '</i>' + esc(meta.zh || c.name) +
        ' <em>' + esc(c.position) + ' · ' + (c.reversed ? '逆位' : '正位') + '</em></div>' +
        (intro ? '<p class="tc-intro">' + esc(intro) + '</p>' : '') + '</div>';
    }
    function showCards(cards, spread) {
      var notes = '<div class="tc-notes">' + cards.map(noteItem).join("") + '</div>';
      if (spread === "celtic_cross") {
        /* 凯尔特十字（十张）标准编号：十字区 1状况居中、2障碍横覆其上（只看正位）、3基础居下、4过去居左、5主观看法居上、6将来居右；权杖柱 7自己/8环境/9希望恐惧/10结果 自下而上。
           左列放牌阵（权杖柱按十字三行总高自动缩放），右列同行并排展示十张牌的牌义。 */
        return '<div class="tc-wrap">' +
          '<div class="tc-cross">' +
            '<div class="x-grid">' +
              '<div class="x-top">' + xcard(cards[4], 5) + '</div>' +
              '<div class="x-left">' + xcard(cards[3], 4) + '</div>' +
              '<div class="x-center">' + xcard(cards[0], 1) + xcard(cards[1], 2, true) + '</div>' +
              '<div class="x-right">' + xcard(cards[5], 6) + '</div>' +
              '<div class="x-below">' + xcard(cards[2], 3) + '</div>' +
            '</div>' +
            '<div class="x-staff">' + xcard(cards[9], 10) + xcard(cards[8], 9) + xcard(cards[7], 8) + xcard(cards[6], 7) + '</div>' +
          '</div>' +
          notes +
        '</div>';
      }
      return '<div class="tcard-grid' + (cards.length === 3 ? ' t3' : '') + '">' + cards.map(function (c) {
        var meta = (S.tarotCards || {})[c.slug] || {};
        return '<div class="tcard-big">' +
          '<div class="imgwrap"><img src="/tarot-img/' + c.slug + '.jpg" alt="' + esc(c.name) + '" loading="lazy" />' +
          '<span class="ori-badge">' + (c.reversed ? '逆位' : '正位') + '</span></div>' +
          '<div class="nm">' + esc(meta.zh || c.name) + '</div>' +
          '<div class="en">' + esc(meta.en || "") + '</div>' +
          '<div class="pos">' + esc(c.position) + '</div>' +
          (meta.intro ? '<p class="tc-intro">' + esc(meta.intro) + '</p>' : '') +
        '</div>';
      }).join("") + '</div>';
    }
    function askTarot(deck, q) {
      streamAI("tarot", trParam() + "&q=" + encodeURIComponent(q) + "&deck=" + encodeURIComponent(deck) + authParam(), q, $("#tr-result"));
    }
    var trDrawing = false;
    function drawTarot(autoAskQ) {
      if (trDrawing) return;
      // 并发保护：本轮 AI 解读仍在流式输出时，禁止重新抽牌（否则会清空正在写入的容器导致卡死）
      if (S.busyKeys && S.busyKeys["tr-result"]) { toast("当前解读进行中，请等解读完成后再抽新牌"); return; }
      var q0 = $("#tr-q").value.trim();
      if (!q0) { toast("请先写下你想问的事，再抽牌"); $("#tr-q").focus(); return; }
      trDrawing = true;
      fetch("/api/tarot/calc?" + trParam()).then(function(r){return r.json();}).then(function(d){
        trDrawing = false;
        if (!d.ok) { $("#tr-err").textContent = d.error || "抽牌失败"; return; }
        // 每次抽牌 = 新一轮：先把上一整轮（牌面+解读+追问链）折叠归档，再渲染新牌面。
        // 归档区在结果容器之外，所以这里 innerHTML 重建 #tr-result 不会冲掉归档。
        archiveRound($("#tr-result"), $("#tr-result").dataset.roundQ || $("#tr-result").dataset.lastQ || "上一轮抽牌");
        // 锁定本次抽牌结果：slug|正逆位串随 AI 解读回传，保证解读用的牌 == 用户看到的牌
        var deck = (d.cards || []).map(function(c){ return c.slug + "|" + (c.reversed ? 1 : 0); }).join(",");
        $("#tr-result").innerHTML = '<div class="p-result">' + resultTitle("牌面") +
          '<div class="p-card">' + showCards(d.cards, d.spread || segVal($("#tr-spread"))) +
          '<button class="tool-ai" id="tr-ai" style="margin-top:18px">AI 解读牌义</button></div>' + '</div>';
        $("#tr-result").dataset.roundQ = q0;
        $("#tr-result").dataset.deck = deck;
        $("#tr-ai").onclick = function () {
          var q = $("#tr-q").value.trim();
          if (!q) { toast("请先写下你的问题"); $("#tr-q").focus(); return; }
          // 入口2：问题文本变了 = 真正的新提问 → 自动重新抽牌，并按新问题解读
          if (q !== $("#tr-result").dataset.roundQ) { toast("问题已更改，正在按新问题重新抽牌"); drawTarot(q); return; }
          askTarot($("#tr-result").dataset.deck, q);
        };
        if (autoAskQ) askTarot(deck, autoAskQ);
        $("#tr-result").scrollIntoView({ behavior:"smooth", block:"nearest" });
      }).catch(function () { trDrawing = false; });
    }
    $("#tr-draw").onclick = function () { drawTarot(null); };
    applyGate("tarot");
  }

  /* ================= 黄历（月历视图 + 默认当日历注 + AI 问事） ================= */
  function renderHuangli() {
    var now = new Date();
    var view = { y: now.getFullYear(), m: now.getMonth() + 1 };
    var sel = { y: view.y, m: view.m, d: now.getDate() };
    stageEl().innerHTML =
      toolHero("老黄历", "以干支、节气与日值辨一日之宜忌，为日常行事提供时间参考。AI 依据完整历注，解释栏目与具体事项的关系。") +
      '<div class="tool-card hl-cal" id="hl-cal"><p class="p-note" style="text-align:center">日历加载中…</p></div>' +
      '<div id="hl-day"><p class="p-note" style="text-align:center;margin:18px 0">当日历注加载中…</p></div>' +
      '<div class="tool-card hl-ai-card"><div class="tool-form">' +
        '<div class="tf-group"><div class="tf-gt">AI 择日答疑</div>' +
          '<p class="p-note" style="margin:0">结合上方所选日期的完整历注，解释宜忌与你所想之事的关系。</p>' +
        '</div>' +
        '<div class="tf-field"><label>你想问什么？（结合上方所选日期）</label>' +
          '<textarea class="ti ta" id="hl-q" placeholder="例如：这天适合搬家吗？"></textarea>' +
          '<div class="p-suggest"><button data-q="今天适合做什么事情？">今天适合做什么</button><button data-q="这周哪天最适合搬家？">本周搬家吉日</button><button data-q="这天适合签约开业吗？">签约开业</button></div>' +
        '</div>' +
        '<label class="p-switch hl-bazi-switch"><input type="checkbox" id="hl-bazi"' + (S.profile ? '' : ' disabled') + ' /><span>导入本人八字信息</span></label>' +
        '<p class="p-note" style="margin:7px 0 2px">' + (S.profile
          ? '择日时一并参考你八字里的日主与喜忌，答案更贴合本人。'
          : '登录后可导入档案里的八字，一并参考日主与喜忌。') + '</p>' +
        '<button class="tool-ai" id="hl-ai">AI 择日答疑</button>' +
        '<div class="p-err" id="hl-err"></div>' +
      '</div></div>' +
      '<div id="hl-result"></div>' +
      aboutDetails("关于黄历", [
        '<b>宜 / 忌</b>：传统上认为适合或不适合进行的事项类别；<b>值神</b>分黄道黑道，<b>十二建星</b>（建除满平定执破危成收开闭）描述日的性质。',
        '<b>冲煞与空亡</b>：冲煞提示日支与哪些生肖相冲、所煞方位；空亡提示力量不足的时段。',
        '<b>神位与物候</b>：财神喜神等方位、二十八宿、九星、物候，是传统择日的辅助参考层。'
      ], "黄历描述「这一天在传统体系中的位置」，不是针对某个人的命运判断；所有字段由程序确定性计算，宜忌只是醒目结论，孤立的吉凶不等于整天的定论。");

    $$(".p-suggest button", stageEl()).forEach(function (b) { b.onclick = function () { $("#hl-q").value = b.dataset.q; }; });
    function hlParam() { return "year=" + sel.y + "&month=" + sel.m + "&day=" + sel.d; }

    /* ---- 月历 ---- */
    function renderCal() {
      fetch("/api/huangli/month?year=" + view.y + "&month=" + view.m)
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { $("#hl-cal").innerHTML = '<p class="p-err">' + esc(d.error || "加载失败") + '</p>'; return; }
          var years = [], y0 = view.y - 6;
          for (var i = 0; i < 13; i++) years.push(y0 + i);
          var html =
            '<div class="hl-head">' +
              '<div><div class="hl-title">' + view.y + '年' + view.m + '月</div>' +
              '<div class="hl-sub">农历' + esc(d.lunar_year) + '年' + esc(d.lunar_month) + '</div></div>' +
              '<div class="hl-ctl">' +
                '<select class="ti" id="hl-year">' + years.map(function (y) { return '<option value="' + y + '"' + (y === view.y ? ' selected' : '') + '>' + y + '年</option>'; }).join("") + '</select>' +
                '<select class="ti" id="hl-month">' + [1,2,3,4,5,6,7,8,9,10,11,12].map(function (m) { return '<option value="' + m + '"' + (m === view.m ? ' selected' : '') + '>' + m + '月</option>'; }).join("") + '</select>' +
                '<button class="hl-nav" id="hl-prev" aria-label="上个月">‹</button>' +
                '<button class="hl-nav" id="hl-next" aria-label="下个月">›</button>' +
              '</div>' +
            '</div>' +
            '<div class="hl-week">' + ["日","一","二","三","四","五","六"].map(function (w) { return '<div>' + w + '</div>'; }).join("") + '</div>' +
            '<div class="hl-grid">' + d.lead.concat(d.days, d.tail).map(function (c) {
              var cls = "hl-cell" + (c.off ? " dim" : "") + (c.today ? " today" : "") +
                (c.off === 0 && c.d === sel.d && sel.y === view.y && sel.m === view.m ? " sel" : "");
              return '<div class="' + cls + '" data-d="' + c.d + '" data-off="' + c.off + '" data-today="' + (c.today ? 1 : 0) + '">' +
                '<b>' + c.d + '</b><span>' + esc(c.lunar) + '</span>' + (c.mark ? '<em>' + esc(c.mark) + '</em>' : '') + '</div>';
            }).join("") + '</div>';
          $("#hl-cal").innerHTML = html;
          function jump(delta) {
            var m = view.m + delta;
            if (m < 1) { m = 12; view.y--; } else if (m > 12) { m = 1; view.y++; }
            view.m = m; renderCal();
          }
          $("#hl-prev").onclick = function () { jump(-1); };
          $("#hl-next").onclick = function () { jump(1); };
          $("#hl-year").onchange = function () { view.y = +this.value; renderCal(); };
          $("#hl-month").onchange = function () { view.m = +this.value; renderCal(); };
          $$(".hl-cell", $("#hl-cal")).forEach(function (cell) {
            cell.onclick = function () {
              var off = +cell.dataset.off, dd = +cell.dataset.d;
              if (off) {   // 点击前后月补位天：翻到对应月份再选中
                var m = view.m + off, y = view.y;
                if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
                view = { y: y, m: m };
                sel = { y: y, m: m, d: dd };
                renderCal();
              } else {
                sel = { y: view.y, m: view.m, d: dd };
                $$(".hl-cell.sel", $("#hl-cal")).forEach(function (x) { x.classList.remove("sel"); });
                cell.classList.add("sel");
              }
              loadDay();
            };
          });
        }).catch(function () { $("#hl-cal").innerHTML = '<p class="p-err">日历加载失败，请刷新重试</p>'; });
    }

    /* ---- 当日历注（开放式面板，按参考样式排版） ---- */
    function loadDay() {
      fetch("/api/huangli/calc?" + hlParam()).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { $("#hl-day").innerHTML = '<p class="p-err" style="text-align:center">' + esc(d.error || "查询失败") + '</p>'; return; }
        var yiItems = (d.yi || []).slice(0, 14), jiItems = (d.ji || []).slice(0, 14);
        var yi = yiItems.length ? yiItems.map(function (t) { return "• " + esc(t); }).join("  ") : "诸事不宜";
        var ji = jiItems.length ? jiItems.map(function (t) { return "• " + esc(t); }).join("  ") : "—";
        var jq = d.jieqi_info || {};
        var cur = jq.current || jq.prev || { name: "—" };
        var curTime = (cur.time || "").replace(" ", " · ");
        var nx = jq.next || { name: "—" };
        var nxTime = (nx.time || "").replace(" ", " · ");
        $("#hl-day").innerHTML =
          '<div class="hl-panel">' +
            '<div class="hlp-top"><span class="hlp-tag">当日历注</span>' +
              '<button class="hlp-share" id="hl-share"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="6" cy="12" r="2.6"/><circle cx="17" cy="6" r="2.6"/><circle cx="17" cy="18" r="2.6"/><path d="M8.3 10.8l6.4-3.5M8.3 13.2l6.4 3.5"/></svg>分享图片</button></div>' +
            '<h2 class="hlp-date">' + sel.y + '年' + sel.m + '月' + sel.d + '日</h2>' +
            '<div class="hlp-sub"><span>农历 ' + esc(d.lunar) + '</span><span>星期' + esc(d.week) + '</span></div>' +
            '<div class="hlp-tri">' +
              '<div><i>生肖</i><b>' + esc([d.shengxiao.year, d.shengxiao.month, d.shengxiao.day].join(" · ")) + '</b></div>' +
              '<div><i>干支</i><b>' + esc(d.ganzhi.year) + ' · ' + esc(d.ganzhi.month) + ' · ' + esc(d.ganzhi.day) + '</b></div>' +
              '<div><i>纳音</i><b>' + esc([d.nayin.year, d.nayin.month, d.nayin.day].join(" · ")) + '</b></div>' +
            '</div>' +
            '<div class="hlp-jq">' +
              '<div><i>当前节气</i><b>' + esc(cur.name) + '</b><span>' + esc(curTime) + '</span></div>' +
              '<div class="hlp-dotline"><i></i><em></em></div>' +
              '<div class="r"><i>下一节气</i><b>' + esc(nx.name) + '</b><span>' + esc(nxTime) + '</span></div>' +
            '</div>' +
            '<div class="hlp-yiji">' +
              '<div class="col"><h4>宜</h4><div class="items">' + yi + '</div>' +
                '<div class="hlp-foot"><i>吉神</i><b>' + esc((d.jishen || []).join("、") || "—") + '</b></div></div>' +
              '<div class="col"><h4>忌</h4><div class="items">' + ji + '</div>' +
                '<div class="hlp-foot"><i>凶煞</i><b>' + esc((d.xiongsha || []).join("、") || "—") + '</b></div></div>' +
            '</div>' +
            '<div class="hlp-two">' +
              '<div class="hlp-block"><h4>日值关系</h4><div class="hlp-grid">' +
                '<div><i>冲煞</i><b>' + esc(d.shengxiao.day) + '日冲' + esc(d.chong_desc) + ' 煞' + esc(d.sha) + '</b></div>' +
                '<div><i>空亡</i><b>' + esc(d.kongwang || "—") + '</b></div>' +
                '<div><i>胎神</i><b>' + esc(d.taishen || "—") + '</b></div>' +
                '<div><i>天神</i><b>' + esc(d.tianshen) + '(' + esc(d.tianshen_type) + '日)</b></div>' +
              '</div></div>' +
              '<div class="hlp-block"><h4>神位方位</h4><div class="hlp-grid">' +
                '<div><i>财神位</i><b>' + esc(d.positions.cai || "—") + '</b></div>' +
                '<div><i>喜神位</i><b>' + esc(d.positions.xi || "—") + '</b></div>' +
                '<div><i>福神位</i><b>' + esc(d.positions.fu || "—") + '</b></div>' +
                '<div><i>阳贵神</i><b>' + esc(d.positions.yanggui || "—") + '</b></div>' +
              '</div></div>' +
            '</div>' +
            '<div class="hlp-xing"><h4>星历物候</h4><div class="hlp-grid wide">' +
              '<div><i>二十八宿</i><b>' + esc(d.xiu_full || d.xiu) + ' (' + esc(d.xiu_luck) + ')</b></div>' +
              '<div><i>月相</i><b>' + esc(d.yue_xiang || "—") + '</b></div>' +
              '<div><i>九星</i><b>' + esc(d.nine_star || "—") + '</b></div>' +
              '<div><i>物候</i><b>' + esc(d.hou || "") + ' ' + esc(d.wuhou || "") + '</b></div>' +
            '</div></div>' +
          '</div>';
        $("#hl-share").onclick = function () { shareDay(d); };
      }).catch(function () { $("#hl-day").innerHTML = '<p class="p-err" style="text-align:center">历注加载失败，请重试</p>'; });
    }
    /* 分享图片：把当日历注要点绘成 PNG 下载 */
    function shareDay(d) {
      var c = document.createElement("canvas");
      c.width = 900; c.height = 640;
      var ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 900, 640);
      ctx.fillStyle = "#9ca3af"; ctx.font = "22px sans-serif";
      ctx.fillText("当日历注 · Destiny Master", 60, 70);
      ctx.fillStyle = "#111827"; ctx.font = "bold 52px sans-serif";
      ctx.fillText(sel.y + "年" + sel.m + "月" + sel.d + "日", 60, 150);
      ctx.fillStyle = "#6b7280"; ctx.font = "26px sans-serif";
      ctx.fillText("农历 " + d.lunar + "　星期" + d.week, 60, 200);
      ctx.fillStyle = "#374151"; ctx.font = "28px sans-serif";
      ctx.fillText("干支 " + d.ganzhi.year + " · " + d.ganzhi.month + " · " + d.ganzhi.day, 60, 260);
      ctx.fillText("冲煞 " + d.shengxiao.day + "日冲" + d.chong_desc + "　财神位 " + d.positions.cai, 60, 310);
      ctx.font = "bold 30px sans-serif"; ctx.fillStyle = "#111827";
      ctx.fillText("宜", 60, 390);
      ctx.font = "26px sans-serif"; ctx.fillStyle = "#374151";
      wrapText(ctx, (d.yi || []).slice(0, 10).join(" · ") || "诸事不宜", 60, 430, 780, 38);
      ctx.font = "bold 30px sans-serif"; ctx.fillStyle = "#111827";
      ctx.fillText("忌", 470, 390);
      ctx.font = "26px sans-serif"; ctx.fillStyle = "#374151";
      wrapText(ctx, (d.ji || []).slice(0, 10).join(" · ") || "—", 470, 430, 370, 38);
      ctx.fillStyle = "#9ca3af"; ctx.font = "20px sans-serif";
      ctx.fillText("仅供自我探索与文化娱乐，不构成现实决策建议", 60, 600);
      var a = document.createElement("a");
      a.download = "huangli-" + sel.y + "-" + sel.m + "-" + sel.d + ".png";
      a.href = c.toDataURL("image/png");
      a.click();
      toast("历注图片已生成");
      function wrapText(ctx2, text, x, y, maxW, lh) {
        var line = "", yy = y;
        for (var i = 0; i < text.length; i++) {
          if (ctx2.measureText(line + text[i]).width > maxW) { ctx2.fillText(line, x, yy); line = text[i]; yy += lh; }
          else line += text[i];
        }
        ctx2.fillText(line, x, yy);
      }
    }

    $("#hl-ai").onclick = function () {
      var q = $("#hl-q").value.trim();
      if (!q) { toast("请先写下想问的事"); $("#hl-q").focus(); return; }
      // 勾选「导入本人八字信息」时，把档案八字一并交给 AI 作为择日参考
      var useBazi = $("#hl-bazi") && $("#hl-bazi").checked && S.profile ? "&use_bazi=1" : "";
      streamAI("huangli", hlParam() + "&q=" + encodeURIComponent(q) + useBazi + authParam(), q, $("#hl-result"));
    };

    renderCal();
    loadDay();   // 打开页面默认直接给出今日历注
    applyGate("huangli");
  }

  /* ================= 轮次管理：「新提问」与「追问」严格区分 =================
     一次「提问」= 确定性问题结果（牌面/卦象/盘面/历注）+ AI 解读 + 追问链，合称一轮。
     · 追问：沿用本轮牌/卦/盘继续问，插在本轮卡内，不动结果、不归档。
     · 新提问：换新问题 → 旧的一整轮折叠归档（功能页内可展开回看）→ 按新问题从头开始。
       塔罗/梅花还会真正重新抽牌/起卦；八字/紫微/黄历的盘固定，只换问题重解。
     归档区挂在结果容器【之外】（stage 层），因为塔罗/梅花重新抽牌会 innerHTML 重建结果容器。 */
  var ROOT_SEL = { bazi:"#bz-result", meihua:"#mh-result", tarot:"#tr-result", huangli:"#hl-result", ziwei:"#zw-result" };
  var QBOX_SEL = { bazi:"#bz-q", meihua:"#mh-q", tarot:"#tr-q", huangli:"#hl-q", ziwei:"#zw-q" };

  function archiveHost(container) {
    var st = container.closest(".p-wrap") || stageEl();
    var host = st.querySelector(":scope > .round-archive");
    if (!host) {
      host = document.createElement("div");
      host.className = "round-archive";
      var root = st.querySelector(ROOT_SEL[S.feature]) || container;
      if (root.parentNode) root.parentNode.insertBefore(host, root.nextSibling);
      else st.appendChild(host);
    }
    return host;
  }
  /* 把 container 当前一轮（结果卡 + 解读卡 + 追问链）打包折叠归档，并清空 container。返回归档节点数。 */
  function archiveRound(container, question) {
    if (!container) return 0;
    var nodes = Array.prototype.slice.call(container.children).filter(function (n) {
      return n.classList && (n.classList.contains("p-result") || n.classList.contains("p-ai"));
    });
    if (!nodes.length) return 0;
    var host = archiveHost(container);
    var item = document.createElement("div");
    item.className = "round-item";
    item.innerHTML = '<div class="round-item-hd"><span class="dot"></span><span class="rq"></span><span class="rsign">展开回看</span></div>' +
      '<div class="round-item-bd"></div>';
    $(".rq", item).textContent = question || "上一轮提问";
    var bd = $(".round-item-bd", item);
    nodes.forEach(function (n) { bd.appendChild(n); });
    host.insertBefore(item, host.firstChild);   // 最新一轮置顶
    container.dataset.lastQ = "";
    return nodes.length;
  }
  function qboxFor(container) {
    if (S.feature === "ziwei") return container.id === "zw-d-ai-out" ? "#zw-dq" : "#zw-q";
    return QBOX_SEL[S.feature] || "#bz-q";
  }
  /* 某结果容器当前是否有解读在流式输出中（与 streamToUrl 的 busy key 规则一致） */
  function containerBusy(container) {
    if (!container) return false;
    var key = container.id || (container.dataset && container.dataset.bkey);
    return !!(key && S.busyKeys && S.busyKeys[key]);
  }
  /* 「换个问题重新提问」：归档当前轮 → 清空本轮 → 清空并聚焦问题框，让用户填新问题从头开始 */
  function reaskFlow(container) {
    if (containerBusy(container)) { toast("当前解读进行中，请等解读完成后再换问题"); return; }
    var label = container.dataset.lastQ || "上一轮提问";
    archiveRound(container, label);
    container.innerHTML = "";
    var q = $(qboxFor(container));
    if (q) { q.value = ""; q.focus(); q.scrollIntoView({ behavior: "smooth", block: "center" }); }
    toast("请输入一个新的问题，然后重新" + (S.feature === "tarot" ? "抽牌" : S.feature === "meihua" ? "起卦" : "解读"));
  }

  /* 新提问前置：并发保护 + 改问题归档旧轮 + 同问题拦截。返回 true 表示可以继续发起解读。
     盘面固定类功能（八字/紫微/黄历）与 streamAI 共用；塔罗/梅花在抽牌流程里已自行归档。 */
  function prepareNewQuestion(container, question) {
    // 并发保护：本轮解读仍在流式输出时，任何新解读/归档都拦下，避免清空正在写入的容器导致卡死
    if (containerBusy(container)) { toast("当前解读进行中，请等解读完成后再提问"); return false; }
    if (container.dataset.lastQ && container.dataset.lastQ !== question) {
      archiveRound(container, container.dataset.lastQ);
    }
    if (container.dataset.lastQ === question && container.querySelector(":scope > .p-ai")) {
      toast("这个问题已解读过；继续请直接用下方追问，或点「换个问题重新提问」");
      var f = container.querySelector(":scope > .p-ai .ai-follow input");
      if (f) f.focus();
      return false;
    }
    container.dataset.lastQ = question;
    return true;
  }
  /* ================= AI 流式解读（共用） ================= */
  function streamAI(feature, query, question, container) {
    if (!prepareNewQuestion(container, question)) return;
    streamToUrl("/api/" + feature + "/deduce?" + query, "AI 解读", question, container, false);
  }
  /* 通用 SSE 流式渲染：解读 / 历史追问共用 */
  function streamToUrl(url, tag, question, container, noRefresh) {
    // AI 解读与追问一律要求登录（后端也要鉴权，这里先拦一层给出明确引导）
    if (requireLogin()) return;
    // busy 按容器隔离：一个功能在解读，不影响切到别的功能发起新解读（后台并行）
    var bkey = container.id || (container.dataset && container.dataset.bkey) || ("c" + Math.random());
    if (!container.id && container.dataset) container.dataset.bkey = bkey;
    if (!S.busyKeys) S.busyKeys = {};
    if (S.busyKeys[bkey]) { toast("此处解读进行中，请稍候"); return; }
    S.busyKeys[bkey] = true;
    var holderId = "ai-" + Date.now();
    // 新提问的旧轮归档已在 streamAI / 抽牌流程里完成（整轮移出结果容器）；
    // 这里只负责渲染新卡：新提问卡带头「换个问题重新提问」，追问子卡不带。
    var isNewQuestion = tag === "AI 解读";
    var headLabel = isNewQuestion ? "新提问" : esc(tag);
    // 「换个问题重新提问」不在初始 HTML：解读进行中不显示，流结束(finish)后才挂载，
    // 避免用户在解读未完成时点它去归档/清空正在写入的容器 -> 卡死。
    var html = '<div class="p-ai" id="' + holderId + '"><div class="p-ai-head"><span class="dot"></span>' +
      '<span class="p-ai-title">' + headLabel + ' · ' + esc(question) + '</span></div>' +
      '<div class="p-ai-body"><span class="p-cursor"></span></div></div>';
    if (isNewQuestion) {
      // 解读卡必须排在确定性结果卡（牌面/卦象）之后，而不是容器最前——
      // 部分功能（塔罗/梅花）把结果卡与 AI 输出放在同一容器，用 afterbegin 会把解读顶到牌面上方。
      var resultCard = container.querySelector(":scope > .p-result");
      if (resultCard) resultCard.insertAdjacentHTML("afterend", html);
      else container.insertAdjacentHTML("afterbegin", html);
    } else container.insertAdjacentHTML("beforeend", html);
    var body = $(".p-ai-body", $("#" + holderId));
    // 点击 AI 解读后立即滚到解读框，避免停留在结果上方
    $("#" + holderId).scrollIntoView({ behavior: "smooth", block: "nearest" });
    var full = "", buf = "", hid = 0;

    fetch(url)
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        var reader = resp.body.getReader(), decoder = new TextDecoder();
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) { finish(); return; }
            buf += decoder.decode(res.value, { stream: true });
            var lines = buf.split("\n\n"); buf = lines.pop();
            lines.forEach(function (line) {
              if (!line.indexOf("data:")) {
                var data = line.slice(5).trim();
                if (data === "[DONE]") { return; }
                try {
                  var o = JSON.parse(data);
                  if (o.cached) { full = ""; }
                  if (o.delta) { full += o.delta; render(); }
                  if (o.hid) { hid = o.hid; }
                } catch (e) {}
              }
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        body.innerHTML = '<div style="color:var(--cinnabar)">解读失败：' + esc(e.message) + '</div>';
        S.busyKeys[bkey] = false;
      });
    function render() {
      try { body.innerHTML = (window.marked ? marked.parse(full) : esc(full)) + '<span class="p-cursor"></span>'; }
      catch (e) { body.innerHTML = esc(full) + '<span class="p-cursor"></span>'; }
      body.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    function finish() {
      S.busyKeys[bkey] = false;
      try { body.innerHTML = (window.marked ? marked.parse(full) : esc(full)); }
      catch (e) { body.innerHTML = esc(full); }
      // 免责声明由后端在正文之后统一附加并计入落盘，前端不再重复追加（避免一次解读出现多条声明）。
      // 用 .done 作为「流结束」信号，供测试与追问定位。
      var card = $("#" + holderId);
      if (card) card.classList.add("done");
      // 「换个问题重新提问」：只在解读完成后才挂载（解读进行中不出现，避免误点导致卡死）
      if (isNewQuestion && card) {
        var head = $(".p-ai-head", card);
        if (head && !$(".round-reask", head)) {
          var rask = document.createElement("button");
          rask.type = "button";
          rask.className = "round-reask";
          rask.title = "归档本轮，按新问题重新开始";
          rask.textContent = "换个问题重新提问";
          rask.onclick = function () { reaskFlow(container); };
          head.appendChild(rask);
        }
      }
      // 每一处解读都支持「继续追问」：有 hid（登录且已落盘）时在卡底挂追问条
      if (hid) attachFollow(card, hid, followNote(S.feature));
      if (!noRefresh && S.feature === "profile") renderProfile();
    }
  }

  /* 追问备注：按功能给出准确说法（塔罗是「牌阵」不重新抽牌，梅花才叫「起卦」）。
     放在追问条内、输入框上方作为提示，不写「说明：」前缀。 */
  function followNote(feature) {
    var MAP = {
      bazi: "追问会沿用这一次的八字盘，不会重新排盘",
      meihua: "追问会沿用这一次的卦象，不会重新起卦",
      tarot: "追问会沿用这一次的牌阵与抽牌结果，不会重新抽牌",
      huangli: "追问会沿用这一次的黄历信息，不会重新查询",
      ziwei: "追问会沿用这一次的命盘，不会重新排盘"
    };
    return MAP[feature] || "追问会沿用这一次的解读内容，不会重新推演";
  }

  /* AI 解读卡通用追问条：复用 /api/history/followup，沿用本次盘面事实，可无限多轮。
     card 为 .p-ai 节点，hid 为该解读落盘后的历史 id。追问结果由 streamToUrl 渲染进
     追问条内的子容器，子结果卡再挂新的追问条，形成连续对话。 */
  function attachFollow(card, hid, noteText) {
    if (!card || !hid) return;
    var old = $(".ai-follow", card);
    if (old) old.remove();
    var wrap = document.createElement("div");
    wrap.className = "ai-follow";
    // 追问提示放在追问条内部、输入框上方，作为追问区域的说明；
    // 不再挂在 AI 正文末尾（那样紧跟免责声明，像是答案的一部分）。
    wrap.innerHTML = (noteText ? '<p class="p-note pf-follow-note">' + esc(noteText) + '</p>' : '') +
      '<div class="ai-follow-row">' +
        '<input class="ti" placeholder="就这次解读继续追问…" />' +
        '<button class="ai-follow-btn" type="button">追问</button></div>' +
      '<div class="ai-follow-slot"></div>';
    card.appendChild(wrap);
    var inp = $("input", wrap), btn = $(".ai-follow-btn", wrap), slot = $(".ai-follow-slot", wrap);
    function ask() {
      var q = inp.value.trim();
      if (!q) { toast("请输入追问内容"); inp.focus(); return; }
      if (btn.disabled) { toast("追问进行中，请稍候"); return; }
      btn.disabled = true; inp.value = "";
      var url = "/api/history/followup?" + pfAuth() + "&id=" + hid + "&q=" + encodeURIComponent(q);
      streamToUrl(url, "追问", q, slot, true);
      setTimeout(function () { btn.disabled = false; }, 1200);
    }
    btn.onclick = ask;
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); ask(); } });
  }

  /* ================= 个人中心 ================= */
  var PF_FEATS = [["bazi", "八字"], ["meihua", "梅花"], ["tarot", "塔罗"], ["huangli", "黄历"], ["ziwei", "紫微"]];
  var pfState = { filter: "", date: "", items: [], dates: [], editBirth: false, editAccount: false, birth: null };

  function pfAuth() {
    return "profile_id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token);
  }
  function renderProfile() {
    var stage = stageEl();
    if (!S.profile) {
      stage.innerHTML = hero("PROFILE", "个人中心", "登录后在此查看你的档案与全部历史提问。") +
        '<div class="p-card" style="text-align:center;padding:50px"><p>尚未登录</p><button class="p-primary" style="width:200px;margin-top:10px" onclick="document.getElementById(\'p-auth-btn\').click()">登录 / 注册</button></div>';
      return;
    }
    stage.innerHTML = hero("PROFILE", "个人中心 · " + esc(S.profile.name), "你的出生档案与各功能的提问历史都保存在云端，随时回看、继续追问。") +
      '<div class="p-card" id="pf-body"><p>加载中…</p></div>';
    pfState.filter = "";
    pfState.date = "";
    loadProfile();
  }
  function loadProfile() {
    var ap = pfAuth();
    var apP = "id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token);
    var listUrl = "/api/history/list?" + ap + "&limit=60" +
      (pfState.filter ? "&feature=" + pfState.filter : "") +
      (pfState.date ? "&date=" + encodeURIComponent(pfState.date) : "");
    Promise.all([
      fetch("/api/history/stats?" + ap).then(function (r) { return r.json(); }),
      fetch(listUrl).then(function (r) { return r.json(); }),
      fetch("/api/profile/get?" + apP).then(function (r) { return r.json(); })
    ]).then(function (res) {
      pfState.items = (res[1] && res[1].items) || [];
      pfState.dates = (res[0] && res[0].dates) || [];
      paintProfile(res[0] || {}, res[1] || {}, res[2] || {});
    }).catch(function (e) {
      var body = $("#pf-body");
      if (body) body.innerHTML = '<p style="color:var(--cinnabar)">加载失败：' + esc(e.message) + '</p>';
    });
  }
  function paintProfile(stats, list, prof) {
    var by = stats.by_feature || {};
    var birth = (prof.profile && prof.profile.birth) ? prof.profile.birth : {};
    pfState.birth = birth;
    var bSeg = birthSegment(birth);
    var cur = PF_FEATS.filter(function (f) { return f[0] === pfState.filter; })[0];
    // 功能卡片：可点击 → 只看该功能的历史对话
    var cards = PF_FEATS.map(function (f) {
      var on = pfState.filter === f[0];
      return '<button type="button" class="p-stat p-stat-btn' + (on ? ' on' : '') + '" data-f="' + f[0] + '">' +
        '<div class="n">' + (by[f[0]] || 0) + '</div><div class="l">' + f[1] + '</div></button>';
    }).join("");
    // 历史缩略卡：功能 + 日期 + 单行问题摘要；纵向列表在固定高度内上下滚动，点击查看详情/追问
    var items = pfState.items.map(function (h) {
      var summary = String(h.question || "").replace(/\s+/g, " ");
      if (summary.length > 54) summary = summary.slice(0, 54) + "…";
      return '<div class="pf-hcard" data-hid="' + h.id + '" role="button" tabindex="0">' +
        '<div class="pf-hcard-top"><span class="p-hist-feat">' + esc(h.feature_name) + '</span>' +
        '<span class="pf-hcard-tools"><span class="pf-hcard-date">' + esc(h.ts || "") + '</span>' +
        '<button type="button" class="p-hist-del" data-del="' + h.id + '">删除</button></span></div>' +
        '<span class="pf-hcard-q">' + esc(summary) + '</span>' +
        '</div>';
    }).join("") || ('<p class="p-note">' + (pfState.date ? "这一天没有提问记录。" : (cur ? "「" + cur[1] + "」还没有提问记录。" : "还没有提问记录，去各功能里问一句吧。")) + '</p>');
    $("#pf-body").innerHTML =
      '<div class="p-profile-head"><div class="p-profile-avatar">' + esc(S.profile.name.charAt(0).toUpperCase()) + '</div>' +
      '<div><h3 style="margin:0;font-family:var(--serif);font-size:19px">' + esc(S.profile.name) + '</h3>' +
      '<p style="margin:5px 0 0;color:var(--ink-2);font-size:12px">累计 ' + (stats.total || 0) + ' 次提问</p></div></div>' +
      '<div class="pf-birth">' +
        '<div class="pf-birth-h"><h3 style="font-family:var(--serif);font-size:15px;margin:0">基本信息</h3>' +
          '<button type="button" class="p-navitem pf-birth-edit" style="width:auto;padding:4px 11px">' +
            (pfState.editBirth ? "收起" : "编辑") + '</button></div>' +
        (pfState.editBirth ? pfBirthForm(birth) :
          '<div class="pf-birth-list">' + bSeg.map(function (x) {
            return '<div class="pf-birth-item"><span class="k">' + esc(x[0]) + '</span><span class="v">' + esc(x[1]) + '</span></div>';
          }).join("") + '</div>' +
          '<p class="p-note pf-hint pf-birth-tip">此处出生信息是八字、紫微、黄历共用的唯一来源；修改后各功能会同步更新。</p>') +
      '</div>' +
      '<div class="pf-account">' +
        '<div class="pf-birth-h"><h3 style="font-family:var(--serif);font-size:15px;margin:0">账号设置</h3>' +
          '<button type="button" class="p-navitem pf-account-toggle" style="width:auto;padding:4px 11px">' +
            (pfState.editAccount ? "收起" : "修改") + '</button></div>' +
        (pfState.editAccount ? pfAccountForm() : '<p class="p-note pf-hint">可修改用户名与登录密码，不影响你的历史对话。</p>') +
      '</div>' +
      '<div class="p-stat-row">' + cards + '</div>' +
      '<p class="p-note pf-hint pf-tip">点击卡片查看该功能的历史对话</p>' +
      '<div style="margin-top:22px"><div class="pf-hist-head"><h3 style="font-family:var(--serif);font-size:16px;margin:0">' +
        (cur ? esc(cur[1]) + ' · 历史对话' : '历史提问') + '</h3>' +
        '<div class="pf-hist-tools">' +
          (pfState.date ? '<button type="button" class="pf-dateclear" title="清除日期">' + esc(pfState.date) + ' ✕</button>' : '') +
          '<button type="button" class="pf-date-btn" id="pf-date-btn">' + CAL_ICON + '<span>' + (pfState.date ? '更改日期' : '按日期查找') + '</span></button>' +
          (cur || pfState.date ? '<button class="p-navitem pf-clear" style="width:auto;padding:4px 10px">清除筛选</button>' : '') +
        '</div>' +
      '</div>' +
      '<div class="pf-hscroll">' + items + '</div>' +
      '<p class="p-note pf-hint">上下滚动查看更多；点击卡片查看完整解读并继续追问</p>' +
      '</div>';
    $$(".p-stat-btn", $("#pf-body")).forEach(function (b) {
      b.onclick = function () {
        pfState.filter = pfState.filter === b.dataset.f ? "" : b.dataset.f;
        loadProfile();
      };
    });
    var be = $(".pf-birth-edit", $("#pf-body"));
    if (be) be.onclick = function () { pfState.editBirth = !pfState.editBirth; paintProfile(stats, list, prof); };
    var bs = $("#pf-birth-save", $("#pf-body"));
    if (bs) bs.onclick = function () { pfSaveBirth(birth); };
    var at = $(".pf-account-toggle", $("#pf-body"));
    if (at) at.onclick = function () { pfState.editAccount = !pfState.editAccount; paintProfile(stats, list, prof); };
    var an = $("#pf-name-save", $("#pf-body"));
    if (an) an.onclick = function () { pfSaveAccount("name"); };
    var ap = $("#pf-pass-save", $("#pf-body"));
    if (ap) ap.onclick = function () { pfSaveAccount("password"); };
    var clr = $(".pf-clear", $("#pf-body"));
    if (clr) clr.onclick = function () { pfState.filter = ""; pfState.date = ""; loadProfile(); };
    // 日期查找：右侧按钮 → 弹出与出生日期同款的日历，选完按日期过滤历史
    var db = $("#pf-date-btn", $("#pf-body"));
    if (db) db.onclick = function () {
      openDateLookup(pfState.date, function (y, m, d) {
        pfState.date = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
        loadProfile();
      });
    };
    var dclr = $(".pf-dateclear", $("#pf-body"));
    if (dclr) dclr.onclick = function () { pfState.date = ""; loadProfile(); };
    // 缩略卡：点卡片查看；点卡内「删除」按钮两步确认，并阻止冒泡到「查看」
    $$(".pf-hcard", $("#pf-body")).forEach(function (card) {
      card.onclick = function () { toggleHistory(+card.dataset.hid, card); };
    });
    $$(".p-hist-del", $("#pf-body")).forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        if (!b.classList.contains("arm")) {
          b.classList.add("arm"); b.textContent = "确认删除";
          setTimeout(function () { b.classList.remove("arm"); b.textContent = "删除"; }, 4000);
          return;
        }
        fetch("/api/history/delete", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile_id: S.profile.id, token: S.profile.token, id: +b.dataset.del })
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { toast(d.error || "删除失败"); return; }
          toast("已删除"); loadProfile();
        }).catch(function () { toast("删除失败，请稍后再试"); });
      };
    });
  }
  /* 档案出生信息 → 展示用的键值对 */
  function birthSegment(birth) {
    birth = birth || {};
    var y = birth.year, m = birth.month, d = birth.day;
    if (!(y && m && d) && birth.date) {
      var seg = String(birth.date).split("-");
      y = +seg[0]; m = +seg[1]; d = +seg[2];
    }
    var g = birth.gender;
    if (g === "male") g = "男"; else if (g === "female") g = "女";
    var knowTime = birth.know_time !== false;
    var hh = birth.hour != null ? birth.hour : null;
    var mm = birth.minute != null ? birth.minute : null;
    return [
      ["出生日期", (y && m && d) ? (y + "年" + m + "月" + d + "日") : "未填写"],
      ["出生时间", knowTime ? (hh != null ? (hh + "时" + (mm || 0) + "分") : "未填写") : "未知（按午时排盘）"],
      ["性别", g || "未填写"]
    ];
  }
  /* 个人中心里的档案出生信息编辑表单 */
  function pfBirthForm(birth) {
    birth = birth || {};
    var seg = birthSegment(birth);
    var y = birth.year, m = birth.month, d = birth.day;
    if (!(y && m && d) && birth.date) {
      var s = String(birth.date).split("-"); y = +s[0]; m = +s[1]; d = +s[2];
    }
    y = y || 1990; m = m || 1; d = d || 1;
    var hours = "", mins = "";
    for (var h = 0; h < 24; h++) hours += '<option value="' + h + '"' + (birth.hour === h ? " selected" : "") + '>' + h + '时</option>';
    for (var mi = 0; mi < 60; mi++) mins += '<option value="' + mi + '"' + (birth.minute === mi ? " selected" : "") + '>' + mi + '分</option>';
    var g = birth.gender === "male" ? "男" : (birth.gender === "female" ? "女" : (birth.gender || "男"));
    var know = birth.know_time !== false;
    return '<div class="pf-birth-form">' +
      '<div class="tf-field"><label>出生日期</label><input class="ti" type="date" id="pf-bd" value="' +
        y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0") + '" /></div>' +
      '<div class="pf-birth-row">' +
        '<div class="tf-field"><label>出生时间</label><div class="pf-birth-time">' +
          '<select class="ti" id="pf-bh">' + hours + '</select>' +
          '<select class="ti" id="pf-bm">' + mins + '</select></div></div>' +
        '<div class="tf-field"><label>性别</label><select class="ti" id="pf-bg">' +
          '<option' + (g === "男" ? " selected" : "") + '>男</option>' +
          '<option' + (g === "女" ? " selected" : "") + '>女</option></select></div>' +
      '</div>' +
      '<label class="p-switch" style="display:flex;align-items:center;gap:8px;margin:2px 0 12px">' +
        '<input type="checkbox" id="pf-bkt"' + (know ? " checked" : "") + ' /><span>我知道出生时间</span></label>' +
      '<div style="display:flex;gap:10px;align-items:center">' +
        '<button class="tool-submit" type="button" id="pf-birth-save" style="flex:0 0 auto;width:auto;padding:9px 20px">保存到档案</button>' +
        '<span class="p-note" style="margin:0">保存后八字、紫微、黄历会同步使用新的出生信息</span>' +
      '</div>' +
    '</div>';
  }
  /* 保存档案出生信息 */
  function pfSaveBirth(old) {
    var dv = ($("#pf-bd") || {}).value || "";
    var seg = dv.split("-");
    if (seg.length !== 3 || !seg[0]) { toast("请选择出生日期"); return; }
    var body = {
      profile_id: S.profile.id, token: S.profile.token,
      birth: {
        year: +seg[0], month: +seg[1], day: +seg[2],
        hour: +($("#pf-bh") || {}).value || 0,
        minute: +($("#pf-bm") || {}).value || 0,
        gender: ($("#pf-bg") || {}).value || "男",
        know_time: !!($("#pf-bkt") || {}).checked,
        calendar: "solar"
      }
    };
    fetch("/api/profile/update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { toast(d.error || "保存失败"); return; }
      pfState.editBirth = false;
      profileBirthChanged();
      toast("基本信息已更新");
      loadProfile();
    }).catch(function () { toast("保存失败，请稍后再试"); });
  }
  /* 账号设置表单：用户名 + 密码（改密码须填当前密码） */
  function pfAccountForm() {
    return '<div class="pf-acct-form">' +
      '<div class="pf-acct-row"><div class="tf-field"><label>用户名</label>' +
        '<input class="ti" id="pf-newname" value="' + esc(S.profile.name) + '" placeholder="2~24 位字母/数字/下划线" /></div>' +
        '<button class="tool-submit" type="button" id="pf-name-save" style="flex:0 0 auto;width:auto;padding:9px 18px">保存用户名</button></div>' +
      '<div class="pf-acct-sep"></div>' +
      '<div class="pf-acct-row"><div class="tf-field"><label>当前密码</label>' +
        '<input class="ti" type="password" id="pf-oldpass" placeholder="修改密码时必填" /></div>' +
        '<div class="tf-field"><label>新密码</label>' +
        '<input class="ti" type="password" id="pf-newpass" placeholder="至少 6 位" /></div>' +
        '<button class="tool-submit" type="button" id="pf-pass-save" style="flex:0 0 auto;width:auto;padding:9px 18px">修改密码</button></div>' +
      '<p class="p-note pf-hint">密码修改后会退出其他设备的登录状态。</p>' +
      '</div>';
  }
  function pfSaveAccount(kind) {
    var body = { profile_id: S.profile.id, token: S.profile.token };
    if (kind === "name") {
      var nm = (($("#pf-newname") || {}).value || "").trim();
      if (!nm) { toast("请输入用户名"); return; }
      body.name = nm;
    } else {
      var op = (($("#pf-oldpass") || {}).value || "");
      var np = (($("#pf-newpass") || {}).value || "");
      if (!op || !np) { toast("请填写当前密码与新密码"); return; }
      if (np.length < 6) { toast("新密码至少 6 位"); return; }
      body.old_password = op; body.new_password = np;
    }
    fetch("/api/profile/update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { toast(d.error || "保存失败"); return; }
      if (kind === "name" && d.name) {
        S.profile.name = d.name;
        try { localStorage.setItem("zw-profile", JSON.stringify(S.profile)); } catch (e) {}
        renderUser();
      }
      pfState.editAccount = false;
      var opEl = $("#pf-oldpass"), npEl = $("#pf-newpass");
      if (opEl) opEl.value = ""; if (npEl) npEl.value = "";
      toast(kind === "name" ? "用户名已更新" : "密码已修改");
      loadProfile();
    }).catch(function () { toast("保存失败，请稍后再试"); });
  }
  // 历史解读：同一项再点一次收起；切换项时先收起旧项，避免重复堆积
  function toggleHistory(id, btn) {
    var existing = $("#pf-body").querySelector('[data-hbox="' + id + '"]');
    if (existing) { existing.remove(); if (btn) btn.classList.remove("on"); return; }
    $$("#pf-body [data-hbox]").forEach(function (n) { n.remove(); });
    $$("#pf-body .pf-hcard").forEach(function (x) { x.classList.remove("on"); });
    if (btn) btn.classList.add("on");
    var ap = pfAuth() + "&id=" + id;
    fetch("/api/history/detail?" + ap).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { toast("未找到该记录"); return; }
      var it = d.item;
      var box = document.createElement("div");
      box.className = "p-card"; box.style.marginTop = "16px"; box.dataset.hbox = id;
      // 历史详情的 AI 卡 + 追问条与解读页保持同一套结构（.p-ai/.ai-follow），
      // 追问复用 attachFollow 统一渲染，格式、多轮能力、免责都一致。
      var card = document.createElement("div");
      card.className = "p-ai";
      card.innerHTML = '<div class="p-ai-head"><span class="dot"></span>历史解读 · ' + esc(it.ts) + '</div>' +
        '<div class="p-ai-body"><p><b>问：</b>' + esc(it.question) + '</p><hr/>' +
        (window.marked ? marked.parse(it.answer) : esc(it.answer)) + '</div>';
      box.appendChild(card);
      box.className = "p-card p-hist-detail";
      box.style.marginTop = "16px"; box.dataset.hbox = id;
      $("#pf-body").appendChild(box);
      // 小字灰色备注放在追问条内部（输入框上方），不再紧跟免责声明、避免像答案的一部分。
      attachFollow(card, id, followNote(it.feature));
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  /* ================= 紫微斗数：站内原生命盘（固定尺寸，无 iframe） =================
     数据来自 /api/chart（十二宫星曜）+ /api/horoscope（大限流年）。
     三视图：命格（格局概览+十二宫主星）/ 本命盘（固定尺寸命盘）/ 运势盘（大限流年叠加）。 */
  var ZW_SLOT = [3, 4, 5, 6, 2, -1, -1, 7, 1, -1, -1, 8, 0, 11, 10, 9];   // 4×4 槽位 → 宫索引
  var ZW_ABBR = { "命宫": "命", "兄弟": "兄", "夫妻": "夫", "子女": "子", "财帛": "财", "疾厄": "疾",
    "迁移": "迁", "仆役": "友", "交友": "友", "官禄": "官", "田宅": "田", "福德": "福", "父母": "父" };
  var ZW_MUT = ["禄", "权", "科", "忌"];
  function zwPN(n) { return n && n.slice(-1) === "宫" ? n : (n || "") + "宫"; }   // 命宫本身即含「宫」，避免出现「命宫宫」
  function zwS() { return S.zw || (S.zw = { chart: null, id: null, key: null, birth: null, year: new Date().getFullYear(), view: "plate", sel: null, horo: null, busy: false }); }  /* 命盘缓存：同一组出生信息（含星座参数）直接复用，登录用户不必每次重新起盘 */
  var ZW_STORE = "zw-chart-v1";
  function zwBirthKey(b) {
    return [b.date, b.timeIndex, b.gender || "男", b.calendar || "solar"].join("|");
  }
  function zwStoreGet() {
    try { return JSON.parse(sessionStorage.getItem(ZW_STORE) || "null"); } catch (e) { return null; }
  }
  function zwStoreSet(o) {
    try { sessionStorage.setItem(ZW_STORE, JSON.stringify(o)); } catch (e) {}
  }
  function zwStoreSync() {
    var st = zwS();
    if (!st.id || !st.chart || !st.key) return;
    zwStoreSet({ key: st.key, id: st.id, chart: st.chart, birth: st.birth,
      uid: S.profile ? S.profile.id : 0, view: st.view, year: st.year,
      fromProfile: !!S.zwFromProfile });
  }
  function zwPalaces() {
    var st = zwS(), out = {};
    (st.chart && st.chart.palaces || []).forEach(function (p) { out[p.index] = p; });
    return out;
  }
  /* 某颗星落在第几宫（用于把运限四化填进对应宫位） */
  function zwStarPalaceIdx(name) {
    var pals = (zwS().chart && zwS().chart.palaces) || [];
    for (var i = 0; i < pals.length; i++) {
      var p = pals[i], all = (p.majorStars || []).concat(p.minorStars || []);
      for (var j = 0; j < all.length; j++) if (all[j].name === name) return p.index;
    }
    return -1;
  }
  /* 四化表：{ 宫索引: [{n:星名, i:0..3}] } */
  function zwMutMap(mutagen) {
    var m = {};
    (mutagen || []).forEach(function (nm, i) {
      var pi = zwStarPalaceIdx(nm);
      if (pi < 0) return;
      (m[pi] = m[pi] || []).push({ n: nm, i: i });
    });
    return m;
  }
  function zwMutOf(star, mutagenList) {
    if (!mutagenList || !star || !star.name) return "";
    var i = mutagenList.indexOf(star.name);
    return i >= 0 ? ZW_MUT[i] : "";
  }
  function zwStarHTML(name, extra, mut) {
    return '<span class="zw-star">' + esc(name) +
      (extra ? '<i>' + esc(extra) + '</i>' : '') +
      (mut ? '<b class="zw-mut m' + ZW_MUT.indexOf(mut) + '">' + mut + '</b>' : '') + '</span>';
  }
  /* 手机端命盘改为纵向宫位列表：按十二宫逆时针顺序（命→兄→夫→子→财→疾→迁→友→官→田→福→父）排列。
     桌面端命盘是 4×4 网格、每个宫位已显式定位 grid-column/grid-row，order 不改变其排布。 */
  function zwOrder(p) {
    var pals = (zwS().chart && zwS().chart.palaces) || [], soul = 0, i;
    for (i = 0; i < pals.length; i++) {
      if (pals[i].isSoulPalace || pals[i].name === "命宫") { soul = pals[i].index; break; }
    }
    return (soul - p.index + 12) % 12;
  }
  function zwPalaceHTML(p, slot, overlay) {
    var st = zwS(), cls = "zw-pal";
    var isSoul = !!(p.isSoulPalace || p.name === "命宫");
    /* 运势盘的「运命」与本命盘的「命宫」用同一套金色标记（淡金底 + 金色描边），两盘视觉语言一致 */
    if (overlay && overlay.decadalIdx === p.index) cls += " hl-d soulpal";
    if (overlay && overlay.yearlyIdx === p.index) cls += " hl-y";
    if (st.sel === p.index) cls += " sel";
    /* 本命盘：命宫同样给淡金底 + 金色描边，明确「特意展示」 */
    if (st.view !== "fortune" && isSoul) cls += " soulpal";
    /* 四化直接标在对应星曜下方：生年 / 大限 / 流年各占一行，只出一个字 */
    var dMap = {}, yMap = {};
    if (overlay) {
      (overlay.dMut && overlay.dMut[p.index] || []).forEach(function (x) { dMap[x.n] = x.i; });
      (overlay.yMut && overlay.yMut[p.index] || []).forEach(function (x) { yMap[x.n] = x.i; });
    }
    /* 每颗星固定四层：名 → 庙旺 → 生年 → 大限 → 流年；空位留占位，四化永远落在同一行 */
    function starCell(s, showBright, isMajor) {
      function slot(mut, extra) {
        return '<span class="zw-scslot">' +
          (mut ? '<b class="zw-sc' + extra + ' m' + ZW_MUT.indexOf(mut) + '">' + esc(mut) + '</b>' : '') + '</span>';
      }
      var br = showBright && s.brightness ? s.brightness : "";
      return '<span class="zw-starwrap">' +
        '<span class="zw-star' + (isMajor ? " major" : "") + '">' + esc(s.name) + '</span>' +
        '<span class="zw-scslot br">' + (br ? '<i>' + esc(br) + '</i>' : '') + '</span>' +
        slot(s.mutagen || "", "") +
        slot(dMap[s.name] != null ? ZW_MUT[dMap[s.name]] : "", "") +
        slot(yMap[s.name] != null ? ZW_MUT[yMap[s.name]] : "", "") +
      '</span>';
    }
    var majors = (p.majorStars || []).map(function (s) { return starCell(s, true, true); }).join("");
    var minors = (p.minorStars || []).map(function (s) { return starCell(s, false, false); }).join("");
    /* 杂曜与主星同行展示：同样竖写一列，字号更小颜色更淡 */
    var adj = (p.adjectiveStars || []).slice(0, 8).map(function (s) {
      return '<span class="zw-star adj">' + esc(s.name) + '</span>';
    }).join("");
    var pills = "";
    if (overlay && overlay.dNames && overlay.dNames[p.index]) {
      var dn = ZW_ABBR[overlay.dNames[p.index]] || overlay.dNames[p.index];
      pills += '<i class="zw-pill d' + (overlay.decadalIdx === p.index ? " soul" : "") + '">运' + esc(dn) + '</i>';
    }
    if (overlay && overlay.yNames && overlay.yNames[p.index]) {
      var yn = ZW_ABBR[overlay.yNames[p.index]] || overlay.yNames[p.index];
      pills += '<i class="zw-pill y' + (overlay.yearlyIdx === p.index ? " soul" : "") + '">流' + esc(yn) + '</i>';
    }
    /* 命宫标记提到宫名旁（与「身」「来因」同级），不再缩在宫格右下角 */
    if (pills) cls += " has-pill";
    var rng = p.decadal && p.decadal.range ? p.decadal.range[0] + "-" + p.decadal.range[1] : "";
    var col = slot % 4 + 1, row = Math.floor(slot / 4) + 1;
    return '<div class="' + cls + ' zw-o-' + zwOrder(p) + '" data-bi="' + p.index + '" style="grid-column:' + col + ';grid-row:' + row + '">' +
      '<div class="zw-pal-h"><b>' + esc(zwPN(p.name)) + '</b>' +
        (isSoul ? '<em class="soul">命</em>' : '') +
        (p.isBodyPalace ? '<em>身</em>' : '') + (p.isOriginalPalace ? '<em class="g">来因</em>' : '') +
        '<span>' + esc(p.heavenlyStem + p.earthlyBranch) + '</span></div>' +
      '<div class="zw-pal-stars">' + majors + minors + adj + '</div>' +
      ((pills || rng) ? '<div class="zw-pal-foot">' +
        '<span class="zw-pal-rng">' + rng + '</span>' +
        (pills ? '<span class="zw-pal-pills">' + pills + '</span>' : "") + '</div>' : "") +
    '</div>';
  }
  function zwCenterHTML() {
    var c = zwS().chart;
    if (!c) return "";
    var pillars = String(c.chineseDate || "").trim().split(/\s+/).slice(0, 4);
    var pl = ["年", "月", "日", "时"];
    var yearStem = (pillars[0] || "")[0] || "";
    var yy = ("甲丙戊庚壬".indexOf(yearStem) >= 0 ? "阳" : "阴") + (c.gender || "男");
    var row = pillars.map(function (t, i) {
      return '<div class="zw-p2"><i>' + pl[i] + '</i><b>' + esc(t[0] || "") + '</b><span>' + esc(t.slice(1)) + '</span></div>';
    }).join("");
    return '<div class="zw-center">' +
      '<div class="zw-c1">' + esc(yy) + ' · ' + esc(c.fiveElementsClass || "") + '</div>' +
      '<div class="zw-c2">阳历 ' + esc(String(c.solarDate || "").replace(/-/g, ".")) + ' ' + esc(c.timeRange || "") + '</div>' +
      '<div class="zw-c2">农历 ' + esc(c.lunarDate || "") + ' · ' + esc(c.time || "") + '</div>' +
      '<div class="zw-cp">' + row + '</div>' +
      '<div class="zw-c3"><span>命主 <b>' + esc(c.soul || "") + '</b></span><span>身主 <b>' + esc(c.body || "") + '</b></span>' +
        '<span>生肖 <b>' + esc(c.zodiac || "") + '</b></span><span>星座 <b>' + esc(c.sign || "") + '</b></span></div>' +
    '</div>';
  }
  function zwOverlay() {
    var st = zwS(), h = st.horo;
    if (!h) return null;
    var grid = st.view === "fortune";
    return {
      dNames: grid && h.decadal ? h.decadal.palaceNames : null,
      decadalIdx: grid && h.decadal ? h.decadal.index : -1,
      yNames: grid && h.yearly ? h.yearly.palaceNames : null,
      yearlyIdx: grid && h.yearly ? h.yearly.index : -1,
      dMut: grid && h.decadal ? zwMutMap(h.decadal.mutagen) : null,
      yMut: grid && h.yearly ? zwMutMap(h.yearly.mutagen) : null
    };
  }
  /* 三方四正虚线：已按需求移除，命盘不再绘制任何连线 */
  /* 固定尺寸十二宫盘：4×4 网格，中宫跨 2×2 */
  function zwPlate() {
    var pals = zwPalaces(), ov = zwOverlay(), html = "";
    for (var slot = 0; slot < 16; slot++) {
      var bi = ZW_SLOT[slot];
      if (bi === -1) { if (slot === 5) html += zwCenterHTML(); continue; }
      var p = pals[bi];
      if (p) html += zwPalaceHTML(p, slot, ov);
    }
    return '<div class="zw-plate" id="zw-plate">' + html + '</div>';
  }
  function zwDetailHTML() {
    var st = zwS(), p = zwPalaces()[st.sel];
    if (!p) return '<p class="p-note zw-detail-hint">点选任一宫位，查看该宫的星曜与运限细节。</p>';
    function starLine(list) {
      if (!list || !list.length) return '<span class="zw-none">—</span>';
      return list.map(function (s) {
        return '<span class="zw-dstar">' + esc(s.name) +
          (s.brightness ? '<i>' + esc(s.brightness) + '</i>' : '') +
          (s.mutagen ? '<b class="zw-mut m' + ZW_MUT.indexOf(s.mutagen) + '">' + esc(s.mutagen) + '</b>' : '') + '</span>';
      }).join("");
    }
    var trine = [1, 5, 7].map(function (d) { return zwPalaces()[(p.index + d) % 12]; }).filter(Boolean)
      .map(function (x) { return '<button class="zw-jump" data-bi="' + x.index + '">' + esc(zwPN(x.name)) + '</button>'; }).join("");
    var dom = ZW_DOMAIN[p.name] || "人生", pn = zwPN(p.name);
    var chips = [
      { t: "这一宫的特点", q: "「" + pn + "」的星曜说明我在" + dom + "上有什么特点？" },
      { t: "优势与警惕", q: "「" + pn + "」的优势与需要警惕的地方分别是什么？" },
      { t: "如何改善", q: "想改善" + dom + "，从「" + pn + "」看该怎么做？" }
    ].map(function (c) { return '<button data-q="' + esc(c.q) + '">' + esc(c.t) + '</button>'; }).join("");
    return '<div class="zw-detail">' +
      '<div class="zw-d-h"><b>' + esc(zwPN(p.name)) + '</b><span>' + esc(p.heavenlyStem + p.earthlyBranch) + '</span>' +
        (p.isBodyPalace ? '<em>身宫</em>' : '') +
        '<button class="zw-close" id="zw-close" type="button">收起</button></div>' +
      '<div class="zw-d-row"><label>主星</label><div>' + starLine(p.majorStars) + '</div></div>' +
      '<div class="zw-d-row"><label>辅星</label><div>' + starLine(p.minorStars) + '</div></div>' +
      '<div class="zw-d-row"><label>杂曜</label><div>' + starLine(p.adjectiveStars) + '</div></div>' +
      '<div class="zw-d-row"><label>十二神</label><div class="zw-d-small">长生 ' + esc(p.changsheng12 || "—") +
        ' · 博士 ' + esc(p.boshi12 || "—") + ' · 将前 ' + esc(p.jiangqian12 || "—") + ' · 岁前 ' + esc(p.suiqian12 || "—") + '</div></div>' +
      '<div class="zw-d-row"><label>大限</label><div class="zw-d-small">' +
        (p.decadal && p.decadal.range ? p.decadal.range[0] + "–" + p.decadal.range[1] + " 岁（" + esc(p.decadal.heavenlyStem + p.decadal.earthlyBranch) + "）" : "—") + '</div></div>' +
      '<div class="zw-d-row"><label>三方四正</label><div>' + trine + '</div></div>' +
      '<div class="zw-d-ask">' +
        '<div class="zw-d-ask-h">就「' + esc(pn) + '」提问<span>' + esc(dom) + '</span></div>' +
        '<div class="p-suggest zw-chips zw-dchips">' + chips + '</div>' +
        '<div class="zw-ask-row"><input class="ti" id="zw-dq" placeholder="例如：这一宫的星曜对' + esc(dom) + '意味着什么？" />' +
          '<button class="tool-ai zw-ask-btn" id="zw-dask" type="button">AI 解读</button></div>' +
        '<div id="zw-d-ai-out"></div>' +
      '</div>' +
    '</div>';
  }
  /* 格局启发式、星曜/四化含义（沿用原紫微服务的命盘总览口径） */
  var ZW_GE = [
    { stars: ["七杀", "破军", "贪狼"], name: "杀破狼格", type: "开创型", desc: "人生主旋律是开新局、破旧局，变动中成事。" },
    { stars: ["紫微", "天府", "廉贞", "武曲", "天相"], name: "紫府相格", type: "领导型", desc: "稳中掌局，善统御资源、组织人事，以守成与经营见长。" },
    { stars: ["太阳", "巨门", "天机"], name: "巨日格", type: "支援型", desc: "以言才与专业策动他人，宜传播、参谋与专业路线。" },
    { stars: ["天同", "天梁", "太阴"], name: "机月同梁格", type: "合作型", desc: "温和周全，长于协调稳健，细水长流。" }
  ];
  var ZW_STAR_MEAN = {
    "紫微": "帝座主尊贵领导", "天府": "库星主稳健守成", "武曲": "财星主刚毅执行", "天相": "印星主辅佐公正",
    "廉贞": "主事业心与原则", "七杀": "主变革冲劲", "破军": "主破旧立新", "贪狼": "主多才交际",
    "太阳": "主博爱名声", "太阴": "主细腻蓄藏", "天梁": "荫星主原则庇荫", "天同": "福星主安逸亲和",
    "天机": "智星主谋略机变", "巨门": "主口才思辨"
  };
  var ZW_MUT_MEAN = { "禄": "财禄顺遂", "权": "掌控主导", "科": "名誉贵人", "忌": "执念阻滞" };
  var ZW_STAR_NICK = {
    "紫微": "帝座", "天府": "库星", "武曲": "财星", "天相": "印星", "廉贞": "事业之星",
    "七杀": "将星", "破军": "耗星", "贪狼": "桃花星", "太阳": "光明星", "太阴": "富星",
    "天梁": "荫星", "天同": "福星", "天机": "智星", "巨门": "口舌星"
  };
  var ZW_MUT_TAIL = {
    "禄": "机遇在此流通，进益顺遂，易得实质好处与人脉助力",
    "权": "能量强势主导，掌控与成就欲在此放大，有成亦有压力",
    "科": "名声显扬于此，贵人多助，处事得体有分寸",
    "忌": "执念与阻滞较重，易纠结内耗，需防反复与是非"
  };
  var ZW_DOMAIN = {
    "命宫": "性格本质", "兄弟": "平辈情缘", "夫妻": "感情婚姻", "子女": "子嗣晚辈",
    "财帛": "理财进财", "疾厄": "健康体质", "迁移": "在外机遇", "仆役": "人脉合作",
    "官禄": "事业模式", "田宅": "家运不动产", "福德": "精神生活", "父母": "长上缘"
  };
  var ZW_BR_W = { "庙": 3, "旺": 2.5, "得": 2, "利": 1.5, "平": 1, "不": 0.5, "陷": 0 };
  function zwMingGe(soul, pals) {
    var names = (soul.majorStars || []).map(function (s) { return s.name; });
    if (!names.length) {
      var opp = pals[(soul.index + 6) % 12];
      names = opp ? (opp.majorStars || []).map(function (s) { return s.name; }) : [];
    }
    var hit = null;
    for (var i = 0; i < ZW_GE.length; i++) {
      if (ZW_GE[i].stars.some(function (n) { return names.indexOf(n) >= 0; })) { hit = ZW_GE[i]; break; }
    }
    hit = hit || ZW_GE[3];
    return { name: hit.name, type: hit.type, desc: hit.desc, starNames: names };
  }
  function zwMeaning(p) {
    var majors = (p.majorStars || []).slice().sort(function (a, b) {
      return (ZW_BR_W[b.brightness] != null ? ZW_BR_W[b.brightness] : 1.5) - (ZW_BR_W[a.brightness] != null ? ZW_BR_W[a.brightness] : 1.5);
    });
    if (!majors.length) return "无主星，格局随对宫与夹宫流动，断事需借参。";
    return majors.slice(0, 2).map(function (s) {
      var t = s.name + (ZW_STAR_MEAN[s.name] || "");
      if (s.brightness === "陷" || s.brightness === "不") t += "（落" + s.brightness + "力弱）";
      if (s.mutagen && ZW_MUT_MEAN[s.mutagen]) t += "，化" + s.mutagen + "主" + ZW_MUT_MEAN[s.mutagen];
      return t;
    }).join("；") + "。";
  }
  /* 命格：原「命盘总览」的格局解析 / 生年四化 + 十二宫一览 + 提问 */
  function zwPatternHTML() {
    var st = zwS(), c = st.chart;
    if (!c) return "";
    var pals = (c.palaces || []).slice().sort(function (a, b) { return a.index - b.index; });
    var soul = null;
    for (var i = 0; i < pals.length; i++) if (pals[i].name === "命宫") soul = pals[i];
    if (!soul) return "";
    var ge = zwMingGe(soul, pals);
    var pillars = String(c.chineseDate || "").trim().split(/\s+/);
    var yy = ("甲丙戊庚壬".indexOf((pillars[0] || "")[0] || "") >= 0 ? "阳" : "阴") + (c.gender || "男");
    var soulStars = (soul.majorStars || []).map(function (s) { return s.name + (s.brightness || ""); }).join("·") ||
      "空宫（借对宫" + ge.starNames.join("·") + "）";

    // 格局解析：命宫 + 三方四正
    var tri = [soul.index, (soul.index + 4) % 12, (soul.index + 8) % 12, (soul.index + 6) % 12];
    var cards = tri.map(function (idx, k) {
      var p = pals[idx];
      if (!p) return "";
      var stars = (p.majorStars || []).map(function (s) {
        return '<span class="zw-tstar">' + esc(s.name) + (s.brightness ? '<i>' + esc(s.brightness) + '</i>' : '') +
          (s.mutagen ? '<b class="zw-mut m' + ZW_MUT.indexOf(s.mutagen) + '">' + esc(s.mutagen) + '</b>' : '') + '</span>';
      }).join("") || '<span class="zw-none">无主星</span>';
      var minors = (p.minorStars || []).slice(0, 3).map(function (s) { return esc(s.name); }).join(" ");
      return '<div class="zw-gcard' + (k === 0 ? " life" : "") + '">' +
        '<div class="zw-gcard-h"><b>' + esc(zwPN(p.name)) + '</b>' + (k === 0 ? '<em>' + esc(p.earthlyBranch) + '</em>' : "") +
          (p.isBodyPalace ? '<em>身</em>' : "") + '<span>' + esc(p.heavenlyStem + p.earthlyBranch) + '</span></div>' +
        '<div class="zw-gcard-stars">' + stars + (minors ? '<span class="zw-gcard-minor">' + minors + '</span>' : "") + '</div>' +
        '<div class="zw-gcard-mean"><b>' + esc(ZW_DOMAIN[p.name] || "") + '</b>：' + esc(zwMeaning(p)) + '</div>' +
      '</div>';
    }).join("");

    // 生年四化
    var found = {};
    pals.forEach(function (p) {
      [(p.majorStars || []), (p.minorStars || [])].forEach(function (list) {
        list.forEach(function (s) { if (s.mutagen && !found[s.mutagen]) found[s.mutagen] = { star: s.name, palace: p.name }; });
      });
    });
    var mutLine = ["禄", "权", "科", "忌"].filter(function (m) { return found[m]; }).map(function (m) {
      var f = found[m];
      return '<div class="zw-mutitem"><div class="zw-mutitem-h"><b>' + esc(f.star) + '</b>' +
        '<span class="zw-mut m' + ZW_MUT.indexOf(m) + '">' + m + '</span>' +
        '<i>落' + esc(f.palace) + '宫 · ' + esc(ZW_DOMAIN[f.palace] || "人生领域") + '</i></div>' +
        '<p>' + esc((ZW_STAR_NICK[f.star] ? ZW_STAR_NICK[f.star] + "化" + m + "，" : "") + ZW_MUT_TAIL[m]) + '。</p></div>';
    }).join("");

    // 十二宫一览（从命宫起）
    var ORDER = ["命宫", "兄弟", "夫妻", "子女", "财帛", "疾厄", "迁移", "仆役", "官禄", "田宅", "福德", "父母"];
    var soulIdx = ORDER.indexOf("命宫");
    var rows = pals.slice().sort(function (a, b) {
      var ia = (ORDER.indexOf(a.name) - soulIdx + 12) % 12, ib = (ORDER.indexOf(b.name) - soulIdx + 12) % 12;
      return ia - ib;
    }).map(function (p) {
      var majors = (p.majorStars || []).map(function (s) {
        return esc(s.name) + (s.brightness ? '<i>' + esc(s.brightness) + '</i>' : '') +
          (s.mutagen ? '<b class="zw-mut m' + ZW_MUT.indexOf(s.mutagen) + '">' + esc(s.mutagen) + '</b>' : '');
      }).join("、") || '<span class="zw-none">空宫</span>';
      var minors = (p.minorStars || []).slice(0, 3).map(function (s) { return esc(s.name); }).join("、");
      var rng = p.decadal && p.decadal.range ? p.decadal.range[0] + "-" + p.decadal.range[1] : "";
      return '<tr><td class="zw-td-n">' + esc(zwPN(p.name)) + (p.isBodyPalace ? '<em>身</em>' : '') + '</td>' +
        '<td>' + esc(p.heavenlyStem + p.earthlyBranch) + '</td>' +
        '<td>' + majors + '</td><td class="zw-td-m">' + minors + '</td><td class="zw-td-r">' + rng + '</td></tr>';
    }).join("");

    return '<div class="zw-pattern">' +
      '<div class="zw-hero">' +
        '<div class="zw-hero-n">' + esc(ge.name) + '<span>· ' + esc(ge.type) + '</span></div>' +
        '<div class="zw-hero-d">' + esc(ge.desc) + '</div>' +
        '<div class="zw-hero-m"><b>' + esc(soulStars) + '</b> 坐命' + esc(soul.earthlyBranch) + '宫 · ' + esc(yy) +
          ' · ' + esc(c.fiveElementsClass || "") + ' · 命主' + esc(c.soul || "") + ' 身主' + esc(c.body || "") + '</div>' +
      '</div>' +
      '<div class="zw-sec-h">格局解析<span>命宫三方四正 · 每宫含义</span></div>' +
      '<div class="zw-gcards">' + cards + '</div>' +
      (mutLine ? '<div class="zw-sec-h">生年四化<span>这一生的能量落点</span></div><div class="zw-muts">' + mutLine + '</div>' : "") +
      '<div class="zw-sec-h">十二宫一览<span>主星 · 辅星 · 大限</span></div>' +
      '<div class="zw-tbl-wrap"><table class="zw-tbl"><thead><tr><th>宫位</th><th>干支</th><th>主星</th><th>辅星</th><th>大限</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
      '<div class="zw-ask">' +
        '<div class="zw-ask-h">就这张命盘提问</div>' +
        '<div class="p-suggest zw-chips"><button data-q="我的命格格局如何？优势与短板分别是什么？">格局与性格</button>' +
          '<button data-q="事业方向适合什么？有哪些需要注意的短板？">事业方向</button>' +
          '<button data-q="财运格局如何？哪些阶段财运会明显转好？">财运</button></div>' +
        '<div class="zw-ask-row"><input class="ti" id="zw-q" placeholder="输入你想问的问题…" />' +
          '<button class="tool-ai zw-ask-btn" id="zw-ask">AI 解读</button></div>' +
      '</div>' +
      '<div id="zw-ai-out"></div>' +
    '</div>';
  }

  /* 运势盘：大限 / 流年直接点选（不用左右箭头），选中后叠加显示四化与宫位标注 */
  function zwGZ(y) {
    var g = "甲乙丙丁戊己庚辛壬癸", z = "子丑寅卯辰巳午未申酉戌亥";
    return g[((y - 4) % 10 + 10) % 10] + z[((y - 4) % 12 + 12) % 12];
  }
  function zwFortuneHTML() {
    var st = zwS(), h = st.horo, c = st.chart;
    if (!c) return "";
    var by = parseInt(String(c.solarDate || "").slice(0, 4), 10) || 0;
    var decs = (c.palaces || []).filter(function (p) { return p.decadal && p.decadal.range; })
      .sort(function (a, b) { return a.decadal.range[0] - b.decadal.range[0]; });
    var curIdx = 0;
    decs.forEach(function (p, i) {
      var s = by + p.decadal.range[0] - 1, e = by + p.decadal.range[1] - 1;
      if (st.year >= s && st.year <= e) curIdx = i;
    });
    var cur = decs[curIdx];
    var ys = cur ? by + cur.decadal.range[0] - 1 : st.year;
    var ye = cur ? by + cur.decadal.range[1] - 1 : st.year;
    var decBtns = decs.map(function (p, i) {
      var s = by + p.decadal.range[0] - 1, e = by + p.decadal.range[1] - 1;
      return '<button class="zw-pickb' + (i === curIdx ? " on" : "") + '" type="button" data-at="' + s + '">' +
        '<b>' + p.decadal.range[0] + '-' + p.decadal.range[1] + '</b><span>' + s + '-' + e + '</span></button>';
    }).join("");
    var yearBtns = "";
    for (var y = ys; y <= ye; y++) {
      yearBtns += '<button class="zw-pickb y' + (y === st.year ? " on" : "") + '" type="button" data-at="' + y + '">' +
        '<b>' + y + '</b><span>' + (y - by + 1) + ' 岁</span></button>';
    }
    /* 选择栏放命盘下方：本命 / 运势两盘的命盘位置一致，切换视图不跳动 */
    return '<div class="zw-fortune">' +
      zwPlate() +
      '<div class="zw-pick">' +
        '<div class="zw-pick-h"><span class="zw-pick-l">大限</span>' +
          '<span class="zw-pick-n">' + esc(cur ? zwPN(cur.name) : "") + ' · ' + ys + '-' + ye +
            (h && h.decadal ? ' · ' + esc(h.decadal.heavenlyStem + h.decadal.earthlyBranch) : "") + '</span>' +
          '<button class="zw-ynow" id="zw-ynow" type="button">回到今年</button></div>' +
        '<div class="zw-pick-grid">' + decBtns + '</div>' +
        '<div class="zw-pick-h"><span class="zw-pick-l">流年</span>' +
          '<span class="zw-pick-n">' + st.year + ' 年 · ' + zwGZ(st.year) + '</span></div>' +
        '<div class="zw-pick-grid y">' + yearBtns + '</div>' +
      '</div>' +
      zwDetailHTML() +
    '</div>';
  }
  /* 渲染当前视图 */
  function zwRender() {
    var st = zwS(), wrap = $("#zw-result");
    if (!wrap) return;
    if (!st.chart) { wrap.innerHTML = ""; return; }
    var body;
    if (st.view === "pattern") body = zwPatternHTML();
    else if (st.view === "fortune") body = zwFortuneHTML();
    else body = zwPlate() + zwDetailHTML();
    wrap.innerHTML =
      '<div class="zw-bar">' +
        '<div class="zw-tabs" id="zw-tabs">' +
          '<button type="button" data-v="pattern"' + (st.view === "pattern" ? ' class="on"' : "") + '>命格</button>' +
          '<button type="button" data-v="plate"' + (st.view === "plate" ? ' class="on"' : "") + '>本命</button>' +
          '<button type="button" data-v="fortune"' + (st.view === "fortune" ? ' class="on"' : "") + '>运势</button>' +
        '</div>' +
        zwProfileAside() +
      '</div>' +
      '<div class="zw-body">' + body + '</div>';
    zwBind();
  }
  /* 紫微结果标题行右侧的档案来源提示（与八字同一套措辞与样式） */
  function zwProfileAside() {
    if (!S.zwFromProfile) return "";
    return '<span class="result-aside" id="zw-edit">已使用档案中的出生信息 · ' +
      '<button type="button" class="link-btn" data-zw-edit="1">修改出生信息</button></span>';
  }
  // 「修改出生信息」：展开紫微表单并移除提示（结果区会重绘，用事件委托）
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-zw-edit]");
    if (!b) return;
    S.zwFromProfile = false;
    // 标记「本次排盘后写回档案」：用户在档案态改过出生信息，档案要跟着更新
    S.zwSaveBirth = true;
    var fw = $("#zw-form-wrap"); if (fw) fw.style.display = "";
    var aside = $("#zw-edit"); if (aside) aside.remove();
    var g = $("#zw-form .tf-group"); if (g) g.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  function zwBind() {
    var st = zwS();
    $$("#zw-tabs button").forEach(function (b) {
      b.onclick = function () {
        st.view = b.dataset.v; st.sel = null;
        zwRender(); zwStoreSync();
        // 运势盘的大限 / 流年叠加数据按需拉取（刷新后直接切到运势时 horo 还没加载）
        if (st.view === "fortune" && !st.horo) zwHoro().then(zwRender);
      };
    });
    $$("#zw-plate .zw-pal").forEach(function (el) {
      el.onclick = function () {
        var bi = +el.dataset.bi;
        st.sel = st.sel === bi ? null : bi;
        zwRender();
        var d = $(".zw-detail") || $(".zw-detail-hint");
        if (d && st.sel != null) d.scrollIntoView({ behavior: "smooth", block: "nearest" });
      };
    });
    var close = $("#zw-close");
    if (close) close.onclick = function () { st.sel = null; zwRender(); };
    $$(".zw-jump").forEach(function (b) {
      b.onclick = function () { st.sel = +b.dataset.bi; zwRender(); };
    });
    if (st.view === "fortune") {
      var load = function (y) { st.year = y; return zwHoro().then(zwRender); };
      $$(".zw-pickb").forEach(function (b) {
        b.onclick = function () { load(+b.dataset.at); };
      });
      var ynow = $("#zw-ynow");
      if (ynow) ynow.onclick = function () { load(new Date().getFullYear()); };
      // 选中项居中（用 rect 计算，offsetLeft 会受定位祖先影响导致滚到最右、选中项被滚出视野）
      $$(".zw-pick-grid").forEach(function (g) {
        var on = $(".zw-pickb.on", g);
        if (!on) return;
        var center = function () {
          var gr = g.getBoundingClientRect(), br = on.getBoundingClientRect();
          var d = (br.left - gr.left) - (g.clientWidth - on.offsetWidth) / 2;
          g.scrollLeft = Math.max(0, Math.min(g.scrollWidth - g.clientWidth, g.scrollLeft + d));
        };
        center();
        requestAnimationFrame(center);
      });
    }
    // 宫位详情里的「就此宫提问」（本命盘 / 运势盘通用）
    var dq = $("#zw-dq"), dask = $("#zw-dask"), psel = zwPalaces()[st.sel];
    if (dq && dask && psel) {
      var runPalAsk = function () {
        var v = dq.value.trim();
        if (!v) { toast("请先写下你想问的问题"); dq.focus(); return; }
        zwAsk(v.indexOf(zwPN(psel.name)) >= 0 ? v : "（只看「" + zwPN(psel.name) + "」）" + v, "#zw-d-ai-out", "#zw-dq");
      };
      dask.onclick = runPalAsk;
      dq.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); runPalAsk(); } };
      $$(".zw-dchips button").forEach(function (b) {
        b.onclick = function () { dq.value = b.dataset.q; dq.focus(); };
      });
    }
    if (st.view === "pattern") {
      $$(".zw-chips button").forEach(function (b) {
        b.onclick = function () { var q = $("#zw-q"); if (q) { q.value = b.dataset.q; q.focus(); } };
      });
      var ask = $("#zw-ask"), input = $("#zw-q");
      if (ask) ask.onclick = function () { zwAsk(input ? input.value.trim() : ""); };
      if (input) input.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); zwAsk(input.value.trim()); } };
    }
  }
  /* AI 推演：紫微与其他功能走完全相同的统一链路（/api/deduce → SSE → hid → 追问）。
     推演参数用命盘 id 保证与本盘一致；渲染/免责/追问条全部复用通用 streamToUrl。 */
  function zwAsk(q, outSel, inputSel) {
    var st = zwS();
    if (!q) { toast("请先写下你想问的问题"); var i0 = $(inputSel || "#zw-q"); if (i0) i0.focus(); return; }
    if (!st.id) { toast("命盘未就绪，请稍候"); return; }
    var out = $(outSel || "#zw-ai-out");
    if (!out) return;
    if (!prepareNewQuestion(out, q)) return;
    var url = "/api/deduce?id=" + encodeURIComponent(st.id) + "&q=" + encodeURIComponent(q) + authParam();
    streamToUrl(url, "AI 解读", q, out, false);
  }
  function zwHoro(retried) {
    var st = zwS();
    if (!st.id) return Promise.resolve();
    return fetch("/api/horoscope?id=" + encodeURIComponent(st.id) + "&year=" + st.year)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) { st.horo = d.horoscope; return; }
        st.horo = null;
        // 缓存的盘 id 失效（服务重启 / 记录过期）：清缓存后按档案重排一次，保留当前视图
        if (!retried && st.birth) {
          try { sessionStorage.removeItem(ZW_STORE); } catch (e) {}
          st.key = null;
          zwStart(st.birth, true, true);
        }
      })
      .catch(function () { st.horo = null; });
  }
  function zwStart(birth, force, keepView) {
    var wrap = $("#zw-result");
    if (!wrap) return;
    var st = zwS();
    var key = zwBirthKey(birth);
    var hit = force ? null : zwStoreGet();
    if (hit && hit.key === key && hit.chart && hit.id) {
      // 命中缓存：直接出盘，没有「正在起盘」闪屏，也不发请求
      st.chart = hit.chart; st.id = hit.id; st.key = key; st.birth = birth;
      st.sel = null; st.view = keepView && st.view ? st.view : (hit.view || "plate");
      st.year = hit.year || new Date().getFullYear();
      zwRender();
      if (st.view === "fortune") zwHoro().then(zwRender);
      return;
    }
    wrap.innerHTML = '<p class="p-note" style="text-align:center;margin:16px 0">正在起盘…</p>';
    st.chart = null; st.id = null; st.sel = null;
    if (!(keepView && st.view)) st.view = "plate";
    st.year = new Date().getFullYear();
    st.key = key; st.birth = birth;
    var p = new URLSearchParams({
      date: birth.date, timeIndex: birth.timeIndex, gender: birth.gender || "男",
      calendar: birth.calendar || "solar", fixLeap: "true"
    });
    // 用户主动改过出生信息 → 写回档案（档案是全站唯一数据源）
    if (S.zwSaveBirth && S.profile) {
      p.set("save", "1");
      p.set("profile_id", String(S.profile.id));
      p.set("token", S.profile.token);
      if (birth.hour != null) p.set("hour", String(birth.hour));
      if (birth.minute != null) p.set("minute", String(birth.minute));
      if (birth.know_time != null) p.set("know_time", birth.know_time ? "1" : "0");
    }
    fetch("/api/chart?" + p.toString()).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || "排盘失败");
      st.chart = d.chart; st.id = d.id;
      if (S.zwSaveBirth && S.profile) {
        S.zwSaveBirth = false;
        toast("出生信息已同步到个人档案，其它功能将使用新信息");
        profileBirthChanged();
      }
      zwStoreSync();
      return zwHoro();
    }).then(function () {
      zwRender();
      var bar = $(".zw-bar");
      if (bar) bar.scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function (e) {
      wrap.innerHTML = '<p class="p-err" style="text-align:center">' + esc(e.message || "排盘失败") + '</p>';
      var fw = $("#zw-form-wrap"); if (fw) fw.style.display = "";
    });
  }

  function renderZiweiEntry() {
    stageEl().innerHTML =
      toolHero("紫微斗数", "以命盘十二宫观人生格局：命宫、财帛、事业、姻缘一目了然；登录后自动带入档案出生信息。") +
      '<div id="zw-form-wrap"><div class="tool-card"><div class="tool-form" id="zw-form">' +
        '<div class="tf-group"><div class="tf-gt">基本信息</div>' +
          '<div class="tf-grid">' +
            '<div class="tf-field"><label>性别</label><select class="ti" id="zw-gender"><option>男</option><option>女</option></select></div>' +
          '</div>' +
        '</div>' +
        '<div class="tf-group">' + birthFieldsHTML("zw", { title: "时间信息" }) + '</div>' +
        '<button class="tool-submit" id="zw-calc">开始排盘</button>' +
        '<div class="p-err" id="zw-err"></div>' +
      '</div></div></div>' +
      '<div id="zw-result"></div>' +
      aboutDetails("关于紫微斗数", [
        '<b>命盘</b>：以出生时间安十二宫与主星，命宫为自我根基，财帛、事业、迁移等宫位各司其职。',
        '<b>四化</b>：化禄、化权、化科、化忌描述星曜能量的流动方向，是看运势变化的关键。',
        '<b>大限流年</b>：十年一大限、一年一流年，命盘随时间推移呈现不同阶段的主题。'
      ], "全部排盘由程序确定性计算；登录后档案出生信息自动带入，无需重复填写。");
    birthFieldsBind("zw");
    S.zwFromProfile = false;
    S.zwSaveBirth = false;
    $("#zw-calc").onclick = function () {
      var b = birthCollect("zw");
      if (b.mode === "bazi") { $("#zw-err").textContent = "紫微排盘请使用「日期」方式输入"; return; }
      if (!b.year || !b.month || !b.day) { $("#zw-err").textContent = "请先选择出生日期"; return; }
      $("#zw-err").textContent = "";
      // 时辰序数：0=早子…12=晚子；未知出生时间默认午时（与档案口径一致）
      var ti = b.know_time ? (b.hour === 23 ? 12 : Math.floor((b.hour + 1) / 2)) : 6;
      S.zwFromProfile = false;
      zwStart({ date: b.year + "-" + b.month + "-" + b.day, timeIndex: ti,
        gender: $("#zw-gender").value, calendar: b.calendar,
        hour: b.hour, minute: b.minute, know_time: b.know_time });
    };
    // 已有缓存的命盘：直接出盘（登录用户不再每次重新排盘）
    var cached = zwStoreGet();
    var restoreCache = function () {
      if (!cached || !cached.birth || !cached.chart) return false;
      if (S.profile && cached.uid !== S.profile.id) return false;
      // 先把表单回填好（点「修改出生信息」时不会是一张空表），再直接出盘
      var seg = String(cached.birth.date || "").split("-"), ti0 = +cached.birth.timeIndex || 0;
      var hr0 = ti0 === 12 ? 23 : (ti0 === 0 ? 0 : ti0 * 2 - 1);
      birthFieldsBind("zw", { calendar: cached.birth.calendar || "solar",
        year: +seg[0], month: +seg[1], day: +seg[2], hour: hr0, minute: 0, know_time: true });
      if ($("#zw-gender")) $("#zw-gender").value = cached.birth.gender || "男";
      zwStart(cached.birth);
      return true;
    };
    // 登录态：始终以档案出生信息为准（与八字一致），不再让缓存抢先决定走哪条路径
    if (S.profile) {
      fetch("/api/profile/get?id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token))
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok && d.profile && d.profile.birth) {
            var b = d.profile.birth;
            var yyyy = b.year, mm = b.month, dd = b.day;
            if ((yyyy == null || mm == null || dd == null) && b.date) {
              var seg = String(b.date).split("-"); yyyy = +seg[0]; mm = +seg[1]; dd = +seg[2];
            }
            birthFieldsBind("zw", { calendar: "solar", year: yyyy, month: mm, day: dd,
              hour: b.hour != null ? b.hour : 12, minute: b.minute != null ? b.minute : 0,
              know_time: b.know_time !== false });
            if (b.gender) $("#zw-gender").value = (b.gender === "male" ? "男" : b.gender === "female" ? "女" : b.gender);
            var ti = b.know_time === false ? 6 : (b.hour === 23 ? 12 : Math.floor(((b.hour != null ? b.hour : 12) + 1) / 2));
            // 档案带入：与八字一致，收起表单并给出「已使用档案中的出生信息」提示
            S.zwFromProfile = true;
            var fw = $("#zw-form-wrap"); if (fw) fw.style.display = "none";
            zwStart({ date: yyyy + "-" + mm + "-" + dd, timeIndex: ti,
              gender: $("#zw-gender").value, calendar: b.calendar || "solar",
              hour: b.hour != null ? b.hour : 12, minute: b.minute != null ? b.minute : 0,
              know_time: b.know_time !== false });
          } else {
            // 档案里没有出生信息：退回手动填写
            restoreCache();
          }
        }).catch(function () { restoreCache(); });
      return;
    }
    // 未登录：用上次的手动排盘结果，否则展示表单
    restoreCache();
    applyGate("ziwei");
  }


  /* ---------------- 启动 ---------------- */
  window.addEventListener("hashchange", function () {
    var f = parseHash();
    if (["liuyao","qimen"].indexOf(f) >= 0) { toast("该功能在二期上线"); navigate("bazi"); location.hash = "/bazi"; return; }
    navigate(f);
  });
  $("#p-navlist").addEventListener("click", function (e) {
    var btn = e.target.closest(".p-navitem");
    if (btn) { e.preventDefault(); go(btn.dataset.feature); }
  });
  // 移动端抽屉：汉堡开合 / 遮罩关闭 / Esc 关闭
  var burger = $("#p-burger");
  if (burger) burger.onclick = toggleNav;
  var navMask = $("#p-nav-mask");
  if (navMask) navMask.onclick = closeNav;
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeNav();
  });
  // 桌面↔移动切换时清掉残留的抽屉状态
  window.addEventListener("resize", function () {
    if (window.innerWidth > 900) closeNav();
  });
  /* iOS Safari 聚焦字号 < 16px 的输入框会自动放大整页。提问框按卡片层级用 14px，
     因此在手指按下（聚焦之前）临时提到 16px，失焦后再还原：既不缩放页面，也不牺牲字号层级 */
  (function () {
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (!isIOS) return;
    document.addEventListener("touchstart", function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains("ti")) t.style.fontSize = "16px";
    }, true);
    document.addEventListener("focusout", function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains("ti")) t.style.fontSize = "";
    }, true);
  })();
  $("#p-theme").onclick = function () {
    var cur = document.documentElement.dataset.theme;
    var next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("zw-theme", next); } catch (e) {}
  };
  $("#p-modal-x").onclick = function () { $("#p-modal").classList.add("hidden"); };
  $("#p-modal").addEventListener("click", function (e) { if (e.target === this) this.classList.add("hidden"); });

  /* ================= 管理员（口令存内存，不落盘；只看用户名与运行日志，不看任何对话内容） ================= */
  var adminKey = "", adminTab = "users";
  function adminHeaders() { return { "x-admin-key": adminKey }; }
  function openAdmin() {
    var modal = $("#p-admin-modal"), box = $("#p-admin-content");
    modal.classList.remove("hidden");
    if (adminKey) { adminPanel(); return; }
    box.innerHTML = '<div class="ad-login"><h3>管理员登录</h3>' +
      '<p class="p-note pf-hint">管理入口仅用于账号管理与运行日志，不提供任何用户对话内容的查看。</p>' +
      '<div class="tf-field"><label>管理员口令</label><input class="ti" type="password" id="admin-key-in" placeholder="输入管理员口令" /></div>' +
      '<button class="tool-submit" type="button" id="admin-login-btn" style="width:100%;margin-top:12px">进入管理台</button></div>';
    $("#admin-login-btn").onclick = function () {
      var k = (($("#admin-key-in") || {}).value || "").trim();
      if (!k) { toast("请输入管理员口令"); return; }
      fetch("/api/admin/list", { headers: { "x-admin-key": k } })
        .then(function (r) { if (!r.ok) throw new Error("口令不正确"); return r.json(); })
        .then(function (d) {
          if (!d.ok) throw new Error("口令不正确");
          adminKey = k; adminPanel();
        }).catch(function (e) { toast(e.message || "验证失败"); });
    };
    var ki = $("#admin-key-in");
    if (ki) ki.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); $("#admin-login-btn").click(); } };
  }
  function adminPanel() {
    var box = $("#p-admin-content");
    box.innerHTML = '<div class="ad-head"><h3>管理台</h3>' +
      '<div class="ad-tabs">' +
        '<button class="ad-tab' + (adminTab === "users" ? " on" : "") + '" data-tab="users">用户管理</button>' +
        '<button class="ad-tab' + (adminTab === "logs" ? " on" : "") + '" data-tab="logs">运行日志</button>' +
      '</div><button class="ad-logout" id="admin-logout">退出</button></div>' +
      '<div id="admin-pane"><p class="p-note">加载中…</p></div>';
    $$(".ad-tab", box).forEach(function (b) {
      b.onclick = function () { adminTab = b.dataset.tab; adminPanel(); };
    });
    $("#admin-logout").onclick = function () { adminKey = ""; openAdmin(); };
    if (adminTab === "users") adminLoadUsers(); else adminLoadLogs();
  }
  function adminLoadUsers() {
    var pane = $("#admin-pane");
    fetch("/api/admin/list", { headers: adminHeaders() })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { pane.innerHTML = '<p class="p-note">加载失败</p>'; return; }
        var rows = (d.users || []).map(function (u) {
          return '<div class="ad-user"><div class="ad-user-info"><b>' + esc(u.name) + '</b>' +
            '<span>注册于 ' + esc(u.created) + '</span></div>' +
            '<button class="ad-del" data-name="' + esc(u.name) + '">删除</button></div>';
        }).join("") || '<p class="p-note">暂无用户</p>';
        pane.innerHTML = '<p class="p-note pf-hint">共 ' + (d.users || []).length + ' 位用户；仅显示用户名与注册时间，不含任何对话或出生信息。</p>' +
          '<div class="ad-users">' + rows + '</div>';
        $$(".ad-del", pane).forEach(function (b) {
          b.onclick = function () {
            if (!b.classList.contains("arm")) {
              b.classList.add("arm"); b.textContent = "确认删除?";
              setTimeout(function () { b.classList.remove("arm"); b.textContent = "删除"; }, 4000);
              return;
            }
            fetch("/api/admin/delete", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
              body: JSON.stringify({ name: b.dataset.name })
            }).then(function (r) { return r.json(); }).then(function (d) {
              if (!d.ok) { toast(d.error || "删除失败"); return; }
              adminLoadUsers(); toast("已删除用户");
            }).catch(function () { toast("删除失败"); });
          };
        });
      }).catch(function () { pane.innerHTML = '<p class="p-note">加载失败</p>'; });
  }
  function adminLoadLogs() {
    var pane = $("#admin-pane");
    fetch("/api/admin/logs?limit=200", { headers: adminHeaders() })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { pane.innerHTML = '<p class="p-note">加载失败</p>'; return; }
        var rows = (d.items || []).map(function (x) {
          var cls = x.status >= 500 ? "err" : (x.status >= 400 ? "warn" : "");
          return '<div class="ad-log ' + cls + '"><span class="ad-log-ts">' + esc(x.ts) + '</span>' +
            '<span class="ad-log-m">' + esc(x.method) + '</span>' +
            '<span class="ad-log-p">' + esc(x.path) + '</span>' +
            '<span class="ad-log-s">' + esc(x.status) + '</span>' +
            '<span class="ad-log-t">' + x.ms + 'ms</span></div>';
        }).join("") || '<p class="p-note">暂无日志</p>';
        pane.innerHTML = '<p class="p-note pf-hint">仅记录访问方法与脱敏路径，已过滤问题、密码、出生信息等全部对话相关内容。</p>' +
          '<div class="ad-logs">' + rows + '</div>';
      }).catch(function () { pane.innerHTML = '<p class="p-note">加载失败</p>'; });
  }
  $("#p-admin-link").onclick = openAdmin;
  $("#p-admin-x").onclick = function () { $("#p-admin-modal").classList.add("hidden"); };
  $("#p-admin-modal").addEventListener("click", function (e) { if (e.target === this) this.classList.add("hidden"); });

  // 归档解读卡：点标题展开/收起回看（事件委托，切页后仍有效）
  document.addEventListener("click", function (e) {
    var h = e.target.closest && e.target.closest(".p-ai-archived .p-ai-head");
    if (!h) return;
    var card = h.parentElement;
    if (card) card.classList.toggle("p-ai-open");
  });
  // 整轮归档卡：点头部展开/收起回看（问题绑定整轮，登录态下本功能内即可回看）
  document.addEventListener("click", function (e) {
    var h = e.target.closest && e.target.closest(".round-item-hd");
    if (!h) return;
    var item = h.parentElement;
    if (!item || !item.classList.contains("round-item")) return;
    var open = item.classList.toggle("open");
    var sign = $(".rsign", h);
    if (sign) sign.textContent = open ? "收起" : "展开回看";
  });
  // 「关于本功能」开合：委托到 document，页面重渲染后依然有效
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".ad-toggle");
    if (!b || !b.parentElement) return;
    var box = b.parentElement;
    if (!box.classList.contains("about-details")) return;
    var body = box.querySelector(".ad-body");
    if (!body) return;
    var open = !box.classList.contains("open");
    box.classList.toggle("open", open);
    b.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) setTimeout(function () { body.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, 40);
  });

  // 全站会话同步：内嵌紫微服务内登录/退出会写 zw-profile，此处实时跟随（写入方自身不触发 storage，故不自激）
  window.addEventListener("storage", function (e) {
    if (e.key !== "zw-profile") return;
    var p = null;
    try { p = e.newValue ? JSON.parse(e.newValue) : null; } catch (err) {}
    if (JSON.stringify(p) === JSON.stringify(S.profile)) return;
    var wasLogged = !!S.profile;
    S.profile = p && p.id && p.token ? { id: p.id, token: p.token, name: p.name } : null;
    var changed = wasLogged !== !!S.profile;
    if (changed) {
      if (!S.profile) clearUserData();   // 他处退出：同步清空本地缓存
      else dropStages();                  // 他处登录：清掉未登录态舞台，避免残留门禁
    }
    renderUser();
    // 同步视图：个人中心刷新统计；登录态切换时强制重建当前页（含门禁 / 档案带入）
    if (changed && S.feature === "profile") renderProfile();
    else if (changed) navigate(S.feature, true);
  });

  renderUser();
  var init = parseHash();
  if (["liuyao","qimen"].indexOf(init) >= 0) init = "bazi";
  // 品牌区点击返回首页
  var brand = $(".p-brand");
  if (brand) {
    brand.setAttribute("role", "link");
    brand.setAttribute("tabindex", "0");
    brand.style.cursor = "pointer";
    brand.title = "返回首页";
    var goHome = function () { go("home"); };
    brand.addEventListener("click", goHome);
    brand.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); } });
  }
  navigate(init);
})();
