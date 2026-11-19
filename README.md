# 命理工作台 Destiny Master

八字 / 紫微斗数 / 梅花易数 / 塔罗 / 老黄历 五合一命理平台，在原有紫微应用基础上扩展为统一门户：登录后共用出生档案，五类功能共享历史记录与个性化 AI 解读（RAG）。

## 线上部署（示例）

> 生产环境的公网 IP、实例 ID、SSH 用户与部署路径均为私有信息，已用占位符代替；按自己的环境替换即可。

| 项目 | 值 |
| --- | --- |
| 访问入口 | `http://<YOUR_SERVER_IP>:8899/`（根路径直接是统一门户） |
| 服务器 | 任意 Linux 云主机（2C2G 起，Ubuntu），需 nginx + Python 3.10+ |
| 部署目录 | `/opt/ziwei`（代码 `/opt/ziwei/{server,web}`，虚拟环境 `/opt/ziwei/venv`） |

> 建议防火墙只放行 8899（反代）与 22（SSH），管理端口不下线；后端 uvicorn 仅监听内网 `127.0.0.1:8744`，不对外暴露。生产密钥（`CODEBUDDY_API_KEY`、管理员口令 `.adminkey`）均通过环境变量或服务器本地文件注入，**不在代码仓库中**。

## 架构

```
浏览器
  │  http://<YOUR_SERVER_IP>:8899/
  ▼
nginx（/etc/nginx/sites-enabled/ziwei，监听 0.0.0.0:8899）
  │  限速：/api/profile/ 1r/s 突发 5；/api/deduce SSE 10 次/分、同 IP 并发 2
  ▼
uvicorn  127.0.0.1:8744（systemd 服务 ziwei.service，仅内网监听，无防火墙规则）
  ├─ FastAPI  server/main.py      档案、紫微排盘/运限数据层、紫微 AI 推演入口（SSE）
  ├─ server/feature_api.py         八字/梅花/塔罗/黄历 calc+deduce、全功能统一 history/followup
  ├─ server/ai.py                  统一 prompt 入口（四功能通用 + 紫微专属规则）+ 统一流/免责
  └─ SQLite   /opt/ziwei/server/ziwei.db  用户档案 + 全功能历史（含紫微）
```

### 统一 AI 链路（五功能同构）

五类功能共用同一条 AI 推演与追问链路，差异只在「确定性计算」与「专属 prompt 规则」：

- **计算层（各功能特有）**：八字/梅花/塔罗/黄历走 `feature_api` 的 `calc` 工厂；紫微保留 `/api/chart` 排盘数据层（命盘是有状态的大对象）。
- **prompt 层**：`ai.build_prompt`（四功能通用铁律 + `FEATURE_GUIDES` 专属规则）；紫微走 `ai.prepare_ziwei` + `ai.build_ziwei_prompt`（`prompt.py` 维护大限/流年/历法对齐法则）——两者都由 `ai.py` 统一导出。
- **流与落盘**：全部经 `ai.stream_answer` 流式输出，`feature_api._with_disclaimer` 统一附加免责，落盘到 `feature_history`（带 `hid`）。
- **追问层**：全部经 `/api/history/followup`，用落盘 payload 重建盘面事实，无需内存会话。
- **RAG**：八字/梅花/塔罗/黄历用 `rag_kb`（FateMaster + zhouyi.cc 语料）；紫微用 `rag`（iztro-learn 语料）。

紫微命盘按出生信息缓存（sessionStorage），登录用户再次进入直接出盘、不再重新计算；`重新排盘` 会清掉缓存。缓存的盘 id 若因服务重启失效，运限请求失败时会自动重排一次。

紫微已改为站内原生渲染（固定正方形 4×4 命盘，无 iframe），直接消费 `/api/chart` + `/api/horoscope`，与八字、塔罗等共用同一套门户外壳与 AI 推演通道。原紫微应用前端保留在 `web/_legacy/ziwei.html`（静态资源仍在根路径，可按需回看），但站点默认入口、导航与视觉都已统一到门户。

## 功能一览

