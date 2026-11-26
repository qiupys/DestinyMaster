# 变更日志（CHANGELOG）

> **版本填写规范（强制）**：每次修改必须同时更新本文件——在顶部新增一节，写明版本号、日期、变更类型（`feat` / `fix` / `style` / `refactor` / `docs`）与变更要点，并与代码一并提交。只允许追加，不允许覆盖历史。前端 css/js 改动还必须同步 bump `web/index.html` 里的 `?v=`。未填写 changelog 的提交视为未完成。

格式：

```
## vXXX (YYYY-MM-DD)
- [类型] 变更要点
```

---

## v143 (2026-11-26)
- [fix] 八字「大运→流年→流月」真正联动：后端 `bazi.chart` 原来只给今年起 10 年流年，点后面大运时流年列表根本没有数据可切，表现为「流年不跟着大运变」；现在流年覆盖当前十年 + 全部展示大运年份（每年带节气月柱与 `dayun` 归属），`liuyue_of_year` 加按年缓存避免重复算。前端按大运年份区间投影流年，点大运换整排流年并把流月重置到该大运默认年；点流年再刷新流月（原逻辑保留）。流年/流月干支仍全部来自后端 Board，前端不做命理推断。
- [refactor] 删除双人表单「早晚子时」开关：全项目无读取点、后端 payload 与个人中心基础信息均无对应字段，属死控件；同时清掉 `extraKnow` 插入位与 `.mrg-zz` 样式。阳历/农历与出生日期同行等高、段间距 sm 的 v142 调整保留。
- [test] API 新增「流年覆盖全部大运且带流月」断言；E2E 新增 H4/H5 验证点大运换流年、点流年换流月；前端 token 护栏确认死开关已清除。portal.js / portal.css / server/bazi.py / index.html bump v143。

## v142 (2026-11-26)
- [style] 双栏合婚出生信息再校准：阳历/农历分段控件外框压到与出生日期按钮同为 `--control-h-compact`（按钮字降到 `--fs-xs`），不再比日期按钮高一圈；早晚子时从「我知道出生时间」行移到「时/分」选择同排并对齐分钟列（`bf-time-row` + `extraTime`），不知道出生时间时随时间区一起隐藏。段间距从 6px 回到 10px（字段内部仍 6px），解决控件挤在一块的问题。
- [test] 前端 token 护栏更新双栏行断言（等高、时分行、间距源）；设计系统表同步。portal.js / portal.css / index.html bump v142。

## v141 (2026-11-26)
- [refactor] 八字大运/流年/流月从「四柱盘面」卡中拆出，独立为 `.p-card bz-options`，放在十神/神煞分析之后、提问卡之前，与紫微运势选择栏同一层级；选项点选的事件委托仍挂在 `#bz-result`，交互不变。选项卡挂在结果根下，显式并入 `--content-w` 单一宽度源并居中，首段不再多画分割线。
- [test] 前端 token 护栏新增选项卡顺序与宽度源断言；设计系统表补组件说明。portal.js / portal.css / index.html bump v141。

## v140 (2026-11-26)
- [style] 双人合婚表单继续压缩纵向占用：共用 `birthFieldsHTML(roomy)` 新增 `bf-date-field`，把「阳历/农历」分段控件收进「出生日期」标签行，两个按钮与标签同为 `--fs-sm`；新增 `bf-know-row`，把「早晚子时」开关并入「我知道出生时间」同一行（早子时字段 id 不变）。布局只在 `min-width:901px` 的 `.mrg-person` 双栏 compact 下生效，单人出生表单与结果盘面不动。
- [test] 前端 token 护栏新增双栏行结构与作用域断言；设计系统唯一来源表补两行组件说明。portal.js / portal.css / index.html bump v140。

## v139 (2026-11-26)
- [fix] 十神分析卡底部说明的分割线贴住四柱卡边框、看起来重叠：说明段 `<p class="p-note bz-analysis-note">` 在 `.p-card` 内，`.p-card p`（0,1,1）覆盖了 `.bz-analysis-note`（0,1,0）的 `margin/font-size/color/line-height`，只剩 `padding-top/border-top` 生效，所以横线没有留白、文字也误用了卡片正文字号。选择器改为 `.bz-analysis p.bz-analysis-note` 恢复设计意图，线宽并入 `--line-w` token，横线与上方卡片恢复 `--gap-sm` 间距。
- [test] 前端 token 护栏新增说明段选择器特异性与 token 断言。portal.css / index.html bump v139。

## v138 (2026-11-26)
- [fix] 十神分析/神煞分析卡宽度对齐：两卡由 `bzAnalysisHTML()` 直接挂在 `#bz-result` 结果根下、不在 `.p-result` 容器内，吃不到 `.p-result .p-card` 的 760 约束，实测撑到 804px（比表单卡/四柱盘卡左右各宽 22px）。给 `.bz-analysis` 显式并入 `--content-w` 单一宽度源并水平居中，实测回到 left286/right1046/760px，与工具卡、四柱盘卡、提问卡完全对齐。不改 --content-w 数值本身，遵守"全部内容区单一宽度源"铁律。
- [test] 前端 token 护栏新增 `.bz-analysis` 宽度源断言。portal.css / index.html bump v138。

## v137 (2026-11-26)
- [feat] 出生地控件三处统一且必填：八字页原「出生地（可选）」自由文本框换成与占星/注册共用的 `placeFieldsHTML` 三级联动（国家/省/城市 + 经纬度），注册弹窗新增同一套出生地字段并写入档案；三处均做必填校验（缺城市/经纬度即拦截）。出生地仅作为身份字段收集入档、纳入 dedupe key，不做真太阳时校正（用户确认口径），产品模板无真太阳时开关。
- [style] 注册弹窗仅注册 tab 加宽到 600px（`.p-modal-box.is-reg`），缓解出生日期/出生地/性别字段拥挤，登录页保持 420px；移动端 is-reg 限 520px 不撑破。
- [style] 合婚双人表单落地 compact 尺度：新增 `--control-h-compact:36px` token，控件 42→36px、控件字 14→13px、标签 13→12px、卡头 14→13px、段间距收紧一档，字号全走 `--fs-*` token；限定 `.mrg-person` 作用域与 `min-width:901px`（窄屏仍走 16px 防 iOS 缩放），只动填写表单不动结果盘面。八字合婚/紫微合婚/占星合盘/黄历双人择日四处共用生效。
- [test] 前端 token 护栏新增三组断言：出生地统一控件与必填/无真太阳时、compact 高度走 token 且作用域受限、注册弹窗仅 reg tab 加宽。portal.js / portal.css / index.html bump v137。

