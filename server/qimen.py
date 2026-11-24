"""时家奇门·转盘(排宫)法排盘引擎：拆补法 / 置闰法两种定局口径，确定性计算。

算法口径：docs/kb/qimen/qimen-dunjia.md 的 7 步流程（四柱→定局→地盘→值符值使
→天盘→八门→八神），第 8 步为盘面标注（旬空/驿马/门迫/击刑/入墓）。

定局口径区别（可通过 method=chaibu / zhirun 切换，只影响局数，不改星门旋转规则）：
- 拆补法（默认）：节气为君，交节即换节气；三元由日柱最近符头判定，不置闰。
- 置闰法：符头为纲。以甲己符头与节气交接的先后判正授 / 超神 / 接气：
  符头先于节气为超神，节气先到为接气；超神满 9 日则「超用未来之气」（取下一节气
  同元局数），若恰在芒种 / 大雪则记为「闰奇」、重复本节气三元以校正历法偏差。
  问题文本不参与定局，同一时刻 + 同一口径必得同一盘。

定局表来源：《奇门遁甲统宗》卷一「阴阳二遁顺逆起例」，并与通行歌诀交叉核对：
  阳遁：冬至惊蛰一七四，小寒二八五，大寒春分三九六，立春八五二，雨水九六三，
        清明立夏四一七，谷雨小满五二八，芒种六三九。
  阴遁：夏至白露九三六，小暑八二五，大暑秋分七一四，立秋二五八，处暑一四七，
        寒露立冬六九三，霜降小雪五八二，大雪四七一。
（注：网络与任务草稿中流传的「处暑一七四/霜降六三九/立冬五二八/小雪四一七/
  大雪三九六」为传抄错位版本，其上元局数不符合阳顺阴逆的洛书递推，故不采用。）

四柱用 lunar_python 的 EightChar 并显式 setSect(1)（晚子时日柱换日、时柱随换日后
日干五鼠遁）；年柱以立春精确交接为界、月柱以节令交接为界。节气取 getPrevJieQi()
（严格早于用事时刻的最近交接点）以按精确交接时刻判定当前节气。所有计算不依赖
真太阳时校正、不依赖 question 文本，同一 when 必得同一盘。
"""
from __future__ import annotations

from datetime import datetime, timedelta

GAN = "甲乙丙丁戊己庚辛壬癸"
ZHI = "子丑寅卯辰巳午未申酉戌亥"
GANZHI60 = [GAN[i % 10] + ZHI[i % 12] for i in range(60)]

# 二十四节气 × 三元(上/中/下) 定局表，《奇门遁甲统宗》卷一口径（见模块 docstring）
JU_TABLE: dict[str, tuple[int, int, int]] = {
    # —— 阳遁：冬至 ~ 芒种 ——
    "冬至": (1, 7, 4), "小寒": (2, 8, 5), "大寒": (3, 9, 6),
    "立春": (8, 5, 2), "雨水": (9, 6, 3), "惊蛰": (1, 7, 4),
    "春分": (3, 9, 6), "清明": (4, 1, 7), "谷雨": (5, 2, 8),
    "立夏": (4, 1, 7), "小满": (5, 2, 8), "芒种": (6, 3, 9),
    # —— 阴遁：夏至 ~ 大雪 ——
    "夏至": (9, 3, 6), "小暑": (8, 2, 5), "大暑": (7, 1, 4),
    "立秋": (2, 5, 8), "处暑": (1, 4, 7), "白露": (9, 3, 6),
    "秋分": (7, 1, 4), "寒露": (6, 9, 3), "霜降": (5, 8, 2),
    "立冬": (6, 9, 3), "小雪": (5, 8, 2), "大雪": (4, 7, 1),
}
YANG_JIEQI = ("冬至", "小寒", "大寒", "立春", "雨水", "惊蛰",
              "春分", "清明", "谷雨", "立夏", "小满", "芒种")
YIN_JIEQI = ("夏至", "小暑", "大暑", "立秋", "处暑", "白露",
             "秋分", "寒露", "霜降", "立冬", "小雪", "大雪")