| 功能 | 入口 | 说明 |
| --- | --- | --- |
| 八字排盘 | `#/bazi` | 四柱 + 十神 + 藏干 + 五行 + 神煞 + 大运 + 流年；大运/流年可点选后直接提问；支持阳历/农历、日期/四柱反查 |
| 紫微斗数 | `#/ziwei` | 命格 / 本命 / 运势三视图；星曜竖写（主星加粗）、四化直接标在对应星曜下（生年实心 / 大限实心描金 / 流年描边）、运财·流命与大限数字同排、点宫位可就该宫提问、大限流年单行滑动选择；**本命盘命宫与运势盘运命统一为「淡金底 + 金色描边 + 宫名旁『命』标」**；**手机端命盘改为纵向宫位列表（十二宫逆时针），不再挤压星曜** |
| 梅花易数 | `#/meihua` | 时间起卦（此刻/指定时间）/ 手动起卦；本卦 + 互卦 + 变卦，动爻标注 |
| 塔罗 | `#/tarot` | 三张 / 凯尔特十字（十张）；十张牌阵左列、牌义右列并排；**牌义含「象征 + 代表」完整两行、带与牌面一致的序号角标，右栏与十字区等高并均匀铺满；权杖柱上下与十字齐平、保持 110:188 竖版比例**；必须先写问题再抽牌 |
| 老黄历 | `#/huangli` | 月历 + 当日历注面板、宜忌、神煞、星历物候；AI 择日答疑（可导入本人八字） |
| 个人中心 | `#/profile` | 基本信息（出生日期/时间/性别）查看与编辑、按功能筛选历史对话、展开回看、继续追问、**单条删除（两步确认）** |

### AI 解读与连续追问（全功能）

- **每处 AI 解读都支持继续追问**：八字、紫微、梅花、塔罗、黄历（紫微含主盘命格 + 宫位详情）的解读卡底部均有「就这次解读继续追问…」输入框，沿用本次盘面事实，可无限多轮。
- **五功能追问全部走同一条链路 `/api/history/followup`**：deduce 落盘后经 SSE 回传 `hid`，追问卡据此续问、追问结果再回传新 `hid` 形成对话链；prompt 带上此前解读要点保持结论一致。未登录不落盘、无追问条。
- 紫微的命盘事实在 deduce 时结构化存入历史 payload（`ziwei_data`），追问时据此重建 prompt，**不再依赖内存 chart 会话**——服务重启后历史追问仍可用，与其他功能行为一致。前端 `zwAsk` 与其他功能一样复用通用 `streamToUrl` 渲染与追问条。

### 出生档案（跨功能唯一数据源）

- 登录后各功能共用同一份出生信息：八字、紫微、黄历均从档案带入，页面上以「已使用档案中的出生信息 · 修改出生信息」提示来源。
- 在任一功能点「修改出生信息」后重新排盘，新信息会**写回档案**（排盘请求带 `save=1`），其它功能随之同步；普通排盘不会覆盖档案。
- 个人中心的「基本信息」可直接改生日/时辰/性别，改完即时生效。
- 档案写入统一归一为公历与标准字段（`year/month/day/hour/minute/gender/know_time`），避免不同功能的排盘粒度互相覆盖。

## 目录结构

```
ziwei-upgrade/
├─ server/                 # FastAPI 后端
│  ├─ main.py              # 应用入口：档案、紫微排盘/运限数据层、紫微推演入口
│  ├─ feature_api.py       # 四功能 calc/deduce + 全功能统一 history/followup 路由
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
│  ├─ portal.html          # 旧入口，仅做 302 跳转到 /
│  ├─ style.css / app.js   # 设计 token + 原紫微应用脚本（app.js 仅 _legacy 页面使用）
│  ├─ _legacy/ziwei.html   # 原紫微应用首页备份（未接入导航）
│  └─ *.json               # 静态数据（塔罗牌义等）
├─ docs/kb/                # 知识库素材（RAG），按领域分目录
└─ tools/                  # 抓取/预处理脚本
```

## 部署

代码在本机修改后推送到服务器，再重启服务：

```bash
cd ziwei-upgrade
# 1) 推送改动（按需选择文件）；<USER>@<YOUR_SERVER_IP> 换成自己的 SSH 凭据
scp web/index.html web/portal.js web/portal.css <USER>@<YOUR_SERVER_IP>:/opt/ziwei/web/
scp server/feature_api.py <USER>@<YOUR_SERVER_IP>:/opt/ziwei/server/
# 2) 重启后端
ssh <USER>@<YOUR_SERVER_IP> 'systemctl restart ziwei && systemctl is-active ziwei'
```

