/*
 * 一条命令跑完整个测试矩阵：API 链路 → 对象层 → 浏览器高频场景 → 浏览器契约矩阵。
 *   node tests/js/run_matrix.js
 * 已有服务可设 BASE_URL=http://127.0.0.1:8899 复用（两段浏览器测试会依次复用）。
 */
"use strict";
var path = require("path");
var { spawnSync } = require("child_process");
var PROJ = path.resolve(__dirname, "../..");
var NODE_MODULES = "/Users/pengyu/.workbuddy/binaries/node/workspace/node_modules";
var env = Object.assign({}, process.env, {
  PYTHONPATH: "server:.",
  NODE_PATH: process.env.NODE_PATH || NODE_MODULES
});
var stages = [
  ["API 链路矩阵 + 静态护栏", PROJ + "/.venv-dev/bin/python",
    ["-m", "unittest", "discover", "-s", "tests/api", "-p", "test_*.py"]],
  ["对象模型定点单测", process.execPath, ["tests/js/test_reading_core.js"]],
  ["对象层契约矩阵", process.execPath, ["tests/js/test_contract_matrix.js"]],
  ["变异探针（历史 bug 注入）", process.execPath, ["tests/js/test_mutation_probes.js"]],
  ["浏览器高频场景", process.execPath, ["tests/js/test_reading_e2e.js"]],
  ["浏览器链路矩阵", process.execPath, ["tests/js/test_browser_matrix.js"]]
];
var failed = [];
stages.forEach(function (stage) {
  console.log("\n========== " + stage[0] + " ==========");
  var r = spawnSync(stage[1], stage[2], { cwd: PROJ, env: env, stdio: "inherit" });
  if (r.status !== 0) failed.push(stage[0] + " (exit " + r.status + ")");
});
console.log("\n========== 矩阵汇总 ==========");
console.log(failed.length ? "失败：" + failed.join("；") : "全部阶段通过");
process.exit(failed.length ? 1 : 0);