# lunar_python 跨年节气表键名偶见拼音，统一映射为中文名
JIEQI_ALIAS = {
    "DONG_ZHI": "冬至", "XIAO_HAN": "小寒", "DA_HAN": "大寒", "LI_CHUN": "立春",
    "YU_SHUI": "雨水", "JING_ZHE": "惊蛰", "CHUN_FEN": "春分", "QING_MING": "清明",
    "GU_YU": "谷雨", "LI_XIA": "立夏", "XIAO_MAN": "小满", "MANG_ZHONG": "芒种",
    "XIA_ZHI": "夏至", "XIAO_SHU": "小暑", "DA_SHU": "大暑", "LI_QIU": "立秋",
    "CHU_SHU": "处暑", "BAI_LU": "白露", "QIU_FEN": "秋分", "HAN_LU": "寒露",
    "SHUANG_JIANG": "霜降", "LI_DONG": "立冬", "XIAO_XUE": "小雪", "DA_XUE": "大雪",
}

# 九宫：宫号 → (宫名, 方位, 五行)
GONG_INFO = {
    1: ("坎一宫", "北", "水"), 2: ("坤二宫", "西南", "土"), 3: ("震三宫", "东", "木"),
    4: ("巽四宫", "东南", "木"), 5: ("中五宫", "中", "土"), 6: ("乾六宫", "西北", "金"),
    7: ("兑七宫", "西", "金"), 8: ("艮八宫", "东北", "土"), 9: ("离九宫", "南", "火"),
}
# 原始九星 / 八门（中宫星天禽、门死门寄坤二）
ORIG_STAR = {1: "天蓬", 2: "天芮", 3: "天冲", 4: "天辅", 5: "天禽",
             6: "天心", 7: "天柱", 8: "天任", 9: "天英"}
ORIG_DOOR = {1: "休门", 2: "死门", 3: "伤门", 4: "杜门", 5: "死门",
             6: "开门", 7: "惊门", 8: "生门", 9: "景门"}
# 外八宫环序（九星旋转 / 八门对齐 / 八神顺逆共用），方向为俯视顺时针
RING = [1, 8, 3, 4, 9, 2, 7, 6]  # 坎→艮→震→巽→离→坤→兑→乾
GODS = ("值符", "螣蛇", "太阴", "六合", "白虎", "玄武", "九地", "九天")
YI = "戊己庚辛壬癸"                      # 六甲遁六仪：甲子戊…甲寅癸
XUN_SHOU = ("甲子", "甲戌", "甲申", "甲午", "甲辰", "甲寅")
DI_PAN_ORDER = "戊己庚辛壬癸丁丙乙"        # 地盘三奇六仪排布顺序

# 地支寄宫（旬空/驿马用）
ZHI_GONG = {"子": 1, "丑": 8, "寅": 8, "卯": 3, "辰": 4, "巳": 4,
            "午": 9, "未": 2, "申": 2, "酉": 7, "戌": 6, "亥": 6}
# 门迫：门五行克宫五行
MEN_WUXING = {"休门": "水", "生门": "土", "伤门": "木", "杜门": "木", "景门": "火",
              "死门": "土", "惊门": "金", "开门": "金"}
KE = {"木": "土", "土": "水", "水": "火", "火": "金", "金": "木"}
# 六仪击刑：天盘仪落此宫即击刑（子卯刑/寅巳申三刑/辰午自刑/丑戌未三刑）
JIXING_GONG = {"戊": 3, "己": 2, "庚": 8, "辛": 9, "壬": 4, "癸": 4}
# 十干入墓：天盘干落此宫即入墓（甲乙木墓未、丙丁戊己火土墓戌、庚辛金墓丑、壬癸水墓辰）
RUMU_GONG = {"甲": 2, "乙": 2, "丙": 6, "丁": 6, "戊": 6, "己": 6,
             "庚": 8, "辛": 8, "壬": 4, "癸": 4}
# 驿马：以日支三合局定，取马所在地支
YIMA = {"寅午戌": "申", "申子辰": "寅", "巳酉丑": "亥", "亥卯未": "巳"}


