# 项目实现说明

> 本文记录十功能的实现方式、引擎与接口映射、数据模型与关键机制，供接手者快速定位「某个功能在哪实现、走什么链路」。
> 功能的用户侧说明见 `README.md`；前端样式见 `FRONTEND_DESIGN.md`；后端工程约定见 `SOFTWARE_ENGINEERING.md`。

## 1. 功能 → 引擎 → 接口映射

| 功能 | 入口 hash | 确定性引擎 | calc / 排盘接口 | deduce 入口 | 语料 |
| --- | --- | --- | --- | --- | --- |
| 八字 | `#/bazi` | `server/bazi.py` | `/api/bazi/calc` | `/api/bazi/deduce` | rag_kb / bazi |
| 紫微 | `#/ziwei` | `server/chart.py`（py-iztro）+ `deduce.py` | `/api/chart` + `/api/horoscope` | `/api/deduce` | rag / iztro-learn |
| 八字合婚 | `#/bazi_marriage` | `server/marriage.py::bazi_marriage` | `/api/bazi_marriage/calc` | `/api/bazi_marriage/deduce` | rag_kb / bazi |
| 紫微合婚 | `#/ziwei_marriage` | `server/marriage.py::ziwei_marriage` | `/api/ziwei_marriage/calc` | `/api/ziwei_marriage/deduce` | rag / iztro-learn |
| 梅花 | `#/meihua` | `server/meihua.py` | `/api/meihua/calc` | `/api/meihua/deduce` | rag_kb / meihua |
| 六爻 | `#/liuyao` | `server/liuyao.py` | `/api/liuyao/calc` | `/api/liuyao/deduce` | rag_kb / liuyao |
| 奇门 | `#/qimen` | `server/qimen.py` | `/api/qimen/calc` | `/api/qimen/deduce` | rag_kb / qimen |
| 塔罗 | `#/tarot` | `server/tarot.py` | `/api/tarot/calc` | `/api/tarot/deduce` | tarot.retrieve_excerpts |
| 占星 | `#/astrology` | `server/astrology.py`（pyswisseph） | `/api/astrology/calc` | `/api/astrology/deduce` | rag_kb / astrology |
| 老黄历 | `#/huangli`（含 personal/pair 两 tab） | `server/huangli.py` | `/api/huangli/calc` + `/month` | `/api/huangli/deduce` | rag_kb / huangli |

合婚两种只给「可核对论据与关系结构」，不给匹配分数。黄历双人择日 `huangli_pair` 保留为后端端点/历史分类/AI 规则，入口合并进老黄历 tab。

## 2. 确定性引擎要点

- **八字**：四柱 + 十神 + 藏干 + 五行 + 神煞 + 大运 + 流年；支持阳历/农历、日期/四柱反查（`pillars_to_date`）。
- **紫微**（`chart.py`）：py-iztro 排盘，固定 4×4 命盘；大限/流年运限由 `horoscope_for` 按立春/节气界计算；命盘是有状态大对象存内存 `CHARTS`，id 索引。
- **合婚**（`marriage.py`）：双人四柱/命盘 + 跨盘对照；双方参数存 payload `_pair`。
- **梅花**（`meihua.py`）：时间/数字/手动/随机起卦，本卦+互卦+变卦+动爻；random 分支用 `sha256(问题|time_ns|random64)` 派生，问题为并列变量。
- **六爻**（`liuyao.py`）：coin/time/number/random/manual 五种起卦；京房八宫 64 卦程序化生成，世应/纳甲/六亲六神/旬空月建日辰/动变；`deck` 为 6 位 6/7/8/9 串。
- **奇门**（`qimen.py`）：时家转盘，24 节气×3 元局表；`method=chaibu`（交节即换）/ `zhirun`（符头为纲，正授/超神/接气，芒种大雪置闰）；地盘/值符值使/九星/八门/八神/旬空驿马门迫击刑入墓。局数星门只由定局表定，年命/用神/起局时间仅改解读焦点。
- **塔罗**（`tarot.py`）：78 张（大阿卡纳 22 + 四花色各 14），三张/凯尔特十字；正逆位在解读前锁定，`question_seed` 派生抽牌，`deck` 锁盘。
- **占星**（`astrology.py`）：pyswisseph 回归黄道 + Placidus 宫制（高纬回落整宫），日月上升中天 + 10 行星 + 12 宫 + 相位 + 元素；`sun_sign(月,日)` 纯查表供塔罗星座。`PLANET_MEANING`/`HOUSE_MEANING` 注入 payload meaning 字段。
- **黄历**（`huangli.py`）：农历、宜忌、二十八宿、神煞、物候；29 项字段（见 `DESIGN_REFERENCE.md` 第三章）。

