/*
 * 统一解读对象模型的单元测试（node 直接跑，无需浏览器/DOM）。
 *   node tests/js/test_reading_core.js
 * 这是「所见即所解」的第二道防线：去重身份、归档、追问链、快照全部落在对象上，
 * 不依赖 DOM 文本解析——六爻那类 bug 从此可以在毫秒级单测里拦下。
 */
"use strict";
var assert = require("assert");
var Core = require("../../web/reading-core.js");

var pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { console.error("  FAIL " + name + ": " + (e.stack || e)); process.exitCode = 1; }
}

console.log("=== reading-core 单元测试 ===");

t("注册表覆盖全部 11 功能 + 双人择日子 tab", function () {
  var keys = ["bazi", "ziwei", "meihua", "liuyao", "qimen", "tarot", "astrology",
    "huangli", "huangli_pair", "bazi_marriage", "ziwei_marriage", "astrology_marriage"];
  keys.forEach(function (k) { assert(Core.def(k), "缺少功能声明 " + k); });
  Object.keys(Core.FEATURES).forEach(function (k) {
    var d = Core.def(k);
    assert(d.name && d.root && d.qbox, k + " 声明不完整");
    assert(d.note && d.note.indexOf("追问") >= 0, k + " 缺追问提示");
  });
});

t("outSel：独立 ai-out 容器与同容器功能都正确", function () {
  assert.strictEqual(Core.outSel("bazi"), "#bz-ai-out");
  assert.strictEqual(Core.outSel("meihua"), "#mh-result");
  assert.strictEqual(Core.outSel("astrology_marriage"), "#asm-ai-out");
});

t("Reading 同一轮 = 问题 + rk 严格相等", function () {
  var r = new Core.Reading({ feature: "liuyao", question: "能否长持？", rk: "liuyao|t|879877" });
  assert(r.isSameRound("能否长持？", "liuyao|t|879877"));
  assert(!r.isSameRound("能否长持？", "liuyao|t|879878"), "换卦必须不同轮");
  assert(!r.isSameRound("能长持吗？", "liuyao|t|879877"), "换问题必须不同轮");
});

t("六爻回归：deck 879877 与 879878 是两轮，不会误命中", function () {
  var s = Core.session("liuyao");
  var r = s.begin("宁德时代能够长持吗？", "liuyao|2026-11-25T16:01:50|879877");
  s.finish(11, "巽为风解读");
  assert(s.find("宁德时代能够长持吗？", "liuyao|2026-11-25T16:01:50|879877"));
  assert(!s.find("宁德时代能够长持吗？", "liuyao|2026-11-25T16:01:50|879878"),
    "换一爻绝不能命中旧解读");
  Core.drop("liuyao");
});

t("归档：current 移到 archived 顶部并释放 current", function () {
  var s = Core.session("tarot");
  s.begin("问题一", "tarot|three|deckA"); s.finish(1, "A");
  s.begin("问题二", "tarot|three|deckB"); s.finish(2, "B");
  var moved = s.archive();
  assert.strictEqual(moved.question, "问题二");
  assert.strictEqual(s.current, null);
  assert.strictEqual(s.archived.length, 1);
  assert.strictEqual(s.archived[0].status, "archived");
  // 归档后仍能查到
  assert(s.find("问题二", "tarot|three|deckB").archived);
  Core.drop("tarot");
});

t("追问链挂到正确 reading，按 id 可定位", function () {
  var s = Core.session("bazi");
  var r = s.begin("事业如何？", "birth|scope"); s.finish(7, "正文");
  var f1 = r.addFollowup("那今年呢？", "今年答", 71);
  var f2 = r.addFollowup("换行业呢？", "换行业答", 72);
  assert.strictEqual(r.followups.length, 2);
  assert.strictEqual(f2.question, "换行业呢？");
  assert.strictEqual(s.findById(7), r);
  assert.strictEqual(s.findById(71), null, "追问不是独立 Reading");
  Core.drop("bazi");
});

