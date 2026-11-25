"""把命盘 JSON 压缩为 LLM 可读的文本摘要，并生成紫微推演提示词。

流年/大限推断法则参考传统文献：
- 《紫微斗数全书》（明·罗洪先校订，陈希夷相传）
- 陆斌兆《紫微斗数讲义》
- 王亭之《中州派紫微斗数》（三合派方法论，重三方四正与四化引动）

星曜/宫位/四化的现代释义知识库已存于 docs/iztro-learn/（iztro 官方文档 learn 板块），
推演时通过 rag.py 检索相关小节摘录注入 prompt（见 build_prompt 的【知识库摘录】段）。
"""
from __future__ import annotations

import rag
from applog import log

MUTAGEN_ORDER = ["禄", "权", "科", "忌"]
BRANCH_ORDER = ["寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥", "子", "丑"]

# 需要在运限摘要中保留的流曜（其余杂曜略去，控制长度）
KEY_FLOW_STARS = {
    "流魁", "流钺", "流昌", "流曲", "流禄", "流羊", "流陀", "流马",
    "流鸾", "流喜", "流刑", "流忌", "运魁", "运钺", "运昌", "运曲",
    "运禄", "运羊", "运陀", "运马", "运鸾", "运喜", "运刑", "运忌",
    "月魁", "月钺", "月昌", "月曲", "月禄", "月羊", "月陀", "月马",
    "月鸾", "月喜", "月刑", "月忌",
}


def _fmt_star(s: dict) -> str:
    t = s.get("name", "")
    b = s.get("brightness")
    m = s.get("mutagen")
    if b and b != "":
        t += f"({b})"
    if m:
        t += f"[{m}]"
    return t


def _palace_line(p: dict, birth_year: int | None = None) -> str:
    stars_m = [_fmt_star(s) for s in p.get("majorStars", [])]
    stars_mi = [s.get("name", "") for s in p.get("minorStars", [])]
    adj = [s.get("name", "") for s in p.get("adjectiveStars", [])][:8]
    body = "身宫" if p.get("isBodyPalace") else ""
    origin = "来因" if p.get("isOriginalPalace") else ""
    dec = p.get("decadal") or {}
    rng = ""
    if dec and dec.get("range"):
        a, b = dec["range"]
        if birth_year:
            rng = f"大限{a}-{b}（虚岁，约公历{birth_year + a - 1}-{birth_year + b - 1}年）"
        else:
            rng = f"大限{a}-{b}（虚岁）"
    parts = [
        f"{p.get('name','')}{body}{origin} [{p.get('heavenlyStem','')}{p.get('earthlyBranch','')}]",
        "主星: " + ("、".join(stars_m) if stars_m else "无主星(借对宫)"),
    ]
    if stars_mi:
        parts.append("辅煞: " + "、".join(stars_mi))
    if adj:
        parts.append("杂曜: " + "、".join(adj))
    if rng:
        parts.append(rng)
    return " | ".join(parts)


def birth_mutagen_line(chart: dict) -> str:
    """生年四化：从盘面星曜的 mutagen 徽标提取。"""
    found = {}
    for p in chart.get("palaces", []):
        for s in (p.get("majorStars") or []) + (p.get("minorStars") or []):
            m = s.get("mutagen")
            if m and m not in found:
                found[m] = f"{s['name']}(落{p.get('name','')})"
    if not found:
        return "未标注"
    return "，".join(f"{m}化{found[m]}" for m in MUTAGEN_ORDER if m in found)


def chart_rag_terms(chart: dict) -> list[str]:
    """盘面上下文检索词：命宫主星 + 生年四化星名——让每次推演的 RAG 都贴合此盘。"""
    terms: list[str] = []
    for p in chart.get("palaces", []):
        if p.get("name") == "命宫":
            terms += [s["name"] for s in (p.get("majorStars") or [])][:3]
    for p in chart.get("palaces", []):
        for s in (p.get("majorStars") or []) + (p.get("minorStars") or []):
            m = s.get("mutagen")
            if m and s["name"] not in terms:
                terms.append(s["name"])
    return terms[:6]


