# 命理工作台 Destiny Master

八字 / 紫微斗数 / 八字合婚 / 紫微合婚 / 梅花易数 / 六爻 / 奇门遁甲 / 塔罗 / 占星命盘 / 老黄历 十功能命理平台：登录后共用出生档案，所有功能共享历史记录与个性化 AI 解读（RAG）。

## 文档导引

- 项目功能、接口、架构与知识库说明见本文。
- 前端设计系统、组件契约与防重复修改规范见 `FRONTEND_DESIGN.md`。
- 模块边界、开发与版本流程见 `SOFTWARE_ENGINEERING.md`。
- 各功能实现细节与引擎映射见 `IMPLEMENTATION.md`。
- 版本变更记录见 `CHANGELOG.md`。

## 架构

```
浏览器（单页门户）
  │  HTTP
  ▼
Web 层  web/index.html + portal.js + portal.css
  │  hash 路由 + SSE 流式解读
  ▼
FastAPI  server/
  ├─ main.py          档案、紫微排盘/运限数据层、紫微 AI 推演入口
  ├─ feature_api.py   兼容门面（对外 router / _with_disclaimer）
  ├─ features/        十一功能分层 API：公共能力 / 上下文 / 计算 / 路由 / 历史记忆
  ├─ 各功能引擎       bazi / marriage / ziwei / meihua / liuyao / qimen / tarot / astrology / huangli
  ├─ ai.py            prompt 装配 + 统一流式输出 + 免责
  └─ rag_kb.py / rag  知识库检索
  ▼
SQLite  用户档案 + 全功能历史（含追问链）
```

### 统一 AI 链路（十一功能同构）

十一类功能共用同一条 AI 推演与追问链路，差异只在「确定性计算」与「专属 prompt 规则」：

- **计算层（各功能特有）**：八字/梅花/塔罗/占星/黄历等走 `features/feature_routes.py` 的 `calc` 工厂（占星由 `astrology.py` 用 pyswisseph 计算完整本命盘，需出生地经纬度）；紫微保留 `/api/chart` 排盘数据层（命盘是有状态的大对象）。
- **prompt 层**：`ai.build_prompt`（五功能通用铁律 + `FEATURE_GUIDES` 专属规则）；紫微走 `ai.prepare_ziwei` + `ai.build_ziwei_prompt`（`prompt.py` 维护大限/流年/历法对齐法则）——两者都由 `ai.py` 统一导出。
- **流与落盘**：全部经 `ai.stream_answer` 流式输出，`features.common.with_disclaimer` 统一附加免责，落盘到 `feature_history`（带 `hid`）。
- **追问层**：全部经 `/api/history/followup`，用落盘 payload 重建盘面事实，无需内存会话。
- **RAG**：八字/梅花/塔罗/占星/黄历用 `rag_kb`（FateMaster + zhouyi.cc + 占星通识语料）；紫微用 `rag`（iztro-learn 语料）。
- **个人约束注入**：梅花解卦**强制**引入档案八字（未补全出生信息则拦截并引导补全）；塔罗可勾选「结合我的太阳星座」（由档案生日换算）。注入文本存进 payload，追问时原样复用，保证前后口径一致；开关状态纳入去重 key。

**命盘类登录态（八字 / 紫微 / 占星）**：登录后以个人档案出生信息为唯一数据源，进入页面即用档案自动排盘并收起填写表单，结果标题标注「已使用档案中的出生信息」并就地提供「修改出生信息」入口；结果区直接提问（盘面卡 / 提问卡 / AI 解读三段平级）。**出生信息不变则复用 sessionStorage 缓存、不重复请求排盘**（`bz-chart-v1` / `zw-chart-v1` / `as-chart-v1`），仅当档案出生信息被修改（`profileBirthChanged`）才清缓存重排。占星「修改出生信息」写回档案后同样触发清缓存重排。紫微缓存的盘 id 若因服务重启失效，运限请求失败时会自动重排一次。

**占卜类（梅花 / 塔罗 / 黄历）**：不自带命盘，进入时在表单顶部以统一的绿色提示框说明「将自动结合档案八字 / 太阳星座」（未登录为 warn 提示），导入个人信息后提问；该提示框在所有占卜页位置一致（表单第一个子元素）。未登录用户则需在占星等命盘页临时填写出生信息（共用档案表单 + 三级地址）。