## v136 (2026-11-26)
- [fix] 彻底收口「连续跑矩阵时合婚切走再切回偶发丢对话」：根因是测试导航用 `page.goto(BASE + "/#/<feat>")`，同文档 hash 跳转在资源紧张时会退化成整页重载，触发 v127 会话边界（新 epoch → 按设计清空对话），并非产品状态逻辑丢对话。测试全程改走 SPA 内部 hash（含每功能入场），切换断言新增 `performance.timeOrigin` 不变护栏。
- [fix] 产品侧补极端竞态自愈：舞台已标 `ready` 但解读投影被异常移走时，仅当对象仍有当前轮、且快照 epoch/token 有效，才从快照回填输出槽与归档；绝不在对象为空（刷新/退出等会话边界）时恢复，绝不重绘盘面/提问框——规避 v135「放宽恢复标记导致紫微宫位提问框丢失」的回归。
- [test] 新增紫微合婚自愈护栏：删除解读卡后切走切回，断言解读卡回填且提问框仍在。浏览器矩阵正式纳入全矩阵。
- [docs] 实测记录：修复前旧写法在全矩阵下偶发 `cur:false/card:false`（快照仍在、epoch 失效），改用 hash 后连续多次全矩阵与单独浏览器矩阵全绿。portal.js / index.html bump v136。

## v135 (2026-11-26)
- [test] 浏览器切换场景改走 SPA 内部 hash（page.goto 到新 hash 可能整页重载 → 新 epoch → 快照被丢弃），切走前等快照落盘、回读按状态等待 20s。
- [docs] 曾尝试放宽快照恢复标记（对象为空时允许二次恢复），实测引入紫微宫位提问框 `#zw-dq` 丢失的回归，已完整回退；前端产品代码与线上 v134 完全一致，本版不 bump 静态资源。

## v134 (2026-11-26)
- [fix] 双人择日归档摘要仍为空：v133 按 question+rk 回退 Reading.board 也未命中（切 tab/换日后轮次键与解读卡登记不一致）。改为从解读卡自身的 `data-hid` 全局定位 Reading（`Core.findReadingById`），直接取该轮冻结的 Board 投影——不再依赖两侧键相等，11 功能通用。
- [test] 浏览器链路矩阵新增 12 条「归档摘要非空」通用断言；切换场景改为等快照落盘后再切走、按状态等待回读（20s），消除并发负载下紫微合婚偶发失败。portal.js / index.html bump v134。

## v133 (2026-11-26)
- [fix] 双人择日归档卡没有盘面摘要：轮次身份 rk 含双方出生参数（`day|日期|pairQs`），而 loadDay 登记 Board 只用日期键，`Core.findBoard(feature, rk)` 取不到盘面；归档改为回退到 `Reading.board`（该轮的 Board 真相源），不再依赖两边键恰好一致。同样惠及「导入本人八字」后 rk 带后缀的其他轮。
- [test] 浏览器矩阵「归档卡摘要非空」通用断言（12 功能）复跑全绿；portal.js / index.html bump v133。

## v132 (2026-11-26)
- [fix] 线上抽查发现紫微归档卡没有盘面摘要：专属投影里假设运限 `decadal.range`/`solarRange` 是数组并直接 `.join()`，真实接口返回对象区间时抛 TypeError，被投影兜底只留 warn、DOM 静默变空。改为统一 `digestRange()` 兼容数组/对象/字符串三种形态。
- [test] 浏览器矩阵运限 mock 改用线上真实对象区间形态，并新增 12 功能通用断言「归档卡必须含从 Board 投影的盘面摘要」——投影内部抛错不再能静默通过。
- [deploy] portal.js / index.html bump v132，已部署到 `/opt/destiny/web`；线上复跑八字与紫微归档抽查均命中专属字段。

## v131 (2026-11-26)
- [feat] 补齐 6 类功能（八字/紫微/占星/三种合婚/老黄历含双人择日，共 8 个注册表项）的 Board 专属投影：此前只有梅花/塔罗/六爻/奇门有投影，其余走通用摘要，只列标量、跳过对象/数组——四柱十神、逐柱十神与神煞细节、流月选点、十二宫主星与四化、行星相位、跨盘柱位关系、黄历宜忌冲煞等核心事实全部丢失。现在每类都有只读纯函数投影，归档卡从冻结 Board 对象重建，架构上不带按钮/事件。
- [docs] 前端设计系统登记 Board 摘要样式的唯一来源；portal.js / portal.css / index.html bump v131。
- [test] 对象模型护栏新增 12 功能专属投影注册、核心字段读取、投影只读（无按钮/输入/事件）断言；浏览器矩阵把紫微 tab 就绪与功能切换回读由固定延时改为按状态等待，消除机器繁忙时的偶发超时。
- [deploy] 线上目录 `/opt/ziwei` 迁移为 `/opt/destiny`，systemd 服务 `ziwei` → `destiny`，nginx 站点与限速区同步更名，并把旧精确匹配的 `/api/deduce` 限速改为正则覆盖统一 `/api/<feature>/deduce` SSE 路由；cron 备份路径同步。迁移后抽查首页 v131 资源、八字/占星/黄历/紫微 calc 接口与 SSE 路由均正常。