def _mutagen_text(mut) -> str:
    if isinstance(mut, dict):
        return "，".join(f"{v}化{k}" for k, v in mut.items())
    if isinstance(mut, list) and mut:
        return "，".join(f"{v}化{m}" for m, v in zip(MUTAGEN_ORDER, mut))
    return ""


def _mutagen_str(h: dict) -> str:
    mut = _mutagen_text(h.get("mutagen"))
    return f"四化[{mut}]" if mut else ""


def _range_str(h: dict) -> str:
    sr = h.get("solarRange")
    if not sr:
        return ""
    return f"公历区间[{sr[0]}~{sr[1]}]"


def _level_line(label: str, h: dict, with_palaces: bool = False,
                with_stars: bool = False) -> str:
    if not h:
        return ""
    idx = h.get("index")
    pos = BRANCH_ORDER[idx % 12] if isinstance(idx, int) else "?"
    bits = [f"{label}：{h.get('heavenlyStem','')}{h.get('earthlyBranch','')}（命宫在{pos}）",
            _mutagen_str(h)]
    mut_bits = [b for b in bits[1:] if b]
    bits = [bits[0]] + mut_bits
    if h.get("jieName") or h.get("lunarMonthLabel"):
        meta = []
        if h.get("jieName"):
            meta.append(f"{h['jieName']}起{h.get('branch','')}月")
        if h.get("lunarMonthLabel"):
            meta.append(h["lunarMonthLabel"])
        bits.append("（" + "，".join(meta) + "）")
    rs = _range_str(h)
    if rs:
        bits.append(rs)
    if with_palaces:
        pn = h.get("palaceNames") or []
        key_names = ["命宫", "财帛", "官禄", "夫妻", "迁移", "福德", "田宅"]
        mapping = []
        for bi, name in enumerate(pn):
            if name in key_names:
                mapping.append(f"{name}={BRANCH_ORDER[bi % 12]}")
        if mapping:
            bits.append("十二宫位[" + "，".join(mapping) + "]")
    if with_stars:
        stars = h.get("stars") or []
        flow = []
        for bi, arr in enumerate(stars):
            names = [s.get("name", "") for s in (arr or []) if s.get("name") in KEY_FLOW_STARS]
            if names:
                flow.append(f"{BRANCH_ORDER[bi % 12]}宫:" + "、".join(names))
        if flow:
            bits.append("流曜[" + "；".join(flow) + "]")
    return "；".join(bits)


def _decadal_range_str(h: dict) -> str:
    r = (h or {}).get("range") or {}
    ages, sr = r.get("ages"), r.get("solarRange")
    if not ages:
        return ""
    s = f"岁数{ages[0]}-{ages[1]}（虚岁）"
    if sr:
        s += f"，约公历{sr[0]}-{sr[1]}年"
    return s


def horoscope_digest(horo: dict, full: bool = False) -> str:
    """运限摘要。full=True 时包含宫位映射与流曜（用于指定年份的深推）。

    历法口径：流年立春界（yearly.solarRange）、流月节气界（monthly.solarRange）、
    大限虚岁（decadal.range.ages/solarRange）、年初尾盘（yearlyTail）。
    """
    if not horo:
        return "暂无运限数据"
    lines = []
    dec_h = horo.get("decadal") or {}
    dec = _level_line("大限", dec_h, with_palaces=full, with_stars=full)
    dr = _decadal_range_str(dec_h)
    if dr:
        dec += f"；{dr}"
    if dec:
        lines.append(dec)
    yr_h = horo.get("yearly") or {}
    yr = _level_line("流年", yr_h, with_palaces=full, with_stars=full)
    if yr:
        if not _range_str(yr_h):
            yr += "；公历区间未知"
        lines.append(yr)
    tail = horo.get("yearlyTail")
    if tail and tail.get("index") is not None:
        tr = tail.get("tailRange") or []
        tpos = BRANCH_ORDER[tail["index"] % 12]
        bits = [f"流年尾盘：{tail.get('heavenlyStem','')}{tail.get('earthlyBranch','')}"
                f"（流年命宫在{tpos}）", _mutagen_str(tail)]
        if tr:
            bits.append(f"适用公历[{tr[0]}~{tr[1]}]（该段仍属上一流年）")
        lines.append("；".join(b for b in bits if b))
    mo = _level_line("流月", horo.get("monthly") or {}, with_palaces=full, with_stars=full)
    if mo:
        lines.append(mo)
    mo_alt = horo.get("monthlyAlt")
    if mo_alt:
        alt = _level_line("流月（次月段）", mo_alt, with_palaces=full, with_stars=full)
        if alt:
            lines.append(alt)
    return "\n".join(lines)


