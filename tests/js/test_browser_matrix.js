/*
 * 浏览器链路矩阵：从 contracts.json 的 ui 配方驱动，对所有功能跑同一组高频场景。
 *
 * roundtrip / followup / repaint / archive / reload / switch / logout
 * 只 mock AI SSE 与追问 SSE；盘面/卦面/牌面全部走真实 calc 端点（真实 HTTP，
 * 紫微的 PythonMonkey 也不会因 TestClient 线程池而段错误）。
 *
 * 运行：
 *   NODE_PATH=<playwright node_modules> node tests/js/test_browser_matrix.js
 *   BASE_URL=http://127.0.0.1:8899 可复用已运行服务。
 */
"use strict";
var http = require("http");
var path = require("path");
var { spawn } = require("child_process");
var CONTRACT = require("../contracts.json");

var PROJ = path.resolve(__dirname, "../..");
var PORT = 8899;
var BASE = process.env.BASE_URL || ("http://127.0.0.1:" + PORT);
var PW = "/Users/pengyu/.workbuddy/binaries/node/workspace/node_modules/playwright";
var chromium = require(PW).chromium;

var pass = 0, fail = 0, hidSeq = 900000;
function check(cond, name, detail) {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " — " + detail)); }
}
function sse(text, hid) {
  return 'data: {"delta":' + JSON.stringify(text) + "}\n\n" +
         'data: {"hid":' + hid + "}\n\n" + "data: [DONE]\n\n";
}
function waitHttp(url, timeoutMs) {
  var start = Date.now();
  return new Promise(function (resolve, reject) {
    (function attempt() {
      var req = http.get(url, function (res) { res.resume(); resolve(true); });
      req.on("error", function () {
        if (Date.now() - start > timeoutMs) reject(new Error("服务启动超时 " + url));
        else setTimeout(attempt, 250);
      });
    })();
  });
}
function click(page, sel) {
  return page.evaluate(function (s) { var el = document.querySelector(s); if (el) el.click(); return !!el; }, sel);
}
function setValues(page, map) {
  return page.evaluate(function (m) {
    Object.keys(m).forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) { el.value = m[sel]; el.dispatchEvent(new Event("change", { bubbles: true })); }
    });
  }, map);
}
function state(page, feature, slot) {
  return page.evaluate(function (o) {
    var s = window.ReadingCore.session(o.f, o.slot || "");
    function rd(r) {
      return r ? { id: r.id, question: r.question, rk: r.rk, answer: r.answer,
        status: r.status, fu: r.followups.map(function (x) { return x.question; }) } : null;
    }
    return { current: rd(s.current), archived: s.archived.map(rd), boardRk: s.boardRk };
  }, { f: feature, slot: slot || "" });
}
function reg(page, tag) {
  return page.evaluate(function (name) {
    return fetch("/api/profile/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, password: "test1234",
        birth: { year: 1990, month: 6, day: 15, hour: 22, minute: 30, gender: "男",
          know_time: true, calendar: "solar", country: "中国", province: "浙江省",
          city: "杭州", lat: 30.27, lon: 120.15, tz: 8 } })
    }).then(function (r) { return r.json(); });
  }, tag + Date.now());
}
function login(page, user) {
  return page.evaluate(function (u) {
    localStorage.setItem("zw-profile", JSON.stringify({ id: u.profile_id, token: u.token, name: u.name }));
  }, user);
}

