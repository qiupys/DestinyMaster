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

/* ============ 边界语义补充（对象层是唯一真相源，必须逐条锁定） ============ */

t("find：rk 为空时跨所有轮只按问题匹配（模板问题定位）", function () {
  var s = Core.session("meihua");
  s.begin("事业如何", "gua|本|A"); s.finish(1, "A");
  s.current.addFollowup("细化", "A细化", 11);
  s.archive();
  s.begin("事业如何", "gua|本|B"); s.finish(2, "B");
  var hit = s.find("事业如何", "");
  assert(hit, "无 rk 应按问题命中");
  assert.strictEqual(hit.reading.rk, "gua|本|A", "无 rk 时按既有优先级命中归档轮");
  assert.strictEqual(s.find("别的问", ""), null);
  Core.drop("meihua");
});

t("find：归档轮优先于当前轮（同问题同 rk 命中归档）", function () {
  var s = Core.session("tarot");
  s.begin("感情", "tarot|three|deckX"); s.finish(3, "旧");
  s.archive();
  s.begin("感情", "tarot|three|deckX"); s.finish(4, "新");
  var hit = s.find("感情", "tarot|three|deckX");
  assert(hit.archived, "相同身份应命中先入队的归档轮");
  assert.strictEqual(hit.reading.answer, "旧");
  Core.drop("tarot");
});

t("find：rk 严格相等，前缀/包含都不算命中", function () {
  var s = Core.session("liuyao");
  s.begin("长持吗", "liuyao|t|879877"); s.finish(5, "巽为风");
  assert(s.find("长持吗", "liuyao|t|879877"));
  assert.strictEqual(s.find("长持吗", "liuyao|t|87987"), null, "少一位不能命中");
  assert.strictEqual(s.find("长持吗", "liuyao|t|879877|x"), null, "多后缀不能命中");
  Core.drop("liuyao");
});

t("begin：新轮直接覆盖 current（归档是调用方职责，对象不隐式归档）", function () {
  var s = Core.session("qimen");
  var a = s.begin("问一", "qimen|a"); s.finish(6, "A");
  var b = s.begin("问二", "qimen|b"); s.finish(7, "B");
  assert.strictEqual(s.current, b);
  assert.strictEqual(s.archived.length, 0, "对象层不替调用方归档，避免隐藏副作用");
  assert.notStrictEqual(a, b);
  Core.drop("qimen");
});

t("finish：无 id 时保留已有 id，busy 归零", function () {
  var s = Core.session("bazi");
  var r = s.begin("事业", "b|s");
  s.busy = true;
  s.finish(88, "正文");
  assert.strictEqual(r.id, 88);
  s.finish(0, "正文2");
  assert.strictEqual(r.id, 88, "无 id 不应抹掉落盘 id");
  assert.strictEqual(r.answer, "正文2");
  assert.strictEqual(s.busy, false);
  Core.drop("bazi");
});

t("archive：current 为空时安全返回 null，不破坏 archived", function () {
  var s = Core.session("ziwei");
  assert.strictEqual(s.archive(), null);
  s.begin("命格", "chart|1"); s.finish(1, "答"); s.archive();
  assert.strictEqual(s.archive(), null, "二次归档不应重复入队");
  assert.strictEqual(s.archived.length, 1);
  Core.drop("ziwei");
});

t("all()：current 在前，archived 最新在前", function () {
  var s = Core.session("astrology");
  s.begin("一", "a|1"); s.finish(1, "1"); s.archive();
  s.begin("二", "a|2"); s.finish(2, "2"); s.archive();
  s.begin("三", "a|3"); s.finish(3, "3");
  var all = s.all();
  assert.deepStrictEqual(all.map(function (r) { return r.question; }), ["三", "二", "一"]);
  Core.drop("astrology");
});

t("setBoard：同步 lastQ 与 boardRk（换盘时更新盘面身份）", function () {
  var s = Core.session("huangli");
  s.setBoard("哪天搬家", "day|2026-11-26");
  assert.strictEqual(s.lastQ, "哪天搬家");
  assert.strictEqual(s.boardRk, "day|2026-11-26");
  s.setBoard("", "");
  assert.strictEqual(s.boardRk, "");
  Core.drop("huangli");
});

t("findById：能在归档轮里定位（追问历史卡重绑依赖它）", function () {
  var s = Core.session("bazi_marriage");
  s.begin("合不合", "bazi-mar|q"); s.finish(91, "答");
  s.addFollowupById ? s.addFollowupById(91, "追问", "追答", 92) : s.current.addFollowup("追问", "追答", 92);
  s.archive();
  assert.strictEqual(s.findById(91).question, "合不合");
  assert.strictEqual(s.findById(92), null, "追问 id 不是独立 Reading，不参与 findById");
  Core.drop("bazi_marriage");
});