def chart_digest(chart: dict) -> str:
    lines = []
    lines.append(
        f"阳历 {chart.get('solarDate')} | 农历 {chart.get('lunarDate')} | "
        f"四柱 {chart.get('chineseDate')} | {chart.get('time')} ({chart.get('timeRange')}) | "
        f"{chart.get('gender')} | 生肖{chart.get('zodiac')} | {chart.get('sign')}"
    )
    lines.append(
        f"命宫地支 {chart.get('earthlyBranchOfSoulPalace')} | 身宫地支 {chart.get('earthlyBranchOfBodyPalace')} | "
        f"命主 {chart.get('soul')} | 身主 {chart.get('body')} | 五行局 {chart.get('fiveElementsClass')}"
    )
    lines.append("【生年四化】" + birth_mutagen_line(chart))
    birth_year = None
    try:
        birth_year = int(str(chart.get("solarDate", "")).split("-")[0])
    except Exception:
        log.warning("紫微出生年解析失败（solarDate=%r），大限岁数标注可能缺省",
                    chart.get("solarDate"), exc_info=True)
    lines.append("【十二宫（按地支序，寅起；大限岁数均为虚岁）】")
    for p in sorted(chart.get("palaces", []), key=lambda x: x.get("index", 0)):
        lines.append("- " + _palace_line(p, birth_year))
    lines.append("【当前运限（今日）】\n" + horoscope_digest(chart.get("horoscope") or {}))
    return "\n".join(lines)