前端静态资源靠查询串做缓存失效，**改完 css/js 必须同步 bump 版本号**（`web/index.html` 里 `portal.css?v=` / `portal.js?v=`）。

### 移动端适配约定（≤700px / ≤900px 两档）

- **命盘**：桌面保持 4×4 固定方形（宫位按地支固定方位：巳午未申／辰·酉／卯·戌／寅丑子亥，中宫跨 2×2）；手机端 `display:flex` 改为纵向宫位列表，星曜由竖排改横排，宫位顺序用 `.zw-o-0…11` 类控制（**不要把 `order` 写进行内 style**，会打乱桌面网格的显式定位）。
- **输入框字号**：表单区输入 16px（防 iOS 聚焦缩放），结果区提问框（`.bz-ask/.zw-ask/.zw-d-ask`）用 14px 与卡片文字同级；iOS 聚焦缩放由 `portal.js` 里的 touchstart 临时提字号方案规避，不动 viewport 的 `maximum-scale`（保留无障碍缩放）。
- **横向滚动条**：命盘网格轨道必须写 `minmax(0, 1fr)`，否则宫格内容的最小宽度会把整页撑出横向滚动条。
- **滑动条描边**：大运/流年等横向滚动容器要同时给 `padding-left` 与 `scroll-padding-left`（≥9px），否则首卡 1px 外扩描边会被 `overflow-x` 裁掉。

## 运维

```bash
systemctl status ziwei --no-pager      # 服务状态
journalctl -u ziwei -n 100 --no-pager  # 后端日志
tail -f /var/log/nginx/error.log       # nginx 日志
nginx -t && systemctl reload nginx     # 改完 nginx 配置先测再重载
cp /opt/ziwei/server/ziwei.db /root/ziwei.db.bak.$(date +%s)   # 备份数据库
```

测试账号清理（管理员口令在服务器 `/opt/ziwei/server/.adminkey`）：

```bash
curl -X POST http://127.0.0.1:8899/api/admin/delete \
  -H 'Content-Type: application/json' -H "x-admin-key: $(cat /opt/ziwei/server/.adminkey)" \
  -d '{"name":"测试账号昵称"}'
```