t("Reading JSON 往返：追问链 + persons + status 无损", function () {
  var r = new Core.Reading({
    id: 9, feature: "ziwei_marriage", question: "合吗", rk: "zm|q",
    answer: "正文", status: "archived", ts: "2026-11-25T00:00:00Z",
    followups: [{ id: 91, question: "追问", answer: "追答", ts: "t" }],
    persons: [
      { role: "self", name: "甲", birth: { year: 1990, month: 1, day: 2 } },
      { role: "partner", name: "乙", birth: { year: 1992, month: 3, day: 4 } }
    ]
  });
  var back = Core.Reading.fromJSON(JSON.parse(JSON.stringify(r.toJSON())));
  assert.strictEqual(back.status, "archived");
  assert.strictEqual(back.followups[0].answer, "追答");
  assert.strictEqual(back.persons.length, 2);
  assert.strictEqual(back.person("partner").birth.year, 1992);
});

t("Person：hour=0 / minute=0 不能被 falsy 判断吞掉", function () {
  var p = new Core.Person({
    role: "self", birth: { year: 2000, month: 1, day: 1, hour: 0, minute: 0 }
  });
  assert.strictEqual(p.birth.hour, 0, "子时 0 点必须保留");
  assert.strictEqual(p.birth.minute, 0);
  assert(p.hasBirth());
});

t("Person JSON 往返：memory / profileId / 经纬度不丢", function () {
  var p = new Core.Person({
    role: "self", name: "甲", gender: "女", profileId: 42, memory: "偏谨慎",
    birth: { year: 1990, month: 5, day: 6, lat: 30.2, lon: 120.1, tz: 8, place: "杭州" }
  });
  var back = Core.Person.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  assert.strictEqual(back.profileId, 42);
  assert.strictEqual(back.memory, "偏谨慎");
  assert.strictEqual(back.birth.place, "杭州");
  assert.strictEqual(back.birth.lat, 30.2);
});

t("快照：serializeFeature 只含指定功能，不串台", function () {
  Core.clearAll();
  Core.session("liuyao").begin("六爻问", "ly|q"); Core.session("liuyao").finish(1, "答");
  Core.session("tarot").begin("塔罗问", "tr|q"); Core.session("tarot").finish(2, "答");
  var blob = Core.serializeFeature("liuyao");
  assert.strictEqual(Object.keys(blob).length, 1);
  assert(blob["liuyao|"].current.question === "六爻问");
  assert(!JSON.stringify(blob).includes("塔罗问"), "不能把别的功能带进快照");
  Core.clearAll();
});

t("快照：restoreFeature 增量恢复，不覆盖未涉及的会话", function () {
  Core.clearAll();
  Core.session("qimen").begin("保留我", "qm|1"); Core.session("qimen").finish(1, "答");
  var blob = Core.serializeFeature("qimen");
  Core.session("meihua").begin("梅花", "mh|1"); Core.session("meihua").finish(2, "答");
  Core.restoreFeature(blob);
  assert.strictEqual(Core.session("qimen").current.question, "保留我");
  assert.strictEqual(Core.session("meihua").current.question, "梅花", "未涉及的会话应保留");
  Core.clearAll();
});

t("followNote：全部功能文案来自注册表（单一来源，无散写 MAP）", function () {
  Object.keys(Core.FEATURES).forEach(function (f) {
    var note = Core.followNote(f);
    assert(note && note.indexOf("追问") >= 0, f + " 追问提示缺失");
    assert.strictEqual(note, Core.def(f).note, f + " 提示未走注册表");
  });
  assert(Core.followNote("not_exist").indexOf("追问") >= 0, "未知功能应有兜底文案");
});

t("FEATURES 冻结：注册表不可被运行期篡改", function () {
  assert(Object.isFrozen(Core.FEATURES));
  var before = Core.def("bazi").name;
  try { Core.FEATURES.bazi.name = "篡改"; } catch (e) {}
  assert.strictEqual(Core.def("bazi").name, before);
});

t("clearAll：多 slot 会话一并清空，重建是全新对象", function () {
  Core.session("ziwei", "").begin("命格", "c|1");
  var d = Core.session("ziwei", "zw-d");
  d.begin("流年", "c|1|2027");
  Core.clearAll();
  assert.strictEqual(Core.session("ziwei", "").current, null);
  assert.strictEqual(Core.session("ziwei", "zw-d").current, null);
  assert.notStrictEqual(Core.session("ziwei", ""), d, "清空后应重建全新会话对象");
});

console.log("=== " + pass + " 项通过 ===");