SYSTEM_RULES = (
    "你是一位精通紫微斗数的资深命理师（南派三合打法为主，兼参四化飞星），"
    "同时具备冷静、现代的表达风格。你将收到一份由排盘程序生成的结构化命盘数据"
    "（十二宫星曜、亮度、四化、大限、流年、流月、流曜）以及用户的提问。\n\n"
    "【本命推演方法论】\n"
    "1. 严格基于给出的命盘数据推演，引用宫位、星曜、亮度、四化必须与数据一致，禁止编造盘面不存在的星曜或宫位。\n"
    "2. 分析框架：先看命宫及三方四正（命宫、官禄、财帛、迁移）定格局与性格底色；"
    "再围绕用户问题锁定相关宫位（问事业看官禄宫+命宫+大限，问感情看夫妻宫+福德宫，"
    "问财运看财帛宫+田宅宫+父母宫），结合生年四化落宫与运限叠加判断吉凶与时机。\n"
    "3. 主体宫位法则（点名某宫≠只看该宫，最高优先级）：当用户点名或以某宫为主体提问"
    "（如「以财帛宫为主体」「就官禄宫提问」「某宫的特点/优势/如何改善」），该宫是论述的太极点与重心，"
    "绝不是唯一取数来源。必须围绕它做三方四正与四化的完整推演："
    "三方四正＝本宫＋对宫（地支序号+6）＋三合二宫（+4、+8，即地支三合局），四宫的星曜、亮度与会照须逐一引用；"
    "再叠加生年四化、大限四化、流年四化的落宫与飞化（禄权科忌飞入/飞出该宫及其三方四正）串联论断。"
    "禁止只罗列该宫本宫一两颗星就下结论，禁止出现「只看X宫」「仅看某宫」式的孤立解读。\n"
    "4. 主体宫须回到全局校验：任何主体宫的结论都要与命宫及整体格局互参——"
    "该宫三方四正所会星曜的庙旺落陷、煞吉、四化，须与命宫三方四正的底色比对；"
    "命宫/身宫/来因宫若牵动该宫须点明联动，不得把某宫从整张盘中割裂出来单解。\n\n"
    "【大限推断法则】（参考《紫微斗数全书》、王亭之《中州派紫微斗数》）\n"
    "1. 大限主十年祸福之骨架：以大限命宫及其三方四正所会本命星曜定此十年之基调（格局高低、重心所在）。\n"
    "2. 大限四化（由大限宫干起）引动本命盘：化禄落宫为十年进益之机，化权为变动掌权，化科为名声考成，"
    "化忌为十年之困与耗，须点明落于本命何宫、应何事类。\n"
    "3. 大限命宫叠本命何宫，则该宫事类为十年主题；并参大限三方会入之禄存、六吉、六煞多寡定顺逆。\n\n"
    "【流年推断法则】（太岁入卦法 + 四化引动 + 三叠盘论法）\n"
    "1. 流年以太岁所在地支宫位起流年命宫，逆布流年十二宫（兄弟、夫妻……）；"
    "先审流年命宫三方四正会入之星：本命星曜定本质，大限星曜定十年背景，流曜定当年引动。\n"
    "2. 流年四化由流年天干而起：化禄主机会进益，化权主变动掌权，化科主名声文书，化忌主阻滞是非；"
    "四化所落之宫即应事领域，须与本命宫位事类互参（如流忌入夫妻宫，感情必见考验）。\n"
    "3. 三叠盘论法：流年命宫叠本命何宫、又叠大限何宫，三宫事类交织为当年主题；"
    "吉凶以本命/大限/流年三层四化交叉引动判断——叠禄为吉上加吉，流年化忌遇生年忌成「双忌」凶应加重。\n"
    "4. 流曜吉凶：流魁流钺主贵人提携；流昌流曲利考试、文书、签约；流禄主财；"
    "流羊流陀主刑伤、阻隔、竞争；流马主出行变动；流鸾流喜主婚恋喜庆；流刑主官非词讼。\n"
    "5. 应期：化忌所入之宫及其冲宫（对宫）为应事之期；星曜庙旺吉力强、落陷减力；煞星会照多波折反复。\n"
    "6. 推断流年时须给出具体公历年份与月份区间作为应期，且必须按【历法对齐法则】表述。\n\n"
    "【历法对齐法则】（重要——时机判断的唯一口径，禁止自行换算）\n"
    "1. 数据中所有岁数（如大限范围、入限岁数）均为【虚岁】（出生即 1 岁）。各运限块已标注公历起讫"
    "（「公历区间[起~止]」「约公历某年-某年」），回答任何时机问题时必须直接引用这些公历区间，"
    "禁止凭干支或岁数自行推算公历年份。\n"
    "2. 流年以【立春】为界：例如丁未流年覆盖公历 2027-02-04 ~ 2028-02-03，与公历年、农历年均不重合。"
    "公历某年 1 月 1 日至立春前一日仍属【上一流年】管辖（数据中以「流年尾盘」给出其干支与区间）；"
    "论及公历年初的事件时，必须先核对尾盘区间，分别点名两段各属哪个流年。\n"
    "3. 流月以【节气】为界（如午月 = 芒种起~小暑前，未月 = 小暑起~立秋前），与农历月、公历月均不重合；"
    "流月块已标注节气名、农历月对照与公历区间。给出月份区间时以流月块的公历区间为准，可附注节气月名。\n"
    "4. 应期输出格式统一为：公历起讫区间 + 运限层级，"
    "如「应期：公历 2027-03 ~ 2027-08（丁未流年，卯月至未月）」。"
    "禁止只写干支、农历月或裸年份数字而不给公历区间。\n\n"
    "【输出要求】\n"
    "1. 输出使用 Markdown，结构：\n"
    "   - **一句话结论**（先给答案）\n"
    "   - **盘面依据**（逐条引用宫位与星曜证据）\n"
    "   - **时机与走势**（应期一律按【历法对齐法则】第 4 条格式给出公历区间与运限层级）\n"
    "   - **建议**（3 条以内，具体可执行）\n"
    "2. 表格规范（重要，直接影响阅读体验）：\n"
    "   - 并列对比信息（如大限/流年四化引动、各宫应事）必须使用标准 Markdown 表格语法（| 分隔 + 表头分隔行），禁止用空格或全角空格模拟表格对齐。\n"
    "   - 表格列数不超过 4 列；单元格内只写短语（如「太阴化禄｜官禄｜财企规划得禄」），不写长句，禁止在单元格内换行。\n"
    "   - 单元格内不要使用加粗以外的 Markdown 语法；更长的解释放在表格下方的普通段落或列表中展开。\n"
    "3. 吉凶并陈、格局之破须写实：盘面若有格局之破、限运之忌、煞忌冲会或落陷失辉，须与优势一样点明并给出具体宫位星曜四化依据，"
    "不得回避或淡化；同时避免夸大灾祸、堆砌凶兆。吉象与凶象各依盘面证据陈述，不以主观祝愿替代盘面判断，也不以宿命口吻渲染负面。\n"
    "4. 语气专业、克制、不说宿命论断语；涉及健康、婚姻重大决策时提醒理性对待。\n"
    "5. 不要自行撰写免责声明或「仅供参考」套话——免责说明由系统在正文之后统一附加，你只需输出推演正文。\n"
    "6. 如果用户追问，结合此前对话上下文继续作答，保持结论一致。"
)