## v130 (2026-11-26)
- [fix] 修复「解读流式输出中切换宫位/视图，解读卡凭空消失」：根因是通用重绘逻辑 `preserveOutputs` 在新视图不含输出槽时（如切到命格视图没有 `#zw-d-ai-out`）直接丢弃缓存节点，导致正在写入的 SSE body 引用悬空。改为把旧节点挂回容器末尾保活，切回对应视图时自动归位——通用修复，非紫微特例。
- [feat] 八字新增流月选择：选中流年后展示该年十二个月的节气月柱（后端 lunar-python 按每月 15 日真实节气月柱计算，与八字排盘同源），点选后把「（只看 YYYY 年 M 月 干支 流月）」拼进问题文本；calc_bazi 复用共用 `parse_target_period` 把时点回写 payload/fact（进 dedupe key），不同流月是不同轮。紫微与八字流月同为二十四节气之「节」分界口径，已写入护栏。
- [feat] 八字新增「十神分析 / 神煞分析」卡：后端 bazi.chart 增 `ten_god_detail`（逐柱天干十神+藏干十神+释义）与 `shensha_by_pillar`（逐柱神煞+吉凶角标+释义），前端 `bzAnalysisHTML` 从 Board.data 投影渲染，当前盘面与归档共用同一份。
- [test] 新增 `tests/api/test_bazi_liuyue.py`（6 项）；E2E 新增 I-b 组（流式切宫位保活 3 项）。全矩阵：API 67（12 skip）/对象 37/契约 169/变异 4/E2E 48/浏览器链路 148 全绿。

## v129 (2026-11-26)
- [refactor] 紫微彻底并入统一工厂：删除独立 `/api/deduce` 与紫微专属指纹（`ziwei_fingerprint`/`ensure_ziwei_fingerprints`），紫微改走 `/api/ziwei/calc` + `/api/ziwei/deduce`，与其他 10 功能共用同一套 dedupe_key / 缓存命中 / SSE 回放 / 落盘 / 追问链路。
- [refactor] 消除紫微专属参数：v128 曾给紫微造 `date`/`time_index`/`target_year` 等新参数，实则八字选流年只把「只看 2027 流年」拼进问题文本即可；紫微改为复用通用 `year/month/day/hour`，hour→时辰用共用 `hour_to_time_index`，目标流年用共用 `parse_target_period` 从问题文本解析，宫位主体措辞本身就在问题里。
- [refactor] 统一工厂新增可选 `prompt_builder` 回调插槽：紫微十二宫专属规则集通过回调接入（单一 prompt 来源，追问也复用），不再为此另写一套路由。calc_ziwei 的 payload 显式带出生身份，排除易变的今日运限与随机 chart_id。
- [fix] 存量紫微历史（老格式 / v128 指纹）首次解读时归一到统一 payload 与 dedupe_key，升级前的对话同样能被同题命中。
- [refactor] 本地目录 `ziwei-upgrade` 更名为 `destiny-master`（线上部署目录 `/opt/ziwei` 不变）；README 与测试脚注路径同步。
- [test] 紫微测试改为打统一接口并断言统一 key；全矩阵 API 61（12 skip）/对象 37/契约 169/变异 4/E2E 45/浏览器 148 全绿。

## v128 (2026-11-26)
- [fix] 紫微同盘+同流年+同宫位+同问题重复生成解读：根因是前端从未向 /api/deduce 传去重 key，而后端命中条件 `if key` 恒为假，紫微是所有功能里唯一从未命中过历史缓存的；存量记录 dedupe_key 也全为 NULL。
- [refactor] 紫微专属稳定指纹 `history.ziwei_fingerprint`：只取出生盘面（剔除每日变化的「当前运限（今日）」段）+ 选定流年/月 + 聚焦宫位 + 问题原文，排除随机 chart_id 与 RAG 结果；后端在落盘前据此查 feature_history，命中直接回放原 answer/hid。
- [fix] 存量紫微历史懒回填：首次命中请求按已落盘 payload 反算指纹写回 dedupe_key（按 库路径+用户 双键只做一次），升级前生成的解读同样可被复用，无需用户重新解读。
- [fix] 前端紫微轮次身份纳入宫位（chart|命盘|流年|宫位），与后端指纹维度对齐，点不同宫位问同一句话不再在对象层串轮；portal.js bump v128。
- [test] 新增 test_ziwei_dedupe.py 5 项：同题命中/换 chart_id 仍命中/问题·流年·宫位变化各起新轮/旧 NULL 记录回填命中/force 强制重生成；全矩阵 API 63（12 skip）/对象 37/契约 169/变异 4/E2E 45/浏览器 148 全绿。

## v127 (2026-11-26)
- [fix] 追问结果内联进解读正文：不再渲染成「追问 · xxx」独立卡+展开按钮（那条点展开还打不开），改为「追问：问 + 答」连续段落，与个人中心历史详情同构；存量快照旧追问卡隐藏卡头、清折叠态。
- [fix] 会话边界收窄为「本次打开页面」：快照写入内存 epoch + 登录 token，恢复时校验，刷新/关标签重开/换号即丢弃旧对话——杜绝上次打开的对话与归档卡串进当前功能页。SPA 内切功能页仍保留（epoch 不变）。
- [test] 静态护栏锁定会话 epoch 校验与追问内联渲染；E2E/浏览器矩阵刷新语义改为「清空」，新增追问内联结构断言。

## v126 (2026-11-26)
- [refactor] 盘面一等对象化：新增 reading-core.js 的 Board 对象（feature/kind/roundKey/data/params/castTime/createdAt，数据深拷贝+逐层冻结），Reading 持有冻结盘面，ReadingSession 以 roundKey 为键管理盘面仓库（含 latestBoard + bindBoardToRound）。12 功能 calc 落地全部 putBoard 存结构化盘面数据，DOM 降级为投影。
- [refactor] 归档盘面摘要改为从 Board 对象投影（boardView）：牌面/卦象/六爻/奇门有专用投影，命盘类走通用事实摘要；归档卡不再复制旧 DOM HTML，历史回看读的是解读那一刻冻结的对象数据。按钮/事件从架构上不可能漏进历史卡（投影函数不生成按钮），不再只靠事后字符串清理。
- [refactor] 命名整改：新增代码参数/局部变量一律用全名（featureName/roundKey/boardData/castTime 等），Board 字段无 rk/d 缩写；既有 Reading.rk 与 data-rk DOM 属性属 v116 契约保持不变。
- [test] 护栏新增 Board 一等对象、12 功能 putBoard、归档从对象投影（禁止复制 .p-result innerHTML）三组断言；核心单测 37 项，浏览器矩阵 148 项。真实链路实测：塔罗/六爻 Board 登记与深冻结、归档卡无 AI 按钮且盘面摘要来自对象、零 JS 错误。

