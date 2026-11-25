# 前端设计与交互参考（ziwei 升级）

> 本文记录本项目前端的信息架构、可核对规则、交互细节与工程约束。
> 第七章是前端约定的唯一事实来源，新增功能或改 UI 前必须先读。

## 一、整体信息架构（每个功能页统一）

每个功能都是一套 **「认识 → 核对 → 使用 → AI 解读 → 边界」** 的叙事落地页，而非裸表单：

1. **01 · 认识**：这个功能是什么、核心概念（卡片式名词解释）、"一个 X 是怎样形成的"分步图解。
2. **02 · 核对**：明确写出确定性计算规则/公式，用户能逐步回看，强调"同一输入永远同一结果"。
3. **03 · 使用**：工具表单（问题输入 + 参数 + 主按钮）。
4. **04 · AI 解读**：AI 基于已确定的盘面 + 文献展开，标注依据，支持追问。
5. **免责边界**：每页顶部一行"本服务仅供娱乐…重要决策结合专业建议"。

左侧固定深色导航（FateMaster 功能菜单），右侧居中的工具表单页。本项目只实现已确定的功能入口。

## 二、可核对性（核心卖点，必须体现）

- **梅花**：页面明写公式——
  - 上卦 =（年支序数 + 农历月 + 农历日）÷8 取余
  - 下卦 =（上式 + 时辰序数）÷8 取余
  - 动爻 =（上式总数）÷6 取余
  - 余 0 → 八卦按 8、动爻按第 6 爻；爻位从初爻自下往上数。
  - 明确"问题文字不参与运算，只作解读语境""用本地时间，不做真太阳时校正/不偷换服务器时区""拿不到合法本地时刻接口直接拒绝"。
  - 结果展示：本卦名 + 动爻位置 + 变卦 + 六爻逐行（自下而上）+ 卦辞/爻辞（真实经文，非占位句）。
- **塔罗**：牌组 78 张（大阿卡纳 22 + 四花色各 14）；三张牌=过去/现在/未来（叙事框架，非三句预言）；正逆位在解读前确定；切换解读风格只改语气不改牌。RWS 体系。
- **六爻**：起卦后展示本卦/变卦/纳甲（干支五行）/六亲（官鬼、妻财、父母…）/六神/世应/月建日辰旬空；强调"六层规则链，每结论可回看"。
- **奇门**：时家奇门、转盘排宫、拆补定局；九宫承载九星/八门/八神/三奇六仪；洛书九宫方位图；"问题文本不影响局数星门位置"；134 个术语格局词典。
- **黄历**：先列全字段（见下），再 AI 解释栏目与事项关系；"宜忌只是醒目结论，孤立吉凶不是整天定论"。

## 三、黄历字段清单（本项目已对齐 29 项）

公历/星期、农历、生肖（年月日）、干支（四柱）、纳音（四柱）、宜、忌、吉神、凶煞、冲煞、空亡、值神(黄道/黑道)、十二建星、财神/喜神/福神/阳贵/阴贵方位、当前节气(精确时刻)、上/下节气、二十八宿(吉凶)、九星、物候/候、节日。

## 四、AI 解读的克制边界（与本项目"客观平衡"铁律一致）

- "AI 不制造神谕"；卦爻辞/牌义是真实文献依据，不是临时生成占位句。
- AI 把问题、盘面、正逆位/卦爻、文献组织成可读叙事，指出主线和盲点。
- 不做宿命断语；健康/婚姻等重大决策提醒理性对待。
- **客观平衡**：矛盾、短板、隐患必须与优点讲得一样清楚（用户 2026-11-17 明确要求，已写入 ai.py 与 prompt.py 铁律）。

## 五、交互细节

- 每个功能有"建议问题"列表引导用户开口（如黄历："今天适合做什么""这周哪天最适合搬家""3月15和20号哪个适合出行"）。
- 结果态先展示确定性盘面（可折叠/可核对），再接 AI 流式解读。
- 免责声明固定底部。
- 术语可点开"名词解释"/"指南"深读（站内大量 guides 链接）。

## 六、本项目的落地取舍

- 已实现十功能：八字、紫微、八字合婚、紫微合婚、梅花、六爻、奇门、塔罗、占星、老黄历，共享登录/档案/历史/个性化能力层。
- 文献 RAG：按领域存于 `docs/kb/<domain>/`，各功能 deduce 用计算模块给出的检索词精确召回。
- 视觉沿用宣纸·墨·黛青主题；样式与间距以 `FRONTEND_DESIGN.md` 的设计系统为唯一来源。