紫微为站内原生渲染（固定正方形 4×4 命盘，无 iframe），直接消费 `/api/chart` + `/api/horoscope`，与八字、塔罗等共用同一套门户外壳与 AI 推演通道。

## 功能一览

入口按五类分组：八字命理（八字排盘 → 八字合婚）、紫微斗数（紫微 → 紫微合婚）、周易占卜（梅花 / 六爻 / 奇门）、西方占卜（占星 → 塔罗）、其他（老黄历）。

| 功能 | 入口 | 说明 |
| --- | --- | --- |
| 首页 | `#/home`（默认） | 落地页：十功能入口卡片按五类分组，点击品牌区（∞ + Destiny Master）随时返回 |
| 八字排盘 | `#/bazi` | 四柱 + 十神 + 藏干 + 五行 + 神煞 + 大运 + 流年；大运/流年可点选后直接提问；支持阳历/农历、日期/四柱反查 |
| 八字合婚 | `#/bazi_marriage` | 双方四柱排盘 + 跨盘对照，只给可核对论据不给分数；生成双人盘后可独立提问 |
| 紫微斗数 | `#/ziwei` | 本命/大限/流年三视图，星曜竖写、四化标注、点宫位就该宫提问；手机端纵向宫位列表 |
| 紫微合婚 | `#/ziwei_marriage` | 双方命盘 + 跨盘对照，只给关系论据不给分数；生成双人盘后可独立提问 |
| 梅花易数 | `#/meihua` | 时间/数字/手动起卦；本卦 + 互卦 + 变卦与动爻；解卦强制结合档案八字命局（缺出生时间引导补全）；手动改爻实时预览卦象 |
| 六爻 | `#/liuyao` | 铜钱/时间/数字/随机/手动起卦；本卦变卦、纳甲、六亲六神、世应、月建日辰旬空；实线爻象绘制 |
| 奇门遁甲 | `#/qimen` | 时家转盘，拆补/置闰双定局；九宫九星八门八神、旬空驿马门迫击刑入墓；年命/用神/起局时间为可选开关（只改解读焦点不改定局） |
| 塔罗 | `#/tarot` | 三张 / 凯尔特十字；正逆位解读前锁定，必须先写问题再抽牌；可勾选结合太阳星座 |
| 占星命盘 | `#/astrology` | 完整本命盘（日月上升中天 + 十大行星 + 十二宫 + 相位 + 元素），出生资料与档案共用；登录用户只读档案卡、可就地修改 |
| 老黄历 | `#/huangli` | 月历 + 当日历注（宜忌/神煞/星历物候），含「个人今日运势」与「双人择日」两个子 tab |
| 个人中心 | `#/profile` | 基本信息（出生日期/时间/出生地三级/性别）查看与编辑，与占星共用出生资料模板；按功能/日期筛选历史、展开回看追问链、批量与单条删除、个人记忆管理 |

### AI 解读与连续追问（全功能）

- **一个「问题」绑定一轮完整结果**：每次提问 = 确定性问题结果（塔罗牌面 / 梅花卦象 / 八字四柱 / 紫微命盘 / 占星本命盘 / 黄历历注）+ AI 解读 + 追问链，三者绑定为同一轮。追问沿用本轮的牌/卦/盘（后端用落盘 payload 重建，塔罗按 slug 精确取本轮牌义），可无限多轮。
- **换问题 = 重新开始**：塔罗/梅花须重新抽牌/起卦才生成新一轮（AI 解读按钮只在牌阵/卦象生成后出现）；占星换出生地/时间即新盘；八字/紫微/黄历盘固定，直接输入新问题点解读即归档旧轮并按新问题重解。旧的一整轮折叠归档到功能页，点「展开回看」可回看正文与追问链（归档轮已移除 AI 解读按钮/快捷问题，不会再拿旧牌解读新问题）。
- **模板问题跳转定位**：点快捷/模板问题会先填入输入框；若该问题在本会话已解读过（当前轮或归档轮），自动滚动展开那次对话并聚焦追问框，不重复解读。同一问题重复点解读也被拦下并定位到原对话，不再堆重复卡。各功能提问区结构统一为：确定性结果卡 → 独立提问卡 → AI 解读卡。
- **全功能追问都走同一条链路 `/api/history/followup`**：deduce 落盘后经 SSE 回传 `hid`，追问卡据此续问、追问结果再回传新 `hid` 形成对话链；prompt 带上此前解读要点保持结论一致。未登录不落盘、无追问条。
- 紫微的命盘事实在 deduce 时结构化存入历史 payload（`ziwei_data`），追问时据此重建 prompt，服务重启后历史追问仍可用。前端复用通用 `streamToUrl` 渲染与追问条。

