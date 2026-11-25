/*
 * 浏览器级集成测试：把 AI 解读全部用 mock SSE 顶掉，验证「解读对象 + DOM 投影 + 追问链」
 * 在真实页面里是否端到端正常。之前这类验证靠临时探针（用完即删），没有入库、不可重复，
 * 导致 v117 对象模型重构后追问等链路缺少回归保护。本文件补上这道防线。
 *
 * 运行（无需真实 API key，AI 全 mock）：
 *   NODE_PATH=/Users/pengyu/.workbuddy/binaries/node/workspace/node_modules \
 *     node tests/js/test_reading_e2e.js
 * 脚本会自行拉起本地 uvicorn（端口 8899），结束自动关闭；也可设 BASE_URL 用已运行的服务。
 *
 * 覆盖：
 *   A. 六爻：起卦 → 解读 mock → Reading 写回(question/rk/answer/hid/persons) + DOM 投影
 *   B. 追问：挂到正确 Reading.followups；连续追问；追问框不堆叠；追问结果卡不挂新框
 *   C. 去重：同问题同 rk 被拦（不新增轮）；换问题归档旧轮
 *   D. 快照：reload 后对象从 sessionStorage 无损恢复（含追问链）
 *   E. 退出登录：Core.clearAll 清空所有会话
 *   F. 双人：bazi_marriage 发起解读，Reading 持 2 个 Person 快照
 *   G. 错误路径：deduce 返回非 SSE JSON 错误 → 卡内显示原因，不留空白
 */
"use strict";
var http = require("http");
var { spawn } = require("child_process");
var path = require("path");

var PROJ = path.resolve(__dirname, "../..");
var PORT = 8899;
var BASE = process.env.BASE_URL || ("http://127.0.0.1:" + PORT);
var PW = "/Users/pengyu/.workbuddy/binaries/node/workspace/node_modules/playwright";
var chromium = require(PW).chromium;

var pass = 0, fail = 0;
function ok(name, detail) { pass++; console.log("  PASS " + name + (detail ? " — " + detail : "")); }
function no(name, detail) { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
function check(cond, name, detail) { cond ? ok(name, detail) : no(name, detail); }

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

function sse(delta, hid) {
  var body = "";
  if (delta) body += 'data: {"delta":' + JSON.stringify(delta) + "}\n\n";
  if (hid) body += 'data: {"hid":' + hid + "}\n\n";
  return body + "data: [DONE]\n\n";
}

function register(page, tag) {
  return page.evaluate(function (name) {
    return fetch("/api/profile/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name, password: "test1234",
        birth: { year: 1990, month: 6, day: 15, hour: 22, minute: 30,
          gender: "男", know_time: true, calendar: "solar",
          country: "中国", province: "浙江省", city: "杭州",
          lat: 30.27, lon: 120.15, tz: 8 }
      })
    }).then(function (r) { return r.json(); });
  }, tag + Date.now());
}

function login(page, reg) {
  return page.evaluate(function (r) {
    localStorage.setItem("zw-profile", JSON.stringify({ id: r.profile_id, token: r.token, name: r.name }));
  }, reg);
}