---

## 七、本项目前端架构与扩展规范（工程约束 · 新增功能必须先读）

> 这一章是**代码约定的唯一事实来源**。目的是让同类需求只在一处实现、全局复用，
> 不再依赖截图逐个发现"独一档"。任何新增功能或改 UI 前，先对照本章的组件契约与清单。

### 7.1 共用组件契约（portal.js，禁止重复造轮子）

| 场景 | 统一入口 | 说明 |
|---|---|---|
| **出生日期时间选择**（年月日 + 时分 + 农历/八字切换） | `birthFieldsHTML(pfx, opts)` / `birthFieldsBind(pfx, init)` / `birthCollect(pfx)` | 出生资料唯一表单模板。用于八字、紫微、占星、个人中心档案、注册。`opts` 细粒度开关：`simple`=隐藏八字切换+农历；`noBazi`=只隐藏八字切换（**档案编辑用此保留农历互转**）；`noLunar`=只隐藏农历。后端写入端 `_birth_to_solar` 统一把农历转公历存储，读取端无需判断历法。 |
| **任意公历日期时间选择**（选一个时刻，非出生资料） | `dateTimeHTML(pfx, opts)` / `dateTimeBind(pfx, init)` / `dateTimeCollect(pfx)` | 复用同一个日历弹窗 `openDateLookup`。用于梅花指定起卦时刻、黄历第二人八字等。**禁止再用原生 `<input type="datetime-local">`。** |
| **日历弹窗** | `openDatePicker(pfx)`（写入出生字段）/ `openDateLookup(initial, onPick)`（回调，不写出生字段） | 全局唯一 `dpEl` 实例，两种模式由 `dpOnPick` 是否为空区分。 |
| **出生地三级联动** | `placeFieldsHTML(pfx)` / `placeFieldsBind` / `placeCollect` | 国家→省/州→城市，含经纬度时区，数据源 `GEO_DATA`。 |
| **提问卡（结果区下方）** | `.bz-ask` / `.zw-ask` / `.zw-d-ask`（宫位详情）/ `.bz-ask.as-ask`（占星） | 统一 `max-width:var(--content-w); margin:16px auto 0`。**禁止写死宽度常量**——盘面卡、提问卡、解读卡、归档卡、门禁卡全部用同一个 `--content-w`（760px）。历史上因「盘面 760、提问 720」两个常量打架，紫微提问卡反复出现"独一档/对不齐"，已彻底收敛为单一变量。 |
| **导入档案信息的提示框** | `.p-bazi-gate`（`.ok` / `.warn`），统一放表单**第一个子元素** | 梅花强制八字 / 塔罗太阳星座 / 黄历八字，样式与位置一致。 |
| **AI 流式解读 + 追问** | `streamAI(feature, query, question, container, rk)` | 统一 SSE 渲染、免责声明由系统附加、落 `feature_history`、卡底挂 `attachFollow`。新功能不要自己写 fetch+渲染。 |

### 7.2 数据模型：原子记录（不可拆分的最小历史单位）

**一条可归档/可保存的记录 = AI 解读 + 功能 + 个人信息 + 问题**，四者缺一不可。

- 后端：`history.save` **只在 `deduce`（AI 解读）时落库**；`calc`（抽牌/起卦/排盘/查历）从不落库。
- 前端：`archiveRound` 只归档含 `.p-ai`（解读卡）的完整轮次；**仅抽卡/起卦、无 AI 解读的纯结果轮直接丢弃**，不产生历史项。
- 追问（`followup`）沿用本轮落盘的 payload 与 `hid`，不产生新记录。
- 用户临时注入的个人约束（八字/星座/第二人八字）存 `payload._injected`，追问原样复用，保证前后一致；开关状态纳入 `payload` → 纳入去重 key。

### 7.3 视觉规范（避免"独一档"）