### 出生档案（跨功能唯一数据源）

- 登录后各功能共用同一份出生信息：八字、紫微、黄历、占星均从档案带入，页面上提示来源。
- **出生信息与档案共用**：出生资料唯一来源是个人档案。占星**登录用户不显示填写表单**，只展示档案出生资料的只读卡（日期/时间/出生地 + 「修改出生信息」跳个人中心）；未登录用户才显示临时填写表单。个人中心「基本信息」编辑、未登录占星表单都复用同一套模板（`birthFieldsHTML` 的日期弹窗 + 时分下拉 + 「我知道出生时间」开关 + 三级出生地）。档案例外只有性别字段。
- **出生地三级联动同一行**：国家 / 省份 / 城市（`GEO_DATA`，中国 34 省级行政区的 300+ 主要地级市 + 14 个国家/地区，港澳台归入中国省级），三列在同一行、选中城市带出经纬度与时区；档案里没记录或列表未含城市时，也会保留原经纬度。港澳台按中国省级行政区处理。
- 在任一功能修改出生资料后重新排盘，新信息会**写回档案**（排盘请求带 `save=1`）；占星排盘后出生日期/时间/出生地一并同步，其它功能随之使用；普通排盘不会覆盖档案。
- 档案写入统一归一为公历与标准字段（`year/month/day/hour/minute/gender/know_time`，外加 `country/province/city/lat/lon/tz`），避免不同功能的排盘粒度互相覆盖。

## 目录结构

```
destiny-master/
├─ server/                 # FastAPI 后端
│  ├─ main.py              # 应用入口：档案、紫微排盘/运限数据层（推演统一在 features/feature_routes）
│  ├─ feature_api.py       # 兼容门面：router / _with_disclaimer
│  ├─ features/            # common / context / calculations / feature_routes / support_routes
│  ├─ astrology.py         # 占星本命盘（Swiss Ephemeris）
│  ├─ bazi.py              # 八字：四柱、大运、四柱反查
│  ├─ meihua.py            # 梅花：本卦 / 互卦 / 变卦
│  ├─ tarot.py             # 塔罗：牌阵与牌位
│  ├─ huangli.py           # 黄历：农历、二十八宿、神煞、物候
│  ├─ prompt.py / ai.py    # 提示词与统一 AI 解读层（SSE 流式）
│  ├─ rag_kb.py / profile.py / history.py
│  └─ ziwei.db             # SQLite（运行时生成）
├─ web/                    # 前端
│  ├─ index.html           # 站点根入口 = 门户（版本号在这里 bump）
│  ├─ portal.js / portal.css   # 门户逻辑与样式（八/紫微/梅花/塔罗/黄历）
│  └─ *.json               # 静态数据（塔罗牌义等）
├─ docs/kb/                # 知识库素材（RAG），按领域分目录
└─ tools/                  # 抓取/预处理脚本
```

### 移动端适配约定（≤700px / ≤900px 两档）

