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
    // 本地缺 horoscope.js：紫微运限走 mock。range 用线上真实形态（对象区间），
    // 防止投影再用 array.join 时静默抛错、归档摘要变空（v131 线上抽查抓到）。
    await page.route("**/api/horoscope*", function (route) {
      route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, horoscope: {
          decadal: { heavenlyStem: "甲", earthlyBranch: "寅", range: { start: 30, end: 39 } },
          yearly: { heavenlyStem: "丙", earthlyBranch: "午",
            solarRange: ["2026-02-04", "2027-02-03"] }
        } }) });
    });

    var features = Object.keys(CONTRACT.features);
    console.log("=== 浏览器链路矩阵：" + features.length + " 功能 × 7 场景 ===");

    for (var fi = 0; fi < features.length; fi++) {
      var f = features[fi], spec = CONTRACT.features[f], ui = spec.ui;
      console.log("\n[" + f + "]");
      try {
      await page.evaluate(function () { window.ReadingCore.clearAll(); });
      // 全程 SPA 内部 hash 导航：page.goto 到同文档 hash 在资源紧张时会退化成整页重载，
      // 刷新即新 epoch（v127 会话边界）→ 对话按设计清空，测试却误判为"切页丢对话"。
      await page.evaluate(function (route) {
        if (location.hash !== route) location.hash = route;
        else window.dispatchEvent(new Event("hashchange"));
      }, ui.route);
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
      if (ui.preAskClick) {
        // 紫微登录自动排盘走真实 py-iztro + node 运限，慢于固定 350ms 的等待；
        // 先等 tab 真正渲染再点，避免矩阵在机器繁忙时偶发「找不到 #zw-ask」。
        try { await page.waitForSelector(ui.preAskClick, { timeout: 20000 }); }
        catch (e) { check(false, f + " 盘面 tab 就绪", "找不到 " + ui.preAskClick); continue; }
        await click(page, ui.preAskClick); await page.waitForTimeout(250);
      }
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
      // v125：归档卡是只读回看——不得残留触发新一轮解读的按钮；追问入口必须保留。
      var arcRo = await page.evaluate(function () {
        var cards = document.querySelectorAll(".round-archive .p-ai-archived");
        var bad = 0, follow = 0;
        Array.prototype.forEach.call(cards, function (c) {
          bad += c.querySelectorAll(".tool-ai, .p-suggest, .p-switch").length;
          follow += c.querySelectorAll(".ai-follow-btn").length;
        });
        return { cards: cards.length, bad: bad, follow: follow };
      });
      check(arcRo.bad === 0, "archive: " + f + " 归档卡只读化（无 AI 触发按钮）", JSON.stringify(arcRo));
      check(arcRo.follow >= 1, "archive: " + f + " 归档卡保留追问入口", JSON.stringify(arcRo));
      // v132：每个功能的归档卡都必须有从 Board 对象投影出的盘面摘要。
      // 投影内部抛错会被 boardView 兜住只留 warn，DOM 上看就是卡里没摘要——
      // 必须显式断言，不能只看归档卡存在。限定当前功能舞台，避免命中别的 stage。
      // 卦面/牌面的专属投影用自有结构而非 .pf-fact 标签，因此断言摘要容器有内容。
      var stageSel = f === "huangli_pair"
        ? "#p-stage-huangli_pair, #p-stage-huangli" : "#p-stage-" + f;
      var digestInfo = await page.evaluate(function (sels) {
        var boxes = 0, length = 0;
        Array.prototype.forEach.call(document.querySelectorAll(sels), function (stage) {
          Array.prototype.forEach.call(stage.querySelectorAll(".round-archive .pf-arch-fact"), function (box) {
            boxes++;
            length += (box.textContent || "").trim().length;
          });
        });
        return { boxes: boxes, length: length };
      }, stageSel);
      check(digestInfo.boxes >= 1 && digestInfo.length > 0,
        "archive: " + f + " 盘面摘要从 Board 投影非空", JSON.stringify(digestInfo));

      // switch：切走再切回（同一页面打开内，epoch 不变），会话与投影都保留
      // 诊断：记录页面 timeOrigin，若切换后变化说明发生整页重载（会话边界），
      // 那不是产品丢对话，而是测试导航把页面 reload 了。
      var originBefore = await page.evaluate(function () { return performance.timeOrigin; });
      // 先等快照真正落盘（SSE 完成回调里异步写），否则机器繁忙时会在写入前就切走。
      try {
        await page.waitForFunction(function (name) {
          var raw = localStorage.getItem("zw-profile");
          if (!raw) return false;
          var uid = JSON.parse(raw).id;
          return !!sessionStorage.getItem("zs-snap-" + name + "-" + uid);
        }, f, { timeout: 10000 });
      } catch (e) { /* 下方 check 会报出具体状态 */ }
      // 必须走 SPA 内部 hash 切换：page.goto 到新 hash 在部分时机触发整页重载，
      // 重载会换新 pageEpoch 并丢弃快照（v127 设计），那就不是在测「同一页面切功能」。
      await page.evaluate(function () { location.hash = "#/home"; });
      await page.waitForTimeout(200);
      await page.evaluate(function (route) { location.hash = route; }, ui.route);
      await page.waitForTimeout(700);
      // 命盘类登录自动排盘 + 快照恢复是异步链路，固定 700ms 在机器繁忙时会
      // 先于恢复完成就断言。按状态等待（超时仍会让下面的 check 报出具体状态）。
      try {
        await page.waitForFunction(function (o) {
          var s = window.ReadingCore.session(o.f);
          return !!s.current && !!document.querySelector(o.out + " .p-ai.done");
        }, { f: f, out: out }, { timeout: 20000 });
      } catch (e) { /* 交由下方 check 输出诊断信息 */ }
      var sw = await page.evaluate(function (o) {
        var s = window.ReadingCore.session(o.f);
        return { cur: !!s.current, card: !!document.querySelector(o.out + " .p-ai.done"),
          origin: performance.timeOrigin, hash: location.hash };
      }, { f: f, out: out });
      check(sw.cur && sw.card && sw.origin === originBefore,
        "switch: " + f + " 功能切换后对话完整",
        JSON.stringify(sw) + " originBefore=" + originBefore +
        " reloaded=" + (sw.origin !== originBefore));

      // v136 自愈护栏（只对紫微合婚跑一次，兼防 v135 的提问框丢失回归）：
      // 对象仍在但解读卡被异常移走，切回必须按快照回填投影，且不能重绘盘面/吞掉提问框。
      if (f === "ziwei_marriage") {
        await page.evaluate(function (s) {
          var card = document.querySelector(s + " .p-ai");
          if (card && card.parentNode) card.parentNode.removeChild(card);
        }, out);
        await page.evaluate(function () { location.hash = "#/home"; });
        await page.waitForTimeout(150);
        await page.evaluate(function (route) { location.hash = route; }, ui.route);
        await page.waitForTimeout(500);
        var healed = await page.evaluate(function (o) {
          return { card: !!document.querySelector(o.out + " .p-ai.done"),
            ask: !!document.querySelector(o.ask),
            origin: performance.timeOrigin };
        }, { out: out, ask: ui.ask });
        check(healed.card && healed.ask && healed.origin === originBefore,
          "selfheal: " + f + " 投影丢失后切回自愈且保留提问框", JSON.stringify(healed));
      }

      // reload（v127 会话边界=本次打开页面）：刷新即新会话，旧对话与快照不恢复
      await page.waitForTimeout(350);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
      var rl = await page.evaluate(function (o) {
        var s = window.ReadingCore.session(o.f);
        var uid = JSON.parse(localStorage.getItem("zw-profile")).id;
        var raw = null;
        try { raw = sessionStorage.getItem("zs-snap-" + o.f + "-" + uid); } catch (e) {}
        return { cur: !!s.current, card: !!document.querySelector(o.out + " .p-ai.done"), snapGone: !raw };
      }, { f: f, out: out });
      check(!rl.cur && !rl.card && rl.snapGone,
        "reload: " + f + " 刷新清空旧会话对话与快照", JSON.stringify(rl));

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