## v125 (2026-11-26)
- [fix] 历史归档卡残留「AI 解读牌义」按钮：盘面摘要此前直接复制 innerHTML，绕过了只读化清理；改为解读正文与盘面摘要共用同一套 stripArchiveControls（剥掉 tool-ai/p-suggest/p-switch，保留追问条）。
- [fix] 存量快照兼容：恢复 arcHtml 时清掉旧版归档卡里嵌着的 AI 按钮，历史回看不再留下触发新一轮解读的入口。
- [test] 浏览器矩阵新增 12×2 项「归档卡只读化 + 追问入口保留」；E2E 新增存量快照残留按钮清理断言（45 项全绿）。

## v124 (2026-11-26)
- [feat] 当前 AI 解读卡（含追问子卡）卡头支持收起/展开：与归档卡同一交互规则（点卡头 toggle，卡头右侧「收起/展开」提示），折叠时正文与追问条一起隐藏；定位已解读问题时自动展开当前卡。此前只有归档卡能折叠，当前卡正文很长时无法收起。
- [style][统一] 塔罗与梅花的 AI 解读按钮从牌面/卦面结果卡内移出，改为与其他所有功能同构的「盘面卡 + 独立 `.bz-ask` 提问卡 + AI 解读输出」三段平级结构；收编 `.stage-locked` 里失效的 `#mh-ai/#tr-ai` 隐藏规则（统一由 `.bz-ask` 负责）。按钮 id 不变，链路与测试契约不受影响。
- [test] E2E 新增 P1（当前卡卡头收起/展开）；浏览器链路矩阵新增通用结构断言「AI 解读入口必须在独立提问卡内、不得嵌在 `.p-result`"：12 功能全过（112→124 项）。
- [docs][发布] portal.js / portal.css / index.html bump v124。

## v123 (2026-11-26)
- [fix][严重] 紫微刷新后「命格/本命/运势」三个视图和十二宫位点全点不动、运势盘像锁死在财帛宫：根因是 v121 为修刷新丢对话引入的 `restoreStageSnap()` 用快照 `rootHtml` 整体覆盖 `#zw-result`，把渲染时绑在 tab / 宫位节点上的 `onclick` 一起抹成 `null`（浏览器实测：刷新前 `typeof onclick === "function"`，刷新后 `object`，点运势 tab 后当前视图仍是 plate）。改为只回填解读输出槽，盘面 DOM 与事件保持当前渲染结果；当前视图不存在的槽暂存进 `OUT_CACHE`，切到对应视图时由 `preserveOutputs()` 原样挂回。快照新增按槽 `outHtml`（解决紫微命格槽与宫位槽互斥时另一槽解读卡丢失）和 `zwState`（视图/选中宫/年份，恢复时先按状态重绘盘面再回填解读卡）。
- [test] `test_reading_e2e.js` M 组新增 M2/M3/M4 三项回归断言：刷新后 tab/宫位事件绑定保留、运势视图可点击切换、宫位可点选；40→43 项全绿。
- [docs][发布] portal.js / index.html bump v123。

## v122 (2026-11-25)
- [refactor][test] 建立声明式测试矩阵：`tests/contracts.json` 作为「功能 × 场景 × 不变量」单一事实源，必须与 `FEATURES` 注册表严格对齐；新增 `test_chain_matrix.py`（真实引擎链路：calc 展示事实逐字进 prompt / 问题回填 / 同盘回放 / 追问保盘 / 身份变化新轮 / 非法锁盘显式报错）、`test_contract_matrix.js`（对象层 9 类不变量对全部功能生成断言）、`test_browser_matrix.js`（全部功能 × 7 高频场景，真实 HTTP + mock AI）、`test_mutation_probes.js`（注入历史 bug 验证矩阵会报警）、`test_contract_matrix_guard.py`（防漏登记），并收口为一条命令 `node tests/js/run_matrix.js`。
- [fix] 矩阵新发现并修复两处真 bug：① 占星 `paintAstro()` 无条件 `archiveRound()`，同参数重绘就把当前解读归档、画面空 —— 改为与八字同构的 `chartKey` 判定 + `preserveOutputs()`；② 双人择日复用老黄历舞台时对象写进 `huangli` 单人会话（两个 Person 丢失），快照也按 `huangli` 存导致刷新丢对话 —— `sessOf` 按 `#hl-tabs` pair 状态归到 `huangli_pair`，切 tab 归档传实际 `feat`，`saveStageSnap/restoreStageSnap` 按 Reading 所属功能存取并复用老黄历舞台。
- [test] 紫微/紫微合婚因 py-iztro 非线程安全不在进程内 TestClient 跑链路矩阵，改由浏览器矩阵走真实 HTTP 覆盖；六爻新增「锁盘解析失败注入」变异断言，确认静默换卦一定报警。
- [test] 全矩阵实测全绿：API 53 项（紫微两项因 PythonMonkey 线程安全在进程内跳过，由浏览器矩阵覆盖）、对象定点 33、对象契约 169、变异探针 4、浏览器高频 40、浏览器契约 112。
- [docs] `SOFTWARE_ENGINEERING.md` 增「测试跟着契约走」铁律与一键跑全矩阵流程；portal.js / reading-core.js bump v122。