- **命盘**：桌面保持 4×4 固定方形（宫位按地支固定方位：巳午未申／辰·酉／卯·戌／寅丑子亥，中宫跨 2×2）；手机端 `display:flex` 改为纵向宫位列表，星曜由竖排改横排，宫位顺序用 `.zw-o-0…11` 类控制（**不要把 `order` 写进行内 style**，会打乱桌面网格的显式定位）。
- **输入框字号**：表单区输入 16px（防 iOS 聚焦缩放），结果区提问框（`.bz-ask/.zw-ask/.zw-d-ask`）用 14px 与卡片文字同级；iOS 聚焦缩放由 `portal.js` 里的 touchstart 临时提字号方案规避，不动 viewport 的 `maximum-scale`（保留无障碍缩放）。
- **横向滚动条**：命盘网格轨道必须写 `minmax(0, 1fr)`，否则宫格内容的最小宽度会把整页撑出横向滚动条。
- **滑动条描边**：大运/流年等横向滚动容器要同时给 `padding-left` 与 `scroll-padding-left`（≥9px），否则首卡 1px 外扩描边会被 `overflow-x` 裁掉。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/profile/register` `/login` | 注册 / 登录（返回 profile id + token） |
| GET | `/api/profile/get` | 读档案（含出生信息） |
| POST | `/api/profile/update` | 改档案：昵称 / 出生信息 / 口令（个人中心「基本信息」用） |
| GET | `/api/chart` | 紫微排盘（date / timeIndex / gender / calendar；`save=1` 才写回档案） |
| GET | `/api/horoscope` | 运限（大限、流年） |
| GET | `/api/{feature}/calc` | 各功能排盘：bazi / bazi_marriage / ziwei_marriage / meihua / liuyao / qimen / tarot / astrology / huangli（`save=1` 才写回档案）；占星额外传 lat/lon/tz/place + country/province/city，紫微用 `/api/chart` |
| GET | `/api/{feature}/deduce` | 全功能统一 AI 解读入口（紫微另有 `/api/deduce`），SSE 流式；登录用户落盘后回传 `{"hid": id}` 供追问。塔罗 `use_star=1` 注入档案星座，黄历 `use_bazi=1` 注入档案八字；梅花强制注入档案八字 |
| GET | `/api/history/followup` | 全功能统一追问：带 `id`(hid) + 问题，另存新记录并回传新 hid |
| GET | `/api/bazi/pillars_to_date` | 四柱反查公历日期 |
| GET | `/api/huangli/month` | 黄历月视图 |
| GET | `/api/history/list` `/detail` `/stats` | 历史列表 / 详情 / 统计 |
| GET | `/api/history/followup` | 历史追问（复用当次盘面继续问，回传新 `{"hid": id}` 支持多轮） |
| POST | `/api/history/delete` | 删除一条历史（body: profile_id + token + id，仅能删本人记录） |
| GET | `/api/kb/stats` | 各领域知识库篇数（运维探活） |

## 知识库（RAG 语料）

知识库素材按领域存于 `docs/kb/<domain>/`（frontmatter 含 title/source/slug/domain）。梅花含传统各家解卦，占星为人工撰写的星座/行星/宫位/相位/解盘指南。当前已入库 **628 篇 / 9 个领域**：

| 领域 | 篇数 | 领域 | 篇数 |
| --- | --- | --- | --- |
| bazi | 97 | qimen | 132 |
| ziwei | 89 | huangli | 30 |
| tarot | 78 | liuyao | 8 |
| meihua | 129 | fengshui | 1 |
| astrology | 17 | | |

> 梅花 129 篇含每卦卦辞/爻辞与多家解卦；另有 6ygua 学堂古籍 47 本（2252 章）按领域归入。占星 17 篇为人工撰写的文献依据。紫微另有 iztro 官方文档语料 21 篇（`docs/iztro-learn/`，供提示词参考）。

`server/rag_kb.py` 的 `DOMAIN_VOCAB` 覆盖上述九个领域的术语词表，`kb_stats()` 自动发现目录，新增领域无需改代码。

**召回要点（实测）**：各功能 deduce 用计算模块给出的 `rag_query` + `rag_extra` 检索。紫微走独立 `rag.retrieve`（命宫主星 + 生年四化作聚焦词）；八字/黄历走 `rag_kb.retrieve`（top5/1400）；梅花语料含爻辞+各家解卦，走 top10/3600 且传 `rag_primary_idx`（本卦序号）让 `rag_kb.retrieve(primary=…)` 按文件 stem 精确锁定本卦语料，压过上下卦，rag_query 含动爻标准爻称（初九/六二…）精确召回爻辞。塔罗不走模糊检索：`tarot.retrieve_excerpts` 按 slug 一牌一篇精确取文献，追问识别焦点牌置顶。塔罗牌数据 78 张、展示名「数字在前」（二宝剑）与语料名「花色在前」（宝剑二）经 `_kb_name` 映射。新增/修改语料后需同步到运行目录，并用 `/api/kb/stats` 核对篇数。

**召回要点（占星）**：占星走 `rag_kb.retrieve(top8/2800)`，由 `astrology.derive` 给出的 `rag_query`（日月上升星座 + 行星落座 + 主要相位）+ `rag_extra` 检索，召回太阳/月亮/上升三要素与各星座事业关系篇文献。

**Prompt 结构**：紫微独立（`prompt.py` 的 `SYSTEM_RULES`，自带免责声明）；八字/梅花/塔罗/占星/黄历共用 `ai.build_prompt` 的 5 条铁律 + `FEATURE_GUIDES` 各功能专属规则块。免责声明由系统统一附加（`features.common.with_disclaimer`，幂等），模型不再自行撰写；deduce/followup/缓存回放三条路径都带。