- **唯一宽度源** `--content-w:760px`（定义在 `.portal-body`）：盘面卡 / 提问卡 / 解读卡 / 归档卡 / 门禁卡 / 结果标题全部 `max-width:var(--content-w); margin:auto`。新增内容区一律用它，**不得再写 720/760 等裸常量**（@media 视口断点除外）。曾因两常量并存导致紫微提问卡反复对不齐。
- 单行输入统一 `.ti`（42px 高）；**提问框一律单行 input，不用 textarea**（曾出现黄历 textarea 高度独一档）。
- 个人中心：基本信息 4 字段一行（`repeat(4,1fr)`）、功能统计 6 卡一行（`repeat(6,1fr)`），窄屏再折行；性别用分段按钮不再独占整栏；表单内保存按钮统一 `.pf-btn`（描边轻量），与「编辑/修改」同调，不用深色 `.tool-submit`。
- 占星盘面每条数据附含义：行星/相位用 `.as-mean` 整行展示，十二宫为 **4 列 × 3 行**（`.as-house-h` 完整星座名 + `.as-house-mean` 可见含义），含义来自后端原子字段 `meaning`/`tone`。**禁止再用 6 列 nowrap + 省略号**（会把星座名缩略成符号）。注意 CSS 中不要重复定义 `.as-houses`，否则后面的规则会覆盖布局（曾踩坑）。
- 老黄历日历：数字 13px / 农历 10px / 格高 42px，保持紧凑，勿放大。

### 7.6 个人记忆（Personal Memory）

- 数据：`server/memory.py` 建 `personal_memory` 表（profile_id 隔离），一条记忆 = 正文 + 分类 + 来源 + 时间戳。分类 `CATEGORIES` 常量统一。
- 后端端点（`features/support_routes.py`，由 `feature_api.py` 门面转出）：`GET /api/memory/list`、`POST /api/memory/save`（带 id=编辑，不带=新增）、`POST /api/memory/delete`、`POST /api/memory/compress`（从历史 ids 抽取答案 → `ai.stream_answer` 收集全文压缩成一条，非流式返回）。
- 前端：个人中心 `.pf-memory` 卡片区，`pfMemoryHTML()` 渲染 + `bindMemory()` 绑定；状态存 `pfState.memories/editMem/memDraft/memCat/memImportOpen/memSelected/memBusy`。
- 交互：新建/编辑进编辑态（分类分段 + textarea）→ 保存；删除两步确认；「从历史导入」勾选历史 → AI 压缩后进编辑态让用户确认再保存。

### 7.4 新增一个功能的标准步骤（Checklist）

1. **后端引擎**：`server/<feat>.py` 写确定性 `derive/query/draw`，返回 `fact` + `rag_query` + `rag_extra`。
2. **注册工厂**：`features/common.FEATURES` 增项、`features/calculations.py` 写 `calc_<feat>`、在 `features/feature_routes.py` 末尾注册 `_make_calc_and_deduce`；`history.FEATURE_NAMES`、`ai.FEATURE_GUIDES`、`rag_kb.DOMAIN_VOCAB` + `docs/kb/<feat>/` 语料。
3. **前端入口**：`render<Feat>` + 首页入口 + `names`/`fn`/`QBOX_SEL`/`ROOT_SEL`/`PF_FEATS` 五处映射；提问卡用 7.1 统一类。
4. **轮次身份**：定义一个确定性 `rk`（牌阵|牌面 / 卦象 / 日期 / 命盘），传给 `streamAI`；问题或 rk 任一变化即平级归档旧轮。
5. **个人约束**：若需结合档案信息，走 `_augment_profile` 注入并写 `payload._injected`；需要选时刻时用 7.1 的统一时间组件。
6. **测试**：先在 `tests/api/` 补 mock 回归（calc/deduce/追问/去重）；`tests/e2e_new_features.js` 覆盖新功能前端关键断言；本地与线上各跑一遍。
7. **发布**：改前端必须 bump `web/index.html` 的 `?v=` 并填写 `CHANGELOG.md`；部署与验证流程见 `SOFTWARE_ENGINEERING.md`。

### 7.5 命盘类 vs 占卜类（个人信息处理）

- **命盘类（八字/紫微/占星）**：出生信息固定后，登录态自动出盘、收起表单、结果区直接提问；按出生信息缓存（`CHART_CACHE`），**信息不变不重排**，仅档案出生信息变更时清缓存重排。
- **占卜类（梅花/塔罗/黄历）**：不自带命盘，导入个人信息 + 提问；档案信息提示框统一置顶。

### 7.7 历史记录：追问合并 + 批量删除（v89）

- **追问合并进同一条历史**（原子记录语义：一次提问 = 原问题 + AI 解读 + 追问链，算一条）：
  - 数据层 `feature_history` 增 `parent_id` 列（旧库自动 `ALTER TABLE` 补列，索引在补列后建）。顶层记录 `parent_id IS NULL`；追问是子记录 `parent_id=root_id`。
  - `history.append_followup()` 写子记录（继承顶层 feature/profile，不单列）；`list_history`/`stats` 只算顶层；`get_detail()` 归一子 id 到顶层并带 `followups[]`（时间正序）；`delete_one` 连坐子记录。
  - followup 端点：`history.append_followup` 代替 `save`，回传顶层 `id` 让追问链始终指向同一轮；对话上下文把 `item.followups` 并入 `prior`，保证多轮追问不丢前文。
  - 前端：历史列表只显示顶层问题；点开详情在同一张 `.p-ai.p-hist-detail` 内用 `.pf-hist-fu` 铺出追问链；追问框多轮复用同一个（追问结果卡 `tag==="追问"` 不再 `attachFollow`，避免逐层堆叠追问框）。