## v121 (2026-11-25)
- [fix][架构] 把 v120 的紫微专用重绘保护收编为全功能通用机制：`preserveOutputs()` + `archiveBeforeRepaint()`。输出容器清单与 slot 映射从 `FEATURES` 注册表派生（`Core.outsOf/slotMap`），新增功能自动纳入，杜绝「一功能写一套」。同盘重绘（八字重排、紫微点宫/切视图）原样保留解读容器；换盘/换卦/换牌/切子功能（八字改出生资料、紫微换盘、黄历 personal↔pair）先按「旧 rk + 问题」归档，对象与 DOM 同步。
- [fix] 对象与 DOM 脱节的三处：① `findAnswered/currentRoundRk` 只读主会话，紫微宫位槽的已解读问题定位不到 → 改为 `Core.sessionsOf` 跨槽查；② 个人中心历史详情追问写进 `profile` 会话、原 Reading 丢追问链 → 新增 `Core.findReadingById(hid)` 全局定位，写回原功能 Reading，并把快照存到原功能键；③ 紫微 `navigate()` 分支直接 `return` 漏掉 `restoreStageSnap`，刷新后对话与对象全丢 → 补上，并修正快照等待条件（紫微盘面无 `.p-result`）。
- [fix] 登录态清理：未登录启动（含直接删 localStorage 后刷新）清残留快照防串号；登录主动 `Core.clearAll()` + 清重绘缓存；退出清全部三个命盘缓存（此前只清紫微）。补 `astrology_marriage` 门禁文案。
- [test] 对象单测 30→33（跨 slot 会话/全局 hid 定位/注册表派生清单）；浏览器 mock E2E 27→31（v120）→**40**，新增 J 多对话与严格 rk+question、K 历史详情追问对象归属、L 功能间切换、M 页面刷新（紫微宫位）、N 登录退出隔离、O 同盘重绘保留；API 静态护栏 41 项（新增重绘保护单一来源断言）。全量通过。
- [docs] `SOFTWARE_ENGINEERING.md`、`FRONTEND_DESIGN.md`、`tests/README.md` 同步；reading-core.js/portal.js bump v121。

## v120 (2026-11-25)
- [fix][严重] 紫微选不同宫位后原先的对话「消失」：根因不是归档，也不是个人中心——`zwRender()` 每次点宫位/切视图都整块重写 `#zw-result` 的 `innerHTML`，把 `#zw-d-ai-out` 里的解读卡与追问链连 DOM 一起冲掉；Reading 对象仍在（I2 实测 PASS），但画面与对象脱节。新增 `zwKeepOutputs()`：重绘前把两个输出容器节点摘出缓存、重绘后原样挂回，事件监听与流式 DOM 引用随节点走；真正换盘时才清缓存，避免旧盘解读挂回新盘。
- [fix] 紫微宫位追问挂错会话：`.ai-follow-slot` 无 id，`sessOf` 此前只查容器自身 id，导致追问写进 `ziwei|""` 而不是解读所在的 `ziwei|"zw-d"`。改为沿 DOM 祖先找 `#zw-d-ai-out`，并从 stage 的 `data-feature` 反推功能。
- [fix] 运限接口失败时无限重排：`zwHoro()` 失败 → 重排生成新 chart id → 再失败 → 再重排……结果区一直停在「正在起盘」（本地缺 `horoscope.js` 必现）。改为只重排一次并 `warn` 留痕；实测 chart 请求由 15+ 次降到 2 次，盘面正常显示。
- [test] `test_reading_e2e.js` 新增 I 组 4 项：宫位解读写入 zw-d slot、切宫位后对象保留、DOM 对话/追问框仍在、追问挂回同一 Reading（27→31 项）。API 40 + 对象单测 30 + 浏览器 mock 31 全过。
- [docs][发布] `SOFTWARE_ENGINEERING.md` 增两条铁律；portal.js bump v120。

## v119 (2026-11-25)
- [style] 追问结果缺少段落感：卡头此前被降级为 12px/500/灰点，读起来像脚注而非新一轮对话。改为 13px/600/墨色 + 深绿金点（与主解读卡头同语义），顶部分隔由浅虚线改实线并留出 16px 呼吸，追问说明文字 11px→12px。全部走既有 token，未引入新字号或散值；唯一来源仍是 `.ai-follow-slot > .p-ai`，`FRONTEND_DESIGN.md` 同步说明。
- [test] 新增 `test_followup_result_reads_as_paragraph` 护栏，锁定追问标题不得回退成 sm 灰字、分隔线必须为实线；API 回归 + 单元 + 对象单测 + mock E2E 全过。`portal.css` bump 至 v119。

## v118 (2026-11-25)
- [test][护栏] 补齐解读链路的自动化测试。此前追问/去重/归档/快照只在真实 AI 下靠用完即删的临时探针验证，测试项少、不可重复。新增 `tests/js/test_reading_e2e.js`：Playwright 拦截全部 `/api/*/deduce` 与 `/api/history/followup` 返回 mock SSE，自起本地 uvicorn（也可 BASE_URL 复用），27 项覆盖对象写回/DOM 投影、追问挂接与连续追问、追问框不堆叠、同问题去重与换问题归档、reload 快照无损恢复、退出登录清理、命盘类导入 Person、双人 Person 快照、非 SSE 错误路径、无 JS 报错。断言只读对象真相源。对象层单测 `test_reading_core.js` 从 13 项扩到 30 项（find 边界/begin/finish/archive 语义/JSON 往返/hour=0/跨 slot 快照/注册表冻结）。`tests/README.md` 记录运行方式。
- [fix] 注册表 `Object.freeze` 原为浅冻结，嵌套功能项运行期仍可篡改；改为逐项深冻结（单测锁定）。
- [fix] 命盘类 Person 快照的出生资料来源 `S.profileBirth` 此前只在改档案/访问占星页时才加载，localStorage 恢复登录后为空——导致八字等 needsBirth 功能导入的 Person 无出生资料。新增 `loadProfileBirth()`，初始化与登录成功后各拉一次档案 birth（带防重复标志），对话冻结的用户信息完整。
- [test] API 回归 39 + 单元 14 + 对象单测 30 + 浏览器 mock E2E 27，全过。