def _sizhu(when: datetime) -> dict:
    """四柱：年柱立春界、月柱节令界、日柱晚子换日、时柱五鼠遁（setSect(1)）。"""
    from lunar_python import Solar
    lunar = Solar.fromYmdHms(when.year, when.month, when.day,
                             when.hour, when.minute, when.second).getLunar()
    ec = lunar.getEightChar()
    ec.setSect(1)  # 1=晚子时日柱换次日、时柱随换日后日干；lunar_python 默认 2（不换）
    return {"year": ec.getYear(), "month": ec.getMonth(),
            "day": ec.getDay(), "hour": ec.getTime()}


def _current_jieqi(when: datetime) -> str:
    """当前节气：取严格早于用事时刻的最近节气交接点，按精确交接时刻判定节气归属。"""
    from lunar_python import Solar
    lunar = Solar.fromYmdHms(when.year, when.month, when.day,
                             when.hour, when.minute, when.second).getLunar()
    name = lunar.getPrevJieQi().getName()
    return JIEQI_ALIAS.get(name, name)


def _futou_yuan(day_gz: str) -> tuple[str, str]:
    """由日柱干支找最近甲己符头，符头支定上中下元。"""
    idx = GANZHI60.index(day_gz)
    futou = GANZHI60[idx]  # fallback
    for k in range(5):     # 甲己符头每隔 5 日，前推至多 4 日必遇
        cand = GANZHI60[(idx - k) % 60]
        if cand[0] in "甲己":
            futou = cand
            break
    zhi = futou[1]
    yuan = "上元" if zhi in "子午卯酉" else ("中元" if zhi in "寅申巳亥" else "下元")
    return futou, yuan


JIEQI_ORDER = ("冬至", "小寒", "大寒", "立春", "雨水", "惊蛰", "春分", "清明",
               "谷雨", "立夏", "小满", "芒种", "夏至", "小暑", "大暑", "立秋",
               "处暑", "白露", "秋分", "寒露", "霜降", "立冬", "小雪", "大雪")


def _jieqi_boundary(when: datetime) -> tuple[str, datetime, str]:
    """当前节气名、精确交接时刻、下一节气名（跨年按 JIEQI_ORDER 回环）。"""
    from lunar_python import Solar
    lunar = Solar.fromYmdHms(when.year, when.month, when.day,
                             when.hour, when.minute, when.second).getLunar()
    jq = lunar.getPrevJieQi()
    name = JIEQI_ALIAS.get(jq.getName(), jq.getName())
    s = jq.getSolar()
    boundary = datetime(s.getYear(), s.getMonth(), s.getDay(),
                        s.getHour(), s.getMinute(), s.getSecond())
    nxt = JIEQI_ORDER[(JIEQI_ORDER.index(name) + 1) % 24] if name in JIEQI_ORDER else name
    return name, boundary, nxt


def _dipan(ju: int, yinyang: str) -> dict[int, str]:
    """排地盘：戊己庚辛壬癸丁丙乙，阳遁从局数宫顺飞九宫、阴遁逆飞。"""
    res: dict[int, str] = {}
    for i, gan in enumerate(DI_PAN_ORDER):
        offset = ju - 1 + i if yinyang == "阳遁" else ju - 1 - i
        res[((offset % 9) + 1)] = gan
    return res


def _xun(shi_gz: str) -> tuple[str, str, int, int]:
    """时柱所属旬：返回 (旬首干支, 遁仪, 时辰在旬内序数1-10, 旬序号0-5)。"""
    idx = GANZHI60.index(shi_gz)
    xun_idx = idx // 10
    return XUN_SHOU[xun_idx], YI[xun_idx], idx - xun_idx * 10 + 1, xun_idx


def _xunkong_gong(xun_shou: str) -> tuple[list[str], set[int]]:
    """旬空地支与落宫：甲子旬戌亥空、甲戌旬申酉空……（旬首支前两位）。"""
    z0 = ZHI.index(xun_shou[1])
    zhis = [ZHI[(z0 - 2) % 12], ZHI[(z0 - 1) % 12]]
    return zhis, {ZHI_GONG[z] for z in zhis}


