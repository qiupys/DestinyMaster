# 软件工程约定

> 本文是后端架构、模块边界、开发与发布流程的权威依据。**接手本项目先读本文**，避免重复造轮子、改错模块、改完不部署或漏填变更记录。
> 前端设计与样式见 `FRONTEND_DESIGN.md`；功能实现与引擎映射见 `IMPLEMENTATION.md`；项目功能与接口说明见 `README.md`。

## 1. 目录与模块边界

```
server/
  main.py           FastAPI 入口；档案、紫微排盘/运限数据层、紫微 deduce（SSE）
  feature_api.py    十功能 calc/deduce 工厂路由 + 全功能 history/followup
  ai.py             prompt 装配（build_prompt / build_ziwei_prompt）+ stream_answer + 免责
  prompt.py         紫微专属规则（大限/流年/历法对齐）
  history.py        feature_history 落盘/查询/追问/去重 key
  profile.py        档案、注册登录、birth 归一、个人记忆表
  memory.py         personal_memory 个人记忆（个人化注入唯一来源）
  rag.py            紫微语料检索（iztro-learn）
  rag_kb.py         其他九领域语料检索（docs/kb）
  bazi.py / marriage.py / chart.py / deduce.py
  meihua.py / liuyao.py / qimen.py / tarot.py / astrology.py / huangli.py
web/
  index.html        单页入口（版本号在这里 bump）
  portal.js         全部前端逻辑、hash 路由、组件模板、SSE 渲染
  portal.css        设计系统 token + 原子组件层 + 功能样式
  *.json            静态数据（塔罗牌义等）
docs/kb/<domain>/    RAG 语料（九领域）
docs/iztro-learn/    紫微语料
tools/               语料抓取/预处理脚本
tests/               单元测试 + E2E
```

**模块边界铁律**：
- 一个功能只在一个引擎文件实现确定性计算，在 `ai.py` 只有一个 prompt 入口，在 `feature_api` 只有一个工厂路由。新增功能不得在前端自写 fetch 渲染或后端另起一套落盘逻辑。
- 数据落盘只走 `history.save`（deduce 时），calc 从不落库。追问只走 `/api/history/followup`。
- 个人化文本只来自 `personal_memory`（`memory.personalization_text()` → `history.personalization()`），不得恢复已删除的自动画像链路。

## 2. AI 链路（十功能同构）

```
calc（确定性计算，出盘面/牌面/卦面）
  → fact / rag_query / rag_extra（引擎产出，可 JSON 落盘）
  → prompt（ai.py 装配 + 个人记忆注入 + RAG 检索）
  → ai.stream_answer（SSE 流式）
  → feature_api._with_disclaimer（系统统一附加免责，模型不自写）
  → history.save（落 feature_history，回传 hid）
  → /api/history/followup（追问，用 payload 重建盘面）
```

- 紫微保留 `/api/chart` + `/api/horoscope` 排盘数据层（命盘是有状态大对象），但推演时把命盘结构化为 `ziwei_data` 存 payload，追问不依赖内存 chart。**服务重启后 CHARTS 清空，deduce 会用登录档案 birth 确定性重建同一张盘**（`_rebuild_session_from_profile`），保证解读不中断。
- 免责声明幂等，deduce / followup / 缓存回放三条路径都带。

## 3. 关键约束（踩过坑，勿回退）

1. **py-iztro / PythonMonkey 非线程安全**：所有调用它的端点必须 `async def`（sync `def` 被 FastAPI 丢线程池会段错误崩 uvicorn，无 traceback）。TestClient 下测紫微也会崩，用真实 HTTP 测。
2. **calc/deduce 锁盘**：塔罗 `deck`、六爻 `deck`、梅花 `upper/lower/moving` 回传后由 deduce 用 `manual` 重建，保证「所见即所解」；合婚 `_pair`、黄历双人 `_p1/_p2` 纳入去重 key。
3. **轮次身份 rk = 问题 + 确定性盘面**，严格相等才算同轮；任一变化即平级归档。`findAnswered()` 传 rk 必须严格相等。
4. **共用确定性结果的功能页必须单一 stage**（如老黄历 personal/pair 两 tab 共用一张日历），禁止拆两个 stage 造成重复 DOM id。
5. **出生资料唯一源 = 档案 `profile.birth`**；后端 `_birth_to_solar` 统一农历转公历；写回只在 `save=1`，普通排盘不覆盖。
6. **nginx 配置备份绝不留在 `sites-enabled/`**（被 include 全部加载致多 server 块冲突），放 `sites-available/` 或 `/root/nginx-backups/`；改完 `nginx -t` 必须无 `conflicting server name` 警告。入口页 no-store，静态资源 no-cache。

## 4. 开发与验证流程

1. 本地改代码 → 语法检查（`node --check`、`python -m py_compile`）。
2. 本地起 uvicorn（空闲端口），跑单元测试：`tests/unit_*.py`（六爻/奇门/合婚/历史等）。
3. 跑 E2E：`tests/e2e_v101.js`（设计系统/流程）、`e2e_v97.js`（主流程）、`e2e_v94.js`（基础），符号说明见测试文件。断言版本号 `>=` 当前版本。
   - Playwright 在 `/Users/pengyu/.workbuddy/binaries/node/workspace/node_modules`，launch 加 `--no-sandbox --disable-dev-shm-usage`。
   - 排查 DOM 交互务必限定可见 stage `#p-stage-<feat>`，否则全局选择器命中隐藏 stage 缓存节点（height=0）误判。
4. 用浏览器注入本地 js/css（route 拦截线上页面）验证纯前端改动，无需重启服务。

## 5. 发布流程（每次必做）

1. bump `web/index.html` 的 `portal.css?v=` / `portal.js?v=`（版本号唯一来源，toybox `sed -i ''` 不稳定，用编辑工具）。
2. 填写 `CHANGELOG.md`（强制，见文件顶部规范）。
3. 提交并推送 git。
4. scp 改动文件到运行目录 → 校验 md5 一致 → `systemctl restart ziwei`（仅改静态前端时不必重启，但 bump 版本号必做）。
5. 线上跑全部 E2E + 检查服务 active + 应用日志无 error/traceback/segfault。
6. SSH 偶发 `channel refused`，用 `-o ControlMaster=no -o ControlPath=none` 直连。

**敏感信息**（`CODEBUDDY_API_KEY`、`.adminkey`）只在运行环境/本地文件注入，绝不入库。

## 6. 变更记录

所有版本变更见 `CHANGELOG.md`。每个版本必须填写，否则视为未完成。