## v117 (2026-11-25)
- [refactor][架构] AI 解读从「散在 DOM dataset」升级为统一对象模型。新增 `web/reading-core.js`（纯数据、无 DOM、可 node 单测）：`Person`（用户信息快照）/`Reading`（一次对话：问题+rk+正文+追问链+参与人）/`ReadingSession`（当前轮+归档+去重+快照）+ 12 项功能声明式注册表（root/qbox/out/note/arity/needsBirth）。对象为唯一真相源，DOM 的 data-rk/data-hid/data-archQ 降为渲染投影。
- [refactor] portal.js 解读链路全部改走对象：findAnswered 严格按 question+rk 查对象、currentRoundRk 读对象 boardRk、归档同步迁移 current→archived、streamToUrl 结束时写回 answer/hid、追问 append 到对应 Reading.followups；选择器表与 followNote MAP 由注册表生成（消除两处「一个功能一份」的重复）。
- [feat] 对话导入用户信息：注册表 arity 声明单人=1/双人合婚与择日=2、needsBirth 声明是否由出生资料定盘；`currentPersons()` 从登录档案构造 Person 快照，双人功能经 `pairFormParams` 写入对方快照。对话一旦建立即冻结参与人，用户中途改档案不影响旧解读追问的一致性。
- [test] 新增 `tests/js/test_reading_core.js`（13 项：去重/归档/追问/快照/双人 Person/六爻换爻隔离）与 `tests/api/test_reading_core_guard.py`（锁单一来源：注册表 arity/needsBirth、无散写 MAP、find/begin/finish 走对象、脚本加载顺序）。API 回归 39 项全过；浏览器实测解读写回/DOM 投影/追问挂接/双人快照全通过。

## v116 (2026-11-25)
- [fix][解读口径] 紫微点名某宫 = 以它为主体、据三方四正与四化展开，不是「只看」单宫。根因：宫位提问区把「（只看「XX宫」）」硬拼进问题文本，随 q 直接进 AI【用户问题】，压过后端三方四正框架；UI「三方四正」快捷跳转偏移 `[1,5,7]` 亦与命格解析口径 `[4,8,6]` 不一致。
- [fix] 前端：提问前缀改「（以「XX宫」为主体，结合三方四正与四化）」（含主体措辞的 chips 不重复加）；三个 chips 与输入框占位改为为主体口径；zwAsk 新增 focusPalace 参数，把主体宫+方法论词结构化传后端；三方四正跳转偏移修正为 `[4,8,6]`。
- [fix] 后端：`prompt.py` SYSTEM_RULES 新增「主体宫位法则」（点名某宫≠只看该宫，须会本宫+对宫+三合二宫四方星曜并叠加生年/大限/流年四化飞化，禁止孤立单宫解）；prepare_ziwei 对「为主体」类提问补入三方四正/四化/对宫/飞化检索词，避免 RAG 只命中单宫词条，并随 payload 带入追问。
- [test] 新增 `tests/api/test_ziwei_palace_focus.py`：锁定 prompt 法则、RAG 补词、前端无「只看」措辞与三方四正偏移；前端 portal.js bump 至 v116。

## v115.1 (2026-11-25)
- [refactor] 消灭全仓静默吞异常：新增 `server/applog.py` 统一日志，后端 10 处 `except: pass` 全部改为留痕（warning + exc_info），前端 16 处空 `.catch(function(){})` / `catch(e){}` 改为 `console.warn`，其中六爻起卦、奇门起局失败改为用户可见错误提示。
- [test] 新增 `tests/api/test_no_silent_except.py` 静态护栏：禁止 `except:pass` 与空 catch 回潮，并要求留痕基础设施在位。API 回归 24 项 + 单元 14 项全过。
- [docs] 前端 portal.js bump 至 v115.1。

## v115 (2026-11-25)
- [fix][严重] 六爻「看到的卦 ≠ AI 解读的卦」：calc 回传 6 位连串 deck（如 `879877`），deduce 只按逗号切分导致解析失败，静默回退为重新起卦；页面显示巽为风、AI 却解读随机新卦。现统一由 `liuyao.parse_yaos` 解析连串与逗号串，锁盘失败一律显式报错，绝不静默换卦。
- [fix] 全部 deduce 把 `q` 回填到 `question`，保证 compute_fn/锁盘重算的「所问」与 calc 一致（此前 deduuce 重算时问题文本丢失）。
- [test] 新增真实引擎端到端护栏（不再 mock 引擎）：断言六爻/塔罗 calc 展示的每一层盘面事实逐字进入 AI prompt；补无效 deck 必须报错且不调用模型、连串与逗号串等价、q 回填三项断言。API 回归 21 项 + 单元测试 14 项全过。

## v114 (2026-11-25)
- [style] 盘面字号收编：新增 `--fs-dense:10px` / `--fs-fine:9px` / `--fs-glyph:40px` 三个专用 token，紫微九宫与详情、奇门九宫、八字步骤、占星宫位、合婚柱位的 9/9.5/10px 全部归位，全站不再有任何裸 px 字号。
- [fix] 普通辅助文字统一提升到 11px：侧栏副标题、即将上线、历史功能标签/日期、黄历农历与节气、奇门问号、必填星号由 10px → `--fs-xs`，不再占用盘面小字。
- [test] 护栏升级：`test_no_bare_px_font_sizes` 拦截所有裸 px（含原 9/9.5/10/40 例外）、`test_panel_and_glyph_tokens_defined` 锁定三 token、`test_aux_text_promoted_to_xs` 防止辅助文字回退。
- [docs] `FRONTEND_DESIGN.md` 例外登记表改为盘面 token 规范；前端版本 bump 至 v114。

