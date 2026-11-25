# 前端设计系统（唯一事实来源）

> **接手必读**：本项目样式反复改来改去的根因是「同类元素各写各的散值」。本文是所有前端样式与组件约定的唯一来源。
> 新增界面直接用 `.ui-*` 原子组件；修改已有样式只改本文列出的「唯一来源」处，禁止在功能专属样式里另写一遍。发现不一致时改源头，不要加覆盖补丁。
> 信息架构与叙事结构见 `DESIGN_REFERENCE.md`；工程与发布流程见 `SOFTWARE_ENGINEERING.md`。

## 1. 设计 token（唯一来源：`.portal-body`）

所有数值集中定义在 `web/portal.css` 的 `.portal-body` 块，**新样式只引用变量，禁止散写 px / 中间值（如 13.5 / 12.5 / 7 / 14）**。曾盘点出 28 种字号、16 种圆角、20 种间距，已收敛为下列阶梯：

| 类别 | 变量 | 取值 |
| --- | --- | --- |
| 字号 | `--fs-xs / sm / base / md / lg / xl / 2xl / 3xl` | 11 / 12 / 13 / 14 / 16 / 20 / 26 / 32 px |
| 间距 | `--gap-xs / sm / md / lg / xl` | 6 / 10 / 16 / 22 / 32 px |
| 圆角 | `--radius-sm / md / lg / pill` | 5 / 8 / 12 / 999 px |
| 控件高 | `--control-h / --btn-h / --btn-primary-h` | 42 / 42 / 46 px |
| 线宽 | `--line-w` | 1 px |
| 内容宽 | `--content-w` | 760 px |

**语义映射（同语义只用同一级）**：
- 表单标签 / AI 正文 / 卡片正文 = `base`(13)
- 控件文字 / 分组标题 / 卡片头 = `md`(14)
- 说明 / 表格 / code / 盘面辅助 = `sm`(12)
- 辅助小按钮 / 元信息 = `xs`(11)
- 卡片之间 = `--gap-md`(16)；区块之间 = `--gap-lg`；首页分组 = `--gap-xl`(32)；块内 = `--gap-sm`(10)；紧凑元素间 = `--gap-xs`(6)
- `.portal-body` 必须显式设 `font-size: var(--fs-base)`，并用零特异性的 `:where(button, input, select, textarea)` 让原生控件继承字体；旧 `style.css` 的 `body=13.5px` 会渗进所有未显式设字号的容器，造成 13 / 13.5 / 13.3333 混用（v113 修）。
- 模板里禁止内联 `font-size`；标题、说明、小按钮都在 `portal.css` 里用 token 定义对应类，避免 JS 模板与 CSS 两处维护（v113 已清理个人中心与梅花卦名）。

## 2. 原子组件层（portal.css 顶部）

新界面**直接用这套类命名**，不再造新类名：

| 组件 | 用途 |
| --- | --- |
| `.ui-field` | 字段容器：标签与控件垂直成组，gap `--gap-sm` |
| `.ui-label` | 字段标签：fs-base / ink-2 |
| `.ui-control` | 输入/下拉：height 42 / radius md / fs-md |
| `.ui-btn` + `.primary` / `.ghost` / `.text` | 按钮基类，三种语义（主/描边/文字） |
| `.ui-card` | 卡片：radius lg / border line |
| `.ui-note` | 说明文字：fs-sm / ink-3 |

存量组件（`.p-card` / `.ti` / `.p-input` / `.p-seg` / `.tool-submit` / `.tool-ai` / `.pf-btn` / `.mrg-person` / `.mrg-p-card` / `.ai-follow-btn` / `.pf-memory`）已收敛复用 token，继续保持。

**盘面字号（v114 收编，全站无裸 px）**：盘面内高密度标注统一走三个专用 token，不得再散写裸 `9 / 9.5 / 10 / 40px`：
- `--fs-dense: 10px` — 星曜、柱位、爻标、八字步骤、占星宫位、奇门九宫、合婚星曜等紧凑标注
- `--fs-fine: 9px` — 角标级极细字（紫微四化/长生十二宫角标、奇门天盘 i）
- `--fs-glyph: 40px` — 梅花卦符等单个图形符号

**禁止外溢**：普通 UI 辅助文字（侧栏副标题、即将上线、历史标签/日期、黄历农历节气、奇门问号、必填星号）一律用 `--fs-xs: 11px`，不得借用 dense/fine。护栏 `test_no_bare_px_font_sizes` + `test_aux_text_promoted_to_xs` 已锁定。

## 3. 关键组件的唯一来源（改样式先看这里）