## 3. 数据模型与链路

- **原子记录**：`feature_history` 一条 = 问题 + AI 解读 + 个人信息 + 追问链。`parent_id` 实现追问父子链（list/stats 只算顶层）；`get_detail()` 归一到 root 带 `followups[]`；删除连坐子记录。
- **落盘**：只在 deduce 经 `history.save` 落库（calc 从不）；payload 含 fact / 盘面 / 注入文本 `_injected`，追问据此重建，不依赖内存会话。
- **去重 key**：`_dedupe_key` = 问题 + 完整 payload；前端 rk = 问题 + 确定性盘面身份（塔罗 deck、梅花卦象、六爻 when+deck、奇门 method+局、黄历日期+双人、八字出生参数+scope、紫微 chart id、占星生日+时分+出生地）。严格相等才算同轮。
- **归档**：`archiveRound` 只归档含 `.p-ai` 的轮；双人合婚盘面/提问卡不被归档清空。
- **追问**：全部走 `/api/history/followup`，带 hid + 问题，prompt 带此前要点保持结论一致；未登录不落盘、无追问条。

## 4. 登录态与个人信息

- **命盘类（八字/紫微/占星）**：登录以档案 `profile.birth` 为唯一源，进页自动排盘、收起表单、三段平级（盘面/提问/AI）；sessionStorage `CHART_CACHE` 三 key（`bz-chart-v1`/`zw-chart-v1`/`as-chart-v1`），信息不变不重排，仅 `profileBirthChanged` 清缓存。占星「修改出生信息」就地展开写回。
- **占卜类（梅花/塔罗/黄历）**：不自带命盘，导入个人信息+提问，绿框 `.p-bazi-gate` 放表单首位。
- **约束注入**：梅花 deduce `_bazi_complete(pid)` 门禁缺出生信息则拒绝；塔罗 `#tr-star` → `use_star=1` 用 `astrology.sun_sign` 注入太阳星座；黄历 `use_bazi=1` 注入八字。注入文本存 payload，开关状态入去重 key。
- **个人化**：唯一来源 `personal_memory`（`memory.personalization_text()` → `history.personalization()` 注入所有 prompt）。自动画像 `user_profile` 链路已删除。

## 5. RAG 检索

- 八字/梅花/塔罗/占星/黄历/合婚用 `rag_kb`（docs/kb 九领域）；紫微用 `rag`（docs/iztro-learn）。
- 塔罗不走模糊检索：`tarot.retrieve_excerpts` 按 slug 一牌一篇精确取文献，追问按焦点牌置顶。
- 梅花按本卦序号 `rag_primary_idx` 精确锁本卦语料 + 动爻标准爻称召回爻辞；占星 top8/2800；八字/黄历 top5/1400。
- 语料共 628 篇 / 9 领域 + 6ygua 47 本 2252 章 + iztro-learn 21 篇。新增/修改后同步运行目录并用 `/api/kb/stats` 核对。

## 6. AI 链路与重启恢复

- 全部经 `ai.stream_answer` 流式 + `features.common.with_disclaimer` 系统免责 + 落 `feature_history` + followup；首轮与追问共用 `features.common.answer_events`。
- 紫微 deduce 无缓存命中时，若内存 `CHARTS` 因重启清空，用登录档案 birth 经 `_rebuild_session_from_profile` 确定性重建盘（无随机，必得同盘），再走 `ai.prepare_ziwei` → `build_ziwei_prompt` → 流式；失败时前端显示明确错误，不留空白卡。
- 前端 `streamToUrl` 检测响应 content-type：非 `text/event-stream` 的 JSON 错误直接显示 `error` 文字。