## v113 (2026-11-25)
- [fix] 前端字号继承根因：旧 `style.css` 的 `body=13.5px` 渗进所有未显式设字号的容器，出现 13 / 13.5 / 13.3333 混用。门户正文改为显式 `font-size: var(--fs-base)`，原生控件用零特异性 `:where()` 继承字体，避免覆盖 `.ti` 等样式。
- [refactor] 全站字号收敛到 token：新增 `--fs-3xl`(32) / `--gap-xl`(32)，页面主标题、分组标题、卡片标题、辅助文字、黄历标题统一走阶梯；盘面小字仅保留 9/9.5/10px 与符号 40px 例外。
- [fix] 控件与卡片一致性：分段按钮、黄历下拉/翻页按钮、日期格统一 42px 控件高；卡片圆角统一 12px，按钮/图标统一 8px；黄历日历格高按设计 42px。
- [refactor] 个人中心与梅花卦名的内联 `font-size` 迁入 CSS 类；小号文字按钮尺寸统一，模板不再散写样式。
- [test] 新增 `tests/api/test_frontend_tokens.py` 静态护栏（无散写字号、控件高度/卡片圆角 token、无内联字号、版本号一致）；逐页计算样式审计 13 页 + 移动端 4 页，非例外异常归零；`e2e_v101.js` 19/19 PASS，JS 报错 0。
- [docs] 更新前端设计系统唯一来源说明。

## v112 (2026-11-25)
- [test] 新增可入库的 API 回归框架（`tests/api/`）：临时 SQLite + 测试账号 + 计算引擎 mock + AI 流式 mock + SSE 解析；不调真实模型、不碰线上库。覆盖十一功能 calc→deduce→追问→历史详情，去重回放/force、盘面身份变化、八字约束跨追问复用、未登录与跨账号鉴权、紫微显式流年与问题内年份解析。
- [refactor] 拆分 1000+ 行 `feature_api.py` 为 `server/features/` 包：`common`（鉴权/去重/RAG/免责/SSE）、`context`（档案八字/星座约束）、`calculations`（确定性计算）、`feature_routes`（动态 calc/deduce）、`support_routes`（历史/记忆/KB）。`feature_api.py` 保留兼容门面，外部调用契约不变。
- [refactor] calc/deduce 共用的长查询参数收敛到单一 FastAPI 依赖；首轮解读与追问共用 `common.answer_events`，消除重复 SSE/落盘代码并支持追问中途断开时保存已生成内容。
- [docs] 更新软件工程约定与变更记录。

## v111 (2026-11-25)
- [fix] 八字排盘「流年」默认高亮当年但提问区显示「未选择大运或流年」：pick 初始化为空导致状态不同步。现默认选中当年流年并同步提示与 scope，用户点击后跟随具体流年。
- [fix] AI 解读卡位置统一到提问框下方：六爻/奇门的结果容器内含提问框，原逻辑把解读卡插到盘面卡之后（提问框上方）。改为优先插到提问框之后；塔罗/梅花插盘面后，八字/紫微/占星/合婚的独立输出容器不受影响。
- [fix] 历史归档卡丢失追问框：archiveRound 只保留正文文本、丢了 data-hid 与追问条（注释本要求保留）。归档卡现保留 hid 并重挂可交互追问框，追问仍写回同一历史链。
- [feat] 新增第十一项功能「占星合盘」（astrology_marriage）：双人本命盘 synastry 跨盘相位（合冲刑拱六合+容许度）、金星火星落对方宫位、日月星座要素配对，确定性计算、不打分数；后端 marriage.astrology_marriage + calc/deduce 工厂注册 + 第二方经纬度参数，前端导航/首页卡片/双人表单(双方出生地)/盘面/提问/个人中心统计分组，AI 专属解读规则，检索复用占星语料。
- [docs] 版本记录同步。

## v110.1 (2026-11-24)
- [test] 扩大功能流程测试：覆盖全部十功能（八字/紫微/八字合婚/紫微合婚/梅花/六爻/奇门/塔罗/占星/黄历）的排盘/起卦→AI解读→追问完整链路，均通过；另验证未登录门禁、换问题平级归档、个人中心历史、登出清缓存、缓存命中回放(cached)与 force 强制重生成、紫微运势选 2033 流年后请求带 year 且解读按癸丑年作答。无新增产品 bug。

## v110 (2026-11-24)
- [fix][安全] 紫微 /api/deduce 鉴权绕过：原逻辑在 profile_id+token 校验失败时回落到命盘会话内绑定的 profile_id，攻击者仅凭泄露的 chart_id（12 位随机串）即可无 token / 用假 token 借他人身份推演、消耗额度并写入他人历史。改为必须有有效凭据，且命盘会话归属与登录者不一致时拒绝（防用自己的 token 借他人盘面）。
- [fix] 非法出生参数导致 500：2月30日、month=13、hour=24/-1、minute=99 等使 lunar_python 抛裸 Exception，八字 calc 与八字合婚 calc 返回 500。bazi.chart 入口加范围校验并将裸 Exception 转 ValueError，接口工厂层加 Exception 兜底，统一返回友好错误。
- [fix] /api/history/delete_batch 混入字符串或超大整数 id 时 int() 抛异常导致 500，改为逐项安全转换并过滤非法值。
- [test] 四路代码评审（接口/引擎/数据/前端）+ 动态验证：3 个临时账户覆盖鉴权隔离、参数边界、缓存串号、历史父子链、删除越权；E2E 冒烟（首页/注册/排盘/黄历AI/JS错误）全通过。

## v109 (2026-11-24)
- [fix] 全链路排查收尾：黄历个人运势的轮次身份纳入「导入八字」开关，避免同日同问题切换约束时命中旧解读；梅花事实层补「起卦时刻」，时令旺衰基准对 AI 显式可见；占星轮次身份纳入经纬度/时区，避免同名地点不同坐标误命中旧盘。