def prepare_ziwei(chart: dict, question: str,
                  target_horo: dict | None = None, target_label: str = "",
                  focus_terms: list[str] | None = None) -> dict:
    """把命盘 + 目标运限 + RAG 检索结果压成可 JSON 化的 prompt 数据。

    返回 dict 会随历史 payload 落盘；追问时无需 chart 对象即可用 assemble_ziwei 重建 prompt，
    这样紫微的排盘会话（内存 CHARTS）与服务重启解耦——与四功能「payload 自带盘面事实」一致。
    """
    digest = chart_digest(chart)
    target = ""
    if target_horo:
        title = target_label or "用户选定的推演目标运限"
        target = f"【{title}】\n" + horoscope_digest(target_horo, full=True) + "\n\n"
    # 轻量 RAG：问题/聚焦词 + 盘面上下文词（命宫主星、生年四化星）一并检索。
    # 点名某宫为主体的提问必须补入方法论词，避免检索只命中该宫单宫词条而取不到三方四正/四化文献。
    extra = list(focus_terms or []) + chart_rag_terms(chart)
    if "为主体" in question or "主体" in question or "就" in question and "宫提问" in question:
        for method_term in ("三方四正", "四化", "对宫", "飞化"):
            if method_term not in extra:
                extra.append(method_term)
    kws = rag.keywords_from(question, extra=extra)
    kb = rag.retrieve(kws)
    kb_block = ""
    if kb:
        kb_block = ("【知识库摘录（星曜/宫位/格局释义，供引用增强解读；"
                    "若与盘面数据冲突，以盘面数据为准）】\n" + "\n\n".join(kb) + "\n\n")
    return {
        "digest": digest, "target": target, "kb_block": kb_block,
        "rag_query": " ".join(kws), "rag_extra": extra,
    }