def derive(when: datetime | None = None, method: str = "chaibu",
           question: str | None = None, year_na: int | None = None,
           yongshen: str | None = None) -> dict:
    """时家奇门转盘拆补法定局排盘。question 仅写入 meta，绝不参与定局或星门位置。
    year_na=求测人出生年（公历），用其年命地支标注落宫；yongshen=用神名称（如「开门」「财星」），
    二者只作解读焦点的盘面标注，绝不参与定局或星门位置。"""
    steps: list[str] = []
    when = when or datetime.now()
    if method not in ("chaibu", "zhirun"):
        raise ValueError(f"未知定局方式：{method}（目前仅支持 chaibu，zhirun 按拆补近似）")

    # 1 四柱
    sz = _sizhu(when)
    steps.append(
        f"步骤1 定四柱：{sz['year']}年 {sz['month']}月 {sz['day']}日 {sz['hour']}时"
        "（年柱立春交接为界、月柱节令交接为界、日柱23:00晚子换日、时柱五鼠遁）"
    )

    # 2 定局：拆补法以节气为君；置闰法以符头为纲，判正授/超神/接气/闰奇。
    jieqi = _current_jieqi(when)
    if jieqi not in JU_TABLE:
        raise ValueError(f"未能识别当前节气：{jieqi!r}，无法定局")
    futou, yuan = _futou_yuan(sz["day"])
    yuan_i = ("上元", "中元", "下元").index(yuan)
    ju_jieqi = jieqi          # 真正用于查定局表的节气（置闰超神时可转到下一节气）
    dingju_state = "节气定局"
    dingju_note = ""
    if method == "chaibu":
        ju = JU_TABLE[jieqi][yuan_i]
        steps.append(
            f"步骤2 拆补法定局：当前节气「{jieqi}」→{('阳遁' if jieqi in YANG_JIEQI else '阴遁')}；"
            f"日柱{sz['day']}最近符头{futou}（符头支{futou[1]}属{yuan}）；"
            f"查定局表得 {ju_jieqi}{yuan} {ju}局。节气优先，交节即换，不置闰。"
        )
    else:
        jq_now, boundary, jq_next = _jieqi_boundary(when)
        day_idx = GANZHI60.index(sz["day"])
        fu_idx = GANZHI60.index(futou)
        futou_date = when.date() - timedelta(days=(day_idx - fu_idx) % 60)
        lead = (boundary.date() - futou_date).days   # >0 符头先到（超神）；<0 节气先到（接气）
        since_jq = (when.date() - boundary.date()).days
        if lead == 0:
            dingju_state = "正授"
        elif lead > 0:
            dingju_state = "超神"
        else:
            dingju_state = "接气"
        # 超神接气以符头相对节气论；累计偏差用「交节后日数」判定（与开源置闰实现同口径）：
        # 交节满 9 日仍未完成换元 → 超用未来节气；芒种/大雪处改为重复三元（闰奇）。
        if since_jq >= 9:
            if jq_now in ("芒种", "大雪"):
                dingju_state = "闰奇"
                dingju_note = (
                    f"{jq_now}交接已过{since_jq}日，符头{futou}仍未对齐（超神累计），"
                    f"在{jq_now}处置闰，重复本节气上中下三元校正偏差"
                )
            else:
                ju_jieqi = jq_next
                dingju_note = (
                    f"{jq_now}交接已过{since_jq}日，符头{futou}仍未对齐（超神累计≥9日），"
                    f"超用未来节气「{jq_next}」同元局数"
                )
        elif lead < 0:
            dingju_note = (
                f"{jq_now}交接已过{-lead}日而符头{futou}未到（接气），"
                f"仍沿用本节气，待符头到位再换元"
            )
        yinyang = "阳遁" if ju_jieqi in YANG_JIEQI else "阴遁"
        ju = JU_TABLE[ju_jieqi][yuan_i]
        steps.append(
            f"步骤2 置闰法定局：当前节气「{jq_now}」交接于{boundary:%Y-%m-%d %H:%M}；"
            f"日柱{sz['day']}最近符头{futou}在{futou_date:%Y-%m-%d}（属{yuan}），"
            f"与节气相差{lead}日 → {dingju_state}。"
            + (dingju_note + "；" if dingju_note else "")
            + f"据「{ju_jieqi}」查定局表得 {yinyang}{ju}局。"
        )
    if ju_jieqi != jieqi:
        steps.append(f"口径提示：置闰法本局取下一节气「{ju_jieqi}」，与拆补法取「{jieqi}」不同。")
    yinyang = "阳遁" if ju_jieqi in YANG_JIEQI else "阴遁"

    # 3 排地盘
    dipan = _dipan(ju, yinyang)
    steps.append(
        "步骤3 排地盘：戊己庚辛壬癸丁丙乙按"
        f"{yinyang}从{ju}宫{'顺' if yinyang == '阳遁' else '逆'}飞九宫 → "
        + "、".join(f"{g}{dipan[g]}" for g in range(1, 10))
    )

    # 4 值符值使
    xun_shou, yi, shi_xu, xun_idx = _xun(sz["hour"])
    yi_gong = next(g for g, gan in dipan.items() if gan == yi)  # 旬首仪落宫
    zhi_fu = ORIG_STAR[yi_gong]      # 值符＝旬首仪落宫的原始星（落中宫为天禽）
    zhi_shi = ORIG_DOOR[yi_gong]     # 值使＝旬首仪落宫的原始门（落中宫为死门）
    steps.append(
        f"步骤4 定值符值使：时柱{sz['hour']}属{xun_shou}旬，旬首遁仪「{yi}」落地盘"
        f"{yi_gong}宫 → 值符「{zhi_fu}」、值使「{zhi_shi}」"
        + ("（中五寄坤二）" if yi_gong == 5 else "")
    )

    # 5 排天盘：值符随时干，九星按外八宫环序同步旋转；天禽随天芮并携中宫干
    shi_gan = sz["hour"][0]
    target_gan = yi if shi_gan == "甲" else shi_gan  # 时干为甲用旬首仪代替
    shi_gan_gong = next(g for g, gan in dipan.items() if gan == target_gan)
    zhi_fu_new = 2 if shi_gan_gong == 5 else shi_gan_gong  # 落中五寄坤二
    base_orig = 2 if yi_gong == 5 else yi_gong
    delta_star = RING.index(zhi_fu_new) - RING.index(base_orig)
    star_at: dict[int, str] = {}
    tian_gan_at: dict[int, str] = {}
    for orig in RING:
        new = RING[(RING.index(orig) + delta_star) % 8]
        star_at[new] = ORIG_STAR[orig]
        tian_gan_at[new] = dipan[orig]  # 天盘干随星走
    tianqin_gong = RING[(RING.index(2) + delta_star) % 8]  # 天芮新宫，天禽同宫
    zhong_gong_gan = dipan[5]                              # 中宫地盘干由天禽携带
    steps.append(
        f"步骤5 排天盘：时干{shi_gan}"
        + (f"甲遁{yi}" if shi_gan == "甲" else "")
        + f"落{shi_gan_gong}宫，值符「{zhi_fu}」移至{zhi_fu_new}宫；"
        f"九星按 {'→'.join(map(str, RING))} 同步旋转（偏移{delta_star}）；"
        f"天禽随天芮落{tianqin_gong}宫并携中宫干{zhong_gong_gan}"
    )

    # 6 排八门：值使随时支，自旬首宫按时辰旬内序数阳顺阴逆走九宫(含中宫)
    start = 2 if yi_gong == 5 else yi_gong
    step = shi_xu - 1
    target = ((start - 1 + (step if yinyang == "阳遁" else -step)) % 9) + 1
    if target == 5:
        target = 2  # 中宫寄坤二
    delta_door = RING.index(target) - RING.index(start)
    door_at: dict[int, str] = {}
    for orig in RING:
        new = RING[(RING.index(orig) + delta_door) % 8]
        door_at[new] = ORIG_DOOR[orig]
    steps.append(
        f"步骤6 排八门：值使「{zhi_shi}」自{start}宫起，{sz['hour'][1]}时旬内第{shi_xu}位"
        f"（走{step}步）{yinyang}{'顺' if yinyang == '阳遁' else '逆'}行至{target}宫；"
        "八门按休生伤杜景死惊开环序对齐"
    )

    # 7 排八神：自值符落宫起阳遁顺时针、阴遁逆时针
    god_at: dict[int, str] = {}
    sidx = RING.index(zhi_fu_new)
    for k, god in enumerate(GODS):
        pos = RING[(sidx + k) % 8] if yinyang == "阳遁" else RING[(sidx - k) % 8]
        god_at[pos] = god
    steps.append(
        f"步骤7 排八神：自值符落宫{zhi_fu_new}起，{yinyang}"
        f"{'顺' if yinyang == '阳遁' else '逆'}排 值符螣蛇太阴六合白虎玄武九地九天"
    )

    # 8 标注：旬空/驿马/门迫/击刑/入墓
    kong_zhi, kong_gong = _xunkong_gong(xun_shou)
    yima_group = next((k for k in YIMA if sz["day"][1] in k), None)
    yima_zhi = YIMA[yima_group] if yima_group else ""
    yima_gong = ZHI_GONG.get(yima_zhi)
    palaces: list[dict] = []
    for g in range(1, 10):
        name, direction, gong_wx = GONG_INFO[g]
        if g == 5:
            digan, tiangan, star, door, god = zhong_gong_gan, zhong_gong_gan, "天禽", "死门", "—"
        else:
            digan = dipan[g]
            tiangan = tian_gan_at.get(g, "—")
            star = star_at.get(g, "—")
            door = door_at.get(g, "—")
            god = god_at.get(g, "—")
        xk = g in kong_gong
        ym = bool(yima_gong and g == yima_gong)
        mp = bool(door and KE.get(MEN_WUXING.get(door, "")) == gong_wx)
        jx = bool(tiangan in JIXING_GONG and JIXING_GONG[tiangan] == g)
        rm = bool(tiangan in RUMU_GONG and RUMU_GONG[tiangan] == g)
        notes: list[str] = []
        if g == 5:
            notes.append(f"中五寄坤二，天禽随天芮落{tianqin_gong}宫")
        if star == "天芮":
            notes.append(f"天禽同宫，携中宫干{zhong_gong_gan}")
        if xk:
            notes.append(f"旬空({''.join(kong_zhi)})")
        if ym:
            notes.append(f"驿马({yima_zhi})")
        if mp:
            notes.append("门迫(门克宫)")
        if jx:
            notes.append("击刑")
        if rm:
            notes.append("入墓")
        palaces.append({
            "gong": g, "name": name, "dir": direction,
            "digan": digan, "tiangan": tiangan, "star": star, "door": door, "god": god,
            "xunkong": xk, "yima": ym, "menpo": mp, "jixing": jx, "rumu": rm,
            "note": "；".join(notes),
        })
    steps.append(
        "步骤8 盘面标注：旬空落" + "/".join(str(x) for x in sorted(kong_gong)) + "宫"
        + (f"；驿马({yima_zhi})落{yima_gong}宫" if yima_gong else "")
        + "；逐宫检查门迫(门克宫)、六仪击刑、十干入墓"
        + "（驿马以日支三合局定，击刑/入墓以天盘干论，旬空以时柱旬论）"
    )

    # 盘面事实文本：AI 唯一依据，风格参照 bazi.py 的 fact
    lines = [
        f"起局：{when.strftime('%Y-%m-%d %H:%M:%S')}　四柱：{sz['year']} {sz['month']} {sz['day']} {sz['hour']}（年 月 日 时）",
        f"节气：{jieqi}　定局口径：{'拆补法' if method == 'chaibu' else '置闰法'}"
        f"（{dingju_state}{'；' + dingju_note if dingju_note else ''}）　"
        f"取局节气：{ju_jieqi}　遁甲：{yinyang}{ju}局　三元：{yuan}　符头：{futou}",
        f"值符：{zhi_fu}（落{zhi_fu_new}宫）　值使：{zhi_shi}（落{target}宫）　旬首：{xun_shou}{yi}　时辰旬内第{shi_xu}位",
        "九宫盘（宫序1-9）：",
    ]
    for p in palaces:
        tags = []
        for key, label in (("xunkong", "旬空"), ("yima", "驿马"), ("menpo", "门迫"),
                           ("jixing", "击刑"), ("rumu", "入墓")):
            if p[key]:
                tags.append(label)
        lines.append(
            f"[{p['gong']}]{p['name']}({p['dir']}): "
            f"地盘{p['digan']} 天盘{p['tiangan']} 星{p['star']} 门{p['door']} 神{p['god']}"
            + (f" 标注:{'/'.join(tags)}" if tags else "")
            + (f" 注:{p['note']}" if p["note"] and not tags else "")
        )
    # 求测焦点标注（年命 / 用神）：只标注落宫供 AI 聚焦，不改盘面。
    focus: dict = {}
    if year_na:
        try:
            yn = int(year_na)
            year_gz = GANZHI60[(yn - 4) % 60]
            year_zhi = year_gz[1]
            # 地支寄宫（奇门通行口径）：子坎一 / 丑未坤二 / 寅艮八 / 卯震三 / 辰巽四 /
            # 巳午离九 / 申坤二 / 酉兑七 / 戌亥乾六。
            zhi_gong = dict(zip("子丑寅卯辰巳午未申酉戌亥",
                                [1, 2, 8, 3, 4, 9, 9, 2, 2, 7, 6, 6]))
            g = zhi_gong.get(year_zhi)
            gp = next((p for p in palaces if p["gong"] == g), None)
            focus["year_na"] = {"ganzhi": year_gz, "gong": g,
                                "palace": (gp or {}).get("name", ""),
                                "door": (gp or {}).get("door", ""),
                                "star": (gp or {}).get("star", "")}
            lines.append(
                f"求测人年命：{yn}年生，年命{year_gz}（地支{year_zhi}）寄"
                f"{str(g) + '宫' if g else '—'}"
                + (f"（{gp['name']}，门{gp['door']} 星{gp['star']}）" if gp else "")
                + "——为求测人自身的参照宫，AI 解读时应聚焦此宫与本宫的关系。"
            )
        except (ValueError, TypeError):
            pass
    if yongshen:
        ys = str(yongshen).strip()
        # 用神为可选项：按「所测之人 / 专项 / 指定八门 / 指定天干」把标签映射到实际落宫，
        # 只作解读焦点标注，绝不反过来改变局数或星门。
        cands: list[dict] = []
        basis = "字面"
        if "年干" in ys:
            cands = [p for p in palaces if p["digan"] == sz["year"][0] or p["tiangan"] == sz["year"][0]]
            basis = f"本局年干{sz['year'][0]}"
        elif "月干" in ys:
            cands = [p for p in palaces if p["digan"] == sz["month"][0] or p["tiangan"] == sz["month"][0]]
            basis = f"本局月干{sz['month'][0]}"
        elif "时干" in ys:
            cands = [p for p in palaces if p["digan"] == sz["hour"][0] or p["tiangan"] == sz["hour"][0]]
            basis = f"本局时干{sz['hour'][0]}"
        elif "丈夫" in ys or "庚" in ys and ys in GAN:
            cands = [p for p in palaces if p["tiangan"] == "庚"]
            basis = "天盘庚"
        elif "妻子" in ys or ys == "乙":
            cands = [p for p in palaces if p["tiangan"] == "乙"]
            basis = "天盘乙"
        elif "事业" in ys:
            cands = [p for p in palaces if p["door"] == "开门"]
            basis = "开门"
        elif "求财" in ys:
            cands = [p for p in palaces if p["door"] == "生门" or p["tiangan"] == "戊" or p["digan"] == "戊"]
            basis = "生门/戊"
        elif "感情" in ys or "婚姻" in ys:
            cands = [p for p in palaces if p["god"] == "六合" or p["tiangan"] in ("乙", "庚")]
            basis = "六合/乙庚"
        elif "健康" in ys or "疾病" in ys:
            cands = [p for p in palaces if p["star"] in ("天芮", "天心")]
            basis = "天芮/天心"
        elif "考试" in ys or "文书" in ys:
            cands = [p for p in palaces if p["door"] == "景门" or p["tiangan"] == "丁"]
            basis = "景门/丁"
        elif "寻物" in ys or "失物" in ys:
            cands = [p for p in palaces if p["god"] in ("六合", "玄武") or p["digan"] == sz["hour"][0]]
            basis = "时干/六合/玄武"
        elif ys in GAN:
            cands = [p for p in palaces if p["tiangan"] == ys]
            basis = f"天盘{ys}"
        else:
            cands = [p for p in palaces if p["door"] == ys]
            basis = f"{ys}门"
        yp = cands[0] if cands else None
        focus["yongshen"] = {"name": ys, "basis": basis,
                             "gong": (yp or {}).get("gong"),
                             "palace": (yp or {}).get("name", ""),
                             "star": (yp or {}).get("star", ""),
                             "gan": (yp or {}).get("tiangan", "")}
        lines.append(
            f"指定用神：{ys}（取用依据：{basis}）"
            + (f"，落{yp['gong']}宫（{yp['name']}，天盘{yp['tiangan']} 星{yp['star']} 门{yp['door']}）"
               if yp else "（盘面中未找到对应落宫，按事项性质取用，AI 须说明取用依据）")
            + "——AI 应以此为解读主线，说明其落宫、生克与修正条件。"
        )
    lines.append(
        "说明：中五宫寄坤二（天禽随天芮、携中宫干" + zhong_gong_gan
        + "）；门迫=门克宫，击刑以天盘六仪落宫论，入墓以天盘干落宫论，旬空依时柱旬、驿马依日支三合局。"
    )
    fact = "\n".join(lines)

    all_stars = " ".join(star_at.get(g, "") for g in RING)
    all_doors = " ".join(door_at.get(g, "") for g in RING)
    all_gods = " ".join(god_at.get(g, "") for g in RING)
    rag_query = (
        f"奇门遁甲 {yinyang}{ju}局 {jieqi}{yuan} 符头{futou} "
        f"{'拆补法' if method == 'chaibu' else '置闰法'} {dingju_state} "
        f"值符{zhi_fu} 值使{zhi_shi} 时柱{sz['hour']} 日柱{sz['day']} "
        f"{all_stars} {all_doors} {all_gods}"
        + (f" 用神{yongshen}" if yongshen else "")
    )
    rag_extra = [
        f"{yinyang}{ju}局", jieqi, yuan, futou, zhi_fu, zhi_shi,
        sz["hour"], sz["day"], all_stars, all_doors, all_gods,
    ]
    if yongshen:
        rag_extra.append(str(yongshen).strip())
    return {
        "when": when.isoformat(timespec="seconds"),
        "method": method,
        "sizhu": sz,
        "jieqi": jieqi,
        "yinyang": yinyang,
        "ju": ju,
        "ju_jieqi": ju_jieqi,
        "dingju_state": dingju_state,
        "dingju_note": dingju_note,
        "yuan": yuan,
        "futou": futou,
        "zhi_fu": zhi_fu,
        "zhi_shi": zhi_shi,
        "palaces": palaces,
        "fact": fact,
        "rag_query": rag_query,
        "rag_extra": rag_extra,
        "steps": steps,
        "focus": focus,
        "meta": {
            "question": question,
            "year_na": year_na,
            "yongshen": yongshen,
            "engine": "时家奇门·转盘排宫·" + ("拆补法" if method == "chaibu" else "置闰法"),
            "dingju_state": dingju_state,
            "note": "问题文本仅记录于此，不参与定局与星门位置；未做真太阳时校正",
        },
    }