## v108 (2026-11-24)
- [fix] 紫微运势盘选定流年后 AI 仍按当前时间解读：前端未把所选年份传给 /api/deduce，轮次身份也不含年份；现携带 year、rk 纳入年份，并在 prompt 中明确「推演目标」优先于「当前运限（今日）」与系统日期，历史结论只在同运限时沿用。
- [fix] 梅花/奇门选定起卦/起局时刻未回传 deduce，AI 会按当前时刻重算时令旺衰；现锁定 calc 实际时刻（梅花 rk 同步纳入时刻），所见即所解。
- [fix] 通用 prompt 增加「用户显式指定时点优先」铁律；八字事实层「当前大运/近年流年」改为「基准大运/基准年起流年」，黄历「节气：今日」改为「该日」，避免盘面标签把模型锚定到系统当前时间。

## v107.2 (2026-11-24)
- [refactor] 彻底清除 Git 历史中的 tests/ 文件对象：filter-branch 重写全部提交的 hash、清理原引用与 reflog、force push 覆盖远端。本地 tests/ 文件保留，旧历史仅存于本地 bundle 备份。

## v107.1 (2026-11-24)
- [refactor] tests/ 全目录移出版本库（本地保留），取消 17 个 E2E/单元测试脚本的追踪并加入 .gitignore；历史提交中的旧文件不改写。

## v107 (2026-11-24)
- [fix] 紫微 AI 解读：服务重启清空内存 CHARTS 后 deduce 返回「命盘缓存失效」、前端把 JSON 当 SSE 流解析导致正文空白。后端改为用登录档案出生信息确定性重建命盘会话，前端对非 SSE 响应显示明确错误提示，不再留空白卡。

## v106 (2026-11-24)
- [fix] 移除 `nginx sites-enabled/` 下的 `.bak` 备份块（被 include 全部加载导致多 server 块冲突、用户命中旧缓存）；静态资源加 `no-cache, must-revalidate`，前端 bump 强制刷新。

## v105 (2026-11-24)
- [refactor] 建立设计系统 token 层与原子组件层（`.ui-field/.ui-label/.ui-control/.ui-btn/.ui-card/.ui-note`），统一控件/按钮/卡片/表单的散落字号、圆角、间距范式；入口页加 no-store 防新旧 JS/CSS 混杂。

## v104 (2026-11-24)
- [style] 双人表单标签与控件绑成 `.bf-field`、段内 .bf-sec，统一段间 16px / 段内 10px / 标签 13px；出生地标签与间距对齐。

## v103 (2026-11-24)
- [style] 建立字号阶梯（11/12/13/14/16）与间距阶梯（6/10/16/22），AI 正文字号统一到 13px，合婚盘面字段改三段 `<span>` 修复孤字换行；补齐合婚/六爻/奇门 AI 容器的首卡间距。

## v102 (2026-11-24)
- [style] 追问结果改为解读卡内连续段（去嵌套圆角卡壳），保留 DOM 结构仅调整 CSS。

## v101 (2026-11-24)
- [fix] 个人中心统计按五类分组、黄历合并双人择日计数；合婚拆分为「生成双人盘」与「独立 AI 提问卡」；奇门问号改为可点击备注、用神补「指定八门」；全站删除盘面事实展开按钮。

## v100 (2026-11-24)
- [fix] 轮次身份改为「问题 + 盘面/牌面/宫位/流年」严格相等；双人盘信息不变时换问题不重排；奇门实现拆补/置闰双定局与可选字段；界面整理。

## v99 (2026-11-24)
- [fix] 删除六爻/奇门事实展开；舒展双人表单；老黄历合并双人择日为子功能 tab（修复重复 DOM id 致日历加载失败）。

## v98 (2026-11-24)
- [feat] 扩充 6ygua 古籍语料（47 本/2252 章）；合婚与择日表单统一；首页按分类归类；修复六爻爻象绘制。

## v96 (2026-11-24)
- [fix] 合婚表单黄历式改造、删除事实按钮、铜钱明细、奇门年命用神必填；补全六爻语料。

## v95 (2026-11-24)
- [feat] 首页卡片按分类分组呈现。

## v94 (2026-11-24)
- [feat] 新增八字/紫微合婚、六爻、奇门遁甲；手动起卦改爻实时预览；py-iztro 端点改 async 修复段错误。

## v93 (2026-11-23)
- [feat] 占卜类起卦/抽牌纳入「所问之事」变量（问题为并列变量而非唯一决定）；calc/deduce 一致性锁定（塔罗牌面/梅花卦象所见即所解）。

## v92 (2026-11-23)
- [feat] 个性化记忆统一到 `personal_memory`（删除自动画像链路）；功能页历史归档单层化；会话快照（reload 后追问不丢）。

## v91 (2026-11-23)
- [fix] 卡片间距统一、追问框沉底、AI 画像可视化与清空（v92 已移除画像）。

## v90 (2026-11-23)
- [fix] 历史提问区与上方卡片宽度对齐。

## v89 (2026-11-23)
- [fix] 追问合并同一历史记录（父子链）；追问框不堆叠；历史批量删除；归档标签/宽度修订。

## v88 (2026-11-23)
- [feat] 单一宽度源统一提问卡；历史去嵌套；档案恢复农历；个人记忆；十二宫重设计；黄历日历收紧。

## v87 (2026-11-23)
- [feat] UI 规范统一与架构文档；时间组件复用；原子记录；占星含义字段；双人择日。

## v86 (2026-11-23)
- [fix] 命盘类登录态缓存不重排；占星自动出盘直接提问；占卜提示位置统一。

## v80–v85 (2026-11-19 ~ 2026-11-23)
- [feat] 出生信息共用档案模板与三级出生地；登录占星只读档案卡；新增占星命盘功能、梅花强制八字、塔罗星座注入；轮次按结果身份去重。
- [feat] 新提问=换问题重新开始（重抽牌/起卦）+ 整轮归档 + 并发保护；删 reask、模板问题跳转定位、归档只读、提问卡结构统一。
- [feat] 落地首页 + AI 登录门禁 + 退登清缓存 + 宽度间距统一；项目图标改为极简黑白 ∞ 风格。

## 初始版本 (2026-11-19)
- [feat] Destiny Master 五功能统一 AI 链路 + 全量知识库；交互修复与全量 E2E 回归测试。