nginx 注意事项：站点配置在 `/etc/nginx/sites-enabled/`，**不要在该目录留 `.bak` 文件**——`include sites-enabled/*` 会把备份一起加载，导致旧端口继续监听；备份放 `sites-available/`。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/profile/register` `/login` | 注册 / 登录（返回 profile id + token） |
| GET | `/api/profile/get` | 读档案（含出生信息） |
| POST | `/api/profile/update` | 改档案：昵称 / 出生信息 / 口令（个人中心「基本信息」用） |
| GET | `/api/chart` | 紫微排盘（date / timeIndex / gender / calendar；`save=1` 才写回档案） |
| GET | `/api/horoscope` | 运限（大限、流年） |
| GET | `/api/{feature}/calc` | 四功能排盘：bazi / meihua / tarot / huangli（`save=1` 才写回档案）；紫微用 `/api/chart` |
| GET | `/api/{feature}/deduce` | 紫微 + 四功能统一 AI 解读入口，SSE 流式；登录用户落盘后回传 `{"hid": id}` 供追问 |
| GET | `/api/history/followup` | 全功能统一追问：带 `id`(hid) + 问题，另存新记录并回传新 hid |
| GET | `/api/bazi/pillars_to_date` | 四柱反查公历日期 |
| GET | `/api/huangli/month` | 黄历月视图 |
| GET | `/api/history/list` `/detail` `/stats` | 历史列表 / 详情 / 统计 |
| GET | `/api/history/followup` | 历史追问（复用当次盘面继续问，回传新 `{"hid": id}` 支持多轮） |
| POST | `/api/history/delete` | 删除一条历史（body: profile_id + token + id，仅能删本人记录） |
| GET | `/api/kb/stats` | 各领域知识库篇数（运维探活） |

## 已下线的旧服务

| 端口 | 原用途 | 处理 |
| --- | --- | --- |
| 8743 | 本门户旧入口 | nginx 站点删除该 listen，防火墙规则已删 |
| 8745 | FitCoach 健身记录 | nginx 站点软链移除，systemd 服务此前已停用，防火墙规则已删 |
| 8100 | 记账 App（静态页 + 8000 后端） | nginx 站点软链移除，后端 8000 早已停止，防火墙规则已删 |
| 8741 | K 线时光机（上游 8742） | nginx 站点软链移除，后端 8742 早已停止，防火墙规则已删 |

## 知识库（RAG 语料）

`tools/crawl_guides.py` 按子 sitemap 抓取 FateMaster `guides` 全部中文页面，按 slug 前缀分域写入 `docs/kb/<domain>/`（frontmatter 含 title/source/slug/domain）。梅花另从 zhouyi.cc 补充 64 篇传统各家解卦（见下）。当前已入库 **560 篇 / 8 个领域**：

| 领域 | 篇数 | 领域 | 篇数 |
| --- | --- | --- | --- |
| bazi | 97 | qimen | 132 |
| ziwei | 89 | huangli | 30 |
| tarot | 78 | liuyao | 4 |
| meihua | 129 | fengshui | 1 |

> 梅花 129 篇 = FateMaster 65（01–64.md 每卦含卦辞/**爻辞** + 总览）+ zhouyi.cc 64（zhouyi-01.md…zhouyi-64.md，含白话文解释 /《断易天机》/ 邵雍 / 傅佩荣 / 传统解卦的事业·经商·求名·婚恋·决策）。后者由 `/tmp/crawl_zhouyi.py` 抓取 `zhouyi.cc/zhouyi/yijing64/{4103..4263}.html`（URL 不连续、夹空页，按 title「周易第N卦」过滤）。

紫微另有 iztro 官方文档语料存于 `/opt/ziwei/docs/iztro-learn/`（21 篇，供提示词参考）。`server/rag_kb.py` 的 `DOMAIN_VOCAB` 覆盖上述八个领域的术语词表，`kb_stats()` 自动发现目录，新增领域无需改代码。

```bash
python3 tools/crawl_guides.py --only ziwei --workers 12   # 只补抓某一领域
python3 tools/crawl_guides.py --force --workers 12        # 全量重抓
```

> 源站响应慢（单页 5–20s，sitemap 可达数十秒），脚本用 curl 子进程 + 线程池并发；推送知识库后记得清掉 macOS 产生的 `._*` 元数据文件（`find /opt/ziwei/docs/kb -name "._*" -delete`），否则会被计入语料。

**召回要点（实测）**：各功能 deduce 用计算模块给出的 `rag_query` + `rag_extra` 检索。紫微走独立 `rag.retrieve`（命宫主星 + 生年四化作聚焦词）；八字/黄历走 `rag_kb.retrieve`（top5/1400）；梅花语料含爻辞+各家解卦，走 top10/3600 且传 `rag_primary_idx`（本卦序号）让 `rag_kb.retrieve(primary=…)` 按文件 stem 精确锁定本卦语料，压过上下卦，rag_query 含动爻标准爻称（初九/六二…）精确召回爻辞。塔罗不走模糊检索：`tarot.retrieve_excerpts` 按 slug 一牌一篇精确取文献，追问识别焦点牌置顶。塔罗牌数据 78 张、展示名「数字在前」（二宝剑）与语料名「花色在前」（宝剑二）经 `_kb_name` 映射。运行真源是线上 `/opt/ziwei/docs/kb`，本地 `docs/kb` 仅供开发参考、可能不全。

**Prompt 结构**：紫微独立（`prompt.py` 的 `SYSTEM_RULES`，自带免责声明）；八字/梅花/塔罗/黄历共用 `ai.build_prompt` 的 5 条铁律 + `FEATURE_GUIDES` 各功能专属规则块。免责声明由系统统一附加（`feature_api._with_disclaimer`，幂等），模型不再自行撰写；deduce/followup/缓存回放三条路径都带。

nginx 站点配置文件仍保留在 `/etc/nginx/sites-available/`（`ziwei`、`fitcoach`、`ledger8100`、`timetrader`），需要恢复时重新软链到 `sites-enabled/` 即可；防火墙规则也可在控制台或 CLI 重新添加。
