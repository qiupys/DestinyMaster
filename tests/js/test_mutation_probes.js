/*
 * 变异探针：把历史 bug 重新注入 reading-core.js 的临时副本，确认矩阵真的会报警。
 * 只在临时目录里改副本，绝不碰仓库源码。
 *
 * 运行：node tests/js/test_mutation_probes.js
 */
"use strict";
var fs = require("fs");
var os = require("os");
var path = require("path");
var { spawnSync } = require("child_process");

var ROOT = path.resolve(__dirname, "../..");
var CORE = fs.readFileSync(path.join(ROOT, "web/reading-core.js"), "utf8");
var CONTRACT = fs.readFileSync(path.join(ROOT, "tests/contracts.json"), "utf8");
var MATRIX = fs.readFileSync(path.join(ROOT, "tests/js/test_contract_matrix.js"), "utf8");

var mutations = [
  {
    name: "忽略 rk（换卦仍去重）",
    from: "return this.question === question && this.rk === rk;",
    to: "return this.question === question;",
    expect: "identity-strict"
  },
  {
    name: "退出不清会话（跨账号串对话）",
    from: "function clearAll() { _sessions = Object.create(null); }",
    to: "function clearAll() { /* mutation */ }",
    expect: "clear-all"
  },
  {
    name: "hid 定位失效（历史追问写错对象）",
    from: "if (r) return { reading: r, feature: s.feature, slot: s.slot };",
    to: "if (r) return null;",
    expect: "global-hid"
  },
  {
    name: "输出容器清单丢槽（紫微宫位重绘丢对话）",
    from: "if (d.outs && d.outs.length) return d.outs.slice();",
    to: "if (d.outs && d.outs.length) return [d.root];",
    expect: "selector-derived"
  }
];

var pass = 0, fail = 0;
mutations.forEach(function (m) {
  if (CORE.indexOf(m.from) < 0) {
    fail++;
    console.log("  FAIL " + m.name + " — 变异锚点已失效，源码结构变更请更新探针");
    return;
  }
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reading-mutation-"));
  ["web", "tests", "tests/js"].forEach(function (d) { fs.mkdirSync(path.join(tmp, d), { recursive: true }); });
  fs.writeFileSync(path.join(tmp, "web/reading-core.js"), CORE.replace(m.from, m.to));
  fs.writeFileSync(path.join(tmp, "tests/contracts.json"), CONTRACT);
  fs.writeFileSync(path.join(tmp, "tests/js/test_contract_matrix.js"), MATRIX);
  var r = spawnSync(process.execPath, ["tests/js/test_contract_matrix.js"], { cwd: tmp, encoding: "utf8" });
  var out = (r.stdout || "") + (r.stderr || "");
  var caught = r.status !== 0 && out.indexOf(m.expect) >= 0;
  if (caught) { pass++; console.log("  PASS " + m.name + " — 被 " + m.expect + " 抓住"); }
  else { fail++; console.log("  FAIL " + m.name + " — 矩阵未报警 (exit " + r.status + ")"); }
  fs.rmSync(tmp, { recursive: true, force: true });
});
console.log("\n=== 变异探针: " + pass + " PASS / " + fail + " FAIL ===");
process.exit(fail ? 1 : 0);