(async function () {
  var server = null;
  var ownServer = !process.env.BASE_URL;
  try {
    if (ownServer) {
      server = spawn(PROJ + "/.venv-dev/bin/python", ["-m", "uvicorn", "main:app",
        "--host", "127.0.0.1", "--port", String(PORT), "--app-dir", "server"], {
        cwd: PROJ, env: Object.assign({}, process.env, { PYTHONPATH: "server:.", CODEBUDDY_API_KEY: "sk-test" }),
        stdio: "ignore"
      });
      await waitHttp(BASE + "/", 20000);
    }

    var browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    var ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    var page = await ctx.newPage();
    var jsErrors = [];
    page.on("pageerror", function (e) { jsErrors.push(String(e)); });

    await page.goto(BASE + "/#/home", { waitUntil: "domcontentloaded" });
    var user = await reg(page, "matrix");
    await login(page, user);
    await page.reload({ waitUntil: "domcontentloaded" });

    await page.route("**/api/deduce*", function (route) {
      hidSeq += 1;
      route.fulfill({ status: 200, contentType: "text/event-stream",
        body: sse("矩阵 mock 解读正文。", hidSeq) });
    });
    await page.route("**/api/*/deduce*", function (route) {
      hidSeq += 1;
      route.fulfill({ status: 200, contentType: "text/event-stream",
        body: sse("矩阵 mock 解读正文。", hidSeq) });
    });
    await page.route("**/api/history/followup*", function (route) {
      route.fulfill({ status: 200, contentType: "text/event-stream",
        body: sse("矩阵 mock 追问答复。", ++hidSeq) });
    });
    // 本地缺 horoscope.js：紫微运限失败会重试排盘。mock 掉让矩阵聚焦解读链路。
    await page.route("**/api/horoscope*", function (route) {
      route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, horoscope: {} }) });
    });

    var features = Object.keys(CONTRACT.features);
    console.log("=== 浏览器链路矩阵：" + features.length + " 功能 × 7 场景 ===");

    for (var fi = 0; fi < features.length; fi++) {
      var f = features[fi], spec = CONTRACT.features[f], ui = spec.ui;
      console.log("\n[" + f + "]");
      try {
      await page.evaluate(function () { window.ReadingCore.clearAll(); });
      await page.goto(BASE + "/" + ui.route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(350);

      var out = await page.evaluate(function (feat) {
        var d = window.ReadingCore.def(feat);
        return d.out || d.root;
      }, f);
      var qbox = await page.evaluate(function (feat) { return window.ReadingCore.def(feat).qbox; }, f);
      if (ui.pair) {
        await setValues(page, {});
        await page.evaluate(function (prefixes) {
          prefixes.forEach(function (p) {
            var d = document.querySelector("#" + p + "-date");
            if (d && !d.value) d.value = "1990-06-15";
          });
        }, ui.pair);
      }
      var Q1 = "矩阵首问-" + f, Q2 = "矩阵换盘-" + f;
      if (ui.fillBeforeCast) await page.fill(qbox, Q1);
      // 登录态命盘类会自动排盘：只有结果区还没有提问入口时才手动点起盘。
      if (ui.cast && !(await page.$(ui.ask))) { await click(page, ui.cast); await page.waitForTimeout(450); }
      if (ui.preAskClick) { await click(page, ui.preAskClick); await page.waitForTimeout(250); }
      try { await page.waitForSelector(ui.ask, { timeout: 8000 }); }
      catch (e) { check(false, f + " 盘面就绪", "找不到 " + ui.ask); continue; }
      try { await page.waitForSelector(qbox, { timeout: 5000 }); }
      catch (e) { check(false, f + " 提问框就绪", "找不到 " + qbox); continue; }

      // 结构统一（v124）：AI 解读入口必须在独立提问卡内（.bz-ask/.zw-ask/.hl-ai-card），
      // 不能嵌在 .p-result 盘面卡里。塔罗/梅花此前是唯一例外，回归断言锁紧。
      var structure = await page.evaluate(function (sel) {
        var b = document.querySelector(sel);
        if (!b) return { ok: false, why: "no-button" };
        var card = b.closest(".bz-ask, .zw-ask, .hl-ai-card");
        var inResult = !!b.closest(".p-result");
        return { ok: !!card && !inResult, card: card ? card.className : "", inResult: inResult };
      }, ui.ask);
      check(structure.ok, "structure: " + f + " 提问卡独立于盘面", JSON.stringify(structure));

      if (!ui.fillBeforeCast) await page.fill(qbox, Q1);
      await click(page, ui.ask);
      try { await page.waitForSelector(out + " .p-ai.done", { timeout: 10000 }); }
      catch (e) { check(false, f + " roundtrip", "解读卡未出现"); continue; }
      await page.waitForTimeout(200);
      var st1 = await state(page, f);
      check(!!st1.current && st1.current.question === Q1 && !!st1.current.rk &&
        st1.current.rk.indexOf("|") > 0 && st1.current.answer.indexOf("矩阵 mock") >= 0,
        "roundtrip: " + f + " 对象写回问题/rk/正文", JSON.stringify(st1.current).slice(0, 160));
      var dom1 = await page.evaluate(function (s) {
        var c = document.querySelector(s + " .p-ai[data-hid]");
        return !!c && c.textContent.indexOf("矩阵 mock") >= 0;
      }, out);
      check(dom1, "roundtrip: " + f + " DOM 投影与对象一致");

      // followup
      var fuSel = out + " .ai-follow input";
      await page.fill(fuSel, "矩阵追问-" + f);
      await page.press(fuSel, "Enter");
      try {
        await page.waitForFunction(function (o) {
          var c = window.ReadingCore.session(o.f).current;
          return c && c.followups.some(function (x) { return x.question === "矩阵追问-" + o.f; });
        }, { f: f }, { timeout: 8000 });
        check(true, "followup: " + f + " 追问挂到同一 Reading");
      } catch (e) { check(false, "followup: " + f + " 追问挂到同一 Reading", String(e).slice(0, 120)); }
      var fuDom = await page.evaluate(function (s) {
        var slot = document.querySelector(s + " .ai-follow-slot");
        return !!(slot && slot.textContent.indexOf("矩阵 mock 追问") >= 0);
      }, out);
      check(fuDom, "followup: " + f + " 追问结果 DOM 落在槽内");

      // repaint：同盘重绘（仅确定性盘面有此操作）
      if (ui.repaint) {
        await click(page, ui.repaint);
        await page.waitForTimeout(600);
        var rp = await page.evaluate(function (o) {
          return { card: !!document.querySelector(o.out + " .p-ai.done"),
            cur: !!(window.ReadingCore.session(o.f).current) };
        }, { out: out, f: f });
        check(rp.card && rp.cur, "repaint: " + f + " 同盘重绘保留解读", JSON.stringify(rp));
      }

      // archive：换盘 + 换问题必须按 rk+question 归档
      var bc = ui.boardChange || {};
      if (ui.boardPreClick) { await click(page, ui.boardPreClick); await page.waitForTimeout(250); }
      if (bc.set) await setValues(page, bc.set);
      if (bc.click) await click(page, bc.click);
      if (bc.newQuestion) await page.fill(qbox, Q2);
      if (bc.cast) { await click(page, bc.cast); await page.waitForTimeout(600); }
      if (bc.cast && ui.preAskClick) { await click(page, ui.preAskClick); await page.waitForTimeout(300); }
      try { await page.waitForSelector(qbox, { timeout: 6000 }); } catch (e) {}
      if (!bc.newQuestion) await page.fill(qbox, Q2);
      await click(page, ui.ask);
      try {
        await page.waitForFunction(function (o) {
          var s = window.ReadingCore.session(o.f);
          return s.archived.length >= 1 && s.current && s.current.question === o.q2 &&
            s.current.answer.indexOf("矩阵 mock") >= 0;
        }, { f: f, q2: Q2 }, { timeout: 10000 });
        var arc = await state(page, f);
        var identChanged = arc.current.rk !== arc.archived[0].rk ||
          arc.current.question !== arc.archived[0].question;
        check(arc.archived[0].question === Q1 && identChanged,
          "archive: " + f + " 旧轮按 rk+问题归档",
          JSON.stringify({ old: arc.archived[0].rk, now: arc.current.rk,
            oldQ: arc.archived[0].question, nowQ: arc.current.question }));
      } catch (e) { check(false, "archive: " + f + " 旧轮按 rk+问题归档", String(e).slice(0, 120)); }
      var arcDom = await page.evaluate(function () {
        return document.querySelectorAll(".round-archive .p-ai-archived").length;
      });
      check(arcDom >= 1, "archive: " + f + " 归档卡可见", String(arcDom));

      // reload：快照恢复对象与 DOM
      await page.waitForTimeout(350);
      await page.reload({ waitUntil: "domcontentloaded" });
      try {
        await page.waitForFunction(function (o) {
          var s = window.ReadingCore.session(o.f);
          return s.current && s.current.question === o.q2;
        }, { f: f, q2: Q2 }, { timeout: 8000 });
        var rl = await page.evaluate(function (s) {
          return !!(document.querySelector(s + " .p-ai.done"));
        }, out);
        check(rl, "reload: " + f + " 快照恢复对象与 DOM", String(rl));
      } catch (e) { check(false, "reload: " + f + " 快照恢复对象与 DOM", String(e).slice(0, 120)); }

      // switch：切走再切回，会话与投影都保留
      await page.goto(BASE + "/#/home", { waitUntil: "domcontentloaded" });
      await page.goto(BASE + "/" + ui.route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(700);
      var sw = await page.evaluate(function (o) {
        var s = window.ReadingCore.session(o.f);
        return { cur: !!s.current, card: !!document.querySelector(o.out + " .p-ai.done") };
      }, { f: f, out: out });
      check(sw.cur && sw.card, "switch: " + f + " 功能切换后对话完整", JSON.stringify(sw));

      // logout：对象与快照清空；再登录给下一功能用
      await page.evaluate(function () { localStorage.removeItem("zw-profile"); });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
      var lo = await page.evaluate(function () {
        var snaps = Object.keys(sessionStorage).filter(function (k) { return k.indexOf("zs-snap-") === 0; });
        var s = window.ReadingCore.session("liuyao");
        return { cur: s.current, arcs: s.archived.length, snaps: snaps };
      });
      check(!lo.cur && lo.arcs === 0 && lo.snaps.length === 0,
        "logout: " + f + " 对象与快照清空", JSON.stringify(lo));
      await login(page, user);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(350);
      } catch (e) {
        check(false, f + " 场景异常（后续功能继续）",
          e.stack ? e.stack.split("\n").slice(0, 2).join(" | ") : String(e));
        try { await login(page, user); } catch (ignore) {}
      }
    }

    check(jsErrors.length === 0, "全程无前端 JS 报错", jsErrors.slice(0, 2).join(" | "));
    await browser.close();
  } catch (e) {
    check(false, "测试执行异常", e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e));
  } finally {
    if (server) { try { server.kill("SIGTERM"); } catch (e) {} }
  }
  console.log("\n=== 浏览器链路矩阵: " + pass + " PASS / " + fail + " FAIL ===");
  process.exit(fail ? 1 : 0);
})();