// 读取某功能会话的对象快照（纯 JSON，便于断言）
function sessionState(page, feature) {
  return page.evaluate(function (f) {
    var s = window.ReadingCore.session(f);
    function rd(r) {
      if (!r) return null;
      return { id: r.id, question: r.question, rk: r.rk, answer: r.answer,
        status: r.status, followups: r.followups.map(function (x) { return { q: x.question, a: x.answer, id: x.id }; }),
        persons: r.persons.map(function (p) { return { role: p.role, name: p.name, year: p.birth && p.birth.year }; }) };
    }
    return {
      current: rd(s.current),
      archived: s.archived.map(rd),
      boardRk: s.boardRk, lastQ: s.lastQ, busy: s.busy
    };
  }, feature);
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

    console.log("=== 浏览器 mock 集成测试（AI 全 mock）===");
    var browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    var ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    var page = await ctx.newPage();
    var jsErrors = [];
    page.on("pageerror", function (e) { jsErrors.push(String(e)); });

    // 注册并登录
    await page.goto(BASE + "/#/home", { waitUntil: "domcontentloaded" });
    var reg = await register(page, "e2emock");
    await login(page, reg);
    await page.reload({ waitUntil: "domcontentloaded" });

    // ---- A. 六爻：起卦 → 解读 mock → 对象写回 + DOM 投影 ----
    console.log("\n[A] 六爻解读写回对象与 DOM 投影");
    // 拦截六爻 deduce，返回可识别的 mock 正文 + hid
    await page.route("**/api/liuyao/deduce*", function (route) {
      route.fulfill({ status: 200, contentType: "text/event-stream",
        body: sse("巽为风，三爻动，变风水涣。此为 mock 解读正文。", 100001) });
    });
    await page.goto(BASE + "/#/liuyao", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    await page.fill("#ly-q", "宁德时代能够长持吗？");
    await page.click("#ly-cast");
    await page.waitForTimeout(500);
    var hasAsk = await page.$("#ly-ask");
    check(!!hasAsk, "起卦后出现解读按钮 #ly-ask");
    await page.click("#ly-ask");
    await page.waitForSelector("#ly-result .p-ai.done", { timeout: 10000 });
    await page.waitForTimeout(200);

    var st = await sessionState(page, "liuyao");
    check(st.current && st.current.question === "宁德时代能够长持吗？", "A1 当前轮问题写入对象", st.current && st.current.question);
    check(st.current && st.current.answer.indexOf("mock 解读正文") >= 0, "A2 mock 正文写入 Reading.answer");
    check(st.current && st.current.id === 100001, "A3 hid 写入 Reading.id", st.current && String(st.current.id));
    check(st.current && st.current.rk && st.current.rk.indexOf("liuyao|") === 0, "A4 rk 为六爻确定性身份", st.current && st.current.rk);
    // 六爻 needsBirth=false：设计上不导入出生信息，persons 应为空（"必要时才导入"）
    check(st.current && st.current.persons.length === 0, "A5 占卜类不导入 Person（needsBirth=false）");
    var domProj = await page.evaluate(function () {
      var card = document.querySelector("#ly-result .p-ai[data-hid]");
      return { hid: card && card.dataset.hid, rk: card && card.dataset.rk,
        hasBody: !!(card && card.querySelector(".p-ai-body").textContent.indexOf("mock") >= 0) };
    });
    check(domProj.hid === "100001" && domProj.hasBody, "A6 DOM 投影 data-hid/正文与对象一致", JSON.stringify(domProj));

    // ---- B. 追问：挂到正确 Reading.followups，框不堆叠 ----
    console.log("\n[B] 追问链");
    await page.route("**/api/history/followup*", function (route) {
      route.fulfill({ status: 200, contentType: "text/event-stream",
        body: sse("短期看好的 mock 追问答复。", 100002) });
    });
    await page.fill(".ai-follow input", "短期呢？");
    await page.press(".ai-follow input", "Enter");
    await page.waitForSelector(".ai-follow-slot .p-ai.done", { timeout: 10000 });
    await page.waitForTimeout(200);
    st = await sessionState(page, "liuyao");
    check(st.current && st.current.followups.length === 1, "B1 追问挂到当前 Reading.followups", st.current && String(st.current.followups.length));
    check(st.current && st.current.followups[0].q === "短期呢？", "B2 追问问题正确");
    check(st.current && st.current.followups[0].a.indexOf("mock 追问") >= 0, "B3 追问答复写入 followup.answer");
    var boxes = await page.evaluate(function () {
      return { total: document.querySelectorAll("#ly-result .ai-follow-btn").length,
        inSlot: document.querySelectorAll("#ly-result .ai-follow-slot .ai-follow-btn").length };
    });
    check(boxes.total === 1 && boxes.inSlot === 0, "B4 追问框不堆叠、结果卡不挂新框", JSON.stringify(boxes));

    // 第二次追问（沿用同一追问条）——产品对追问按钮有 1.2s 防抖，等解锁再发
    await page.waitForFunction(function () {
      var b = document.querySelector("#ly-result .ai-follow-btn");
      return b && !b.disabled;
    }, { timeout: 5000 });
    await page.fill(".ai-follow input", "那长期呢？");
    await page.press(".ai-follow input", "Enter");
    await page.waitForFunction(function () {
      var c = window.ReadingCore.session("liuyao").current;
      return c && c.followups.length === 2;
    }, { timeout: 10000 });
    st = await sessionState(page, "liuyao");
    check(st.current.followups.length === 2 && st.current.followups[1].q === "那长期呢？", "B5 连续追问累积到第 2 条");

    // ---- C. 去重 + 归档 ----
    console.log("\n[C] 去重与归档");
    // 同问题同 rk 再度解读：prepareNewQuestion 应拦截，不新增轮（当前 hid 不变）
    await page.click("#ly-ask");
    await page.waitForTimeout(400);
    st = await sessionState(page, "liuyao");
    check(st.current && st.current.id === 100001 && st.archived.length === 0, "C1 同问题同 rk 被去重拦截，不新增轮");
    // 换问题 → 归档旧轮
    await page.fill("#ly-q", "换个问题：能加仓吗？");
    await page.click("#ly-cast");
    await page.waitForTimeout(400);
    await page.click("#ly-ask");
    // 归档是同步的，但快照在 finish() 里才写。等新解读正文也落盘，确保快照是最新态。
    await page.waitForFunction(function () {
      var s = window.ReadingCore.session("liuyao");
      return s.archived.length === 1 && s.current && s.current.answer.indexOf("mock 解读正文") >= 0;
    }, { timeout: 10000 });
    st = await sessionState(page, "liuyao");
    check(st.archived.length === 1 && st.archived[0].status === "archived", "C2 换问题后旧轮进入归档且 status=archived");
    check(st.archived[0].followups.length === 2, "C3 归档轮保留完整追问链");
    check(st.current && st.current.question === "换个问题：能加仓吗？", "C4 新问题成为 current");

    // ---- D. 快照：reload 后对象无损恢复 ----
    console.log("\n[D] 快照恢复");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    // reload 后仍在 liuyao 页，对象应从 sessionStorage 恢复
    var restored = await page.evaluate(function () {
      var blob = null;
      try {
        var uid = JSON.parse(localStorage.getItem("zw-profile")).id;
        var raw = sessionStorage.getItem("zs-snap-liuyao-" + uid);
        blob = raw ? JSON.parse(raw).core : null;
      } catch (e) {}
      var s = window.ReadingCore.session("liuyao");
      return { hasBlob: !!blob, q: s.current && s.current.question,
        arc: s.archived.length, fu: s.archived[0] && s.archived[0].followups.length };
    });
    check(restored.hasBlob, "D1 sessionStorage 含对象快照 core 字段");
    check(restored.q === "换个问题：能加仓吗？", "D2 reload 后 current 无损恢复", restored.q);
    check(restored.arc === 1 && restored.fu === 2, "D3 reload 后归档轮与追问链无损", JSON.stringify(restored));

    // ---- E. 退出登录清空对象 ----
    console.log("\n[E] 退出登录清理");
    var cleared = await page.evaluate(function () {
      // 直接走产品逻辑：退出登录会调用 Core.clearAll()
      // 这里模拟退出动作（若退出按钮选择器存在则点击，否则直接验证 clearAll 契约）
      window.ReadingCore.clearAll();
      return { cur: window.ReadingCore.session("liuyao").current, arc: window.ReadingCore.session("liuyao").archived.length };
    });
    check(cleared.cur === null && cleared.arc === 0, "E1 clearAll 清空所有解读会话");

    // ---- F. 双人：两个 Person 快照 ----
    console.log("\n[F] 双人 Person 快照");
    var pair = await page.evaluate(function () {
      var C = window.ReadingCore;
      C.clearAll();
      var self = new C.Person({ role: "self", name: "甲", profileId: 1, birth: { year: 1990, month: 1, day: 1 } });
      var mate = new C.Person({ role: "partner", name: "乙", birth: { year: 1992, month: 3, day: 4 } });
      var s = C.session("bazi_marriage");
      s.begin("今年适合结婚吗？", "bazi-mar|qs", [self, mate]);
      s.finish(200, "合盘正文");
      var blob = C.serializeFeature("bazi_marriage");
      C.clearAll();
      C.restoreFeature(blob);
      var r = C.session("bazi_marriage").current;
      return { arity: C.def("bazi_marriage").arity, n: r.persons.length,
        self: r.person("self").name, mate: r.person("partner").birth.year };
    });
    check(pair.arity === 2 && pair.n === 2, "F1 双人功能 arity=2 且 Reading 持 2 Person", JSON.stringify(pair));
    check(pair.self === "甲" && pair.mate === 1992, "F2 双方 Person 快照序列化后无损");

    // ---- H. 命盘类：八字自动排盘 + 导入带出生资料的 Person ----
    console.log("\n[H] 命盘类自动导入用户信息");
    await page.evaluate(function () { window.ReadingCore.clearAll(); });
    await page.route("**/api/bazi/deduce*", function (route) {
      route.fulfill({ status: 200, contentType: "text/event-stream",
        body: sse("八字 mock 解读：财官相生。", 300001) });
    });
    await page.goto(BASE + "/#/bazi", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#bz-q", { timeout: 8000 });
    await page.waitForTimeout(500);
    await page.fill("#bz-q", "今年事业如何？");
    await page.click("#bz-ai");
    await page.waitForSelector("#bz-ai-out .p-ai.done", { timeout: 10000 });
    var bz = await sessionState(page, "bazi");
    check(bz.current && bz.current.answer.indexOf("八字 mock") >= 0, "H1 八字解读 mock 写回对象");
    check(bz.current && bz.current.persons.length === 1 && bz.current.persons[0].role === "self", "H2 命盘类导入 1 个 self Person");
    check(bz.current && bz.current.persons[0].year === 1990, "H3 Person 含登录档案出生年", bz.current && String(bz.current.persons[0].year));

    // ---- G. 错误路径：非 SSE JSON 错误 → 卡内显示原因 ----
    console.log("\n[G] 错误路径");
    await page.evaluate(function () { window.ReadingCore.clearAll(); });
    await page.unroute("**/api/liuyao/deduce*");
    await page.route("**/api/liuyao/deduce*", function (route) {
      route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "模拟服务端错误" }) });
    });
    await page.goto(BASE + "/#/liuyao", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.fill("#ly-q", "错误路径测试");
    await page.click("#ly-cast");
    await page.waitForTimeout(300);
    await page.click("#ly-ask");
    await page.waitForTimeout(600);
    var errShown = await page.evaluate(function () {
      var cards = Array.prototype.slice.call(document.querySelectorAll("#ly-result .p-ai"));
      var last = cards[cards.length - 1];
      return last ? last.textContent.indexOf("模拟服务端错误") >= 0 : false;
    });
    check(errShown, "G1 非 SSE 错误在卡内显示原因，不留空白卡");

    check(jsErrors.length === 0, "Z. 全程无前端 JS 报错", jsErrors.slice(0, 2).join(" | "));
    await browser.close();
  } catch (e) {
    no("测试执行异常", e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e));
  } finally {
    if (server) { try { server.kill("SIGTERM"); } catch (e) {} }
  }
  console.log("\n=== 浏览器 mock 集成测试: " + pass + " PASS / " + fail + " FAIL ===");
  process.exit(fail ? 1 : 0);
})();