t("快照：序列化 → 恢复，解读/归档/追问无损，busy 归零", function () {
  var s = Core.session("astrology");
  s.begin("本命", "astro|b1"); s.finish(3, "本命答");
  s.current.addFollowup("细化", "细化答", 31);
  s.archive();
  s.begin("流年", "astro|b1|2027"); s.finish(4, "流年答");
  s.busy = true;
  var blob = Core.serializeFeature("astrology");
  assert(Object.keys(blob).length === 1);
  Core.drop("astrology", "");
  Core.restoreFeature(blob);
  var back = Core.session("astrology");
  assert.strictEqual(back.busy, false, "恢复后不应仍在 streaming");
  assert.strictEqual(back.current.question, "流年");
  assert.strictEqual(back.current.followups.length, 0);
  assert.strictEqual(back.archived[0].question, "本命");
  assert.strictEqual(back.archived[0].followups[0].answer, "细化答");
  Core.drop("astrology", "");
});

t("多 slot 隔离：紫微命格盘与运势盘互不覆盖", function () {
  var a = Core.session("ziwei", "");
  var b = Core.session("ziwei", "zw-d");
  a.begin("命格", "chart|1"); a.finish(1, "命格答");
  b.begin("流年", "chart|1|2027"); b.finish(2, "流年答");
  assert.notStrictEqual(a, b);
  assert.strictEqual(a.current.question, "命格");
  assert.strictEqual(b.current.question, "流年");
  var blob = Core.serializeFeature("ziwei");
  assert.strictEqual(Object.keys(blob).length, 2, "两个 slot 都要进出快照");
  Core.clearAll();
});

t("clearAll：退出登录清空所有会话", function () {
  Core.session("qimen").begin("x", "q");
  Core.clearAll();
  assert.strictEqual(Core.session("qimen").current, null);
});

t("注册表 arity：单人=1，双人合婚/择日=2", function () {
  ["bazi", "ziwei", "meihua", "liuyao", "qimen", "tarot", "astrology", "huangli"].forEach(function (f) {
    assert.strictEqual(Core.def(f).arity, 1, f + " 应为单人");
  });
  ["huangli_pair", "bazi_marriage", "ziwei_marriage", "astrology_marriage"].forEach(function (f) {
    assert.strictEqual(Core.def(f).arity, 2, f + " 应为双人");
  });
  assert.strictEqual(Core.def("bazi").needsBirth, true);
  assert.strictEqual(Core.def("liuyao").needsBirth, false);
});

t("Person：用户信息快照与 hasBirth 判定", function () {
  var p = new Core.Person({
    role: "self", name: "张三", gender: "男", profileId: 7,
    birth: { year: 1990, month: 5, day: 12, hour: 8, minute: 30, lat: 31.2, lon: 121.5, place: "上海" },
    memory: "偏谨慎"
  });
  assert(p.hasBirth());
  assert.strictEqual(p.birth.place, "上海");
  assert.strictEqual(p.role, "self");
  var blank = new Core.Person({ role: "partner" });
  assert(!blank.hasBirth(), "缺出生资料应判否");
});

t("双人对话：一个 Reading 持两个 Person，快照冻结", function () {
  var self = new Core.Person({ role: "self", name: "甲", birth: { year: 1990, month: 1, day: 1 } });
  var mate = new Core.Person({ role: "partner", name: "乙", birth: { year: 1992, month: 3, day: 4 } });
  var s = Core.session("bazi_marriage");
  var r = s.begin("今年适合结婚吗？", "bazi-mar|qs", [self, mate]);
  s.finish(20, "合盘正文");
  assert.strictEqual(r.persons.length, 2);
  assert.strictEqual(r.person("self").name, "甲");
  assert.strictEqual(r.person("partner").name, "乙");
  // 用户后来改档案，不影响这次解读的快照
  self.name = "改名了";
  assert.strictEqual(r.person("self").name, "甲", "对话应冻结解读当时的用户信息");
  Core.drop("bazi_marriage");
});

t("双人对话快照：两个 Person 随 Reading 无损序列化", function () {
  var s = Core.session("astrology_marriage");
  s.begin("合盘", "astro-mar|qs", [
    new Core.Person({ role: "self", name: "甲", birth: { year: 1990, month: 1, day: 1 } }),
    new Core.Person({ role: "partner", name: "乙", birth: { year: 1991, month: 2, day: 2 } })
  ]);
  s.finish(21, "正文");
  var blob = Core.serializeFeature("astrology_marriage");
  Core.drop("astrology_marriage", "");
  Core.restoreFeature(blob);
  var back = Core.session("astrology_marriage").current;
  assert.strictEqual(back.persons.length, 2);
  assert.strictEqual(back.person("partner").birth.year, 1991);
  Core.clearAll();
});

console.log("=== " + pass + " 项通过 ===");