def assemble_ziwei(data: dict, question: str, history: list | None = None,
                   profile_summary: str = "", user_profile: str = "") -> str:
    """纯文本装配：由 prepare_ziwei 产出的 data + 统一格式的历史/画像拼成 prompt。

    history 兼容两种形态：
    - 统一链路（feature_history）：[{'ts','question','answer'}]
    - 旧内存会话：[{'role','content'}]
    末尾不写免责声明——由 feature_api 在系统层统一附加（与四功能一致）。
    """
    digest = data.get("digest", "")
    target = data.get("target", "")
    kb_block = data.get("kb_block", "")
    # 用户选定流年/流月时，命盘数据末尾的「当前运限（今日）」与推演目标会冲突，
    # 模型容易按系统当前日期作答（选了 2027 还在讲丙午年）。此处明确目标运限的优先级。
    target_priority = ""
    if target:
        target_priority = (
            "【推演目标优先级（最高）】\n"
            "本轮只推演【推演目标】指定的年份/月份运限。命盘数据末尾的「当前运限（今日）」"
            "仅为排盘时的参考背景，禁止用它替代目标年份；回答中「今年/当年/流年」一律指目标年份。"
            "禁止读取系统当前日期、今日流年或今日流月推算应期；若【推演目标】未给出流月盘，"
            "就不要指定目标年份的具体流月区间，应期按已给出的流年/大限公历区间表述。\n\n"
        )
    profile_block = ""
    if user_profile:
        profile_block += (
            "【个人记忆（用户手动维护的自我认知，仅供参考；"
            "据此调整语气与关注点，不要在回复中复述或宣称记得这些）】\n"
            + user_profile[:800] + "\n\n"
        )
    if profile_summary:
        profile_block += (
            "【用户档案 · 既往推演摘要（更早轮次的结论沉淀，结论仍有效；"
            "与本轮话题相关时优先衔接，不要重复推演已下过的判断）】\n"
            + profile_summary[:1800] + "\n\n"
        )
    convo = ""
    if history:
        msgs = []
        for m in list(history)[-6:]:
            if "question" in m:  # 统一历史格式（question/answer）
                q = (m.get("question") or "").strip()
                a = (m.get("answer") or "").strip().replace("\n", " ")
                a = a[:1600] + ("…" if len(a) > 1600 else "")
                if q:
                    msgs.append(f"用户: {q}")
                if a:
                    msgs.append(f"命理师: {a}")
            else:  # 旧内存格式（role/content）
                role = "用户" if m.get("role") == "user" else "命理师"
                content = (m.get("content") or "")[:1600]
                if content:
                    msgs.append(f"{role}: {content}")
        if msgs:
            convo = (
                "【历史对话（同一位用户的连续咨询，必须延续上文的推演结论、口径与语气；"
                "用户说「继续／上面／刚才／那之前」即指此处内容，禁止当作全新提问重新推演）】\n"
                + "\n".join(msgs) + "\n\n"
            )
            if target:
                convo += ("注意：历史结论仅作背景；若历史推演的年份/运限与本轮【推演目标】不同，"
                          "时序与应期一律以本轮目标为准，不得把旧年份的判断套到新年份上。\n\n")
    return (
        f"{SYSTEM_RULES}\n\n"
        f"【命盘数据】\n{digest}\n\n"
        f"{target_priority}"
        f"{target}"
        f"{kb_block}"
        f"{profile_block}"
        f"{convo}"
        f"【用户问题】\n{question}\n\n"
        "请基于以上命盘数据完成推演。若涉及大限或流年，务必按【大限推断法则】与【流年推断法则】逐条对照盘面作答；"
        "若知识库摘录与所论星曜/宫位相关，引用其释义丰富解读（如星曜性格、宫位事类、格局成破），但不得编造摘录中不存在的论断。"
        "若存在历史对话，这是同一位用户的连续咨询：优先延续上文已给出的结论与判断，"
        "用户追问时在原有基础上深化（除非盘面明显矛盾，否则不要推翻或改口此前结论）。"
        "直接输出 Markdown 正文，不要输出与推演无关的任何内容。"
    )


def build_prompt(chart: dict, question: str, history: list,
                 target_horo: dict | None = None, target_label: str = "",
                 focus_terms: list[str] | None = None,
                 profile_summary: str = "", user_profile: str = "") -> str:
    """兼容旧调用：一步到位生成 prompt（新链路改用 prepare_ziwei + assemble_ziwei）。"""
    data = prepare_ziwei(chart, question, target_horo, target_label, focus_terms)
    return assemble_ziwei(data, question, history, profile_summary, user_profile)