- **批量删除**：后端 `POST /api/history/delete_batch`（ids 列表 → `history.delete_many`，顶层+子记录连坐，仅本人）；前端个人中心 `.pf-hist-zone` 历史区加「批量删除」→ 全选 `#pf-selall` / 单选 `.pf-hcard-ck` / 删除选中（两步确认）/ 退出，状态存 `pfState.batchMode/selected`。
- **历史区宽度**：`.pf-hist-zone` 用 `max-width:var(--content-w);margin:auto` 包住标题+列表，与展开的 `.p-ai.p-hist-detail` 严格同宽居中（曾因列表撑满外层 p-card、详情卡锁 760 导致左右边缘对不齐）。
- **归档回看标签**：`freezeForReview()` 把归档轮内 `.p-ai-title` 的「新提问 · 问题」改写为「本次解读」——外层 `.round-item-hd .rq` 已显示问题文本，内层重复即残留。

### 7.8 历史区宽度再修订（v90）
- 个人中心是撑满 `#pf-body` 内宽的卡片流（个人记忆 / 统计卡均 `max-width:none`）。历史区此前误用 `max-width:var(--content-w)=760;margin:auto` 居中，导致相对上方卡片整体右缩进约 90px。
- 修订：`.pf-hist-zone` 去掉 max-width 与 auto margin，改 `margin:22px 0 0` 跟随父容器内宽；`.p-ai.p-hist-detail` 覆盖全局 `.p-ai` 的 760 限制（`max-width:none;margin:16px 0 0`）。三者（个人记忆 / 统计 / 历史区）left 与 width 实测完全一致。
- 注意：`--content-w:760` 仍用于**功能页**（盘面/提问/解读/归档），个人中心卡片流不在此列，勿混淆。

### 7.9 卡片节奏 / 追问框沉底 / AI 画像管理（v91）
- **卡片垂直节奏**：盘面卡→提问卡是 16px，提问卡→解读卡此前是 `.p-ai` 全局 8px，忽大忽小。用 `#as-ai-out > .p-ai:first-child` 等各功能 ai-out/结果容器首张解读卡统一到 16px（追问结果卡在 slot 内不受影响）。
- **追问框沉底**：追问结果槽 `.ai-follow-slot` 与输入栏 `.ai-follow` 从「输入栏包含 slot」改为「slot 前置、输入栏紧随其后」的兄弟结构。多轮追问结果都追加进 slot，输入栏永远在所有追问结果最下方（`body → slot → 输入栏`）。追问结果卡仍不挂新输入框，始终只有一个输入栏。
- **AI 画像管理（回答「删了历史 AI 为何还记得」）**：
  - 用户画像 `profiles.user_profile` 与更早对话摘要 `summaries` 是 AI 从历次对话提炼的**长期记忆，独立于 `feature_history` 历史提问表**——删除历史提问不会清除。追问时 `_personalize → get_user_profile` 会把它重新注入 prompt，所以删历史后 AI 仍可能引用旧信息（如「八成上限两成现金零融资」）。
  - 新增 `GET /api/profile/ai_profile`(profile_id,token) 读画像+摘要、`POST /api/profile/ai_profile/clear` 清空画像+摘要并把 `profile_upto`/`compressed_until` 水位推进到最新消息（避免旧消息被再次提炼重建）。`profile.get_ai_profile/clear_ai_profile` 实现。
  - 个人中心新增「AI 记忆管理」卡（在个人记忆卡上方）：展示 AI 记住的内容 + 「清空 AI 画像」两步确认。让用户看清来源并自主清除。