| 需求 | 唯一来源 | 说明 |
| --- | --- | --- |
| 出生资料表单 | `birthFieldsHTML/Bind/Collect` | 所有出生日期/时间/农历表单唯一模板；`opts`：`simple`=隐八字+农历，`noBazi`=只隐八字（档案编辑保留农历互转），`noLunar`=只隐农历 |
| 任意公历时刻 | `dateTimeHTML/Bind/Collect` | 梅花指定起卦、黄历第二人八字；共用日历 `openDateLookup`，禁用原生 `datetime-local` |
| 日历弹窗 | 全局单例 `dpEl` / `openDateLookup` | 两种模式由 `dpOnPick` 是否为空区分 |
| 出生地三级联动 | `placeFieldsHTML/Bind/Collect` + `GEO_DATA` | 国家→省/州→城市；三列同一行，窄屏 <620 折单列；城市 select id=`${pfx}-city` |
| 提问卡 | `.bz-ask` / `.zw-ask` / `.zw-d-ask` / `.bz-ask.as-ask` | 统一 `max-width:var(--content-w)`，禁止写死宽度 |
| 门禁提示框 | `.p-bazi-gate`（`.ok`/`.warn`） | 统一放表单第一个子元素 |
| AI 流式解读 | `streamToUrl` / `streamAI` | 统一 SSE 渲染、免责、追问条；新功能不得自写 fetch |
| 双人表单间距 | `birthFieldsHTML(opts.roomy)` 的 `.bf-field`/`.bf-sec`/`.bf-fields` | 标签与控件绑 `.bf-field`；段间 16 / 段内 10 / 标签 13；`.mrg-zz` 块级 flex 避免行盒空白；`applyTime()` 隐藏 `#pfx-timewrap` |
| AI 正文字号 | `.p-ai-body` | 13px / 行高 1.9；h1=16 / h2=14 / h3·h4=13；表格/code=12；段距走 gap 变量 |
| 合婚盘面字段 | `renderPairResult` 的 `.mrg-line` | 三段 `<span>`（nowrap / flex gap 6 / 11px），禁用全角空格，防孤字换行 |
| 追问结果样式 | `.ai-follow-slot > .p-ai` | 保留 DOM、CSS 去卡壳（border0 / radius0 / body padding0，slot padding 0 20px），但必须保留段落感：卡头 `fs-base`/600/`--ink-2` + 金点（`--wx-jin`），顶部实线 `--line-strong` + `margin/padding-top: --gap-md`；禁止退回 sm 灰字脚注；不要再套圆角卡 |
| 首卡间距 | 各结果容器 `> .p-ai:first-child` | 16px；新增功能必须把容器 id 加进名单：`#as-ai-out/#bz-ai-out/#bzm-ai-out/#zm-ai-out/#zw-ai-out/#zw-d-ai-out`、`#tr-result/#mh-result/#ly-result/#qm-result/#hl-result` |

## 4. 历史区与统计

- 原子记录 = AI 解读 + 功能 + 个人信息 + 问题，不可拆分。`archiveRound` 只归档含 `.p-ai` 的轮（整树查，解读卡在嵌套 `#*-ai-out`）。
- 历史详情解读卡去 `.p-card` 外壳，直接 `.p-ai.p-hist-detail`。追问链用 `.pf-hist-fu` 连续段。
- 个人中心统计卡按五类分组（与首页同序），黄历 chip 合并 `huangli + huangli_pair` 计数，筛选传逗号分隔 feature。
- 提问框一律单行 input，不用 textarea；性别用分段按钮；保存按钮 `.pf-btn`（描边轻量），不用 `.tool-submit`。

## 5. 缓存破坏（反复踩坑，必守）

1. `index.html` 带 `no-store` 元标签。
2. nginx `location = /` 返回 `Cache-Control: no-store`。
3. 静态资源 `location ~* \.(css|js|png|svg|ico|woff2?)$` 返回 `no-cache, must-revalidate`——**只靠 ETag 不够**，Chrome 启发式缓存会直接复用旧副本，造成「新 JS + 旧 CSS」混杂（表现为按钮 open 类生效但内容不显示）。
4. 每次改 css/js 必须 bump `index.html` 的 `?v=`。用户看到旧样式时先查命中了哪个 server 块、再查缓存头，不要盲目改代码。

## 6. 移动端适配

- 命盘桌面 4×4 固定方形（宫位按地支方位），手机端 `display:flex` 改纵向宫位列表，顺序用 `.zw-o-0…11` 类控制（不要写行内 `order`，会打乱桌面网格）。
- 表单输入 16px 防 iOS 聚焦缩放；结果区提问框用 14px；iOS 缩放用 touchstart 临时提字号规避，不动 `maximum-scale`。
- 命盘网格轨道写 `minmax(0, 1fr)`，否则撑出横向滚动条；横向滚动容器同时给 `padding-left` 与 `scroll-padding-left`（≥9px），防首卡描边被裁。

## 7. 防重复修改自检清单

改任何前端样式前逐条确认：
1. 该值是否已有 token？有则引用，无则评估是否该加入阶梯。
2. 该组件是否已有唯一来源（第 3 节表）？有则改源头，不在功能样式里覆盖。
3. 同类元素（标签/控件/卡片/间距）是否与已有页面一致？用浏览器 computed style 对比。
4. 改完是否 bump 版本号、跑 `tests/api/test_frontend_tokens.py` 静态护栏 + `e2e_v101.js` 设计断言、填 changelog？
5. 是否只在可见 stage 内测试（避免隐藏缓存节点误判）？
