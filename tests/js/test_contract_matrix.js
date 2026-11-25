/*
 * 对象层契约矩阵：从 contracts.json + reading-core.js 注册表生成用例。
 *
 * 与 test_reading_core.js 的定点单测不同，这里对【每个已注册功能】执行同一组不变量：
 * registry-complete / selector-derived / identity-strict / lifecycle / snapshot-json /
 * persons-arity / slot-isolation / global-hid / clear-all。
 * 新增功能只要写进 FEATURES + contracts.json，自动获得这 9 组保护。
 *
 * 运行：node tests/js/test_contract_matrix.js
 */
"use strict";
var Core = require("../../web/reading-core.js");
var CONTRACT = require("../contracts.json");

var pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " — " + detail)); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

var FEATURES = Object.keys(CONTRACT.features).sort();
var INV = CONTRACT.invariants.module;
console.log("=== 对象层契约矩阵：" + FEATURES.length + " 功能 × " + INV.length + " 不变量 ===");

FEATURES.forEach(function (f, idx) {
  var def = Core.def(f);
  var spec = CONTRACT.features[f];
  var q = "矩阵问题-" + f, rk = "rk|" + f + "|boardA";

  check(!!def && !!def.name && !!def.qbox,
    INV[0] + ": " + f + " 注册表完整", def);
  check(def.arity === 1 || def.arity === 2,
    INV[0] + ": " + f + " arity 合法", def && def.arity);
  check(Core.outSel(f) === (def.out || def.root) && Core.outsOf(f).indexOf(Core.outSel(f)) >= 0,
    INV[1] + ": " + f + " 输出容器从注册表派生", Core.outsOf(f));
  var slots = def.slots || {};
  var smap = Core.slotMap();
  check(Object.keys(slots).every(function (id) { return smap[id] === slots[id]; }),
    INV[1] + ": " + f + " slot 映射一致", smap);

  var reading = new Core.Reading({ feature: f, question: q, rk: rk });
  check(reading.isSameRound(q, rk) && !reading.isSameRound(q + "X", rk) && !reading.isSameRound(q, rk + "X"),
    INV[2] + ": " + f + " rk+question 严格身份");

  var persons = [];
  for (var i = 0; i < def.arity; i++) {
    persons.push(new Core.Person({ role: i === 0 ? "self" : "partner", name: "P" + i,
      profileId: i + 1, birth: { year: 1990 + i, month: 6, day: 15, hour: i === 0 ? 0 : 10 } }));
  }
  var s = Core.session(f);
  var r = s.begin(q, rk, persons);
  check(r.feature === f && s.busy && s.current === r && s.lastQ === q && s.boardRk === rk,
    INV[3] + ": " + f + " begin 写入当前轮");
  r.addFollowup("追问一", "答一", idx * 100 + 1);
  s.finish(idx * 100 + 1, "正文-" + f);
  check(!s.busy && r.id === idx * 100 + 1 && r.answer === "正文-" + f,
    INV[3] + ": " + f + " finish 写回 id/正文");
  s.setBoard(q, "rk|" + f + "|boardB");
  var archived = s.archive();
  check(archived === r && archived.status === "archived" && s.current === null &&
    s.archived[0] === r && !!s.find(q, rk) && s.find(q, rk).archived,
    INV[3] + ": " + f + " archive 与归档查找");

  var blob = Core.serializeFeature(f);
  var json = JSON.parse(JSON.stringify(blob));
  Core.clearAll();
  Core.restoreFeature(json);
  var restored = Core.session(f).archived[0];
  check(restored && restored.question === q && restored.rk === rk &&
    Core.session(f).boardRk === "rk|" + f + "|boardB" && restored.answer === "正文-" + f &&
    restored.followups.length === 1 && restored.followups[0].question === "追问一",
    INV[4] + ": " + f + " JSON 快照无损往返",
    JSON.stringify(restored && restored.toJSON()));

  check(restored.persons.length === def.arity &&
    (!def.arity || restored.persons[0].birth.year === 1990 || def.arity === 0),
    INV[5] + ": " + f + " Person 数量符合 arity", restored.persons.length);
  check(def.arity === 1 ? !!restored.person("self") : (!!restored.person("self") && !!restored.person("partner")),
    INV[5] + ": " + f + " Person 角色可取", def.arity);

  var other = Core.session(f, "matrix-slot");
  check(other !== s && Core.sessionsOf(f).length >= 2 && Core.sessionsOf(f).indexOf(other) >= 0,
    INV[6] + ": " + f + " slot 隔离且 sessionsOf 跨槽");
  var hid = idx * 1000 + 7;
  restored.id = hid;
  var located = Core.findReadingById(hid);
  check(located && located.feature === f && located.reading === restored,
    INV[7] + ": " + f + " 按 hid 全局定位原 Reading", located && located.feature);

  // 先留下一个未归档的 current：若 clearAll 被改成空操作，下面必然报警。
  Core.session(f, "matrix-slot").begin("残留-" + f, "rk|residual", []);
  Core.clearAll();
  check(Core.session(f, "matrix-slot").current === null &&
    Core.session(f, "matrix-slot").archived.length === 0,
    INV[8] + ": " + f + " clearAll 清空所有槽");
});

// 跨功能：一个功能的对话不能串到另一个功能，hid 定位不能串账号式误命中
Core.clearAll();
var fa = FEATURES[0], fb = FEATURES[FEATURES.length - 1];
var ra = Core.session(fa).begin("跨功能-A", "rk|A", []);
ra.addFollowup("只有 A 有", "答", 77);
Core.session(fb).begin("跨功能-B", "rk|B", []);
check(Core.session(fb).current.followups.length === 0 &&
  Core.findReadingById(0) === null && Core.session(fa).current === ra,
  "clear-all: 跨功能会话隔离");
Core.clearAll();

console.log("\n=== 对象层契约矩阵: " + pass + " PASS / " + fail + " FAIL ===");
process.exit(fail ? 1 : 0);