### 7.10 记忆统一 / 归档单层化 / 会话快照（v92）
- **记忆统一到个人记忆**：删除 v91 新增的「AI 记忆管理」（自动画像 user_profile + 摘要）。个性化注入唯一来源 = 用户手动维护的 `personal_memory`（个人记忆卡），`memory.personalization_text()` 拼成 `[分类] 内容` 文本，`history.personalization()` 注入所有功能 prompt（含紫微首轮/追问）。删除个人记忆即时不再注入。后端删 `GET/POST /api/profile/ai_profile`、画像后台提炼 `maybe_update_user_profile`、profile.py 画像函数；前端删 pfAiprofileHTML/bindAiprofile/CSS/pfState.aiProfile/loadProfile fetch。prompt 文案统一为「个人记忆（用户手动维护的自我认知…不要在回复中复述或宣称记得这些）」。
  - 注意：profile.py 的 `_ensure_profile_columns()` 必须保留（db() 初始化调用它补 messages.dedupe_key），只去掉 user_profile/profile_upto 列迁移即可。
- **功能页历史归档单层化**：`archiveRound()` 从 `.round-item > .round-item-hd + .round-item-bd > .p-ai` 双层卡套卡，改为生成【一张 `.p-ai.p-ai-archived`】——卡头 `.p-ai-head`=「历史 · 问题」（点按折叠，复用已有 `.p-ai-archived` CSS 的 `::after` 展开回看/收起），卡体 `.p-ai-body`=解读正文 + 追问链（盘面摘要并入 `.pf-arch-fact` 引用块）。与新提问解读卡完全同构，杜绝嵌套。`findAnswered` 用 `dataset.archQ`/`.p-ai-archived`，`revealAnswered` 切 `p-ai-open`；删除旧 `.round-item-hd` 点击委托。旧 `.round-item*` CSS 已清。
- **会话快照（reload 后提问不丢）**：纯 hash 切页 DOM 本就保留（实测 1→1），但 reload 后解读卡丢失（盘面靠 chart 缓存恢复）。新增 `saveStageSnap(feat)`（在 streamToUrl finish 后把结果区+归档区 innerHTML 存 sessionStorage，key 按 uid 隔离）、`restoreStageSnap(feat)`（navigate render 后恢复，命盘类等异步排盘落地再恢复）、`clearAllSnaps()`（退出登录清）。追问框改 `bindFollowBar(card)` 可重绑（card.dataset.hid + dataset.bound 防重复），`rebindFollows()` 供恢复后重绑。

### 7.11 占卜类起卦/抽牌纳入「所问之事」变量（v93）
- **设计原则**：占卜类（梅花/塔罗）的确定性计算层（calc）此前完全不带问题——问题只在 deduce 阶段进 prompt。v93 让**所问之事作为变量之一**参与成卦/抽牌，但**不是唯一决定因素**：问题与「当下时刻 + 系统随机源」共同成卦，同一问题在不同时刻起卦/抽牌仍会得到不同结果，保留占卜的机缘感与随机性。（曾误做成「问题唯一决定」的确定性种子，被纠正：问题只是并列变量。）
- **梅花**：`meihua.derive(..., question=)` 的 `random` 分支用 `sha256(问题|time_ns|random.getrandbits(64))` 派生 num1/num2，steps 写明「依所问之事…并参合当下机缘起数」。`time/number/manual` 三种传统起卦方式不受影响，问题不参与。derive 返回值新增 `num1/num2`。**时间起卦保持传统算法不动**。
- **塔罗**：`tarot.question_seed(q)` 用 `sha256(问题|time_ns|random.getrandbits(64))` 的前 8 字节作 int 种子，`_calc_tarot` 调 `tarot.draw(spread, seed=question_seed(q))`。`draw(seed=)` 与 `cards_from_deck()` 机制复用。
- **黄历**：不改（择日类，问题不参与「起卦/抽牌」，无对应动作）。
- **一致性（关键）**：calc 与 deduce 是两次独立调用，若都按「问题+时刻+随机」重算会得到两副不同的卦/牌。锁定方案：
  - 梅花：前端 calc 拿到 `d.upper.name/d.lower.name/d.moving` 后，deduce 改传 `method=manual&upper=&lower=&moving=`（manual 分支从三元组重建的本卦/互卦/变卦/六爻/fact/rag_query 与 calc 完全一致，已 E2E 验证 fact+rag_query 全等）。
  - 塔罗：沿用既有 `deck`（slug|正逆位串）回传，`cards_from_deck()` 覆盖随机抽牌。
  - 因此「用户看到的卦/牌 == AI 解读的卦/牌」，追问也复用同一副。
- **前端**：梅花 `castMeihua`/塔罗 `drawTarot` 的 calc fetch 追加 `&question=问题`；文案改为「结合所问之事与当下机缘」并明确「同一问题每次也可能不同」。版本号 v93。
- **参数链路**：calc/deduce 工厂的 `params` 统一带 `question`（deduce 用 q→question），compute_fn 从 `p["question"]` 读取。
