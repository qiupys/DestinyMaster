/* 命理馆门户逻辑：hash 路由 + 登录 + 四功能（八字/梅花/塔罗/黄历）+ 历史。
   设计：确定性计算先展示（可核对），再按需请求 AI 流式解读；全程复用后端 /api/。 */
(function () {
  "use strict";

  // v116：统一解读对象模型（web/reading-core.js，纯数据层，可 node 单测）。
  // 一次 AI 解读 = 一个 Reading 对象；当前轮/归档/追问/去重全由 ReadingSession 管理。
  // DOM 上的 data-rk / data-hid / data-archQ 只是对象的渲染投影：写给 CSS/E2E 看，
  // 判断状态一律问对象，不再扫 DOM 文本——杜绝「展示与解读脱节」。
  var Core = window.ReadingCore;
  if (!Core) throw new Error("reading-core.js 未加载：请检查 index.html 脚本顺序");

  var S = {
    feature: "home",
    profile: null,       // {id, token, name}
    busy: false,
    stageCache: {},      // feature -> 持久 DOM 容器；切页只隐藏/显示，不销毁
    pageEpoch: "",       // 本次打开页面（内存随机值，不持久化）：同一 SPA 切功能页不变，刷新即新
  };
  // v127「本次打开页面」会话边界：刷新（含关标签重开）即视为新会话，旧对话不恢复。
  // epoch 只在内存里，刷新后 JS 重新执行生成新值；快照里的旧 epoch 对不上即丢弃。
  try { S.pageEpoch = String(Date.now()) + "-" + Math.random().toString(36).slice(2); }
  catch (e) { S.pageEpoch = String(Math.random()); }

  /* 容器 → 解读会话：feature 显式传入优先；紫微运势盘用独立 slot 与命格盘隔离。
     黄历 personal/pair 共用 #hl-result，靠调用方传入的 feature 区分（不靠 DOM）。 */
  var SLOT_CONTAINERS = Core.slotMap();

  /* ===== Board 投影框架（v126）=====
   * 盘面（牌面/卦象/命盘/黄历）是一等对象 Board，不是 DOM 里的 HTML 字符串。
   * calc 成功后 putBoard() 把结构化数据 d 存进会话仓库；DOM 只是它的投影。
   * 归档摘要、快照恢复一律 boardView() 从对象重新渲染——绝不复制旧 DOM，
   * 这样按钮/事件/失效状态根本不会从旧画面漏进历史卡。
   * 每个功能在 calc 后调用 putBoard(feature, rk, d, params, when)；
   * boardView 按 feature 分派到注册过的投影函数（见 BOARD_VIEWS）。
   */
  var BOARD_VIEWS = {};
  function putBoard(featureName, roundKey, boardData, lockParams, castTime) {
    if (!featureName || !roundKey || !boardData) return null;
    var board = new Core.Board({
      feature: featureName,
      kind: featureName,
      roundKey: roundKey,
      data: boardData,
      params: lockParams || {},
      castTime: castTime || boardData.when || ""
    });
    Core.session(featureName).setBoard(board);
    return board;
  }
  /* 从 Board 对象渲染只读盘面摘要（归档卡用），无按钮/无提问框/无事件。
     命盘类无专用投影时用通用事实摘要：递归提取 board.data 的标量字段，
     历史回看读的是冻结的对象数据，不是旧 DOM——保证只读且不失真。 */
  var BOARD_FACT_LABELS = {
    pillars: "四柱", wuxing: "五行", shensha: "神煞", sizhu: "四柱",
    palaces: "宫位", planets: "行星", aspects: "相位", houses: "宫",
    ben_gua: "本卦", bian_gua: "变卦", hu_gua: "互卦", yaos: "六爻",
    cards: "牌", deck: "卦签", yi: "宜", ji: "忌", jieqi_info: "节气",
    a_data: "甲方", b_data: "乙方", cross: "合盘", majorStars: "主星",
    yuejian: "月建", richen: "日辰", xunkong: "旬空"
  };
  function generalBoardView(featureName, board) {
    var data = board.data || {};
    var lines = [];
    Object.keys(data).forEach(function (key) {
      var value = data[key];
      if (value == null || typeof value === "object" || value === "") return;
      var label = BOARD_FACT_LABELS[key] || key;
      lines.push('<span class="pf-fact"><b>' + esc(label) + '</b>' + esc(String(value)) + '</span>');
    });
    // 关键数组/对象字段（四柱、宫位、牌）：只列名字，避免历史卡过长
    ["pillars", "sizhu", "ben_gua", "bian_gua", "a_data", "b_data"].forEach(function (key) {
      var obj = data[key];
      if (!obj || typeof obj !== "object") return;
      var parts = Object.keys(obj).slice(0, 8).map(function (subKey) {
        return esc(subKey) + " " + esc(String(obj[subKey] && typeof obj[subKey] === "object" ? (obj[subKey].name || "") : obj[subKey]));
      });
      if (parts.length) lines.push('<span class="pf-fact"><b>' + (BOARD_FACT_LABELS[key] || key) + '</b>' + parts.join(" · ") + '</span>');
    });
    if (!lines.length) return "";
    return '<div class="p-result"><div class="p-card pf-board-digest">' + lines.join("") + '</div></div>';
  }
  /* ===== 命盘/合婚/黄历的专属投影（v131）=====
   * 通用 generalBoardView 只列标量，十个核心盘面字段（四柱、十神细节、神煞、
   * 宫位、行星、相位、跨盘关系等）是对象/数组，会被整段跳过，归档摘要因此残缺。
   * 这里为每个功能注册纯函数投影：输入只有冻结的 Board.data，输出只读 HTML，
   * 没有按钮/事件/提问框，与牌面/卦面投影同构。 */
  function digestFact(label, value) {
    if (value == null || value === "" || value === false) return "";
    if (Array.isArray(value) && !value.length) return "";
    return '<span class="pf-fact"><b>' + esc(label) + '</b>' + esc(String(value)) + '</span>';
  }
  function digestCard(title, facts) {
    var rows = facts.filter(Boolean);
    if (!rows.length) return "";
    return '<div class="p-result"><div class="p-card pf-board-digest">' +
      '<span class="pf-fact pf-digest-h"><b>' + esc(title) + '</b>盘面事实 · 只读</span>' +
      rows.join("") + '</div></div>';
  }
  function digestStars(list, limit) {
    if (!list || !list.length) return "无主星";
    var max = limit || 4;
    return list.slice(0, max).map(function (star) {
      return (star.name || "") + (star.brightness ? "(" + star.brightness + ")" : "") +
        (star.mutagen ? "化" + star.mutagen : "");
    }).join("、") + (list.length > max ? " 等" : "");
  }
  function digestPillars(pillars, gods) {
    var labels = { year: "年", month: "月", day: "日", hour: "时" };
    return Object.keys(labels).map(function (key) {
      var tenGod = (gods || {})[key];
      return labels[key] + " " + ((pillars || {})[key] || "—") + (tenGod ? "(" + tenGod + ")" : "");
    }).join(" · ");
  }
  // 运限区间在不同来源里可能是数组、{start,end} 对象或普通字符串，统一安全格式化。
  function digestRange(value) {
    if (value == null) return "";
    if (Array.isArray(value)) return value.join("~");
    if (typeof value === "object") {
      return [value.start, value.end, value.from, value.to, value.startYear, value.endYear]
        .filter(function (part) { return part != null && part !== ""; }).join("~");
    }
    return String(value);
  }
  function baziBoardView(boardData) {
    var labels = { year: "年", month: "月", day: "日", hour: "时" };
    var wuxing = boardData.wuxing || {}, nayin = boardData.nayin || {};
    var facts = [
      digestFact("四柱十神", digestPillars(boardData.pillars, boardData.ten_gods)),
      digestFact("日主", boardData.day_master),
      digestFact("纳音", Object.keys(labels).map(function (key) {
        return labels[key] + " " + (nayin[key] || "—");
      }).join(" · ")),
      digestFact("五行", Object.keys(wuxing).map(function (key) { return key + (wuxing[key] || 0); }).join(" ")),
      digestFact("神煞", (boardData.shensha || []).map(function (item) {
        return item.name + "（" + (item.pillars || []).join("、") + "柱）";
      }).join("；"))
    ];
    // 对象/数组核心事实：逐柱十神（含藏干）与逐柱神煞，通用摘要原本整段跳过。
    var detail = boardData.ten_god_detail || {}, byPillar = boardData.shensha_by_pillar || {};
    Object.keys(labels).forEach(function (key) {
      var item = detail[key] || {}, parts = [];
      if (item.main) parts.push(item.main + (item.main_desc ? "（" + item.main_desc + "）" : ""));
      var hidden = (item.hidden || []).map(function (x) { return x.gan + x.shi_shen; });
      if (hidden.length) parts.push("藏干 " + hidden.join("、"));
      if (parts.length) facts.push(digestFact(labels[key] + "柱十神", parts.join(" · ")));
      var shensha = (byPillar[key] || []).map(function (x) { return x.name; });
      if (shensha.length) facts.push(digestFact(labels[key] + "柱神煞", shensha.join("、")));
    });
    var current = boardData.current || {};
    if (current.dayun) facts.push(digestFact("当前大运", current.dayun + "（" +
      (current.dayun_range || []).join("-") + "，" + (current.age || "—") + "岁）"));
    if (boardData.target_year) {
      var liunian = null, liuyue = null;
      (boardData.liunian || []).forEach(function (yearItem) {
        if (yearItem.year !== boardData.target_year) return;
        liunian = yearItem;
        (yearItem.liuyue || []).forEach(function (monthItem) {
          if (monthItem.month === boardData.target_month) liuyue = monthItem;
        });
      });
      facts.push(digestFact("推演时点", boardData.target_year + "年" +
        (liunian ? " " + liunian.ganzhi : "") +
        (liuyue ? " · " + boardData.target_month + "月 " + liuyue.ganzhi + "（节气月柱）" : "")));
    }
    return digestCard("八字", facts);
  }
  BOARD_VIEWS.bazi = baziBoardView;
  function ziweiBoardView(boardData) {
    var palaces = (boardData.palaces || []).slice().sort(function (a, b) {
      return (a.index || 0) - (b.index || 0);
    });
    var facts = [
      digestFact("农历", boardData.lunarDate),
      digestFact("干支", boardData.chineseDate),
      digestFact("五行局", boardData.fiveElementsClass),
      digestFact("命主身主", "命主 " + (boardData.soul || "—") + " · 身主 " + (boardData.body || "—"))
    ];
    var soul = null;
    palaces.forEach(function (palace) { if (palace.name === "命宫") soul = palace; });
    if (soul) facts.push(digestFact("命宫", (soul.heavenlyStem || "") + (soul.earthlyBranch || "") +
      " · " + digestStars(soul.majorStars)));
    facts.push(digestFact("十二宫主星", palaces.map(function (palace) {
      return palace.name + " " + digestStars(palace.majorStars, 2);
    }).join("；")));
    var mutagens = {};
    palaces.forEach(function (palace) {
      [palace.majorStars, palace.minorStars].forEach(function (stars) {
        (stars || []).forEach(function (star) {
          if (star.mutagen && !mutagens[star.mutagen]) {
            mutagens[star.mutagen] = star.name + "化" + star.mutagen + "落" + palace.name;
          }
        });
      });
    });
    ["禄", "权", "科", "忌"].forEach(function (key) {
      if (mutagens[key]) facts.push(digestFact("生年四化", mutagens[key]));
    });
    var horo = boardData.horoscope || {};
    if (horo.decadal) facts.push(digestFact("大限", (horo.decadal.heavenlyStem || "") +
      (horo.decadal.earthlyBranch || "") + (digestRange(horo.decadal.range) ? " · " + digestRange(horo.decadal.range) + "岁" : "")));
    if (horo.yearly) facts.push(digestFact("流年", (horo.yearly.heavenlyStem || "") +
      (horo.yearly.earthlyBranch || "") + (digestRange(horo.yearly.solarRange) ? " · " + digestRange(horo.yearly.solarRange) : "")));
    if (horo.monthly) facts.push(digestFact("流月", (horo.monthly.heavenlyStem || "") +
      (horo.monthly.earthlyBranch || "") + (digestRange(horo.monthly.solarRange) ? " · " + digestRange(horo.monthly.solarRange) : "")));
    return digestCard("紫微命盘", facts);
  }
  BOARD_VIEWS.ziwei = ziweiBoardView;
  function astroBoardView(boardData) {
    function pos(item) {
      if (!item) return "—";
      return (item.sign || "—") + " " + (item.degree || "") +
        (item.house ? " · 第" + item.house + "宫" : "");
    }
    var facts = [
      digestFact("太阳", pos(boardData.sun)),
      digestFact("月亮", pos(boardData.moon)),
      digestFact("上升", pos(boardData.asc)),
      digestFact("中天", pos(boardData.mc)),
      digestFact("宫制", boardData.house_system),
      digestFact("元素", Object.keys(boardData.element || {}).map(function (key) {
        return key + (boardData.element[key] || 0);
      }).join(" "))
    ];
    facts.push(digestFact("行星落座", (boardData.planets || []).filter(function (planet) {
      return planet.key !== "sun" && planet.key !== "moon";
    }).map(function (planet) {
      return planet.name + " " + (planet.sign || "—") + " " + (planet.degree || "") +
        (planet.house ? " 第" + planet.house + "宫" : "") + (planet.retro ? " 逆行" : "");
    }).join("；")));
    facts.push(digestFact("主要相位", (boardData.aspects || []).slice(0, 8).map(function (aspect) {
      return aspect.a + " " + aspect.name + " " + aspect.b + "（" + aspect.orb + "°）";
    }).join("；")));
    return digestCard("占星本命盘", facts);
  }
  BOARD_VIEWS.astrology = astroBoardView;
  function pairBoardFacts(boardData, kind) {
    var first = boardData.a_data || {}, second = boardData.b_data || {}, cross = boardData.cross || {};
    var facts = [digestFact("甲方", first.name || "甲方"), digestFact("乙方", second.name || "乙方")];
    if (kind === "bazi") {
      facts.push(digestFact("甲方四柱十神", digestPillars(first.pillars, first.ten_gods)));
      facts.push(digestFact("乙方四柱十神", digestPillars(second.pillars, second.ten_gods)));
      facts.push(digestFact("甲方日主", (first.day_master || "—") + " · " +
        ((first.strength || {}).level || "—") + " / " + ((first.strength || {}).favor || "—")));
      facts.push(digestFact("乙方日主", (second.day_master || "—") + " · " +
        ((second.strength || {}).level || "—") + " / " + ((second.strength || {}).favor || "—")));
      var day = cross.day_pillar_relation || {}, dayPair = day.pair || {};
      facts.push(digestFact("日柱夫妻宫", (dayPair.a || "—") + " / " + (dayPair.b || "—") + " · " +
        (day.relations || []).map(function (relation) { return relation.relation; }).join("、")));
      facts.push(digestFact("柱位关系", (cross.pillar_groups || []).filter(function (group) {
        return (group.relations || []).some(function (relation) {
          return !/无合冲刑害破/.test(relation.relation || "");
        });
      }).slice(0, 8).map(function (group) {
        return group.who + "：" + (group.relations || []).filter(function (relation) {
          return !/无合冲刑害破/.test(relation.relation || "");
        }).map(function (relation) { return relation.relation; }).join("、");
      }).join("；")));
      var tenGod = cross.ten_god_cross || {};
      facts.push(digestFact("跨盘十神", "甲看乙 " + (tenGod.a_day_master_over_b || []).map(function (x) {
        return x.who + "=" + x.ten_god;
      }).join("、") + "；乙看甲 " + (tenGod.b_day_master_over_a || []).map(function (x) {
        return x.who + "=" + x.ten_god;
      }).join("、")));
      var spouse = cross.spouse_star || {};
      ["a_spouse_star_in_b", "b_spouse_star_in_a"].forEach(function (key) {
        var item = spouse[key];
        if (item) facts.push(digestFact("配偶星 " + (item.seen_from || key),
          (item.target_gods || []).join("、") + "：" + (item.present ? "对方盘中可见" : "对方盘中未见")));
      });
    } else if (kind === "ziwei") {
      ["命宫", "夫妻宫", "福德宫"].forEach(function (name) {
        [first, second].forEach(function (person, index) {
          var palace = person[name] || {};
          facts.push(digestFact((index ? "乙方" : "甲方") + name, (palace.branch || "—") +
            " · " + digestStars(palace.majorStars, 3)));
        });
      });
      [first, second].forEach(function (person, index) {
        var mutagen = person.birth_mutagens || {}, parts = [];
        ["禄", "权", "科", "忌"].forEach(function (key) {
          (mutagen[key] || []).forEach(function (star) { parts.push(star.name + "化" + key); });
        });
        if (parts.length) facts.push(digestFact((index ? "乙方" : "甲方") + "生年四化", parts.join("、")));
      });
      ["夫妻宫对照", "命宫对照", "福德宫对照"].forEach(function (key) {
        var item = cross[key] || {};
        if (item.a || item.b) facts.push(digestFact(key, (item.a && item.a.branch ? item.a.branch : "—") +
          " / " + (item.b && item.b.branch ? item.b.branch : "—")));
      });
      facts.push(digestFact("四化投射", (cross["四化投射"] || []).map(function (item) {
        return item.from + " " + item.star + "化" + item.mutagen + "→" + item.to_name + item.to_palace;
      }).slice(0, 8).join("；")));
      ["运限时间线"].forEach(function (key) {
        var item = cross[key] || {};
        if (item.a || item.b) facts.push(digestFact(key, "甲 " + ((item.a || {}).decadal || {}).name +
          " · 乙 " + ((item.b || {}).decadal || {}).name));
      });
    } else {
      [first, second].forEach(function (person, index) {
        var label = index ? "乙方" : "甲方";
        facts.push(digestFact(label + "三方", "太阳 " + ((person.sun || {}).sign || "—") +
          " · 月亮 " + ((person.moon || {}).sign || "—") + " · 上升 " + ((person.asc || {}).sign || "—")));
      });
      facts.push(digestFact("跨盘相位", (cross.aspects || []).slice(0, 10).map(function (aspect) {
        return aspect.a + " " + aspect.name + " " + aspect.b + "（" + aspect.orb + "°）";
      }).join("；")));
    }
    return facts;
  }
  function baziMarriageBoardView(boardData) {
    return digestCard("八字合婚", pairBoardFacts(boardData, "bazi"));
  }
  BOARD_VIEWS.bazi_marriage = baziMarriageBoardView;
  function ziweiMarriageBoardView(boardData) {
    return digestCard("紫微合婚", pairBoardFacts(boardData, "ziwei"));
  }
  BOARD_VIEWS.ziwei_marriage = ziweiMarriageBoardView;
  function astroMarriageBoardView(boardData) {
    return digestCard("占星合盘", pairBoardFacts(boardData, "astro"));
  }
  BOARD_VIEWS.astrology_marriage = astroMarriageBoardView;
  function huangliBoardView(boardData, board) {
    var isPair = board && board.feature === "huangli_pair";
    var info = boardData.jieqi_info || {};
    var currentJieqi = info.current || info.prev || {};
    var nextJieqi = info.next || {};
    var facts = [
      digestFact(isPair ? "择日" : "公历", boardData.solar),
      digestFact("农历", boardData.lunar + " · " + (boardData.week || "")),
      digestFact("干支生肖", (boardData.ganzhi || "") + " · " + (boardData.shengxiao || "")),
      digestFact("宜", (boardData.yi || []).slice(0, 12).join("、")),
      digestFact("忌", (boardData.ji || []).slice(0, 12).join("、")),
      digestFact("吉神", (boardData.jishen || []).join("、")),
      digestFact("凶煞", (boardData.xiongsha || []).join("、")),
      digestFact("冲煞", (boardData.chong || "") + " · " + (boardData.sha || "") + " · 空亡 " + (boardData.kongwang || "")),
      digestFact("值神", (boardData.tianshen || "") + "（" + (boardData.tianshen_type || "") + "）· " + (boardData.zhixing || "")),
      digestFact("节气", (currentJieqi.name || "—") + (nextJieqi.name ? " → " + nextJieqi.name + "（" + (nextJieqi.time || "") + "）" : ""))
    ];
    return digestCard(isPair ? "双人择日" : "老黄历", facts);
  }
  BOARD_VIEWS.huangli = huangliBoardView;
  BOARD_VIEWS.huangli_pair = huangliBoardView;
  function boardView(featureName, board) {
    if (!board) return "";
    var renderProjection = BOARD_VIEWS[featureName] || generalBoardView;
    try { return renderProjection(board.data, board); }
    catch (error) { warn("盘面投影渲染失败：" + featureName, error); return ""; }
  }
  function sessOf(container, feature) {
    var f = feature || S.feature;
    var slot = "";
    if (container) {
      // 追问容器是 .ai-follow-slot（无 id），必须沿 DOM 祖先找到 #zw-d-ai-out，
      // 否则紫微宫位追问会记到 slot="" 的另一条会话上，与解读脱节。
      var node = container;
      while (node && node !== document.body) {
        if (node.id && SLOT_CONTAINERS[node.id]) { slot = SLOT_CONTAINERS[node.id]; break; }
        node = node.parentElement;
      }
      if (!feature && container.closest) {
        var stage = container.closest(".p-wrap[data-feature]");
        if (stage && stage.dataset.feature) f = stage.dataset.feature;
      }
    }
    // 双人择日是老黄历舞台的别名：S.feature/stage.dataset 都是 huangli，
    // 但对象模型与历史都按 huangli_pair（两个 Person）归属，不能退化成单人会话。
    if (!feature && f === "huangli" && document.querySelector('#hl-tabs button.on[data-v="pair"]')) {
      f = "huangli_pair";
    }
    return Core.session(f, slot);
  }
  /* ===== 重绘保护（全功能共用，禁止再给单个功能写 xxxKeepOutputs） =====
     盘面/卦面/牌面身份不变的重绘（紫微点宫位、切视图等）必须把 AI 输出容器原样挂回：
     节点不动 → 追问事件、流式 DOM 引用、归档链全部随节点保留。
     容器清单来自 Core.outsOf(feature) 注册表，新增功能自动纳入。 */
  var OUT_CACHE = {};
  function preserveOutputs(container, paint, feature) {
    var f = feature || S.feature;
    if (!OUT_CACHE[f]) OUT_CACHE[f] = {};
    var sels = Core.outsOf(f);
    sels.forEach(function (sel) {
      var el = $(sel);
      if (el) OUT_CACHE[f][sel] = el;      // 当前视图有就刷新缓存；没有就留着上次节点
    });
    paint();
    sels.forEach(function (sel) {
      var fresh = $(sel), old = OUT_CACHE[f][sel];
      if (!fresh) {
        // 重绘后的视图不含这个输出槽（如紫微切 tab 把 st.sel 重置为 null、
        // 或切到命格视图时 #zw-d-ai-out 根本不渲染）：paint 的 innerHTML 已让
        // 缓存节点脱离 DOM。若直接 return，正在流式写入的 body 引用就悬空，
        // 解读卡「凭空消失」。把旧节点挂回容器末尾保活，切回对应视图时下一次
        // preserveOutputs 会把它 replaceChild 归位——节点身份不变、追问链不断。
        // appendChild 对已挂载节点会自动移动，无需 parentNode 守卫。
        if (old && container && old.parentNode !== container) container.appendChild(old);
        return;
      }
      if (old && old !== fresh) {
        if (fresh.parentNode) fresh.parentNode.replaceChild(old, fresh);
      } else OUT_CACHE[f][sel] = fresh;
    });
  }
  function clearOutCache(feature) { delete OUT_CACHE[feature || S.feature]; }
  /* 盘面身份变化（换盘/换卦/换牌/切子功能）时统一归档旧轮，对象与 DOM 同步后重建。
     rk+question 严格相等才算同轮：dataset 缺失时从 ReadingSession 兜底。 */
  function archiveBeforeRepaint(container, feature) {
    if (!container) return;
    var sess = sessOf(container, feature);
    var q = container.dataset.lastQ || sess.lastQ || "上一轮提问";
    var rk = container.dataset.rk || sess.boardRk || "";
    archiveRound(container, q, rk);
    // 多 slot 功能（紫微宫位槽）：归档区只有一份，但另一槽的对象也要从 current 移走
    Core.sessionsOf(sess.feature).forEach(function (s) {
      if (s !== sess && s.current) s.archive();
    });
    clearOutCache(sess.feature);
  }
  // 老黄历的两个子功能共用同一舞台；旧链接 #/huangli_pair 通过它切到双人择日 tab。
  var hlApplyMode = null;
  // 每个功能持有自己的舞台容器。切到别的功能时只隐藏，正在进行的 AI 流式解读
  // 仍写到原容器里继续跑；切回来时提问框、解读结果、追问链都原样还在。
  function stageEl() {
    var f = S.feature;
    var el = S.stageCache[f];
    if (!el) {
      el = document.createElement("div");
      el.className = "p-wrap";
      el.id = "p-stage-" + f;
      el.dataset.feature = f;
      $("#p-content").appendChild(el);
      S.stageCache[f] = el;
    }
    return el;
  }
  try {
    var raw = localStorage.getItem("zw-profile");
    if (raw) S.profile = JSON.parse(raw);
    else {
      // 未登录启动（含直接删 localStorage 后刷新）：清掉上一账号残留的会话快照。
      // 初始化不经过 setProfile，这里必须自己清，否则旧对话会在下次登录时冒出来。
      Object.keys(sessionStorage).forEach(function (k) {
        if (k && k.indexOf("zs-snap-") === 0) sessionStorage.removeItem(k);
      });
    }
  } catch (e) { warn("读取本地登录态失败", e); }

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  // 静默失败留痕：以前大量 .catch(function(){}) 把网络/解析错误吞掉，
  // 用户点了没反应、开发者也查不到。降级场景至少进 console，关键操作给用户提示。
  function warn(tag, e) { if (window.console && console.warn) console.warn("[命理馆] " + tag, e || ""); }
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
  }); };

  /* ---------------- 工具 ---------------- */
  function toast(msg) {
    var t = $("#p-toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }
  function authParam() {
    return S.profile ? "&profile_id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token) : "";
  }
  /* AI 功能登录门禁：各功能的门文案 */
  var AI_GATES = {
    bazi:   { title: "AI 八字问答", desc: "基于您的八字，可就具体问题继续提问，答复仅供参考。" },
    meihua: { title: "AI 梅花解卦", desc: "基于本次卦象，可就所问之事继续提问，答复仅供参考。" },
    tarot:  { title: "AI 塔罗解读", desc: "基于本次牌阵，可就所问之事继续提问，答复仅供参考。" },
    huangli:{ title: "AI 黄历答疑", desc: "基于当日历注，可就择日事项继续提问，答复仅供参考。" },
    huangli_pair: { title: "AI 双人择日", desc: "基于当日历注与双方四柱，可就共同事项继续提问，答复仅供参考。" },
    ziwei:  { title: "AI 紫微推演", desc: "基于本次命盘，可就格局与运限继续提问，答复仅供参考。" },
    astrology: { title: "AI 占星解读", desc: "基于本次本命盘的行星落座、宫位与相位，可就性格与运势继续提问，答复仅供参考。" },
    bazi_marriage: { title: "AI 八字合婚", desc: "基于双方已排定的四柱与跨盘关系，可就相处模式继续提问，答复仅供参考。" },
    ziwei_marriage: { title: "AI 紫微合婚", desc: "基于双方已排定的命盘与四化交叉，可就关系结构继续提问，答复仅供参考。" },
    astrology_marriage: { title: "AI 占星合盘", desc: "基于双方已排定的本命盘、落宫与相位，可就关系动力学继续提问，答复仅供参考。" },
    liuyao: { title: "AI 六爻解卦", desc: "基于本次卦盘的纳甲、六亲、世应与动变，可就所问之事继续提问，答复仅供参考。" },
    qimen:  { title: "AI 奇门解盘", desc: "基于本次九宫盘的干星门神与格局，可就所问之事继续提问，答复仅供参考。" }
  };
  /* 未登录时的门禁块：模糊的假提问框 + 锁 + 标题说明 + 登录按钮（对齐参考图） */
  function aiGateBlock(feature) {
    var cfg = AI_GATES[feature] || AI_GATES.bazi;
    return '<div class="ai-gate">' +
      '<div class="ag-fake" aria-hidden="true">' +
        '<div class="ag-fake-chip"></div><div class="ag-fake-chip ag-fake-short"></div>' +
        '<div class="ag-fake-row"><span></span><b></b></div></div>' +
      '<div class="ag-front">' +
        '<svg class="ag-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>' +
        '<div class="ag-title">' + esc(cfg.title) + '</div>' +
        '<p class="ag-desc">' + esc(cfg.desc) + '</p>' +
        '<button type="button" class="ag-btn">立即登录 / 注册</button>' +
      '</div></div>';
  }
  function bindAIGate(root) {
    var b = root && $(".ag-btn", root);
    if (b) b.onclick = openAuth;
  }
  /* 统一门禁守卫：未登录则拦下 AI 解读/追问并弹出登录框。返回 true 表示已拦截。 */
  function requireLogin() {
    if (S.profile) return false;
    toast("请先登录或使用 AI 解读与追问");
    openAuth();
    return true;
  }
  /* 在每个功能舞台渲染后调用：未登录时在表单与结果之间插入门禁卡，
     并给舞台加 stage-locked（CSS 隐藏真正的 AI 提问框/按钮），登录后自动移除。 */
  function applyGate(feature) {
    var st = stageEl();
    st.classList.toggle("stage-locked", !S.profile);
    var old = $(".ai-gate-host", st);
    if (old) old.remove();
    if (S.profile) return;
    var host = document.createElement("div");
    host.className = "ai-gate-host";
    host.innerHTML = aiGateBlock(feature);
    // 门禁卡放在确定性结果（卦象/牌面/历注/命盘）之后、「关于」说明之前，
    // 即与登录后 AI 提问框出现的位置一致（结果卡下方），宽度也与结果卡对齐。
    var about = $(".about-details", st);
    if (about) st.insertBefore(host, about);
    else st.appendChild(host);
    bindAIGate(host);
  }
  /* 命盘类缓存：出生信息不变时复用已排好的盘，登录态不重复请求后端排盘。
     key 由出生信息决定；个人信息变更时 profileBirthChanged 统一清除。 */
  var CHART_CACHE = { bazi: "bz-chart-v1", astrology: "as-chart-v1", ziwei: "zw-chart-v1" };
  function chartCacheGet(feature) {
    try { return JSON.parse(sessionStorage.getItem(CHART_CACHE[feature]) || "null"); } catch (e) { return null; }
  }
  function chartCacheSet(feature, obj) {
    try { sessionStorage.setItem(CHART_CACHE[feature], JSON.stringify(obj)); }
    catch (e) { warn("命盘缓存写入失败（不影响排盘）", e); }
  }
  /* 档案出生信息变更后：清掉全部命盘缓存（否则旧盘仍被复用），并刷新档案副本 */
  function profileBirthChanged() {
    Object.keys(CHART_CACHE).forEach(function (f) {
      try { sessionStorage.removeItem(CHART_CACHE[f]); }
      catch (e) { warn("清理命盘缓存失败", e); }
    });
    if (S.zw) { S.zw.chart = null; S.zw.id = null; S.zw.key = null; S.zw.horo = null; }
    if (S.profile) {
      fetch("/api/profile/get?id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token))
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok && d.profile) S.profileBirth = d.profile.birth || null;
        }).catch(function (e) { warn("刷新档案出生信息失败", e); });
    }
  }
  /* 销毁所有功能舞台缓存（提问/解读/追问/门禁 DOM）。登录或退出都必须调用：
     否则其它功能里"未登录态"缓存的舞台（带门禁）在登录后切回去仍是门禁。 */
  function dropStages() {
    Object.keys(S.stageCache).forEach(function (k) {
      var el = S.stageCache[k];
      if (el && el.parentNode) el.parentNode.removeChild(el);
      delete S.stageCache[k];
    });
    S.busyKeys = {};
  }
  /* 退出登录时清空本账号全部前端缓存：各功能舞台上的提问/解读/追问、命盘、
     紫微 session 缓存、个人中心的历史与出生信息。避免退出后仍能翻到上一个人的对话。 */
  function clearUserData() {
    clearAllSnaps();
    dropStages();
    Core.clearAll();                    // v116：解读对象仓库随用户数据一起清空
    OUT_CACHE = {};                     // v121：重绘保护缓存按用户隔离，退出即清
    S.profileBirth = null;
    S.zw = null; S.zwFromProfile = false;
    // 三个命盘缓存全清（此前只清紫微，八字/占星残留靠 uid 兜底，不算彻底）
    Object.keys(CHART_CACHE).forEach(function (f) {
      try { sessionStorage.removeItem(CHART_CACHE[f]); }
      catch (e) { warn("清理" + f + "命盘缓存失败", e); }
    });
    pfState = { filter: "", date: "", items: [], dates: [], editBirth: false, editAccount: false,
      birth: null, memories: [], editMem: 0, memDraft: "", memCat: "综合", memImportOpen: false, memSelected: [], memBusy: false };
  }
  /* 加载登录档案的出生资料到 S.profileBirth：命盘类 Person 快照（对话导入用户信息）的
     唯一来源。登录态可能来自 localStorage 恢复（未经 setProfile），故初始化与登录后都要拉。
     只加载一次，档案变更走 profileBirthChanged() 刷新。 */
  function loadProfileBirth() {
    if (!S.profile || S.profileBirth || S.profileBirthLoading) return Promise.resolve(null);
    S.profileBirthLoading = true;
    return fetch("/api/profile/get?id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        S.profileBirthLoading = false;
        if (d.ok && d.profile) S.profileBirth = d.profile.birth || null;
        return S.profileBirth;
      })
      .catch(function (e) { S.profileBirthLoading = false; warn("加载档案出生资料失败", e); return null; });
  }
  function setProfile(p) {
    var wasLogged = !!S.profile;
    var changed = wasLogged !== !!p;
    S.profile = p;
    try { p ? localStorage.setItem("zw-profile", JSON.stringify(p)) : localStorage.removeItem("zw-profile"); }
    catch (e) { warn("保存登录态失败", e); }
    if (!p) clearAllSnaps();   // 未登录（含直接删 localStorage 后刷新）一律清残留快照，防串账号
    if (changed) {
      if (!p) clearUserData();
      else {
        dropStages();
        Core.clearAll(); OUT_CACHE = {};           // 登录也主动清旧会话，不依赖「未登录不能解读」的前提
        loadProfileBirth();                        // 加载档案出生资料供 Person 快照
      }
    }
    renderUser();
    // 登录/退出后立刻刷新当前视图：个人中心刷新统计，其它页强制重建（门禁 ↔ 档案带入）
    if (changed && S.feature === "profile") renderProfile();
    else if (changed) navigate(S.feature, true);
  }
  function renderUser() {
    var el = $("#p-user");
    el.innerHTML = S.profile
      ? esc(S.profile.name) + ' <a id="p-logout">退出</a>'
      : '<a id="p-login-link">登录</a>';
    var lo = $("#p-logout");
    if (lo) lo.onclick = function () { setProfile(null); toast("已退出"); };
    var li = $("#p-login-link");
    if (li) li.onclick = openAuth;
    // 底部同一个按钮：未登录=登录/注册；已登录=个人中心，就地切换，不留冗余占位
    var ab = $("#p-auth-btn");
    var lab = $("#p-auth-label");
    if (ab) {
      if (S.profile) {
        if (lab) lab.textContent = "个人中心 · " + S.profile.name;
        ab.classList.add("is-profile");
        ab.onclick = function () { go("profile"); };
      } else {
        if (lab) lab.textContent = "登录 / 注册";
        ab.classList.remove("is-profile");
        ab.onclick = openAuth;
      }
    }
  }

  /* ---------------- 路由 ---------------- */
  function parseHash() {
    var h = (location.hash || "").replace(/^#\/?/, "");
    var feat = h.split("?")[0] || "home";
    return feat;
  }
  /* 移动端抽屉导航 */
  function closeNav() {
    if (!document.body.classList.contains("nav-open")) return;
    document.body.classList.remove("nav-open");
    var b = $("#p-burger");
    if (b) b.setAttribute("aria-expanded", "false");
  }
  function toggleNav() {
    var open = document.body.classList.toggle("nav-open");
    var b = $("#p-burger");
    if (b) b.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function go(feat) {
    location.hash = feat; // 统一 #/xxx
  }
  /* ---------- 功能页会话快照（reload/重建后保留本会话提问） ----------
     把每个功能的结果区 + 归档区 HTML 存进 sessionStorage。命盘类盘面本就有 chart 缓存，
     但解读卡/追问链此前只活在内存 stage，reload 即丢。快照让它们跨 reload 存活，
     等价于「切回功能页提问还在」。按 uid 隔离，退出登录清除。 */
  var SNAP_PREFIX = "zs-snap-";
  function snapKey(feat) { return SNAP_PREFIX + feat + "-" + (S.profile ? S.profile.id : "anon"); }
  function saveStageSnap(feat) {
    if (!S.profile) return;
    // 双人择日的对象属于 huangli_pair，但舞台仍是共用的 huangli。
    var st = S.stageCache[feat] || (feat === "huangli_pair" ? S.stageCache["huangli"] : null);
    if (!st) return;
    var rootSel = ROOT_SEL[feat];
    var root = rootSel ? $(rootSel, st) : null;
    var arc = $(".round-archive", st);
    if (!root && !arc) return;
    try {
      // v123：各输出槽单独存一份。紫微命格槽(#zw-ai-out)与宫位槽(#zw-d-ai-out)互斥，
      // 只读当前视图的 rootHtml 会丢掉另一槽的解读卡；缓存里保留暂未挂回的节点。
      var outHtml = {};
      Core.outsOf(feat).forEach(function (sel) {
        var el = $(sel, st) || (OUT_CACHE[feat] && OUT_CACHE[feat][sel]);
        if (el) outHtml[sel] = el.innerHTML;
      });
      sessionStorage.setItem(snapKey(feat), JSON.stringify({
        // v127：会话边界=本次打开页面。epoch 是内存随机值，刷新即变；
        // 恢复时 epoch 不符的快照一律丢弃，杜绝上次打开的对话串进当前功能页。
        pageEpoch: S.pageEpoch,
        profileToken: S.profile && S.profile.token ? S.profile.token : "",
        // v116：解读状态以对象为真相源（含轮次/归档/追问链）；DOM 仅作视觉投影。
        core: Core.serializeFeature(feat),
        rootHtml: root ? root.innerHTML : null,
        rootId: root ? root.id : null,
        outHtml: outHtml,
        // 紫微视图状态（选中宫位/视图/年份）：盘面是动态渲染的，快照必须记录身份，
        // 否则刷新后回到默认盘面，宫位槽的解读卡虽有对象却无处投影。
        zwState: feat === "ziwei" && S.zw ? { view: S.zw.view, sel: S.zw.sel, year: S.zw.year } : null,
        arcHtml: arc ? arc.innerHTML : null,
        formHidden: (function () {
          var fc = $(".tool-card[id$='-form-card']", st);
          return fc ? fc.style.display === "none" : false;
        })()
      }));
    } catch (e) { warn("保存舞台快照失败（不影响使用）", e); }
  }
  function restoreStageSnap(feat, stageFeat) {
    if (!S.profile) return;
    var raw;
    try { raw = sessionStorage.getItem(snapKey(feat)); } catch (e) { warn("读取舞台快照失败", e); }
    if (!raw) return;
    var snap;
    try { snap = JSON.parse(raw); } catch (e) { return; }
    // v127：会话边界=本次打开页面。epoch 对不上（刷新/重开标签页）或登录态变了（换号），
    // 就是上一次会话的残留——直接丢弃，不恢复任何对话/归档。这是「不要把历史对话
    // 展示在当前功能下」的架构保证：只有本次打开页面内产生的对话才会被恢复。
    var tokenNow = S.profile && S.profile.token ? S.profile.token : "";
    if (snap.pageEpoch !== S.pageEpoch || snap.profileToken !== tokenNow) {
      try { sessionStorage.removeItem(snapKey(feat)); } catch (e2) { warn("清除过期快照失败", e2); }
      return;
    }
    var st = S.stageCache[stageFeat || feat];
    if (!st || st.dataset.snapRestored === "1") return;
    // 命盘类排盘是异步的（拉档案/算盘后 innerHTML 重建结果区）。等结果卡出现再恢复快照，
    // 否则会被随后落地的排盘覆盖。最多等 ~2s；纯占卜类结果区同步生成，立即可恢复。
    var rootSel = snap.rootId ? "#" + snap.rootId : (ROOT_SEL[feat] || null);
    var tries = 0;
    function attempt() {
      if (!st.isConnected) return;                 // 已被销毁，放弃
      if (st.dataset.snapRestored === "1") return;  // 已被别处恢复
      var root = rootSel ? $(rootSel, st) : null;
      // 结果区还没排盘且是命盘类 → 再等。紫微盘面没有 .p-result，
      // 此前只认它导致紫微快照每次都要空等 2s、甚至被随后重绘覆盖（刷新丢对话）。
      var ready = root && (root.querySelector(".p-result") ||
        root.querySelector("#zw-plate") || root.querySelector(".zw-pattern"));
      if (root && !ready && tries < 20 && ["bazi","astrology","ziwei"].indexOf(feat) >= 0) {
        tries++; setTimeout(attempt, 100); return;
      }
      var restored = false;
      // 对象先恢复，紫微再按快照的视图状态重绘盘面（事件随渲染重新绑定），
      // 最后回填解读槽——顺序反了会被 preserveOutputs 刷掉。
      Core.restoreFeature(snap.core || {});
      if (feat === "ziwei" && snap.zwState && zwS().chart) {
        var z = zwS();
        z.view = snap.zwState.view || z.view;
        z.sel = snap.zwState.sel != null ? snap.zwState.sel : null;
        z.year = snap.zwState.year || z.year;
        zwRender();
        restored = true;
      }
      if (feat === "ziwei" && root) {
        // v123：紫微盘面是动态渲染且 tab / 宫位 onclick 绑在节点上，绝不能用旧
        // innerHTML 整体覆盖（刷新后整盘点不动、像锁死在财帛宫）。只回填解读输出槽：
        // 当前视图没有的槽暂存，切到对应视图时由 preserveOutputs 挂回。
        var tmp = document.createElement("div");
        if (snap.rootHtml != null) tmp.innerHTML = snap.rootHtml;
        if (!OUT_CACHE[feat]) OUT_CACHE[feat] = {};
        Core.outsOf(feat).forEach(function (sel) {
          var html = snap.outHtml && snap.outHtml[sel];
          var src = null;
          if (html != null) {
            src = document.createElement("div");
            src.innerHTML = html;
          } else {
            // 兼容 v122 及更早的快照（没有 outHtml 字段）：从 rootHtml 里挖。
            var id = sel.replace(/^#/, "");
            src = tmp.querySelector(sel) || tmp.querySelector("#" + id);
          }
          if (!src) return;
          var dst = $(sel, root);
          if (dst) { dst.innerHTML = src.innerHTML; OUT_CACHE[feat][sel] = dst; }
          else OUT_CACHE[feat][sel] = src;
          restored = true;
        });
      } else if (snap.rootHtml != null && root) {
        // 其他功能结果区是静态 HTML，快照整块回填即可（盘面本身不重绘）。
        root.innerHTML = snap.rootHtml; restored = true;
      }
      if (snap.arcHtml != null) {
        var arc = $(".round-archive", st);
        if (!arc) { arc = document.createElement("div"); arc.className = "round-archive"; st.appendChild(arc); }
        arc.innerHTML = snap.arcHtml; restored = true;
        // v125：存量快照（v123 及之前）的归档卡里嵌着旧结构的 AI 按钮，
        // 恢复后统一只读化——历史回看不该留下触发新一轮解读的入口。
        Array.prototype.slice.call(arc.querySelectorAll(".p-ai-archived .tool-ai, .p-ai-archived .p-suggest, .p-ai-archived .p-switch"))
          .forEach(function (c) { if (c.parentNode) c.parentNode.removeChild(c); });
      }
      if (snap.formHidden) {
        var fc = $(".tool-card[id$='-form-card']", st);
        if (fc) fc.style.display = "none";
      }
      if (restored) {
        // 对象状态与 DOM 投影同步恢复：追问/去重判断从对象读，必须与画面一致。
        st.dataset.snapRestored = "1";
        rebindFollows(st);
      }
    }
    setTimeout(attempt, 0);
  }
  /* v136：舞台已标 ready 但解读投影丢失时的极端竞态自愈（异常重绘/节点被移走）。
     只从有效快照回填输出槽与归档区，绝不重绘盘面、不碰提问框——
     v135 曾无条件复用 restoreStageSnap 重绘紫微，反而弄丢宫位提问框。
     对象先于 DOM：对象为空说明发生会话边界（刷新/退出），此时绝不允许恢复。 */
  function restoreOutputsOnly(featName, stage) {
    if (!S.profile || !stage) return false;
    var raw;
    try { raw = sessionStorage.getItem(snapKey(featName)); } catch (e) { return false; }
    if (!raw) return false;
    var snap;
    try { snap = JSON.parse(raw); } catch (e) { return false; }
    var tokenNow = S.profile.token || "";
    if (snap.pageEpoch !== S.pageEpoch || snap.profileToken !== tokenNow) return false;
    var restored = false;
    if (snap.arcHtml != null) {
      var arc = $(".round-archive", stage);
      if (!arc) { arc = document.createElement("div"); arc.className = "round-archive"; stage.appendChild(arc); }
      arc.innerHTML = snap.arcHtml;
      Array.prototype.slice.call(arc.querySelectorAll(
        ".p-ai-archived .tool-ai, .p-ai-archived .p-suggest, .p-ai-archived .p-switch"))
        .forEach(function (c) { if (c.parentNode) c.parentNode.removeChild(c); });
      restored = true;
    }
    var tmp = document.createElement("div");
    if (snap.rootHtml != null) tmp.innerHTML = snap.rootHtml;
    if (!OUT_CACHE[featName]) OUT_CACHE[featName] = {};
    Core.outsOf(featName).forEach(function (sel) {
      var html = snap.outHtml && snap.outHtml[sel];
      var src = null;
      if (html != null) {
        src = document.createElement("div");
        src.innerHTML = html;
      } else {
        var id = sel.replace(/^#/, "");
        src = tmp.querySelector(sel) || tmp.querySelector("#" + id);
      }
      if (!src) return;
      var dst = $(sel, stage);
      if (dst) { dst.innerHTML = src.innerHTML; OUT_CACHE[featName][sel] = dst; }
      else OUT_CACHE[featName][sel] = src;
      restored = true;
    });
    if (restored) rebindFollows(stage);
    return restored;
  }
  function clearAllSnaps() {
    try {
      Object.keys(sessionStorage).forEach(function (k) {
        if (k && k.indexOf(SNAP_PREFIX) === 0) sessionStorage.removeItem(k);
      });
    } catch (e) { warn("清理舞台快照失败", e); }
  }

  function navigate(feat, force) {
    // 双人择日已改为老黄历内子功能：旧 hash /huangli_pair 复用同一舞台并切到 pair tab，
    // 不再单独建 stage（否则 #hl-cal/#hl-day 重复 id → 日历恒「加载中」）。
    var pairAlias = feat === "huangli_pair";
    if (pairAlias) feat = "huangli";
    var changed = S.feature !== feat;
    S.feature = feat;
    closeNav();
    $$(".p-navitem").forEach(function (b) { b.classList.toggle("active", b.dataset.feature === feat); });
    var ab = $("#p-auth-btn");
    if (ab) ab.classList.toggle("current", feat === "profile");
    var names = { home:"首页",bazi:"八字排盘",ziwei:"紫微斗数",meihua:"梅花易数",liuyao:"六爻",qimen:"奇门遁甲",
      tarot:"塔罗牌",astrology:"占星命盘",huangli:"老黄历",profile:"个人中心",
      bazi_marriage:"八字合婚",ziwei_marriage:"紫微合婚",astrology_marriage:"占星合盘" };
    $("#p-crumb").textContent = names[feat] || feat;
    // 隐藏所有已建舞台，只显示当前功能的；DOM 不销毁 → 提问框/解读/追问/进行中的 SSE 全部保留
    Object.keys(S.stageCache).forEach(function (k) { S.stageCache[k].style.display = "none"; });
    var st = stageEl();
    st.style.display = "";
    // 个人中心每次进入都刷新（历史/统计可能已变）；其余功能首次渲染或强制时才重建
    if (feat === "profile") { renderProfile(); return; }
    if (st.dataset.ready === "1" && !force) {  // 已有内容，切回来直接复用
      if (pairAlias && hlApplyMode) hlApplyMode("pair");
      // v136：舞台标了 ready 却丢解读投影时按快照回填，但只回填 DOM——
      // 对象为空（刷新/退出等会话边界）绝不恢复，避免把上次会话的对话串回来；
      // 也不重绘盘面/提问框，杜绝 v135 那种"修好切换却弄丢紫微提问框"的回归。
      var backFeat = pairAlias ? "huangli_pair" : feat;
      var hasCurrent = Core.sessionsOf(backFeat).some(function (sessItem) { return !!sessItem.current; });
      var firstOut = (Core.outsOf(backFeat) || [])[0];
      if (hasCurrent && firstOut && !$(firstOut + " .p-ai", st)) restoreOutputsOnly(backFeat, st);
      return;
    }
    st.dataset.ready = "1";
    if (feat === "home") { renderHome(); return; }
    // 紫微同样是命盘类：此前直接 return 漏掉快照恢复，刷新后对话与对象全丢。
    if (feat === "ziwei") { renderZiweiEntry(); restoreStageSnap(feat); return; }
    var fn = { bazi: renderBazi, meihua: renderMeihua, tarot: renderTarot, huangli: renderHuangli,
      astrology: renderAstrology, liuyao: renderLiuyao, qimen: renderQimen,
      bazi_marriage: renderBaziMarriage, ziwei_marriage: renderZiweiMarriage,
      astrology_marriage: renderAstrologyMarriage }[feat];
    if (fn) {
      fn();
      if (pairAlias && hlApplyMode) hlApplyMode("pair");
      // renderXxx 重建了结果区骨架；若本会话此前有解读快照（reload 后），此刻恢复之。
      // 双人择日是老黄历舞台的别名：快照按 huangli_pair 存、舞台按 huangli 建。
      restoreStageSnap(pairAlias ? "huangli_pair" : feat, feat);
    }
  }

  /* ---------------- 通用渲染块 ---------------- */
  function hero(tag, title, desc) {
    return '<div class="p-hero"><span class="p-hero-tag">' + tag + '</span>' +
      '<h1>' + title + '</h1><p>' + desc + '</p></div>';
  }
  function sec(no, title, body) {
    return '<section class="p-sec"><div class="p-sec-h"><span class="p-sec-no">' + no + '</span><h2>' + title + '</h2></div>' + body + '</section>';
  }
  function term(name, desc) {
    return '<div class="p-term"><b>' + name + '</b><span>' + desc + '</span></div>';
  }
  // 参考站工具页风格：居中的标题 + 一行副标题，不使用编号叙事块
  function toolHero(title, sub) {
    return '<div class="tool-hero"><h1>' + esc(title) + '</h1><p>' + esc(sub) + '</p></div>';
  }
  // 结果区简洁标题（无编号圆圈）
  function resultTitle(t) {
    return '<div class="result-title">' + esc(t) + '</div>';
  }
  // 折叠的使用说明，放在表单下方，默认收起（用原生 details，浏览器自带开合，不依赖脚本）
  /* 折叠说明：不能用原生 <details>——实测在用户的 Chrome 环境里 open 属性生效但内容不渲染；
     用按钮 + .open 类驱动（display 由 CSS 显式控制，不依赖 hidden 属性与 details 机制） */
  function aboutDetails(title, bullets, note) {
    return '<div class="about-details">' +
      '<button class="ad-toggle" type="button" aria-expanded="false"><span class="ad-sign"></span>关于本功能 · 原理与边界</button>' +
      '<div class="ad-body"><h4>' + esc(title) + '</h4><ul>' +
      bullets.map(function (b) { return '<li>' + b + '</li>'; }).join("") +
      '</ul>' + (note ? '<p class="ad-note">' + esc(note) + '</p>' : '') + '</div></div>';
  }
  function steps(items) {
    return '<div class="p-steps">' + items.map(function (it, i) {
      return '<div class="p-step"><span class="p-step-n">' + (i + 1) + '</span><div class="p-step-body">' + it + '</div></div>';
    }).join("") + "</div>";
  }

  /* ---------------- 登录弹层 ---------------- */
  function openAuth() {
    var box = $("#p-auth-content");
    box.innerHTML =
      '<div class="p-auth-head"><h2>欢迎使用 Destiny Master</h2><p>登录或注册账号以使用完整功能</p></div>' +
      '<div class="p-auth-tabs"><button class="on" data-t="login">登录</button><button data-t="reg">注册档案</button></div>' +
      '<div id="p-auth-form"></div>';
    function showForm(t) {
      $$(".p-auth-tabs button", box).forEach(function (b) { b.classList.toggle("on", b.dataset.t === t); });
      var f = $("#p-auth-form", box);
      if (t === "login") {
        f.innerHTML =
          '<div class="p-frow"><label class="p-flabel">用户名</label><input class="p-input" id="au-name" autocomplete="off" /></div>' +
          '<div class="p-frow" style="margin-top:12px"><label class="p-flabel">密码</label><input class="p-input" id="au-pass" type="password" /></div>' +
          '<div class="p-err" id="au-err"></div>' +
          '<button class="auth-submit" id="au-submit">登录 / 注册</button>' +
          '<p class="p-note" style="text-align:center">登录后可保存出生档案、历史提问，获得跨功能的个性化解读。</p>';
      } else {
        f.innerHTML =
          '<div class="p-frow"><label class="p-flabel">用户名（2~24 位字母数字下划线）</label><input class="p-input" id="au-name" maxlength="24" /></div>' +
          '<div class="p-inline" style="margin-top:12px">' +
            '<div class="p-frow"><label class="p-flabel">密码（≥6位）</label><input class="p-input" id="au-pass" type="password" /></div>' +
            '<div class="p-frow"><label class="p-flabel">确认密码</label><input class="p-input" id="au-pass2" type="password" /></div>' +
          '</div>' +
          '<div class="p-frow" style="margin-top:16px">' + birthFieldsHTML("au", { title: "出生信息", compact: true }) + '</div>' +
          '<div class="p-frow" style="margin-top:12px"><label class="p-flabel">性别</label><div class="p-seg" id="au-gender"><button class="on" data-v="男">男</button><button data-v="女">女</button></div></div>' +
          '<div class="p-err" id="au-err"></div>' +
          '<button class="auth-submit" id="au-submit">注册并登录</button>';
        birthFieldsBind("au");
        segBind($("#au-gender", f));
      }
      $("#au-submit", f).onclick = function () { submitAuth(t); };
    }
    $$(".p-auth-tabs button", box).forEach(function (b) { b.onclick = function () { showForm(b.dataset.t); }; });
    showForm("login");
    closeNav();   // 移动端：从抽屉点开登录后先收起抽屉，否则会压住弹窗
    $("#p-modal").classList.remove("hidden");
  }
  function segBind(seg) {
    if (!seg) return;
    $$("button", seg).forEach(function (b) { b.onclick = function () {
      $$("button", seg).forEach(function (x) { x.classList.remove("on"); }); b.classList.add("on");
    }; });
  }
  function segVal(seg) { var b = $(".on", seg || document); return b ? b.dataset.v : ""; }

  /* ---------------- 出生信息控件组（八字页与注册弹窗共用） ----------------
     排版严格按参考样式：标题行右侧「输入方式：日期/八字」，左列出生日期，
     右列「我知道出生时间」开关 + 时/分下拉；日期经「选择日期」弹窗挑选。 */
  var LN_DAYS = (function () {
    var cn = ["一","二","三","四","五","六","七","八","九","十"], out = [];
    for (var i = 1; i <= 30; i++) {
      if (i === 10) out.push("初十");
      else if (i === 20) out.push("二十");
      else if (i === 30) out.push("三十");
      else if (i < 10) out.push("初" + cn[i - 1]);
      else if (i < 20) out.push("十" + cn[i - 11]);
      else out.push("廿" + cn[i - 21]);
    }
    return out;
  })();
  var GZ60 = (function () {
    var G = "甲乙丙丁戊己庚辛壬癸".split(""), Z = "子丑寅卯辰巳午未申酉戌亥".split(""), a = [];
    for (var i = 0; i < 60; i++) a.push(G[i % 10] + Z[i % 12]);
    return a;
  })();
  var CAL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  function birthFieldsHTML(pfx, opts) {
    opts = opts || {};
    var hours = "", mins = "";
    for (var h = 0; h < 24; h++) hours += '<option value="' + h + '">' + h + '时</option>';
    for (var m2 = 0; m2 < 60; m2++) mins += '<option value="' + m2 + '">' + m2 + '分</option>';
    var gzOpts = GZ60.map(function (g) { return '<option>' + g + '</option>'; }).join("");
    // 输入方式切换（日期/八字）与历法切换（阳历/农历）是两件事，分开控制：
    //   noBazi   —— 隐藏「日期/八字」切换（档案、占星等只用日期输入的场景）
    //   noLunar  —— 隐藏「农历」按钮（确无农历转换能力的场景）
    //   simple   —— 兼容旧调用：等价于 noBazi + noLunar
    var hideMode = opts.noBazi || opts.simple;
    var hideLunar = opts.noLunar || opts.simple;
    var head = opts.title ?
      '<div class="bf-head"><span class="bf-title">' + opts.title + '</span>' +
        (hideMode ? '' :
          '<span class="bf-modes">输入方式：<span class="p-seg bf-mode" id="' + pfx + '-mode">' +
            '<button class="on" data-v="date">日期</button><button data-v="bazi">八字</button></span></span>') +
      '</div>' : "";
    var pillars = [["py","年柱"],["pm","月柱"],["pd","日柱"],["pt","时柱"]].map(function (it) {
      return '<div class="tf-field"><label>' + it[1] + '</label><select class="ti" id="' + pfx + '-' + it[0] + '">' + gzOpts + '</select></div>';
    }).join("");
    var mbazi = '<div id="' + pfx + '-mbazi" style="display:none">' +
      '<div class="bf-pillars">' + pillars + '</div>' +
      '<p class="p-note">直接输入已知的四柱干支，系统将反查对应的出生日期后排盘。</p>' +
    '</div>';
    var labDate = '<label class="bf-lab">出生日期</label>';
    var labTime = '<label class="bf-lab" id="' + pfx + '-tlabel" for="' + pfx + '-hour">出生时间</label>';
    var calHTML = '<div class="p-seg bf-cal" id="' + pfx + '-cal"><button class="on" data-v="solar">阳历</button>' +
      (hideLunar ? '' : '<button data-v="lunar">农历</button>') + '</div>';
    var dateHTML = '<button type="button" class="bf-datebtn" id="' + pfx + '-datebtn"><span id="' + pfx + '-datebtn-t">1990年6月15日</span><i>' + CAL_ICON + '</i></button>' +
      '<input type="hidden" id="' + pfx + '-date" value="1990-06-15" />' +
      '<input type="hidden" id="' + pfx + '-ly" value="1990" />' +
      '<input type="hidden" id="' + pfx + '-lm" value="1" />' +
      '<input type="hidden" id="' + pfx + '-ld" value="1" />';
    var knowHTML = '<label class="p-switch"><input type="checkbox" id="' + pfx + '-knowtime" checked /><span>我知道出生时间</span></label>';
    var hintHTML = '<p class="p-note bf-hint" id="' + pfx + '-kthint">如果不知道确切出生时间，可以不选择</p>';
    var timeHTML = '<div class="bf-time" id="' + pfx + '-time">' +
      '<select class="ti" id="' + pfx + '-hour">' + hours + '</select>' +
      '<select class="ti" id="' + pfx + '-minute">' + mins + '</select>' +
    '</div>';
    // roomy（双人表单）专用：标签与它所属控件绑成 .bf-field，段与段之间统一间距。
    // 旧版把标签/控件拆成 6 个 grid item 全用 11px row-gap，标签下空一大截。
    if (opts.roomy) {
      return '<div class="bf-wrap bf-roomy">' + head +
        '<div class="bf-fields">' +
          '<div class="bf-sec"><div class="bf-field">' + labDate + calHTML + '</div>' + dateHTML + '</div>' +
          '<div class="bf-sec">' + knowHTML +
            '<div class="bf-field" id="' + pfx + '-timewrap">' + labTime + timeHTML + '</div>' + hintHTML +
          '</div>' +
        '</div>' + mbazi +
      '</div>';
    }
    return '' +
      '<div class="bf-wrap' + (opts.compact ? " bf-compact" : "") + '">' + head +
        '<div id="' + pfx + '-mdate">' +
          '<div class="bf-grid">' +
            '<div class="bf-a1">' + labDate + '</div>' +
            '<div class="bf-b1">' + labTime + '</div>' +
            '<div class="bf-a2">' + calHTML + '</div>' +
            '<div class="bf-b2">' + knowHTML + hintHTML + '</div>' +
            '<div class="bf-a3">' + dateHTML + '</div>' +
            '<div class="bf-b3">' + timeHTML + '</div>' +
          '</div>' +
        '</div>' + mbazi +
      '</div>';
  }
  var LN_MONTHS = ["正月","二月","三月","四月","五月","六月","七月","八月","九月","十月","冬月","腊月"];
  var CN_DIGITS = ["〇","一","二","三","四","五","六","七","八","九"];
  function cnYear(y) { return String(y).split("").map(function (c) { return CN_DIGITS[+c]; }).join(""); }
  function refreshBirthBtn(pfx) {
    var cal = segVal($("#" + pfx + "-cal")) || "solar";
    var t;
    if (cal === "solar") {
      var v = ($("#" + pfx + "-date").value || "1990-06-15").split("-");
      t = (+v[0]) + "年" + (+v[1]) + "月" + (+v[2]) + "日";
    } else {
      t = "农历 " + cnYear(+$("#" + pfx + "-ly").value || 1990) + "年" +
        LN_MONTHS[(+$("#" + pfx + "-lm").value || 1) - 1] + LN_DAYS[(+$("#" + pfx + "-ld").value || 1) - 1];
    }
    $("#" + pfx + "-datebtn-t").textContent = t;
  }
  function birthSetDate(pfx, y, m, d) {
    $("#" + pfx + "-date").value = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    refreshBirthBtn(pfx);
  }
  function birthSetLunar(pfx, y, m, d) {
    $("#" + pfx + "-ly").value = y; $("#" + pfx + "-lm").value = m; $("#" + pfx + "-ld").value = d;
    refreshBirthBtn(pfx);
  }
  // 绑定控件组行为；init = {mode, calendar, year, month, day, hour, minute, know_time, pillars}
  function birthFieldsBind(pfx, init) {
    var cal = (init && init.calendar) || "solar";
    function applyCal() { refreshBirthBtn(pfx); }
    $$("#" + pfx + "-cal button").forEach(function (b) {
      b.onclick = function () { segSet($("#" + pfx + "-cal"), b.dataset.v); applyCal(); };
    });
    $("#" + pfx + "-datebtn").onclick = function () {
      if (segVal($("#" + pfx + "-cal")) === "lunar") openLunarPicker(pfx);
      else openDatePicker(pfx);
    };
    function applyTime() {
      var kt = $("#" + pfx + "-knowtime").checked;
      var t = $("#" + pfx + "-time"), l = $("#" + pfx + "-tlabel"), h = $("#" + pfx + "-kthint");
      if (t) t.style.display = kt ? "grid" : "none";
      if (l) l.style.display = kt ? "" : "none";
      if (h) h.style.display = kt ? "none" : "";
      // roomy 结构里标签与控件同属 .bf-field，整体隐藏才不会留下空标签位
      var wrap = $("#" + pfx + "-timewrap");
      if (wrap) wrap.style.display = kt ? "" : "none";
    }
    $("#" + pfx + "-knowtime").onchange = applyTime;
    function applyMode() {
      var modeEl = $("#" + pfx + "-mode");
      var v = modeEl ? (segVal(modeEl) || "date") : "date";  // simple 模式无切换器，固定日期
      var mdate = $("#" + pfx + "-mdate"), mbazi = $("#" + pfx + "-mbazi");
      if (mdate) mdate.style.display = v === "date" ? "" : "none";
      if (mbazi) mbazi.style.display = v === "bazi" ? "" : "none";
    }
    $$("#" + pfx + "-mode button").forEach(function (b) {
      b.onclick = function () { segSet($("#" + pfx + "-mode"), b.dataset.v); applyMode(); };
    });
    if (init) {
      if (init.mode && $("#" + pfx + "-mode")) segSet($("#" + pfx + "-mode"), init.mode);
      segSet($("#" + pfx + "-cal"), cal);
      if (init.year) {
        if (cal === "lunar") birthSetLunar(pfx, init.year, init.month, init.day);
        else birthSetDate(pfx, init.year, init.month, init.day);
      }
      if (init.pillars) {
        $("#" + pfx + "-py").value = init.pillars.year;
        $("#" + pfx + "-pm").value = init.pillars.month;
        $("#" + pfx + "-pd").value = init.pillars.day;
        $("#" + pfx + "-pt").value = init.pillars.time;
      }
      if (init.hour != null) $("#" + pfx + "-hour").value = String(init.hour);
      if (init.minute != null) $("#" + pfx + "-minute").value = String(init.minute);
      $("#" + pfx + "-knowtime").checked = init.know_time !== false;
    }
    applyCal(); applyTime(); applyMode();
  }
  // 收集控件组数值；日期方式 {mode:"date", calendar, year, month, day, hour, minute, know_time}
  // 八字方式 {mode:"bazi", pillar_year, pillar_month, pillar_day, pillar_time}
  function birthCollect(pfx) {
    var modeEl = $("#" + pfx + "-mode");
    var mode = modeEl ? (segVal(modeEl) || "date") : "date";
    if (mode === "bazi") {
      return { mode: "bazi",
        pillar_year: $("#" + pfx + "-py").value, pillar_month: $("#" + pfx + "-pm").value,
        pillar_day: $("#" + pfx + "-pd").value, pillar_time: $("#" + pfx + "-pt").value };
    }
    var cal = segVal($("#" + pfx + "-cal")) || "solar";
    var out = { mode: "date", calendar: cal };
    if (cal === "solar") {
      var d = $("#" + pfx + "-date").value.split("-");
      out.year = +d[0]; out.month = +d[1]; out.day = +d[2];
    } else {
      out.year = +$("#" + pfx + "-ly").value || 1990;
      out.month = +$("#" + pfx + "-lm").value || 1;
      out.day = +$("#" + pfx + "-ld").value || 1;
    }
    var kt = $("#" + pfx + "-knowtime").checked;
    out.know_time = kt;
    out.hour = kt ? (+$("#" + pfx + "-hour").value || 0) : 12;
    out.minute = kt ? (+$("#" + pfx + "-minute").value || 0) : 0;
    return out;
  }

  /* ---------------- 出生地三级联动（国家 / 省份 / 城市） ----------------
     数据源：中国全部省级行政区（含港澳台）+ 主要城市，另含常见国家/地区。
     每项 = [城市名, 纬度, 经度, 时区]；中国城市统一东八区。
     与出生日期时间一起构成档案共用的出生信息，供八字/占星等排盘。 */
  // 三级出生地数据：[名称, 纬度, 经度, UTC时区]。中国覆盖 34 个省级行政区的主要地级市。
  var GEO_DATA = {
    "中国": {
      "北京市": [["北京",39.9042,116.4074,8]],
      "天津市": [["天津",39.3434,117.3616,8]],
      "上海市": [["上海",31.2304,121.4737,8]],
      "重庆市": [["重庆",29.5630,106.5516,8]],
      "河北省": [["石家庄",38.0428,114.5149,8],["唐山",39.6305,118.1802,8],["秦皇岛",39.9354,119.6005,8],["邯郸",36.6256,114.5391,8],["邢台",37.0681,114.5048,8],["保定",38.8740,115.4646,8],["张家口",40.7688,114.8860,8],["承德",40.9515,117.9638,8],["沧州",38.3036,116.8388,8],["廊坊",39.5379,116.6836,8],["衡水",37.7391,115.6696,8]],
      "山西省": [["太原",37.8706,112.5489,8],["大同",40.0768,113.3001,8],["阳泉",37.8576,113.5801,8],["长治",36.1953,113.1164,8],["晋城",35.4906,112.8514,8],["朔州",39.3319,112.4327,8],["晋中",37.6870,112.7523,8],["运城",35.0263,111.0038,8],["忻州",38.4174,112.7343,8],["临汾",36.0880,111.5190,8],["吕梁",37.5185,111.1441,8]],
      "辽宁省": [["沈阳",41.8057,123.4315,8],["大连",38.9140,121.6147,8],["鞍山",41.1086,122.9944,8],["抚顺",41.8385,123.9560,8],["本溪",41.2974,123.7533,8],["丹东",40.1242,124.3640,8],["锦州",41.0953,121.1215,8],["营口",40.6715,122.2330,8],["阜新",42.0219,121.6694,8],["辽阳",41.2697,123.1704,8],["盘锦",41.1248,122.0706,8],["铁岭",42.2241,123.8394,8],["朝阳",41.5738,120.4512,8],["葫芦岛",40.7116,120.8275,8]],
      "吉林省": [["长春",43.8171,125.3235,8],["吉林",43.8379,126.5496,8],["四平",43.1658,124.3506,8],["辽源",42.9024,125.1444,8],["通化",41.7231,125.9400,8],["白山",41.9390,126.4243,8],["松原",45.1407,124.8250,8],["白城",45.6192,122.8406,8],["延吉",42.9048,129.5077,8]],
      "黑龙江省": [["哈尔滨",45.8038,126.5349,8],["齐齐哈尔",47.3543,123.9181,8],["鸡西",45.2950,130.9798,8],["鹤岗",47.2584,130.2823,8],["双鸭山",46.6370,131.1637,8],["大庆",46.5891,125.1143,8],["伊春",47.7276,128.8993,8],["佳木斯",46.8196,130.3613,8],["七台河",45.7687,130.8329,8],["牡丹江",44.5548,129.6386,8],["黑河",50.2450,127.5281,8],["绥化",46.6391,126.9823,8]],
      "江苏省": [["南京",32.0603,118.7969,8],["无锡",31.4912,120.3119,8],["徐州",34.2058,117.2847,8],["常州",31.8108,119.9736,8],["苏州",31.2989,120.5853,8],["南通",31.9802,120.8944,8],["连云港",34.5966,119.2217,8],["淮安",33.5979,119.0213,8],["盐城",33.3452,120.1625,8],["扬州",32.3936,119.4128,8],["镇江",32.1874,119.4254,8],["泰州",32.4558,119.9231,8],["宿迁",33.9631,118.2755,8]],
      "浙江省": [["杭州",30.2741,120.1551,8],["宁波",29.8683,121.5440,8],["温州",27.9938,120.6993,8],["嘉兴",30.7461,120.7554,8],["湖州",30.8932,120.0867,8],["绍兴",30.0304,120.5826,8],["金华",29.0792,119.6547,8],["衢州",28.9369,118.8557,8],["舟山",30.0183,122.1069,8],["台州",28.6560,121.4208,8],["丽水",28.4543,119.9211,8]],
      "安徽省": [["合肥",31.8206,117.2272,8],["芜湖",31.3529,118.4334,8],["蚌埠",32.9170,117.3898,8],["淮南",32.6255,117.0004,8],["马鞍山",31.6704,118.5073,8],["淮北",33.9524,116.7983,8],["铜陵",30.9451,117.8129,8],["安庆",30.5431,117.0518,8],["黄山",29.7176,118.3374,8],["滁州",32.3018,118.3169,8],["阜阳",32.8897,115.8180,8],["宿州",33.6461,116.9870,8],["六安",31.7537,116.5034,8],["亳州",33.8445,115.7785,8],["池州",30.6565,117.4911,8],["宣城",30.9456,118.7583,8]],
      "福建省": [["福州",26.0745,119.2965,8],["厦门",24.4798,118.0894,8],["莆田",25.4315,119.2408,8],["三明",26.2658,117.6124,8],["泉州",24.8742,118.6757,8],["漳州",24.5124,117.6477,8],["南平",26.6374,118.1799,8],["龙岩",25.0912,117.0287,8],["宁德",26.6597,119.5496,8]],
      "江西省": [["南昌",28.6829,115.8581,8],["景德镇",29.2713,117.1772,8],["萍乡",27.6210,113.8543,8],["九江",29.7127,116.0018,8],["新余",27.8175,114.9277,8],["鹰潭",28.2457,117.0322,8],["赣州",25.8315,114.9355,8],["吉安",27.1121,114.9928,8],["宜春",27.8113,114.3782,8],["抚州",27.9798,116.3578,8],["上饶",28.4545,117.9439,8]],
      "山东省": [["济南",36.6512,117.1201,8],["青岛",36.0671,120.3826,8],["淄博",36.8135,118.0551,8],["枣庄",34.8107,117.3182,8],["东营",37.4360,118.6737,8],["烟台",37.4636,121.4479,8],["潍坊",36.7070,119.1613,8],["济宁",35.4142,116.5871,8],["泰安",36.1953,117.0938,8],["威海",37.5139,122.1247,8],["日照",35.4155,119.5268,8],["临沂",35.1043,118.3564,8],["德州",37.4367,116.3590,8],["聊城",36.4545,115.9859,8],["滨州",37.3820,117.9690,8],["菏泽",35.2346,115.4809,8]],
      "河南省": [["郑州",34.7466,113.6254,8],["开封",34.7972,114.3116,8],["洛阳",34.6197,112.4540,8],["平顶山",33.7713,113.1929,8],["安阳",36.1039,114.3930,8],["鹤壁",35.7488,114.2934,8],["新乡",35.3027,113.9269,8],["焦作",35.2223,113.2424,8],["濮阳",35.7615,115.0273,8],["许昌",34.0357,113.8346,8],["漯河",33.5820,114.0261,8],["三门峡",34.7765,111.1941,8],["南阳",32.9906,112.5284,8],["商丘",34.4109,115.6506,8],["信阳",32.1470,114.0890,8],["周口",33.6294,114.6505,8],["驻马店",32.9795,114.0224,8]],
      "湖北省": [["武汉",30.5928,114.3055,8],["黄石",30.1998,115.0388,8],["十堰",32.6293,110.7982,8],["宜昌",30.6919,111.2865,8],["襄阳",32.0090,112.1224,8],["鄂州",30.3961,114.8906,8],["荆门",31.0357,112.1994,8],["孝感",30.9259,113.9136,8],["荆州",30.3350,112.2390,8],["黄冈",30.4476,114.8724,8],["咸宁",29.8680,114.3286,8],["随州",31.6901,113.3829,8],["恩施",30.2714,109.4825,8]],
      "湖南省": [["长沙",28.2282,112.9388,8],["株洲",27.8270,113.1339,8],["湘潭",27.8290,112.9414,8],["衡阳",26.8937,112.5715,8],["邵阳",27.2438,111.4693,8],["岳阳",29.3704,113.1290,8],["常德",29.0520,111.7048,8],["张家界",29.1324,110.4793,8],["益阳",28.5801,112.3558,8],["郴州",25.7758,113.0087,8],["永州",26.4234,111.6082,8],["怀化",27.5497,109.9787,8],["娄底",27.7005,112.0008,8],["湘西",28.3116,109.7395,8]],
      "广东省": [["广州",23.1291,113.2644,8],["韶关",24.8019,113.5945,8],["深圳",22.5431,114.0579,8],["珠海",22.2707,113.5767,8],["汕头",23.3541,116.6816,8],["佛山",23.0218,113.1214,8],["江门",22.5789,113.0944,8],["湛江",21.2707,110.3588,8],["茂名",21.6636,110.9193,8],["肇庆",23.0473,112.4692,8],["惠州",23.1116,114.4166,8],["梅州",24.2879,116.1228,8],["汕尾",22.7857,115.3758,8],["河源",23.7439,114.6970,8],["阳江",21.8578,111.9765,8],["清远",23.6824,113.0562,8],["东莞",23.0207,113.7518,8],["中山",22.5177,113.3926,8],["潮州",23.6564,116.6225,8],["揭阳",22.5277,116.3732,8],["云浮",22.9217,112.0260,8]],
      "广西壮族自治区": [["南宁",22.8170,108.3669,8],["柳州",24.3264,109.4287,8],["桂林",25.2736,110.2900,8],["梧州",23.4768,111.3079,8],["北海",21.4814,109.1200,8],["防城港",21.6146,108.3534,8],["钦州",21.9785,108.6243,8],["贵港",23.0959,109.6028,8],["玉林",22.6552,110.1800,8],["百色",23.9024,106.6149,8],["贺州",24.3966,111.5678,8],["河池",24.6904,108.0753,8],["来宾",23.7490,109.2307,8],["崇左",22.3763,107.3648,8]],
      "海南省": [["海口",20.0442,110.1999,8],["三亚",18.2528,109.5119,8],["三沙",16.8300,112.3400,8],["儋州",19.5215,109.5789,8]],
      "四川省": [["成都",30.5728,104.0668,8],["自贡",29.5658,104.7753,8],["攀枝花",26.5806,101.7186,8],["泸州",28.8700,105.4435,8],["德阳",31.1317,104.3978,8],["绵阳",31.4674,104.6796,8],["广元",32.4356,105.8431,8],["遂宁",30.5247,105.5926,8],["内江",29.5739,104.6801,8],["乐山",29.5564,103.7658,8],["南充",30.8343,106.0851,8],["眉山",30.0488,103.8500,8],["宜宾",28.7667,104.6417,8],["广安",30.4743,106.6333,8],["达州",31.2081,107.5015,8],["雅安",29.9806,103.0126,8],["巴中",31.8716,106.7534,8],["资阳",30.1223,104.6417,8]],
      "贵州省": [["贵阳",26.6470,106.6302,8],["六盘水",26.5930,104.8303,8],["遵义",27.7259,106.9270,8],["安顺",26.2549,105.9478,8],["毕节",27.3019,105.2897,8],["铜仁",27.7176,109.2020,8],["兴义",25.0881,104.8957,8],["凯里",26.5836,107.9687,8],["都匀",26.2584,107.5178,8]],
      "云南省": [["昆明",25.0389,102.7183,8],["曲靖",25.5012,103.7975,8],["玉溪",24.3505,102.5475,8],["保山",25.1115,99.1617,8],["昭通",27.5520,103.7176,8],["丽江",26.8721,100.2327,8],["普洱",22.7803,100.9785,8],["临沧",23.8869,100.0892,8],["楚雄",25.0466,101.5239,8],["个旧",23.3549,103.1532,8],["文山",23.3732,104.2440,8],["景洪",22.0036,100.7968,8],["大理",25.6065,100.2676,8],["芒市",24.4308,98.5845,8],["香格里拉",27.8250,99.7060,8]],
      "西藏自治区": [["拉萨",29.6520,91.1721,8],["日喀则",29.2677,88.8812,8],["昌都",31.1366,97.1770,8],["林芝",29.6465,94.3626,8],["山南",29.2390,91.7735,8],["那曲",31.4765,92.0600,8],["阿里",32.5000,80.1000,8]],
      "陕西省": [["西安",34.3416,108.9398,8],["铜川",34.8967,108.9446,8],["宝鸡",34.3616,107.2363,8],["咸阳",34.3297,108.7092,8],["渭南",34.5008,109.5108,8],["延安",36.5859,109.4809,8],["汉中",33.0676,107.0238,8],["榆林",38.2855,109.7347,8],["安康",32.6906,109.0290,8],["商洛",33.8736,109.9401,8]],
      "甘肃省": [["兰州",36.0611,103.8343,8],["嘉峪关",39.7715,98.2890,8],["金昌",38.5147,102.1876,8],["白银",36.5559,104.1393,8],["天水",34.5809,105.7249,8],["武威",37.9267,102.6411,8],["张掖",38.9253,100.4498,8],["平凉",35.5424,106.6655,8],["酒泉",39.7306,98.5120,8],["庆阳",35.7340,107.6384,8],["定西",35.5804,104.6260,8],["陇南",33.4010,104.9318,8],["临夏",35.6005,103.2121,8],["合作",34.9780,102.9127,8]],
      "青海省": [["西宁",36.6171,101.7782,8],["海东",36.5026,102.1041,8],["海北",36.8860,100.9000,8],["黄南",35.5180,102.0100,8],["海南州",36.2830,100.6200,8],["果洛",34.4800,99.9900,8],["玉树",33.0000,97.0100,8],["海西",37.3700,97.3700,8]],
      "宁夏回族自治区": [["银川",38.4872,106.2309,8],["石嘴山",39.0230,106.3820,8],["吴忠",37.9906,106.1990,8],["固原",36.0164,106.2414,8],["中卫",37.4579,105.1897,8]],
      "新疆维吾尔自治区": [["乌鲁木齐",43.8256,87.6168,8],["克拉玛依",45.5996,84.8893,8],["吐鲁番",42.9500,89.1900,8],["哈密",42.8330,93.5100,8],["昌吉",44.0100,87.3000,8],["博乐",44.9030,82.0740,8],["库尔勒",41.7250,86.1700,8],["阿克苏",41.1700,80.2600,8],["阿图什",39.7130,76.1680,8],["喀什",39.4704,75.9898,8],["和田",37.1120,79.9220,8],["伊宁",43.9220,81.3179,8],["塔城",46.7460,82.9850,8],["阿勒泰",47.8480,88.1390,8]],
      "内蒙古自治区": [["呼和浩特",40.8426,111.7492,8],["包头",40.6575,109.8403,8],["乌海",39.7020,106.7950,8],["赤峰",42.2580,118.9565,8],["通辽",43.6520,122.2430,8],["鄂尔多斯",39.8200,109.9900,8],["呼伦贝尔",49.2120,119.7660,8],["巴彦淖尔",40.7420,107.3870,8],["乌兰察布",40.9940,113.1330,8],["乌兰浩特",46.0580,122.0360,8],["锡林浩特",43.9330,116.0470,8],["阿拉善左旗",38.8300,105.6700,8]],
      "香港特别行政区": [["香港",22.3193,114.1694,8]],
      "澳门特别行政区": [["澳门",22.1987,113.5439,8]],
      "台湾省": [["台北",25.0330,121.5654,8],["新北",25.0110,121.4200,8],["桃园",24.9937,121.3011,8],["台中",24.1477,120.6736,8],["台南",23.0000,120.2000,8],["高雄",22.6273,120.3014,8],["基隆",25.1330,121.7400,8],["新竹",24.8039,120.9698,8],["嘉义",23.4800,120.4500,8]]
    },
    "新加坡": { "新加坡": [["新加坡",1.3521,103.8198,8]] },
    "日本": { "关东": [["东京",35.6895,139.6917,9],["横滨",35.4437,139.6380,9],["埼玉",35.8600,139.6500,9]], "关西": [["大阪",34.6937,135.5023,9],["京都",35.0116,135.7681,9],["神户",34.6901,135.1955,9]], "中部": [["名古屋",35.1815,136.9066,9]], "九州": [["福冈",33.5904,130.4017,9]], "北海道": [["札幌",43.0618,141.3545,9]] },
    "韩国": { "京畿道": [["首尔",37.5665,126.9780,9]], "庆尚南道": [["釜山",35.1796,129.0756,9]], "仁川": [["仁川",37.4563,126.7052,9]], "大邱": [["大邱",35.8714,128.6014,9]], "大田": [["大田",36.3504,127.3845,9]], "光州": [["光州",35.1595,126.8526,9]] },
    "马来西亚": { "雪兰莪": [["吉隆坡",3.1390,101.6869,8]], "槟城": [["槟城",5.4141,100.3288,8]], "柔佛": [["新山",1.4927,103.7414,8]], "马六甲": [["马六甲",2.1896,102.2501,8]] },
    "泰国": { "曼谷": [["曼谷",13.7563,100.5018,7]], "清迈": [["清迈",18.7883,98.9853,7]], "普吉": [["普吉",7.8804,98.3923,7]], "芭提雅": [["芭提雅",12.9236,100.8825,7]] },
    "越南": { "河内": [["河内",21.0278,105.8342,7]], "胡志明市": [["胡志明市",10.8231,106.6297,7]], "岘港": [["岘港",16.0680,108.2239,7]] },
    "美国": { "加利福尼亚州": [["洛杉矶",34.0522,-118.2437,-8],["旧金山",37.7749,-122.4194,-8],["圣迭戈",32.7157,-117.1611,-8],["圣何塞",37.3382,-121.8863,-8]], "纽约州": [["纽约",40.7128,-74.0060,-5],["布法罗",42.8864,-78.8784,-5]], "华盛顿州": [["西雅图",47.6062,-122.3321,-8]], "德克萨斯州": [["休斯顿",29.7604,-95.3698,-6],["达拉斯",32.7767,-96.7970,-6]], "伊利诺伊州": [["芝加哥",41.8781,-87.6298,-6]], "马萨诸塞州": [["波士顿",42.3601,-71.0589,-5]], "夏威夷州": [["檀香山",21.3069,-157.8583,-10]] },
    "加拿大": { "安大略省": [["多伦多",43.6532,-79.3832,-5],["渥太华",45.4215,-75.6972,-5]], "不列颠哥伦比亚省": [["温哥华",49.2827,-123.1207,-8]], "魁北克省": [["蒙特利尔",45.5017,-73.5673,-5]], "阿尔伯塔省": [["卡尔加里",51.0447,-114.0719,-7],["埃德蒙顿",53.5461,-113.4938,-7]] },
    "英国": { "英格兰": [["伦敦",51.5074,-0.1278,0],["曼彻斯特",53.4808,-2.2426,0],["伯明翰",52.4862,-1.8904,0]], "苏格兰": [["爱丁堡",55.9533,-3.1883,0],["格拉斯哥",55.8642,-4.2518,0]] },
    "澳大利亚": { "新南威尔士州": [["悉尼",-33.8688,151.2093,10]], "维多利亚州": [["墨尔本",-37.8136,144.9631,10]], "昆士兰州": [["布里斯班",-27.4698,153.0251,10]], "西澳大利亚州": [["珀斯",-31.9505,115.8605,8]], "南澳大利亚州": [["阿德莱德",-34.9285,138.6007,10]] },
    "法国": { "法兰西岛": [["巴黎",48.8566,2.3522,1]], "奥弗涅-罗讷-阿尔卑斯": [["里昂",45.7640,4.8357,1]], "普罗旺斯-阿尔卑斯-蓝色海岸": [["马赛",43.2965,5.3698,1]] },
    "德国": { "柏林": [["柏林",52.5200,13.4050,1]], "巴伐利亚": [["慕尼黑",48.1351,11.5820,1]], "北莱茵-威斯特法伦": [["科隆",50.9375,6.9603,1],["杜塞尔多夫",51.2277,6.7735,1]], "汉堡": [["汉堡",53.5511,9.9937,1]] },
    "新西兰": { "奥克兰": [["奥克兰",-36.8485,174.7633,12]], "惠灵顿": [["惠灵顿",-41.2865,174.7762,12]] }
  };
  function placeFieldsHTML(pfx, opts) {
    opts = opts || {};
    return '<div class="place-fields" id="' + pfx + '-place">' +
      '<div class="pl-grid">' +
        '<div class="pl-col"><label class="bf-lab">国家 / 地区</label><select class="ti" id="' + pfx + '-country"></select></div>' +
        '<div class="pl-col"><label class="bf-lab">省 / 州</label><select class="ti" id="' + pfx + '-province"></select></div>' +
        '<div class="pl-col"><label class="bf-lab">城市</label><select class="ti" id="' + pfx + '-city"></select></div>' +
      '</div>' +
      '<input type="hidden" id="' + pfx + '-lat" /><input type="hidden" id="' + pfx + '-lon" /><input type="hidden" id="' + pfx + '-tz" />' +
      '<p class="p-note pl-hint">' + esc(opts.hint || "出生地决定占星的上升与宫位；列表未含的城市可选邻近城市或手动调整经纬度。") + '</p>' +
    '</div>';
  }
  // 绑定三级联动；init = {country, province, city, lat, lon, tz}
  function placeFieldsBind(pfx, init) {
    init = init || {};
    var cEl = $("#" + pfx + "-country"), pEl = $("#" + pfx + "-province"), ctyEl = $("#" + pfx + "-city");
    function fillProvinces(keep) {
      var provs = GEO_DATA[cEl.value] || {};
      var keys = Object.keys(provs);
      pEl.innerHTML = keys.map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + '</option>'; }).join("");
      if (keep && provs[keep]) pEl.value = keep;
      fillCities(init && init.city);
    }
    function fillCities(keep) {
      var cities = (GEO_DATA[cEl.value] || {})[pEl.value] || [];
      ctyEl.innerHTML = cities.map(function (c) { return '<option value="' + esc(c[0]) + '" data-lat="' + c[1] + '" data-lon="' + c[2] + '" data-tz="' + c[3] + '">' + esc(c[0]) + '</option>'; }).join("");
      var chosen = keep && ctyEl.querySelector('option[value="' + String(keep).replace(/"/g, '\\"') + '"]');
      if (chosen) ctyEl.value = keep;
      applyGeo();
    }
    function applyGeo() {
      var o = ctyEl.options[ctyEl.selectedIndex];
      $("#" + pfx + "-lat").value = o ? (o.dataset.lat || "") : "";
      $("#" + pfx + "-lon").value = o ? (o.dataset.lon || "") : "";
      $("#" + pfx + "-tz").value = o ? (o.dataset.tz || 8) : 8;
    }
    cEl.innerHTML = Object.keys(GEO_DATA).map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + '</option>'; }).join("");
    cEl.onchange = function () { init = null; fillProvinces(); };
    pEl.onchange = function () { init = null; fillCities(); };
    ctyEl.onchange = applyGeo;
    // 回填档案：优先按名称精确匹配三级；匹配不到但有经纬度时，补一个"自定义"城市项
    var country = init.country || "中国";
    var prov = init.province || "", city = init.city || "";
    if (!GEO_DATA[country]) country = "中国";
    cEl.value = country;
    var provs = GEO_DATA[country] || {};
    if (!provs[prov]) prov = Object.keys(provs)[0] || "";
    pEl.innerHTML = Object.keys(provs).map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + '</option>'; }).join("");
    pEl.value = prov;
    var cities = provs[prov] || [];
    var found = cities.some(function (c) { return c[0] === city; });
    if (city && !found && init.lat != null && init.lon != null) {
      cities = cities.slice();
      cities.push([city, init.lat, init.lon, init.tz != null ? init.tz : 8]);
    }
    ctyEl.innerHTML = cities.map(function (c) { return '<option value="' + esc(c[0]) + '" data-lat="' + c[1] + '" data-lon="' + c[2] + '" data-tz="' + c[3] + '">' + esc(c[0]) + '</option>'; }).join("");
    if (city && ctyEl.querySelector('option[value="' + String(city).replace(/"/g, '\\"') + '"]')) ctyEl.value = city;
    if ((!city || !found) && init.lat != null && init.lon != null && city) {
      ctyEl.value = city; // 自定义项已追加
    }
    applyGeo();
  }
  function placeCollect(pfx) {
    var co = $("#" + pfx + "-country").value;
    var pr = $("#" + pfx + "-province").value;
    var city = $("#" + pfx + "-city").value;
    var lat = $("#" + pfx + "-lat").value, lon = $("#" + pfx + "-lon").value, tz = $("#" + pfx + "-tz").value || 8;
    return { country: co, province: pr, city: city, place: (co === "中国" ? pr.replace(/(省|市|自治区|特别行政区)$/, "") : co) + (city ? "·" + city : ""),
             lat: lat === "" ? null : +lat, lon: lon === "" ? null : +lon, tz: +tz };
  }

  /* ---------------- 双人表单共用组件（八字合婚 / 紫微合婚 / 双人择日复用） ----------------
     两人并列、字段完全一致：姓名 + 性别 + 出生信息 + 出生地 + 导入本人信息。
     不默认带入档案；登录用户点「导入本人信息」才把档案填入当前这一方。 */
  function pairPersonHTML(pfx, side, label) {
    return '<div class="mrg-person">' +
      '<div class="mrg-ph"><span>' + esc(label) + '</span>' +
        (S.profile ? '<button type="button" class="mrg-import" data-import="' + pfx + '">导入本人信息</button>' : '') +
      '</div>' +
      '<div class="tf-grid">' +
        '<div class="tf-field"><label>姓名</label><input class="ti" id="' + pfx + '-name" placeholder="如：' + esc(side) + '方" /></div>' +
        '<div class="tf-field"><label>性别</label><select class="ti" id="' + pfx + '-gender">' +
          '<option' + (side === "男" ? " selected" : "") + '>男</option>' +
          '<option' + (side === "女" ? " selected" : "") + '>女</option></select></div>' +
      '</div>' +
      birthFieldsHTML(pfx, { title: "出生信息", noBazi: true, roomy: true }) +
      '<label class="p-switch mrg-zz"><input type="checkbox" id="' + pfx + '-earlyzi" /><span>早晚子时</span></label>' +
      placeFieldsHTML(pfx, { hint: "出生地用于真太阳时校正，未收录城市可选邻近城市。" }) +
    '</div>';
  }
  function pairFormHTML(pfxA, pfxB, note) {
    return '<div class="mrg-pair">' + pairPersonHTML(pfxA, "男", "男方信息") +
      pairPersonHTML(pfxB, "女", "女方信息") + '</div>' +
      (note ? '<p class="p-note mrg-pair-note">' + esc(note) + '</p>' : '');
  }
  function pairFormBind(pfxA, pfxB) {
    [pfxA, pfxB].forEach(function (p) { birthFieldsBind(p); placeFieldsBind(p); });
    $$(".mrg-import[data-import]").forEach(function (btn) {
      btn.onclick = function () {
        if (!S.profile) { requireLogin(); return; }
        var pfx = btn.getAttribute("data-import");
        fetch("/api/profile/get?id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token))
          .then(function (r) { return r.json(); }).then(function (d) {
            var b = d.ok && d.profile && d.profile.birth;
            if (!b || !(b.year || b.date)) { toast("档案中还没有完整出生信息，请先到个人中心补全"); return; }
            var seg = String(b.date || "").split("-");
            birthFieldsBind(pfx, { calendar: b.calendar || "solar",
              year: b.year || +seg[0], month: b.month || +seg[1], day: b.day || +seg[2],
              hour: b.hour != null ? b.hour : 12, minute: b.minute != null ? b.minute : 0,
              know_time: b.know_time !== false });
            placeFieldsBind(pfx, b);
            var nameEl = $("#" + pfx + "-name"), genderEl = $("#" + pfx + "-gender");
            if (nameEl && S.profile.name) nameEl.value = S.profile.name;
            if (genderEl) genderEl.value = (b.gender === "female" ? "女" : b.gender === "male" ? "男" : (b.gender || genderEl.value));
            toast("已导入本人信息，可继续修改");
          }).catch(function () { toast("读取档案失败，请重试"); });
      };
    });
  }
  function pairCollect(pfx, label, errSel) {
    var b = birthCollect(pfx);
    var err = $(errSel);
    if (b.mode === "bazi") { if (err) err.textContent = "请使用日期方式填写" + label + "的出生信息"; return null; }
    if (!b.year || !b.month || !b.day) { if (err) err.textContent = "请完整填写" + label + "的出生日期"; return null; }
    var pl = placeCollect(pfx);
    ["country", "province", "city", "place", "lat", "lon", "tz"].forEach(function (k) { b[k] = pl[k]; });
    return b;
  }
  function pairFormParams(pfxA, pfxB, errSel, opts) {
    var err = $(errSel);
    if (err) err.textContent = "";
    var a = pairCollect(pfxA, "男方", errSel);
    if (!a) return null;
    var b = pairCollect(pfxB, "女方", errSel);
    if (!b) return null;
    var out = [];
    // bothPlaces：占星合盘双方都要出生地（宫位按各自出生地算）；八字/紫微合婚只需男方的一组。
    var bothPlaces = !!(opts && opts.bothPlaces);
    function put(p, prefix, pfx) {
      var gender = $("#" + pfx + "-gender").value;
      var name = ($("#" + pfx + "-name").value || "").trim();
      out.push(prefix + "year=" + p.year, prefix + "month=" + p.month, prefix + "day=" + p.day,
        prefix + "hour=" + p.hour, prefix + "minute=" + p.minute, prefix + "calendar=" + p.calendar,
        prefix + "gender=" + encodeURIComponent(gender), prefix + "name=" + encodeURIComponent(name));
      if (!prefix || bothPlaces) {
        ["country", "province", "city", "place", "lat", "lon", "tz"].forEach(function (k) {
          if (p[k] !== null && p[k] !== undefined && p[k] !== "") out.push(prefix + k + "=" + encodeURIComponent(p[k]));
        });
      }
    }
    put(a, "", pfxA);
    put(b, "p2_", pfxB);
    // v116：把表单里这双方的信息存为 Person 快照，供对话对象导入（合婚/双人择日）。
    // 与查询串同源，避免「AI 读的年份 ≠ 用户填的年份」这类脱节。
    if (typeof setPartner === "function") {
      setPartner(new Core.Person({
        role: "partner",
        name: ($("#" + pfxB + "-name").value || "").trim(),
        gender: $("#" + pfxB + "-gender").value,
        birth: b
      }));
    }
    return out.join("&");
  }

  /* ---------------- 「选择日期」弹窗（年月下拉 + 周一起始月历网格） ---------------- */
  var DP_CN_M = ["一月","二月","三月","四月","五月","六月","七月","八月","九月","十月","十一月","十二月"];
  var dpEl = null, dpPfx = null, dpY = 0, dpM = 1, dpOnPick = null, dpPickVal = "";
  function dpSync() {
    $("#dp-y", dpEl).value = String(dpY);
    $("#dp-m", dpEl).value = String(dpM);
  }
  function dpRender() {
    $("#dp-cap", dpEl).textContent = DP_CN_M[dpM - 1] + " " + dpY;
    var lead = (new Date(dpY, dpM - 1, 1).getDay() + 6) % 7;   // 周一起始
    var dim = new Date(dpY, dpM, 0).getDate();
    var prevDim = new Date(dpY, dpM - 1, 0).getDate();
    var total = Math.ceil((lead + dim) / 7) * 7;
    var sel = dpOnPick ? String(dpPickVal || "").split("-").map(Number)
                       : (($("#" + dpPfx + "-date") || { value: "" }).value || "").split("-").map(Number);
    var td = new Date();
    var html = "";
    for (var i = 0; i < total; i++) {
      var dnum, mm, yy, cls = "dp-cell";
      if (i < lead) { dnum = prevDim - lead + 1 + i; mm = dpM - 1; yy = dpY; cls += " dim"; if (mm < 1) { mm = 12; yy--; } }
      else if (i >= lead + dim) { dnum = i - lead - dim + 1; mm = dpM + 1; yy = dpY; cls += " dim"; if (mm > 12) { mm = 1; yy++; } }
      else { dnum = i - lead + 1; mm = dpM; yy = dpY; }
      if (sel.length === 3 && sel[0] === yy && sel[1] === mm && sel[2] === dnum) cls += " sel";
      else if (yy === td.getFullYear() && mm === td.getMonth() + 1 && dnum === td.getDate()) cls += " today";
      html += '<div class="' + cls + '" data-y="' + yy + '" data-m="' + mm + '" data-d="' + dnum + '">' + dnum + '</div>';
    }
    $("#dp-grid", dpEl).innerHTML = html;
  }
  function dpEnsure() {
    if (dpEl) return;
    dpEl = document.createElement("div");
    dpEl.className = "dp-mask hidden";
    dpEl.innerHTML =
      '<div class="dp-modal">' +
        '<div class="dp-head"><b>选择日期</b><button type="button" class="dp-x">✕</button></div>' +
        '<div class="dp-ym"><select class="ti" id="dp-y"></select><select class="ti" id="dp-m">' +
          DP_CN_M.map(function (t, i) { return '<option value="' + (i + 1) + '">' + t + '</option>'; }).join("") +
        '</select></div>' +
        '<div class="dp-card">' +
          '<div class="dp-title"><button type="button" class="dp-nav" id="dp-prev">‹</button><b id="dp-cap"></b><button type="button" class="dp-nav" id="dp-next">›</button></div>' +
          '<div class="dp-wk">' + ["一","二","三","四","五","六","日"].map(function (t) { return "<span>" + t + "</span>"; }).join("") + '</div>' +
          '<div class="dp-grid" id="dp-grid"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dpEl);
    var years = "";
    for (var y = 1901; y <= 2099; y++) years += '<option value="' + y + '">' + y + '年</option>';
    $("#dp-y", dpEl).innerHTML = years;
    $("#dp-y", dpEl).onchange = function () { dpY = +this.value; dpRender(); };
    $("#dp-m", dpEl).onchange = function () { dpM = +this.value; dpRender(); };
    $("#dp-prev", dpEl).onclick = function () { dpM--; if (dpM < 1) { dpM = 12; dpY--; } dpSync(); dpRender(); };
    $("#dp-next", dpEl).onclick = function () { dpM++; if (dpM > 12) { dpM = 1; dpY++; } dpSync(); dpRender(); };
    $(".dp-x", dpEl).onclick = dpClose;
    dpEl.addEventListener("mousedown", function (e) { if (e.target === dpEl) dpClose(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") dpClose(); });
    $("#dp-grid", dpEl).addEventListener("click", function (e) {
      var c = e.target.closest(".dp-cell");
      if (!c) return;
      if (dpOnPick) {
        dpOnPick(+c.dataset.y, +c.dataset.m, +c.dataset.d);
      } else {
        birthSetDate(dpPfx, +c.dataset.y, +c.dataset.m, +c.dataset.d);
      }
      dpClose();
    });
  }
  function openDatePicker(pfx) {
    dpEnsure();
    dpPfx = pfx; dpOnPick = null;
    var v = ($("#" + pfx + "-date").value || "").split("-");
    var td = new Date();
    dpY = +v[0] || td.getFullYear();
    dpM = +v[1] || td.getMonth() + 1;
    dpSync(); dpRender();
    dpEl.classList.remove("hidden");
  }
  // 通用「选日期」弹窗（个人中心按日期查找）：复用出生日期同款日历，选完回调，不写入任何出生字段
  function openDateLookup(initial, onPick) {
    dpEnsure();
    dpOnPick = onPick;
    dpPickVal = initial || "";
    var v = dpPickVal.split("-");
    var td = new Date();
    dpY = +v[0] || td.getFullYear();
    dpM = +v[1] || td.getMonth() + 1;
    dpSync(); dpRender();
    dpEl.classList.remove("hidden");
  }
  function dpClose() { if (dpEl) dpEl.classList.add("hidden"); dpOnPick = null; }

  /* ================= 统一「日期时间选择」组件（架构约定 · 所有需选公历时刻的功能共用） =================
     契约：任何“选一个公历日期 + 时分”的场景（出生资料、梅花指定起卦时刻、择日参照等）
     必须复用本组件与同一个日历弹窗 openDateLookup，禁止再各自造原生 <input type="datetime-local">。
     出生资料 birthFieldsHTML 是本组件在「出生」语境的扩展（额外含农历/八字输入/know_time 开关）。
       dateTimeHTML(pfx, opts)    渲染「日期按钮 + 时/分下拉」，视觉复用 .bf-datebtn / .bf-time
       dateTimeBind(pfx, init)    绑定行为；日期按钮走 openDateLookup 回调回填，不写任何出生字段
       dateTimeCollect(pfx)       {year,month,day,hour,minute,when(ISO)}
     新增功能需要选时刻时，直接调用这三个函数即可，无需再实现日历。 */
  function dateTimeHTML(pfx, opts) {
    opts = opts || {};
    var hours = "", mins = "";
    for (var h = 0; h < 24; h++) hours += '<option value="' + h + '">' + h + '时</option>';
    for (var m = 0; m < 60; m++) mins += '<option value="' + m + '">' + m + '分</option>';
    return '<div class="dt-field">' +
      '<div class="bf-grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)">' +
        '<div><label class="bf-lab">' + (opts.dateLabel || "日期") + '</label>' +
          '<button type="button" class="bf-datebtn" id="' + pfx + '-dtbtn"><span id="' + pfx + '-dtbtn-t">选择日期</span><i>' + CAL_ICON + '</i></button>' +
          '<input type="hidden" id="' + pfx + '-date" /></div>' +
        '<div><label class="bf-lab">' + (opts.timeLabel || "时间") + '</label>' +
          '<div class="bf-time" id="' + pfx + '-dttime"><select class="ti" id="' + pfx + '-hour">' + hours + '</select>' +
          '<select class="ti" id="' + pfx + '-minute">' + mins + '</select></div></div>' +
      '</div></div>';
  }
  function dateTimeSet(pfx, y, m, d) {
    $("#" + pfx + "-date").value = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    var t = $("#" + pfx + "-dtbtn-t");
    if (t) t.textContent = y + "年" + m + "月" + d + "日";
  }
  function dateTimeBind(pfx, init) {
    var d = init || {};
    if (d.year && d.month && d.day) dateTimeSet(pfx, d.year, d.month, d.day);
    if (d.hour != null) $("#" + pfx + "-hour").value = String(d.hour);
    if (d.minute != null) $("#" + pfx + "-minute").value = String(d.minute);
    $("#" + pfx + "-dtbtn").onclick = function () {
      var v = ($("#" + pfx + "-date").value || "").split("-");
      var initial = v.length === 3 ? v.join("-") : "";
      openDateLookup(initial, function (yy, mm, dd) { dateTimeSet(pfx, yy, mm, dd); });
    };
  }
  function dateTimeCollect(pfx) {
    var v = ($("#" + pfx + "-date").value || "").split("-");
    var y = +v[0], m = +v[1], d = +v[2];
    var h = +$("#" + pfx + "-hour").value || 0, mi = +$("#" + pfx + "-minute").value || 0;
    return { year: y, month: m, day: d, hour: h, minute: mi,
      when: y ? (y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0") +
        " " + String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0")) : "" };
  }

  /* ---------------- 「选择农历日期」弹窗（年份/月份/日期 三下拉 + 确认） ---------------- */
  var lpEl = null, lpPfx = null;
  function openLunarPicker(pfx) {
    if (!lpEl) {
      lpEl = document.createElement("div");
      lpEl.className = "dp-mask hidden";
      var yOpts = "";
      for (var y = 1901; y <= 2099; y++) yOpts += '<option value="' + y + '">' + y + '年</option>';
      var mOpts = LN_MONTHS.map(function (t, i) { return '<option value="' + (i + 1) + '">' + t + '</option>'; }).join("");
      var dOpts = LN_DAYS.map(function (t, i) { return '<option value="' + (i + 1) + '">' + t + '</option>'; }).join("");
      lpEl.innerHTML =
        '<div class="dp-modal">' +
          '<div class="dp-head"><b>选择农历日期</b><button type="button" class="dp-x">✕</button></div>' +
          '<div class="lp-grid">' +
            '<div class="lp-f"><label>年份</label><select class="ti" id="lp-y">' + yOpts + '</select></div>' +
            '<div class="lp-f"><label>月份</label><select class="ti" id="lp-m">' + mOpts + '</select></div>' +
            '<div class="lp-f"><label>日期</label><select class="ti" id="lp-d">' + dOpts + '</select></div>' +
          '</div>' +
          '<div class="lp-foot"><button type="button" class="dp-ok" id="lp-ok">确认</button></div>' +
        '</div>';
      document.body.appendChild(lpEl);
      $(".dp-x", lpEl).onclick = lpClose;
      lpEl.addEventListener("mousedown", function (e) { if (e.target === lpEl) lpClose(); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") lpClose(); });
      $("#lp-ok", lpEl).onclick = function () {
        birthSetLunar(lpPfx, +$("#lp-y", lpEl).value, +$("#lp-m", lpEl).value, +$("#lp-d", lpEl).value);
        lpClose();
      };
    }
    lpPfx = pfx;
    $("#lp-y", lpEl).value = $("#" + pfx + "-ly").value || "1990";
    $("#lp-m", lpEl).value = $("#" + pfx + "-lm").value || "1";
    $("#lp-d", lpEl).value = $("#" + pfx + "-ld").value || "1";
    lpEl.classList.remove("hidden");
  }
  function lpClose() { if (lpEl) lpEl.classList.add("hidden"); }

  function doAuth(url, body, okMsg, err) {
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { err.textContent = d.error || "操作失败"; return; }
        setProfile({ id: d.profile_id, token: d.token, name: d.name });
        $("#p-modal").classList.add("hidden");
        toast(okMsg);
        // 登录后强制重建当前页：移除 AI 门禁、带入档案出生信息、个人中心刷新统计
        if (S.feature === "profile") renderProfile();
        else navigate(S.feature, true);
      })
      .catch(function (e) { err.textContent = "网络错误：" + e.message; });
  }
  function submitAuth(t) {
    var name = $("#au-name").value.trim(), pass = $("#au-pass").value;
    var err = $("#au-err"); err.textContent = "";
    if (t === "login") {
      doAuth("/api/profile/login", { name: name, password: pass }, "登录成功", err);
      return;
    }
    if (pass !== $("#au-pass2").value) { err.textContent = "两次密码不一致"; return; }
    var gender = segVal($("#au-gender"));
    var bc = birthCollect("au");
    if (bc.mode === "bazi") {
      // 八字方式：先由四柱反查出生公历日期，再建立档案
      fetch("/api/bazi/pillars_to_date?pillar_year=" + encodeURIComponent(bc.pillar_year) +
        "&pillar_month=" + encodeURIComponent(bc.pillar_month) +
        "&pillar_day=" + encodeURIComponent(bc.pillar_day) +
        "&pillar_time=" + encodeURIComponent(bc.pillar_time))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) { err.textContent = d.error || "无法由该八字推算出生日期"; return; }
          doAuth("/api/profile/register", { name: name, password: pass,
            birth: { calendar: "solar", year: d.year, month: d.month, day: d.day,
              hour: d.hour, minute: 0, know_time: true, gender: gender } }, "档案已建立", err);
        })
        .catch(function (e) { err.textContent = "网络错误：" + e.message; });
      return;
    }
    if (!bc.year || !bc.month || !bc.day) { err.textContent = "请选择出生日期"; return; }
    doAuth("/api/profile/register", { name: name, password: pass,
      birth: { calendar: bc.calendar, year: bc.year, month: bc.month, day: bc.day,
        hour: bc.hour, minute: bc.minute, know_time: bc.know_time, gender: gender } }, "档案已建立", err);
  }

  // 八字日期部分查询串：日期方式带 calendar/year/...；八字方式带四柱干支
  function baziQS(p) {
    if (p.mode === "bazi")
      return "pillar_year=" + encodeURIComponent(p.pillar_year) + "&pillar_month=" + encodeURIComponent(p.pillar_month) +
        "&pillar_day=" + encodeURIComponent(p.pillar_day) + "&pillar_time=" + encodeURIComponent(p.pillar_time);
    return "calendar=" + p.calendar + "&year=" + p.year + "&month=" + p.month + "&day=" + p.day +
      "&hour=" + p.hour + "&minute=" + p.minute;
  }

  /* ================= 落地首页 ================= */
  function renderHome() {
    var FEATURES = [
      { feat: "bazi",   tag: "八字命理", name: "八字排盘", desc: "四柱十神、五行喜忌、大运流年，就一张盘继续追问。",
        icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>' },
      { feat: "bazi_marriage", tag: "八字命理", name: "八字合婚", desc: "双方四柱对照：夫妻宫、十神交叉与大运流年，只给可核对的论据，不打分数。",
        icon: '<path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10z"/>' },
      { feat: "ziwei",  tag: "紫微斗数", name: "紫微斗数", desc: "十二宫格局、四化飞星、大限流年，命盘可点宫提问。",
        icon: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>' },
      { feat: "ziwei_marriage", tag: "紫微斗数", name: "紫微合婚", desc: "两张命盘的夫妻宫、命宫、福德宫与双向四化交叉，看清关系结构。",
        icon: '<circle cx="8" cy="12" r="4"/><circle cx="16" cy="12" r="4"/><path d="M12 8v8"/>' },
      { feat: "meihua", tag: "周易占卜", name: "梅花易数", desc: "时间或手动起卦，本卦互卦变卦与动爻，逐层解读。",
        icon: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2.1 5-5 2.1 2.1-5 5-2.1z"/>' },
      { feat: "liuyao", tag: "周易占卜", name: "六爻", desc: "铜钱/时间/数字起卦，纳甲六亲世应与动变，逐爻可核对。",
        icon: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 8h10M7 12h4M7 16h10"/>' },
      { feat: "qimen",  tag: "周易占卜", name: "奇门遁甲", desc: "时家转盘拆补定局，九宫八门九星八神与格局，逐宫可复算。",
        icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>' },
      { feat: "astrology", tag: "西方占卜", name: "占星命盘", desc: "按生日与出生地排出完整本命盘：日月上升、行星落座、宫位与相位。",
        icon: '<circle cx="12" cy="12" r="9"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="2.5"/>' },
      { feat: "astrology_marriage", tag: "西方占卜", name: "占星合盘", desc: "两张本命盘的跨盘相位、金星火星落宫与日月要素对照，看清相处结构，不打分数。",
        icon: '<circle cx="8" cy="12" r="4"/><circle cx="16" cy="12" r="4"/><path d="M12 8v8"/>' },
      { feat: "tarot",  tag: "西方占卜", name: "塔罗牌", desc: "三张或凯尔特十字牌阵，先写问题再抽牌，按牌位成文。",
        icon: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/><path d="M5 20h14"/>' },
      { feat: "huangli",tag: "其他功能", name: "老黄历", desc: "宜忌、值神、冲煞与物候；内含「个人今日运势」与「双人择日」两个子功能。",
        icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01"/>' },
      /* 双人择日已并入老黄历作为子功能，不再单列入口 */
    ];
    function cardHTML(f) {
      return '<button type="button" class="home-card" data-feature="' + f.feat + '">' +
        '<span class="home-card-ic"><svg class="ic" viewBox="0 0 24 24">' + f.icon + '</svg></span>' +
        '<span class="home-card-name">' + esc(f.name) + '</span>' +
        '<span class="home-card-desc">' + esc(f.desc) + '</span>' +
        '<span class="home-card-go" aria-hidden="true">→</span>' +
        '</button>';
    }
    // 按 tag 分类分组：首次出现顺序即分类展示顺序，组内保留原卡片次序。
    var groupNames = [];
    FEATURES.forEach(function (f) { if (groupNames.indexOf(f.tag) < 0) groupNames.push(f.tag); });
    var sections = groupNames.map(function (g) {
      var items = FEATURES.filter(function (f) { return f.tag === g; });
      return '<section class="home-group">' +
        '<h2 class="home-group-h"><span class="home-group-bar"></span>' + esc(g) + '</h2>' +
        '<div class="home-grid">' + items.map(cardHTML).join('') + '</div>' +
        '</section>';
    }).join('');
    stageEl().innerHTML =
      '<div class="home-page">' +
        '<div class="home-hero">' +
          '<span class="home-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 12c-1.889-2.554-3.77-4-6-4a4 4 0 0 0 0 8c2.23 0 4.111-1.446 6-4 1.889-2.554 3.77-4 6-4a4 4 0 0 1 0 8c-2.23 0-4.111-1.446-6-4Z"/></svg></span>' +
          '<h1>观象 · 知变 · 自省</h1>' +
          '<p>以传统命理与象征体系为镜，照见当下、理解自己。选择一个入口开始，所有推演都可继续追问。</p>' +
        '</div>' +
        sections +
        '<p class="home-footnote">所有解读仅供自我探索与文化娱乐，不构成现实决策建议。</p>' +
      '</div>';
    $$(".home-card", stageEl()).forEach(function (c) {
      c.onclick = function () { go(c.dataset.feature); };
    });
  }

  /* ================= 八字排盘 ================= */
  /* 八字「十神分析 / 神煞分析」投影（v130）：纯函数，从 Board.data 渲染，
     当前盘面与历史归档共用同一份——盘面数据来自后端确定性计算，前端不做命理推断。 */
  function bzAnalysisHTML(boardData) {
    var pillarNames = ["年柱", "月柱", "日柱", "时柱"], keys = ["year", "month", "day", "hour"];
    var detail = boardData.ten_god_detail || {}, byPillar = boardData.shensha_by_pillar || {};
    // 十神分析：逐柱列出天干十神（主气）+ 藏干十神，各带释义。
    var godCols = keys.map(function (key) {
      var cell = detail[key] || {};
      var hidden = (cell.hidden || []).map(function (h) {
        return '<span class="bz-god"><b>' + esc(h.shi_shen) + '</b>' +
          (h.desc ? '<i>' + esc(h.desc) + '</i>' : '') + '</span>';
      }).join("");
      return '<div class="bz-god-col"><div class="bz-god-h"><b>' + pillarNames[keys.indexOf(key)] + '</b>' +
        '<span>' + esc(cell.gan || "") + '</span></div>' +
        '<span class="bz-god main"><b>' + esc(cell.main || "—") + '</b>' +
        (cell.main_desc ? '<i>' + esc(cell.main_desc) + '</i>' : '') + '</span>' +
        hidden + '</div>';
    }).join("");
    var godCard = '<div class="p-card bz-analysis"><div class="bz-sec-h">十神分析<span>四柱天干与藏干的十神关系</span></div>' +
      '<div class="bz-god-grid">' + godCols + '</div>' +
      '<p class="p-note bz-analysis-note">十神描述的是日主与其余各字的生克关系，不同柱位对应不同人生阶段：年柱主早年与长辈，月柱主成长与父母，日柱主自我与配偶，时柱主晚年与子嗣；它们共同构成性格底色与人生面向。</p>' +
      '</div>';
    // 神煞分析：逐柱列出命中所带神煞，带吉凶角标与释义。
    var toneClass = { "吉": "good", "凶": "bad", "中": "mid" };
    var shaCols = keys.map(function (key) {
      var list = byPillar[key] || [];
      var items = list.length ? list.map(function (s) {
        return '<span class="bz-sha"><b>' + esc(s.name) + '</b>' +
          '<em class="' + (toneClass[s.tone] || "mid") + '">' + esc(s.tone) + '</em>' +
          (s.desc ? '<i>' + esc(s.desc) + '</i>' : '') + '</span>';
      }).join("") : '<span class="p-note">本柱未见常用神煞</span>';
      return '<div class="bz-sha-col"><div class="bz-sha-h">' + pillarNames[keys.indexOf(key)] +
        '<span>' + (list.length ? "共 " + list.length + " 项" : "—") + '</span></div>' + items + '</div>';
    }).join("");
    var shaCard = '<div class="p-card bz-analysis"><div class="bz-sec-h">神煞分析<span>神煞仅作辅助参考，不宜单独据以言吉凶</span></div>' +
      '<div class="bz-sha-grid">' + shaCols + '</div></div>';
    return godCard + shaCard;
  }

  function renderBazi() {
    S.bzFromProfile = false;
    stageEl().innerHTML =
      toolHero("八字排盘", "八字以四柱定命局，以大运流年观其变化；AI 提供解读与连续问答。") +
      '<div class="tool-card" id="bz-form-card"><div class="tool-form" id="bazi-form">' +
        '<div class="tf-group"><div class="tf-gt">基本信息</div>' +
          '<div class="tf-grid">' +
            '<div class="tf-field"><label>性别</label><select class="ti" id="bz-gender"><option>男</option><option>女</option></select></div>' +
            '<div class="tf-field"><label>出生地（可选）</label><input class="ti" id="bz-place" placeholder="请输入出生地" /></div>' +
          '</div>' +
        '</div>' +
        '<div class="tf-group">' + birthFieldsHTML("bz", { title: "时间信息" }) + '</div>' +
        '<button class="tool-submit" id="bz-calc">开始计算八字</button>' +
        '<div class="p-err" id="bz-err"></div>' +
      '</div></div>' +
      '<div id="bz-result"></div>' +
      aboutDetails("关于八字排盘", [
        '<b>四柱</b>：年、月、日、时各一柱，每柱一天干一地支，共八字。日柱天干为「日主」，代表命主自身。',
        '<b>十神</b>：以日主与其他天干的生克关系定正官、七杀、正印、比肩、食神、正财等，描述不同的人生力量。',
        '<b>纳音</b>：六十甲子配五行之音，如「沙中金」「杨柳木」，辅助判断气质与格局。',
        '<b>大运</b>：十年一运，依性别与年干阴阳顺逆排布，提示不同阶段的整体趋势。'
      ], "年柱以立春为界、月柱以节气为界；全部字段由程序确定性计算，同一出生信息永远得到同一盘面。登录后可直接带入档案里的出生资料。");

    birthFieldsBind("bz");
    var params = function () {
      var b = birthCollect("bz");
      b.gender = $("#bz-gender").value;
      b.birth_place = $("#bz-place").value.trim();
      return b;
    };
    var lastQS = "";   // 本次排盘的出生参数，供下方提问复用
    var autoCalcFlag = false;   // 自动带入排盘时不滚动，避免一进页面就跳过标题与表单
    $("#bz-calc").onclick = function () {
      var isAuto = autoCalcFlag; autoCalcFlag = false;
      var p = params();
      var qs = baziQS(p) +
        "&gender=" + encodeURIComponent(p.gender) + "&birth_place=" + encodeURIComponent(p.birth_place);
      // 用户主动改过出生信息 → 排盘成功后写回档案（档案是全站唯一数据源）
      var saveBirth = S.bzSaveBirth && S.profile;
      if (saveBirth) qs += "&save=1" + authParam();
      lastQS = qs;
      // 登录态且非写回：命中缓存直接用缓存数据渲染，不重复请求排盘（档案变更会清缓存）
      var cacheKey = qs.replace(/&save=1.*$/, "");
      var cached = (S.profile && !saveBirth) ? chartCacheGet("bazi") : null;
      var fetchJson = (cached && cached.key === cacheKey && cached.uid === S.profile.id && cached.data)
        ? (function () { return Promise.resolve(cached.data); })
        : (function () { return fetch("/api/bazi/calc?" + qs).then(function (r) { return r.json(); }); });
      fetchJson().then(function (d) {
        if (!d.ok) { $("#bz-err").textContent = d.error || "排盘失败"; return; }
        if (S.profile && !saveBirth) chartCacheSet("bazi", { key: cacheKey, uid: S.profile.id, data: d });
        if (d.birth_saved) {
          S.bzSaveBirth = false;
          toast("出生信息已同步到个人档案，其它功能将使用新信息");
          // 档案变了：清掉各功能的本地命盘缓存，避免旧盘继续被复用
          profileBirthChanged();
        }
        var note = d.pillar_lookup ?
          '<p class="p-note" style="margin:0 0 12px">已按四柱反查出生时间：公历 ' + d.pillar_lookup.year + '年' +
          d.pillar_lookup.month + '月' + d.pillar_lookup.day + '日 ' + d.pillar_lookup.hour + '时' +
          (d.pillar_lookup.multiple ? '（同一八字可对应多个日期，取最早）' : '') + '。</p>' : "";
        var kv = '<div class="p-kv bz-kv">' + ["year","month","day","hour"].map(function (k, i) {
          var lbl = ["年柱","月柱","日柱","时柱"][i];
          var hg = ((d.ten_god_zhi || {})[k] || []).map(function (x) { return x.gan + x.shi_shen; }).join("·");
          return '<div class="p-kv-item"><div class="k">' + lbl + ' · ' + d.ten_gods[k] + '</div><div class="v">' + d.pillars[k] + '</div>' +
            '<div class="k" style="margin-top:4px">' + d.nayin[k] + '</div>' +
            (hg ? '<div class="k bz-hg">藏干 ' + hg + '</div>' : '') + '</div>';
        }).join("") + '</div>';

        // 五行分布（条形长度按本盘最大值归一，便于横向比较）
        var wx = d.wuxing || {};
        var wxMax = 1;
        ["木","火","土","金","水"].forEach(function (g) { if ((wx[g] || 0) > wxMax) wxMax = wx[g] || 0; });
        var wxHtml = '<div class="bz-wx">' + ["木","火","土","金","水"].map(function (g) {
          var n = wx[g] || 0;
          return '<span class="bz-wx-i"><b>' + g + '</b><i style="width:' + Math.round((n / wxMax) * 40) + 'px"></i><em>' + n + '</em></span>';
        }).join("") + '</div>';

        // 神煞
        var ssHtml = (d.shensha || []).length
          ? '<div class="bz-tags">' + d.shensha.map(function (s) {
              return '<span class="bz-tag" title="' + esc(s.desc) + '"><b>' + esc(s.name) + '</b><i>' + esc(s.pillars.join("/")) + '柱</i></span>';
            }).join("") + '</div>'
          : '<p class="p-note" style="margin:6px 0 0">本盘未见常用神煞。</p>';

        // 大运（10 步，标出当前，可点选后提问）
        var cur = d.current || {};
        var dyHtml = '<div class="bz-strip"><div class="bz-scroll">' + (d.dayun || []).map(function (y) {
          var on = cur.dayun && y.ganzhi === cur.dayun ? " on" : "";
          return '<button type="button" class="bz-step' + on + '" data-kind="dy" data-gz="' + esc(y.ganzhi) + '"' +
            ' data-from="' + y.start_year + '" data-to="' + y.end_year + '" data-age="' + y.age + '-' + y.end_age + '">' +
            '<b>' + esc(y.ganzhi) + '</b><span>' + y.age + '-' + y.end_age + '岁</span>' +
            '<i>' + y.start_year + '</i><em>' + esc(y.shi_shen) + '</em></button>';
        }).join("") + '</div></div>';

        // 流年（今年起 10 年，可点选后提问）
        var lnHtml = '<div class="bz-strip"><div class="bz-scroll">' + (d.liunian || []).map(function (x) {
          var on = x.year === cur.year ? " on" : "";
          return '<button type="button" class="bz-step' + on + '" data-kind="ln" data-gz="' + esc(x.ganzhi) + '"' +
            ' data-year="' + x.year + '" data-age="' + x.age + '">' +
            '<b>' + esc(x.ganzhi) + '</b><span>' + x.year + '</span>' +
            '<i>' + x.age + '岁</i><em>' + esc(x.shi_shen) + '</em></button>';
        }).join("") + '</div></div>';

        // 流月：依附于选中的流年，十二个月的节气月柱由后端随流年一并返回（所见即所解）。
        // 默认展示当年流年的流月；点选别的流年时刷新这一行。
        var defLnForLy = null;
        (d.liunian || []).forEach(function (x) { if (x.year === cur.year) defLnForLy = x; });
        function lyRowHTML(ln) {
          if (!ln || !(ln.liuyue || []).length) {
            return '<div class="bz-strip"><div class="bz-scroll"><span class="p-note">请先在上方选中一个流年</span></div></div>';
          }
          return '<div class="bz-strip"><div class="bz-scroll">' + ln.liuyue.map(function (month) {
            return '<button type="button" class="bz-step' + '" data-kind="ly" data-gz="' + esc(month.ganzhi) + '"' +
              ' data-year="' + ln.year + '" data-month="' + month.month + '">' +
              '<b>' + esc(month.ganzhi) + '</b><span>' + month.month + ' 月</span></button>';
          }).join("") + '</div></div>';
        }

        var curLine = cur.dayun
          ? '<p class="bz-cur">当前 ' + cur.year + ' 年 · ' + cur.age + ' 岁 · 行 ' + esc(cur.dayun) + ' 大运（' +
            (cur.dayun_range || []).join("-") + '）</p>'
          : '';

        var chips = [
          { t: "整体格局", q: "整体格局的优缺点是什么？" },
          { t: "事业与财运", q: "事业与财运如何？有哪些风险？" },
          { t: "性格与修习", q: "性格特点与需要修习的地方？" },
          { t: "感情婚姻", q: "感情与婚姻的走向如何？" }
        ];

        // 结构统一：盘面结果卡、独立提问卡、AI 解读输出三段平级（提问卡不再嵌在盘面卡内）
        // 同盘重绘（切回缓存/切大运流年）保留解读容器；换出生参数=新盘，先按旧 rk 归档整轮。
        var bzRoot = $("#bz-result");
        if (bzRoot.dataset.chartKey && bzRoot.dataset.chartKey !== cacheKey) {
          archiveBeforeRepaint(bzRoot, "bazi");
        }
        bzRoot.dataset.chartKey = cacheKey;
        // v126：八字盘数据存进 Board 对象（真相源）。rk = bazi|出生参数。
        var baziRoundKey = "bazi|" + cacheKey;
        putBoard("bazi", baziRoundKey, d, { params: cacheKey }, "");
        preserveOutputs(bzRoot, function () {
        bzRoot.innerHTML = '<div class="p-result">' +
          '<div class="result-head"><div class="result-title">四柱盘面</div>' + profileAside() + '</div>' +
          '<div class="p-card">' + note + kv + wxHtml +
            '<div class="bz-sec"><div class="bz-sec-h">神煞</div>' + ssHtml + '</div>' +
            '<div class="bz-sec"><div class="bz-sec-h">大运<span>十年一运 · 点选可据此提问</span></div>' + curLine + dyHtml + '</div>' +
            '<div class="bz-sec"><div class="bz-sec-h">流年<span>今年起十年 · 点选后可看该年流月</span></div>' + lnHtml + '</div>' +
            '<div class="bz-sec"><div class="bz-sec-h">流月<span>节气月柱 · 点选可据此提问</span></div>' +
              '<div id="bz-liuyue">' + lyRowHTML(defLnForLy) + '</div></div>' +
          '</div>' +
        '</div>' +
        bzAnalysisHTML(d) +
        '<div class="bz-ask">' +
          '<div class="bz-ask-h">就这张盘提问<span id="bz-pick">未选择大运、流年或流月</span></div>' +
          '<div class="p-suggest zw-chips">' + chips.map(function (c) {
            return '<button type="button" data-q="' + esc(c.q) + '">' + esc(c.t) + '</button>';
          }).join("") + '</div>' +
          '<div class="zw-ask-row"><input class="ti" id="bz-q" placeholder="例如：事业与财运的格局，有哪些优势与需要警惕的短板？" />' +
            '<button class="tool-ai zw-ask-btn" id="bz-ai" type="button">AI 解读</button></div>' +
        '</div>' +
        '<div id="bz-ai-out"></div>';
        }, "bazi");

        // 大运 / 流年 / 流月点选：默认选中当年流年（与按钮高亮一致），再按用户点击切换。
        // 用事件委托绑在 #bz-result：点流年刷新出的流月按钮无需重新绑定。
        var defLn = null;
        (d.liunian || []).forEach(function (x) { if (x.year === cur.year) defLn = x; });
        var pick = defLn
          ? { kind: "ln", gz: defLn.ganzhi, from: "", to: "", year: defLn.year, age: defLn.age, month: "" }
          : { kind: "", gz: "", from: "", to: "", year: "", age: "", month: "" };
        var pickTip = $("#bz-pick");
        if (defLn) pickTip.textContent = "已选流年 " + defLn.year + " " + defLn.ganzhi + "（" + defLn.age + "岁）";
        $("#bz-result").onclick = function (e) {
          var b = e.target.closest && e.target.closest(".bz-step");
          if (!b) return;
          var kind = b.dataset.kind;
          var same = pick.kind === kind && pick.gz === b.dataset.gz &&
            (kind !== "ly" || pick.month === b.dataset.month);
          $$("#bz-result .bz-step").forEach(function (x) {
            if (x.dataset.kind === kind && !same) x.classList.remove("on");
          });
          var on = b.classList.toggle("on", !same);
          if (!on) { pick = { kind: "", gz: "", from: "", to: "", year: "", age: "", month: "" };
            pickTip.textContent = "未选择大运、流年或流月"; return; }
          pick = { kind: kind, gz: b.dataset.gz, from: b.dataset.from, to: b.dataset.to,
            year: b.dataset.year, age: b.dataset.age, month: b.dataset.month || "" };
          if (kind === "dy") {
            pickTip.textContent = "已选大运 " + pick.gz + "（" + pick.from + "-" + pick.to + "，虚岁 " + pick.age + "）";
            $("#bz-q").value = "在 " + pick.gz + " 大运（" + pick.from + "-" + pick.to + "）期间，我的事业与财运趋势如何？";
          } else if (kind === "ln") {
            pickTip.textContent = "已选流年 " + pick.year + " " + pick.gz + "（" + pick.age + "岁）";
            $("#bz-q").value = pick.year + " 年 " + pick.gz + " 流年，我的运势重点与需要留意的地方是什么？";
            // 刷新流月行：跟随刚选中的流年（五虎遁干支已从该流年的 liuyue 取）
            var ln = null;
            (d.liunian || []).forEach(function (x) { if (String(x.year) === String(pick.year)) ln = x; });
            var host = $("#bz-liuyue");
            if (host) host.innerHTML = lyRowHTML(ln);
            // 流年变了，旧的流月选中作废
            $$("#bz-result .bz-step.ly").forEach(function (x) { x.classList.remove("on"); });
          } else if (kind === "ly") {
            pickTip.textContent = "已选 " + pick.year + " 年 " + pick.month + " 月 " + pick.gz + " 流月";
            $("#bz-q").value = pick.year + " 年 " + pick.month + " 月（" + pick.gz + " 流月），这个月的运势重点是什么？";
          }
          $("#bz-q").focus();
        };
        $$("#bz-result .zw-chips button").forEach(function (b) {
          b.onclick = function () { pickQuestion(b.dataset.q, "#bz-q"); };
        });
        var askBz = function () {
          var q = ($("#bz-q").value || "").trim();
          if (!q) { toast("请先写下想问的问题"); $("#bz-q").focus(); return; }
          var scope = "";
          if (pick.kind === "dy") scope = "（只看 " + pick.gz + " 大运 " + pick.from + "-" + pick.to + "）";
          if (pick.kind === "ln") scope = "（只看 " + pick.year + " " + pick.gz + " 流年）";
          if (pick.kind === "ly") scope = "（只看 " + pick.year + " 年 " + pick.month + " 月 " + pick.gz + " 流月）";
          streamAI("bazi", lastQS + "&q=" + encodeURIComponent(scope + q) + authParam(), q, $("#bz-ai-out"), lastQS + "|" + scope);
        };
        $("#bz-ai").onclick = askBz;
        $("#bz-q").onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); askBz(); } };

        if (!isAuto) $("#bz-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    };
    // 登录后不再展示基本信息与时间信息：直接用档案出生信息排盘，只留提问与 AI 对话
    function collapseBirth() {
      S.bzFromProfile = true;
      var card = $("#bz-form-card"); if (card) card.style.display = "none";
    }
    /* 结果标题行右侧的档案来源提示 */
    function profileAside() {
      if (!S.bzFromProfile) return "";
      return '<span class="result-aside" id="bz-edit">已使用档案中的出生信息 · ' +
        '<button type="button" class="link-btn" data-bz-edit="1">修改出生信息</button></span>';
    }
    // 「修改出生信息」：展开表单卡并收起提示（结果标题可能在多处重绘，用事件委托）
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-bz-edit]");
      if (!b) return;
      S.bzFromProfile = false;
      // 标记「本次排盘后写回档案」：用户在档案态改过出生信息，档案要跟着更新
      S.bzSaveBirth = true;
      var card = $("#bz-form-card"); if (card) card.style.display = "";
      var aside = $("#bz-edit"); if (aside) aside.remove();
      var g = $("#bazi-form .tf-group"); if (g) g.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    // 登录后自动带入档案出生信息，并直接排出盘（无需再手动点计算）
    if (S.profile) {
      fetch("/api/profile/get?id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token))
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok && d.profile && d.profile.birth) {
            var b = d.profile.birth;
            var yyyy = b.year, mm = b.month, dd = b.day;
            if ((yyyy == null || mm == null || dd == null) && b.date) {
              var seg = String(b.date).split("-"); yyyy = +seg[0]; mm = +seg[1]; dd = +seg[2];
            }
            birthFieldsBind("bz", { calendar: "solar", year: yyyy, month: mm, day: dd,
              hour: b.hour != null ? b.hour : 12, minute: b.minute != null ? b.minute : 0,
              know_time: b.know_time !== false });
            if (b.gender) $("#bz-gender").value = (b.gender === "male" ? "男" : b.gender === "female" ? "女" : b.gender);
            // 自动排盘：填好档案出生信息后直接出结果
            if ($("#bz-date").value) { autoCalcFlag = true; $("#bz-calc").click(); }
            collapseBirth();
          }
        }).catch(function (e) { warn("八字页载入档案出生信息失败", e); });
    }
    applyGate("bazi");
  }
  function segSet(seg, v) { $$("button", seg).forEach(function (b) { b.classList.toggle("on", b.dataset.v === v); }); }

  /* ================= 梅花易数 ================= */
  function renderMeihua() {
    stageEl().innerHTML =
      toolHero("梅花易数 · 每日决策", "梅花易数取象于当下，观变于一事：所问之事与起卦时刻、机缘共同参与成卦，卦成之后由 AI 结合《周易》原文解读。") +
      '<div class="tool-card"><div class="tool-form" id="mh-form">' +
        '<div class="p-bazi-gate" id="mh-bazi-gate"><span class="bg-ic">◈</span><span class="bg-txt">正在检查您的命局资料…</span></div>' +
        '<div class="tf-group"><div class="tf-gt">提出您的决策问题</div>' +
          '<p class="p-note" style="margin:0 0 10px">请输入一个明确的问题，系统将自动为您起卦</p>' +
          '<input class="ti" id="mh-q" placeholder="例如：我是否应该接受这个工作机会？" />' +
          '<div class="p-suggest"><button data-q="事业上顺势推进还是另寻他途？">事业去向</button><button data-q="这段关系下一步如何？">感情走向</button><button data-q="眼下这个决定是否明智？">当下决策</button></div>' +
        '</div>' +
        '<div class="tf-group"><div class="tf-gt">起卦方式</div>' +
          '<div class="p-seg" id="mh-method">' +
            '<button class="on" data-v="time">时间起卦</button><button data-v="number">数字起卦</button><button data-v="random">随机数起卦</button><button data-v="manual">手动起卦</button></div>' +
          '<div id="mh-inputs"></div>' +
        '</div>' +
        '<button class="tool-submit" id="mh-calc">生成卦象</button>' +
        '<div class="p-err" id="mh-err"></div>' +
      '</div></div>' +
      '<div id="mh-result"></div>' +
      '<div id="mh-ai-box"></div>' +
      aboutDetails("起卦规则", [
        '<b>时间起卦</b>：根据起卦时刻的农历年月日时起卦。上卦 =（年支数＋月数＋日数）mod 8，下卦 =（年支数＋月数＋日数＋时辰数）mod 8，动爻 = 总数 mod 6。',
        '<b>数字起卦</b>：第一个数字取下卦，第二个数字取上卦，动爻 =（两数之和）mod 6。',
        '先天八卦数：乾1 · 兑2 · 离3 · 震4 · 巽5 · 坎6 · 艮7 · 坤8；年数以立春为界的年支序数计（子1…亥12），不是公历年份；余数为 0 时按第 8 卦 / 第 6 爻处理。',
        '<b>手动起卦</b>：点击爻位设置阴阳，再选择变爻位置；本卦、动爻、变卦随之确定。'
      ], "随机起卦把所问之事与起卦时刻、机缘共同作为变量，问题并非唯一决定因素——同一问题在不同时刻起卦也会有不同卦象；时间/数字/手动起卦仍按各自传统规则。每一次卦象与所问之事绑定：本卦、动爻与变卦在同一轮解读和追问中保持不变。AI 解读引用的卦爻辞是《周易》真实文本。");

    $$(".p-suggest button", stageEl()).forEach(function (b) { b.onclick = function () { pickQuestion(b.dataset.q, "#mh-q"); updateBtn(); }; });
    var GUA_NAMES = ["乾","兑","离","震","巽","坎","艮","坤"];
    var GUA_SYMBOL = { "乾":"☰","兑":"☱","离":"☲","震":"☳","巽":"☴","坎":"☵","艮":"☶","坤":"☷" };
    var GUA_BITS = { "乾":"111","兑":"011","离":"101","震":"001","巽":"110","坎":"010","艮":"100","坤":"000" };
    // 文王六十四卦：(上卦,下卦) → 全名。手动起卦预览随爻变实时显示本卦/变卦。
    var KINGWEN64 = {"乾":{"乾":"乾为天","兑":"天泽履","离":"天火同人","震":"天雷无妄","巽":"天风姤","坎":"天水讼","艮":"天山遁","坤":"天地否"},"兑":{"乾":"泽天夬","兑":"兑为泽","离":"泽火革","震":"泽雷随","巽":"泽风大过","坎":"泽水困","艮":"泽山咸","坤":"泽地萃"},"离":{"乾":"火天大有","兑":"火泽睽","离":"离为火","震":"火雷噬嗑","巽":"火风鼎","坎":"火水未济","艮":"火山旅","坤":"火地晋"},"震":{"乾":"雷天大壮","兑":"雷泽归妹","离":"雷火丰","震":"震为雷","巽":"雷风恒","坎":"雷水解","艮":"雷山小过","坤":"雷地豫"},"巽":{"乾":"风天小畜","兑":"风泽中孚","离":"风火家人","震":"风雷益","巽":"巽为风","坎":"风水涣","艮":"风山渐","坤":"风地观"},"坎":{"乾":"水天需","兑":"水泽节","离":"水火既济","震":"水雷屯","巽":"水风井","坎":"坎为水","艮":"水山蹇","坤":"水地比"},"艮":{"乾":"山天大畜","兑":"山泽损","离":"山火贲","震":"山雷颐","巽":"山风蛊","坎":"山水蒙","艮":"艮为山","坤":"山地剥"},"坤":{"乾":"地天泰","兑":"地泽临","离":"地火明夷","震":"地雷复","巽":"地风升","坎":"地水师","艮":"地山谦","坤":"坤为地"}};
    var manualYaos = [1,1,1,1,1,1];   // 自下而上，1=阳；手动起卦编辑器状态
    var manualMoving = 0;             // 0=未选变爻
    var lastGua = null;               // 最近一次起卦结果，供 AI 解卦用
    var mhBaziReady = false;          // 档案是否具备完整八字（梅花解卦强制要求）

    /* 梅花解卦强制结合本人八字：进入时拉取档案判断出生信息是否完整，
       据更新顶部提示条；未登录/缺出生时间则由后端最终拦截，这里先给出引导。 */
    function refreshBaziGate() {
      var gate = $("#mh-bazi-gate");
      if (!gate) return;
      if (!S.profile) {
        mhBaziReady = false;
        gate.className = "p-bazi-gate warn";
        gate.innerHTML = '<span class="bg-ic">◈</span><span class="bg-txt">梅花解卦将结合您的八字命局以提高准确度——请先登录并补全出生信息。</span>';
        return;
      }
      fetch("/api/profile/get?id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token)).then(function (r) { return r.json(); }).then(function (d) {
        var b = (d.ok && d.profile && d.profile.birth) || {};
        var complete = !!(b.year && b.month && b.day && b.know_time !== false && b.hour !== null && b.hour !== undefined && b.hour !== "");
        mhBaziReady = complete;
        gate.className = "p-bazi-gate " + (complete ? "ok" : "warn");
        gate.innerHTML = complete
          ? '<span class="bg-ic">◈</span><span class="bg-txt">解卦将自动结合您档案中的八字命局（四柱喜忌），使命盘与卦象相互印证，结论更贴合本人。</span>'
          : '<span class="bg-ic">◈</span><span class="bg-txt">您的档案尚缺完整出生时间，梅花解卦需结合八字命局——请先到「个人中心」补全出生年月日与时辰。</span>';
      }).catch(function () {
        mhBaziReady = false;
        gate.className = "p-bazi-gate warn";
        gate.innerHTML = '<span class="bg-ic">◈</span><span class="bg-txt">命局资料读取失败，请刷新重试或到个人中心补全出生信息。</span>';
      });
    }
    refreshBaziGate();

    /* 爻线图形：阳爻一条长横，阴爻两段 */
    function yaoGlyph(yang, moving) {
      return '<span class="yao-line' + (yang ? ' yang' : ' yin') + (moving ? ' moving' : '') + '">' +
        (yang ? '<i></i>' : '<i></i><i></i>') + '</span>';
    }
    function posName(i) { return i === 1 ? "初爻" : (i === 6 ? "上爻" : "二爻 三爻 四爻 五爻".split(" ")[i - 2]); }
    function trigramName(bits3) {   // bits3: 自下而上三爻
      // 必须强制转字符串：数字 + 数字会相加（1+1+1=3），永远匹配不到 "111"，
      // 导致预览始终是「乾上乾下」——手动起卦改爻不更新卦名的真正原因。
      var key = String(bits3[2]) + String(bits3[1]) + String(bits3[0]);
      for (var n in GUA_BITS) if (GUA_BITS[n] === key) return n;
      return "乾";
    }
    function guaFullName(bits) {
      var up = trigramName(bits.slice(3)), lo = trigramName(bits.slice(0, 3));
      return { name: (KINGWEN64[up] || {})[lo] || (up + "上" + lo + "下"),
               up: up, lo: lo };
    }
    function hexLinesHTML(bits, moving) {   // 自上而下画六爻，动爻标红
      return [6,5,4,3,2,1].map(function (i) {
        return '<div class="mh-pv-line">' + yaoGlyph(bits[i - 1] === 1, moving === i) + '</div>';
      }).join("");
    }
    function drawEditor() {
      $("#mh-editor").innerHTML = [6,5,4,3,2,1].map(function (i) {
        var yang = manualYaos[i - 1] === 1, mv = manualMoving === i;
        return '<div class="mh-yao-row"><span class="pos">' + posName(i) + '</span>' +
          '<button class="yao-toggle" data-i="' + i + '" aria-label="切换阴阳">' + yaoGlyph(yang, mv) + '</button>' +
          '<span class="yy">' + (yang ? '阳爻' : '阴爻') + '</span>' +
          '<button class="mv-toggle' + (mv ? ' on' : '') + '" data-i="' + i + '">' + (mv ? '动爻' : '不变') + '</button></div>';
      }).join("");
      var ben = guaFullName(manualYaos);
      var hint = $("#mh-mhint");
      if (hint) hint.textContent = "本卦 " + ben.up + "上 " + ben.lo + "下 · 点爻线切换阴阳，点“不变/动爻”指定变爻";
      // 卦象预览：每次点击爻线 / 变爻都实时重画本卦与变卦，让改动立刻对应到具体卦象
      var pv = $("#mh-gua-preview");
      if (pv) {
        var bianBits = manualYaos.slice();
        if (manualMoving) bianBits[manualMoving - 1] = bianBits[manualMoving - 1] === 1 ? 0 : 1;
        var bian = guaFullName(bianBits);
        pv.innerHTML =
          '<div class="mh-pv-card"><div class="mh-pv-tag">本卦</div>' +
            '<div class="mh-pv-sym">' + (GUA_SYMBOL[ben.up] || "") + (GUA_SYMBOL[ben.lo] || "") + '</div>' +
            '<div class="mh-pv-lines">' + hexLinesHTML(manualYaos, manualMoving) + '</div>' +
            '<div class="mh-pv-nm">' + esc(ben.name) + '</div>' +
            '<div class="mh-pv-sub">' + esc(ben.up) + '上 ' + esc(ben.lo) + '下</div></div>' +
          (manualMoving
            ? '<div class="mh-pv-card bian"><div class="mh-pv-tag">变卦 · 第' + manualMoving + '爻动</div>' +
              '<div class="mh-pv-sym">' + (GUA_SYMBOL[bian.up] || "") + (GUA_SYMBOL[bian.lo] || "") + '</div>' +
              '<div class="mh-pv-lines">' + hexLinesHTML(bianBits, 0) + '</div>' +
              '<div class="mh-pv-nm">' + esc(bian.name) + '</div>' +
              '<div class="mh-pv-sub">' + esc(bian.up) + '上 ' + esc(bian.lo) + '下</div></div>'
            : '');
      }
    }
    // 起卦输入区统一事件委托：避免动态重渲染后绑定丢失导致"点了没反应"
    $("#mh-inputs").addEventListener("click", function (e) {
      var yt = e.target.closest(".yao-toggle");
      if (yt) { var i = +yt.dataset.i; manualYaos[i - 1] = manualYaos[i - 1] === 1 ? 0 : 1; drawEditor(); return; }
      var mt = e.target.closest(".mv-toggle");
      if (mt) { var j = +mt.dataset.i; manualMoving = manualMoving === j ? 0 : j; drawEditor(); return; }
    });

    function renderInputs() {
      var m = segVal($("#mh-method")), box = $("#mh-inputs");
      if (m === "number") {
        box.innerHTML = '<div class="tf-grid" style="margin-top:12px">' +
          '<div class="tf-field"><label>下卦之数（第一个数字）</label><input class="ti" id="mh-n1" type="number" value="23" /></div>' +
          '<div class="tf-field"><label>上卦之数（第二个数字）</label><input class="ti" id="mh-n2" type="number" value="45" /></div></div>';
      } else if (m === "time") {
        // 时间起卦始终复用统一的 dateTimeHTML + 同一个日历弹窗，默认填当前时刻；
        // 不再另造「此刻 / 指定时间」小控件，避免两套时间选择器并存。
        var nw = new Date();
        box.innerHTML = '<div class="tf-group" style="margin-top:12px"><div class="tf-gt">占卜日期和时间</div>' +
          dateTimeHTML("mhw", { dateLabel: "起卦日期", timeLabel: "起卦时刻" }) +
          '<p class="p-note" style="margin:8px 0 0">默认取当前时刻；点日期按钮可在同一日历中改选任意公历时刻。</p></div>';
        dateTimeBind("mhw", { year: nw.getFullYear(), month: nw.getMonth() + 1, day: nw.getDate(),
          hour: nw.getHours(), minute: nw.getMinutes() });
      } else if (m === "manual") {
        box.innerHTML = '<div class="tf-group" style="margin-top:12px"><div class="tf-gt">卦象预览</div>' +
          '<p class="p-note" id="mh-mhint" style="margin:0 0 8px">点爻线切换阴阳，点“不变/动爻”指定变爻</p>' +
          '<div class="mh-yaos" id="mh-editor"></div>' +
          '<div class="mh-gua-preview" id="mh-gua-preview"></div></div>';
        drawEditor();
      } else {
        box.innerHTML = '<p class="p-note">系统会结合你所问之事与当下机缘给出两个数：第一数取下卦，第二数取上卦，动爻以两数之和除 6 取余。同一个问题在不同时刻起卦，卦象也会不同。</p>';
      }
    }
    renderInputs();
    $$("#mh-method button").forEach(function (b) {
      b.onclick = function () { segSet($("#mh-method"), b.dataset.v); renderInputs(); };
    });
    // 生成卦象始终可点：未填问题时点击给出明确提示，避免"点了没反应"的观感
    function updateBtn() {}
    $("#mh-q").addEventListener("input", updateBtn);

    function mhParams() {
      var m = segVal($("#mh-method")), p = "method=" + m;
      if (m === "number") p += "&num1=" + ($("#mh-n1").value || 1) + "&num2=" + ($("#mh-n2").value || 1);
      if (m === "time" && $("#mhw-date") && $("#mhw-date").value) {
        p += "&when=" + encodeURIComponent(dateTimeCollect("mhw").when);
      }
      if (m === "manual") {
        var bits = manualYaos.map(String).join("");
        var upBits = bits.slice(3).split("").reverse().join(""), loBits = bits.slice(0, 3).split("").reverse().join("");
        var name2 = {}; for (var n in GUA_BITS) name2[GUA_BITS[n]] = n;
        p += "&upper=" + encodeURIComponent(name2[upBits] || "乾") + "&lower=" + encodeURIComponent(name2[loBits] || "乾") + "&moving=" + (manualMoving || 1);
      }
      return p;
    }
    function guaCard(tag, gua, upper, lower, isBian, movingLabel) {
      return '<div class="mh-gua-card' + (isBian ? ' bian' : '') + '">' +
        '<div class="tag">' + tag + '</div>' +
        '<div class="sym">' + esc(upper.symbol || "") + '<span>' + esc(lower.symbol || "") + '</span></div>' +
        '<div class="nm">' + esc(gua.name) + '</div>' +
        '<div class="sub">' + esc((gua.index || "—")) + '卦 · 上' + esc(upper.name) + '下' + esc(lower.name) + '</div>' +
        (movingLabel ? '<div class="mv">' + esc(movingLabel) + '</div>' : '') +
      '</div>';
    }
    // v126：卦面投影（纯函数）——从 Board.data 重建盘面卡，归档/快照都走它，不读旧 DOM。
    function mhBoardView(boardData) {
      var bianUpper = (boardData.bian_gua && boardData.bian_gua.upper) || boardData.upper;
      var bianLower = (boardData.bian_gua && boardData.bian_gua.lower) || boardData.lower;
      return '<div class="p-result">' + resultTitle("卦象") +
        '<div class="p-card"><div style="text-align:center;margin-bottom:14px"><div class="p-hero-tag">第' + boardData.ben_gua.index + '卦</div>' +
        '<div class="mh-pv-name">' + esc(boardData.ben_gua.name) + '</div>' +
        '<div class="mh-pv-move">第 ' + boardData.moving + ' 爻动 · 变卦 ' + esc(boardData.bian_gua.name) + '</div></div>' +
        '<div class="mh-gua-row">' +
          guaCard("本卦", boardData.ben_gua, boardData.upper, boardData.lower, false, "第 " + boardData.moving + " 爻动") +
          guaCard("互卦", boardData.hu_gua || boardData.ben_gua, (boardData.hu_gua || boardData).upper, (boardData.hu_gua || boardData).lower, false) +
          guaCard("变卦", boardData.bian_gua, bianUpper, bianLower, true, "第 " + boardData.moving + " 爻动") +
        '</div></div></div>';
    }
    BOARD_VIEWS.meihua = mhBoardView;
    var mhDrawing = false;
    function castMeihua(autoAskQ) {
      if (mhDrawing) return;
      // 并发保护：本轮 AI 解卦仍在流式输出时，禁止重新起卦（否则会清空正在写入的容器导致卡死）
      if (S.busyKeys && S.busyKeys["mh-result"]) { toast("当前解卦进行中，请等解读完成后再起新卦"); return; }
      var q0 = $("#mh-q").value.trim();
      if (!q0) { toast("请先写下你的决策问题"); $("#mh-q").focus(); return; }
      mhDrawing = true;
      $("#mh-err").textContent = "";
      // 所问之事作为起卦变量之一随 calc 下发（随机起卦时与时刻/随机源共同参与起数）
      fetch("/api/meihua/calc?" + mhParams() + "&question=" + encodeURIComponent(q0)).then(function(r){return r.json();}).then(function(d){
        mhDrawing = false;
        if (!d.ok) { $("#mh-err").textContent = d.error || "起卦失败"; return; }
        var bianUpper = (d.bian_gua && d.bian_gua.upper) || d.upper;
        var bianLower = (d.bian_gua && d.bian_gua.lower) || d.lower;
        // 每次起卦 = 新一轮：先折叠归档上一整轮（卦象+解读+追问链），再渲染新卦象。
        // 带上旧轮的 rk，归档项才有完整身份；同问题不同卦因 rk 不同而各成平级轮。
        archiveRound($("#mh-result"), $("#mh-result").dataset.roundQ || $("#mh-result").dataset.lastQ || "上一轮起卦", $("#mh-result").dataset.rk);
        // 卦象身份 = 本卦序 + 动爻 + 变卦序；同问题不同卦是两轮，不能按问题文本去重
        // 身份含起卦时刻：同一卦不同时辰，外应与时令旺衰不同，属不同轮
        var mhRk = "gua|" + d.ben_gua.index + "-" + d.moving + "-" + d.bian_gua.index + "|" + (d.when || "");
        // 锁定本次卦象与起卦时刻：deduce 用 manual + 这组上下卦/动爻重算，并沿用 calc 的实际时刻。
        // 少了 when，用户指定了起卦时间也会被 deduce 的「当前时刻」覆盖，时令旺衰与所见不一致。
        var mhLock = "method=manual&upper=" + encodeURIComponent(d.upper.name) +
          "&lower=" + encodeURIComponent(d.lower.name) + "&moving=" + d.moving +
          "&when=" + encodeURIComponent(d.when || "");
        // v126：盘面数据存进 Board 对象（真相源），DOM 只是投影。
        putBoard("meihua", mhRk, d, { lock: mhLock, upper: d.upper.name, lower: d.lower.name, moving: d.moving }, d.when);
        // 结构统一（v124）：卦象卡 + 独立提问卡 + AI 解读输出三段平级，与六爻/奇门同构。
        $("#mh-result").innerHTML = mhBoardView(d) +
          '<div class="bz-ask"><div class="bz-ask-h">就这一卦提问<span>卦盘已锁定，追问与解读使用同一卦</span></div>' +
          '<button class="tool-ai" id="mh-ai">AI 解卦</button></div>';
        lastGua = d;
        $("#mh-result").dataset.roundQ = q0;
        $("#mh-result").dataset.rk = mhRk;
        $("#mh-ai").onclick = function () {
          var q = $("#mh-q").value.trim();
          if (!q) { toast("请先写下所问之事"); return; }
          if (requireLogin()) return;
          if (!mhBaziReady) { toast("请先在个人中心补全出生年月日与出生时间，梅花解卦需结合您的八字命局"); return; }
          // 问题文本变了 = 新提问 → 重新起卦并按新问题解卦
          if (q !== $("#mh-result").dataset.roundQ) { toast("问题已更改，正在按新问题重新起卦"); castMeihua(q); return; }
          streamAI("meihua", mhLock + "&q=" + encodeURIComponent(q) + authParam(), q, $("#mh-result"), mhRk);
        };
        if (autoAskQ && mhBaziReady && S.profile) streamAI("meihua", mhLock + "&q=" + encodeURIComponent(autoAskQ) + authParam(), autoAskQ, $("#mh-result"), mhRk);
        $("#mh-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
      }).catch(function () { mhDrawing = false; });
    }
    $("#mh-calc").onclick = function () { castMeihua(null); };
    applyGate("meihua");
  }

  /* ================= 塔罗牌 ================= */
  function renderTarot() {
    stageEl().innerHTML =
      toolHero("塔罗牌占卜", "以图像与象征映照问题的不同侧面。写下明确的问题，程序会结合所问之事与当下机缘抽牌；确认牌面后，由 AI 按牌位和正逆位组织成一条与你有关的叙事——包含主线，也指出盲点。") +
      '<div class="tool-card"><div class="tool-form" id="tr-form">' +
        (S.profile
          ? '<div class="p-bazi-gate ok tr-star-gate"><span class="bg-ic">◈</span><span class="bg-txt">解牌将自动结合您档案生日换算的太阳星座（性格基调），让解读更贴合本人。</span></div>'
          : '<div class="p-bazi-gate warn tr-star-gate"><span class="bg-ic">◈</span><span class="bg-txt">登录后，塔罗解牌将自动结合档案生日换算的太阳星座，让解读更贴合本人。</span></div>') +
        '<div class="tf-group"><div class="tf-gt">提出您的问题</div>' +
          '<p class="p-note" style="margin:0 0 10px">请输入一个明确的问题，程序会结合所问之事与当下机缘抽牌；同一问题每次抽牌也可能不同。确认牌面后，可让 AI 按牌位和正逆位解读</p>' +
          '<input class="ti" id="tr-q" placeholder="例如：创业还是留在大公司更适合我？" />' +
          '<div class="p-suggest tr-chips"><button data-q="创业还是留在大公司更适合我？">创业还是留在大公司更适合我？</button><button data-q="对方不喜欢我，我该如何让自己放下？">对方不喜欢我，我该如何让自己放下？</button><button data-q="为何我在社交场中难以做真实的自己？">为何我在社交场中难以做真实的自己？</button></div>' +
        '</div>' +
        '<div class="tf-group"><div class="tf-gt">牌阵</div>' +
          '<div class="p-seg" id="tr-spread"><button class="on" data-v="three">三张牌 · 过去现在未来</button><button data-v="celtic_cross">凯尔特十字（十张）</button></div>' +
        '</div>' +
        '<label class="p-switch tr-star-switch"><input type="checkbox" id="tr-star"' + (S.profile ? ' checked' : ' disabled') + ' /><span>结合我的太阳星座解牌</span></label>' +
        '<button class="tool-submit" id="tr-draw">抽取塔罗牌</button>' +
        '<div class="p-err" id="tr-err"></div>' +
      '</div></div>' +
      '<div id="tr-result"></div>' +
      aboutDetails("关于塔罗牌", [
        '完整牌组 78 张：大阿卡纳 22 张如人生章节，小阿卡纳 56 张把主题落到行动（权杖）、情绪（圣杯）、思虑（宝剑）与现实（星币）。本站采用 Rider-Waite-Smith 体系，牌面取自经典 RWS 图像。',
        '正位 / 逆位会改变牌的表达方式；牌面（牌名、牌位、正逆位）在解读前全部确定，不随语气切换而改变。',
        '「过去·现在·未来」是帮助叙事的时间框架，不是三句预言；牌与牌之间的重复、冲突与转折，比单张吉凶更有信息。'
      ], "塔罗像一面带象征语言的镜子，帮助看见期待、恐惧与尚未承认的选择；它是自我探索工具，不是心理诊断或命运判决。");

    segBind($("#tr-spread"));
    $$(".p-suggest button", stageEl()).forEach(function (b) { b.onclick = function () { pickQuestion(b.dataset.q, "#tr-q"); }; });
    // 牌义清单（78 张：中英文名 / 牌面图 / 正逆位关键词 / 简介），一次加载全站复用
    if (!S.tarotCards) {
      fetch("/tarot-cards.json").then(function (r) { return r.json(); }).then(function (j) { S.tarotCards = j; }).catch(function (e) { warn("塔罗牌义表加载失败", e); });
    }
    function trParam() { return "spread=" + segVal($("#tr-spread")); }
    /* 单张牌面（十字布局用小图 + 序号角标） */
    function xcard(c, num, over) {
      return '<div class="x-card xc' + (over ? ' x-over' : '') + '">' +
        '<div class="imgwrap"><img src="/tarot-img/' + c.slug + '.jpg" alt="' + esc(c.name) + '" /><span class="x-num">' + num + '</span></div>' +
      '</div>';
    }
    /* 牌义注释：序号 · 牌位 · 牌名 · 正逆位 + 完整简介（象征 + 代表，与卡面序号一一对应） */
    function noteItem(c, i) {
      var meta = (S.tarotCards || {}) || {};
      meta = meta[c.slug] || {};
      var intro = String(meta.intro || "");
      return '<div class="tc-note"><div class="nm"><i class="no">' + (i + 1) + '</i>' + esc(meta.zh || c.name) +
        ' <em>' + esc(c.position) + ' · ' + (c.reversed ? '逆位' : '正位') + '</em></div>' +
        (intro ? '<p class="tc-intro">' + esc(intro) + '</p>' : '') + '</div>';
    }
    function showCards(cards, spread) {
      var notes = '<div class="tc-notes">' + cards.map(noteItem).join("") + '</div>';
      if (spread === "celtic_cross") {
        /* 凯尔特十字（十张）标准编号：十字区 1状况居中、2障碍横覆其上（只看正位）、3基础居下、4过去居左、5主观看法居上、6将来居右；权杖柱 7自己/8环境/9希望恐惧/10结果 自下而上。
           左列放牌阵（权杖柱按十字三行总高自动缩放），右列同行并排展示十张牌的牌义。 */
        return '<div class="tc-wrap">' +
          '<div class="tc-cross">' +
            '<div class="x-grid">' +
              '<div class="x-top">' + xcard(cards[4], 5) + '</div>' +
              '<div class="x-left">' + xcard(cards[3], 4) + '</div>' +
              '<div class="x-center">' + xcard(cards[0], 1) + xcard(cards[1], 2, true) + '</div>' +
              '<div class="x-right">' + xcard(cards[5], 6) + '</div>' +
              '<div class="x-below">' + xcard(cards[2], 3) + '</div>' +
            '</div>' +
            '<div class="x-staff">' + xcard(cards[9], 10) + xcard(cards[8], 9) + xcard(cards[7], 8) + xcard(cards[6], 7) + '</div>' +
          '</div>' +
          notes +
        '</div>';
      }
      return '<div class="tcard-grid' + (cards.length === 3 ? ' t3' : '') + '">' + cards.map(function (c) {
        var meta = (S.tarotCards || {})[c.slug] || {};
        return '<div class="tcard-big">' +
          '<div class="imgwrap"><img src="/tarot-img/' + c.slug + '.jpg" alt="' + esc(c.name) + '" loading="lazy" />' +
          '<span class="ori-badge">' + (c.reversed ? '逆位' : '正位') + '</span></div>' +
          '<div class="nm">' + esc(meta.zh || c.name) + '</div>' +
          '<div class="en">' + esc(meta.en || "") + '</div>' +
          '<div class="pos">' + esc(c.position) + '</div>' +
          (meta.intro ? '<p class="tc-intro">' + esc(meta.intro) + '</p>' : '') +
        '</div>';
      }).join("") + '</div>';
    }
    // v126：牌面投影（纯函数）——从 Board.data 重建，供归档/快照使用。
    function trBoardView(boardData) {
      return '<div class="p-result">' + resultTitle("牌面") +
        '<div class="p-card">' + showCards(boardData.cards || [], boardData.spread) + '</div></div>';
    }
    BOARD_VIEWS.tarot = trBoardView;
    function askTarot(deck, q) {
      var useStar = $("#tr-star") && $("#tr-star").checked && S.profile ? "&use_star=1" : "";
      streamAI("tarot", trParam() + "&q=" + encodeURIComponent(q) + "&deck=" + encodeURIComponent(deck) + useStar + authParam(), q, $("#tr-result"), $("#tr-result").dataset.rk);
    }
    var trDrawing = false;
    function drawTarot(autoAskQ) {
      if (trDrawing) return;
      // 并发保护：本轮 AI 解读仍在流式输出时，禁止重新抽牌（否则会清空正在写入的容器导致卡死）
      if (S.busyKeys && S.busyKeys["tr-result"]) { toast("当前解读进行中，请等解读完成后再抽新牌"); return; }
      var q0 = $("#tr-q").value.trim();
      if (!q0) { toast("请先写下你想问的事，再抽牌"); $("#tr-q").focus(); return; }
      trDrawing = true;
      // 所问之事作为抽牌变量之一随 calc 下发（与时刻/随机源共同参与抽牌，问题唯一改变也会改变牌面分布）
      fetch("/api/tarot/calc?" + trParam() + "&question=" + encodeURIComponent(q0)).then(function(r){return r.json();}).then(function(d){
        trDrawing = false;
        if (!d.ok) { $("#tr-err").textContent = d.error || "抽牌失败"; return; }
        // 每次抽牌 = 新一轮：先把上一整轮（牌面+解读+追问链）折叠归档，再渲染新牌面。
        // 归档区在结果容器之外，所以这里 innerHTML 重建 #tr-result 不会冲掉归档。
        // 带上旧轮 rk：同问题三张牌/凯尔特十字是不同身份，各自成平级轮，不嵌套、不互相去重。
        archiveRound($("#tr-result"), $("#tr-result").dataset.roundQ || $("#tr-result").dataset.lastQ || "上一轮抽牌", $("#tr-result").dataset.rk);
        // 锁定本次抽牌结果：slug|正逆位串随 AI 解读回传，保证解读用的牌 == 用户看到的牌
        var deck = (d.cards || []).map(function(c){ return c.slug + "|" + (c.reversed ? 1 : 0); }).join(",");
        var spreadNow = d.spread || segVal($("#tr-spread"));
        // 牌阵身份 = 牌阵类型 + 实际牌面串；换牌阵或重新抽牌都会得到新的 rk
        var trRk = "tarot|" + spreadNow + "|" + deck;
        $("#tr-result").dataset.rk = trRk;
        // v126：牌面数据存进 Board 对象（真相源），DOM 只是投影。
        putBoard("tarot", trRk, d, { deck: deck, spread: spreadNow }, d.when);
        // 结构统一（v124）：牌面卡 + 独立提问卡 + AI 解读输出三段平级，
        // 与六爻/奇门/八字/紫微同构；此前按钮内嵌在牌面卡里，是全站唯一的例外。
        $("#tr-result").innerHTML = trBoardView(d) +
          '<div class="bz-ask"><div class="bz-ask-h">就这一组牌提问<span>牌面已锁定，问题只决定解读焦点</span></div>' +
          '<button class="tool-ai" id="tr-ai">AI 解读牌义</button></div>';
        $("#tr-result").dataset.roundQ = q0;
        $("#tr-result").dataset.deck = deck;
        $("#tr-ai").onclick = function () {
          var q = $("#tr-q").value.trim();
          if (!q) { toast("请先写下你的问题"); $("#tr-q").focus(); return; }
          // 入口2：问题文本变了 = 真正的新提问 → 自动重新抽牌，并按新问题解读
          if (q !== $("#tr-result").dataset.roundQ) { toast("问题已更改，正在按新问题重新抽牌"); drawTarot(q); return; }
          askTarot($("#tr-result").dataset.deck, q);
        };
        if (autoAskQ) askTarot(deck, autoAskQ);
        $("#tr-result").scrollIntoView({ behavior:"smooth", block:"nearest" });
      }).catch(function () { trDrawing = false; });
    }
    $("#tr-draw").onclick = function () { drawTarot(null); };
    applyGate("tarot");
  }

  /* ================= 占星命盘（完整本命盘） ================= */
  var SIGN_SYM = { "白羊座":"♈","金牛座":"♉","双子座":"♊","巨蟹座":"♋","狮子座":"♌","处女座":"♍",
    "天秤座":"♎","天蝎座":"♏","射手座":"♐","摩羯座":"♑","水瓶座":"♒","双鱼座":"♓" };
  function signSym(n) { return SIGN_SYM[n] || "✦"; }

  function renderAstrology() {
    // 命盘类：登录态用档案出生信息自动排盘并收起表单，结果区直接提问；
    // 出生信息不变则复用缓存、不重复排盘，仅档案变更时才重排。未登录态需在本页填写出生资料后手动生成。
    var asProfileBirth = null;   // 登录态档案出生信息副本
    var asEditing = false;       // 登录态是否处于「修改出生信息」编辑模式

    stageEl().innerHTML =
      toolHero("占星命盘 · 本命盘", "使用与你个人档案共用的出生资料排出完整本命盘：太阳、月亮、上升三大件，十大行星落座，十二宫宫位与主要相位。AI 将据此作一次结构化解读。") +
      '<div class="tool-card" id="as-form-card"><div class="tool-form" id="as-form">' +
        '<div class="tf-group"><div class="tf-gt">出生资料</div>' +
          birthFieldsHTML("as", { simple: true, compact: true }) +
          placeFieldsHTML("as") +
          '<p class="p-note" style="margin:8px 0 0">出生地决定上升与宫位；不知道精确时间时可用中午 12:00，但上升与宫位会有偏差。登录后会存入个人档案，供各功能共用。</p>' +
        '</div>' +
        '<button class="tool-submit" id="as-calc">生成本命盘</button>' +
        '<div class="p-err" id="as-err"></div>' +
      '</div></div>' +
      '<div id="as-result"></div>' +
      aboutDetails("关于本命盘", [
        '<b>太阳</b>代表核心自我与意志，<b>月亮</b>代表情绪与内在需求，<b>上升</b>代表外在呈现与人生态度，三者共同构成人格骨架。',
        '行星落在<b>十二星座</b>（如何表达）与<b>十二宫位</b>（在哪个生活领域），再结合与其他行星的<b>相位</b>（协作或张力）一并解读，才是完整的占星判断。',
        '本盘采用回归黄道、Placidus 宫制（高纬度自动回落整宫制），星历由 Swiss Ephemeris 计算；占星为性格与趋势的象征性参考，非命运定论。'
      ], "占星是一面象征之镜，帮助你理解性格倾向与人生课题；它提供视角而非答案，选择权始终在你手中。");

    // 表单始终绑定（登录态拉档案后回填、未登录态临时填写）
    birthFieldsBind("as", { calendar: "solar" });
    placeFieldsBind("as", {});

    // 排盘参数：登录态默认取档案；「修改出生信息」编辑态与未登录态取表单
    function asParams() {
      if (S.profile && !asEditing && asProfileBirth && asProfileBirth.year) {
        var b = asProfileBirth;
        var co = b.country || "中国", pv = b.province || "", ct = b.city || "";
        var place = (co === "中国" ? pv.replace(/(省|市|自治区|特别行政区)$/, "") : co) + (ct ? "·" + ct : "");
        return { y: b.year, m: b.month, d: b.day, h: b.hour != null ? b.hour : 12, mi: b.minute != null ? b.minute : 0,
                 country: co, province: pv, city: ct, place: place, lat: b.lat, lon: b.lon, tz: b.tz != null ? b.tz : 8 };
      }
      var fb = birthCollect("as");
      var pl = placeCollect("as");
      return { y: fb.year, m: fb.month, d: fb.day, h: fb.hour, mi: fb.minute,
               country: pl.country, province: pl.province, city: pl.city,
               place: pl.place, lat: pl.lat, lon: pl.lon, tz: pl.tz };
    }

    // 登录态排完盘后收起出生资料卡，结果标题右侧给出来源提示 + 修改入口（对齐八字/紫微）
    function collapseBirth() { var card = $("#as-form-card"); if (card) card.style.display = "none"; }
    function profileAside() {
      if (!S.profile || asEditing) return "";
      return '<span class="result-aside" id="as-edit">已使用档案中的出生信息 · ' +
        '<button type="button" class="link-btn" data-as-edit="1">修改出生信息</button></span>';
    }
    // 「修改出生信息」：展开已回填的表单卡供编辑（改动后重新生成会写回档案）
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-as-edit]");
      if (!b) return;
      asEditing = true;
      var card = $("#as-form-card"); if (card) card.style.display = "";
      var aside = $("#as-edit"); if (aside) aside.remove();
      var g = $("#as-form .tf-group"); if (g) g.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    // 登录态：拉档案 → 回填表单 → 出生信息完整则自动出盘（命中缓存直接用，不重复排盘）
    if (S.profile) {
      fetch("/api/profile/get?id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token))
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok && d.profile && d.profile.birth) {
            var b = d.profile.birth;
            asProfileBirth = b; S.profileBirth = b;
            birthFieldsBind("as", { calendar: "solar", year: b.year, month: b.month, day: b.day,
              hour: b.hour != null ? b.hour : 12, minute: b.minute != null ? b.minute : 0,
              know_time: b.know_time !== false });
            placeFieldsBind("as", { country: b.country, province: b.province, city: b.city,
              lat: b.lat, lon: b.lon, tz: b.tz });
            // 出生日期 + 经纬度齐全才自动出盘；缺项则保留表单让用户补全
            if (b.year && b.month && b.day && b.lat != null && b.lon != null) autoCastAstro();
          }
        }).catch(function (e) { warn("占星页载入档案出生信息失败", e); });
    }
    function posLine(label, sym, sign, deg, house) {
      return '<div class="as-pos"><span class="as-pos-sym">' + sym + '</span>' +
        '<span class="as-pos-label">' + label + '</span>' +
        '<span class="as-pos-sign">' + esc(sign) + '</span>' +
        '<span class="as-pos-deg">' + esc(deg) + '</span>' +
        (house ? '<span class="as-pos-house">第' + house + '宫</span>' : '') + '</div>';
    }
    var asDrawing = false;
    var ASTRO_CHIPS = [
      { t: "性格优势", q: "我的性格优势与短板分别是什么？" },
      { t: "事业方向", q: "我现阶段的事业方向该如何选择？" },
      { t: "感情课题", q: "我的感情关系有哪些课题？" }
    ];
    function astroKey(pa) { return [pa.y, pa.m, pa.d, pa.h, pa.mi, pa.lat, pa.lon, pa.place].join("|"); }
    function buildQS(pa) {
      return "year=" + pa.y + "&month=" + pa.m + "&day=" + pa.d + "&hour=" + pa.h + "&minute=" + pa.mi +
        "&lat=" + pa.lat + "&lon=" + pa.lon + "&tz=" + pa.tz + "&place=" + encodeURIComponent(pa.place) +
        "&country=" + encodeURIComponent(pa.country) + "&province=" + encodeURIComponent(pa.province) +
        "&city=" + encodeURIComponent(pa.city) +
        (S.profile && asEditing ? "&save=1&gender=" + encodeURIComponent((asProfileBirth && asProfileBirth.gender) || "男") : "");
    }
    // 纯渲染：把排盘数据与提问卡画进结果区（三段平级，对齐八字）
    function paintAstro(d, pa, qs, rk, q) {
      // 与八字同构：只有出生参数变化（新盘）才归档整轮；同盘重绘必须保留解读容器。
      var asRoot = $("#as-result");
      if (asRoot.dataset.chartKey && asRoot.dataset.chartKey !== rk) {
        archiveBeforeRepaint(asRoot, "astrology");
      }
      asRoot.dataset.chartKey = rk;
      // v126：占星本命盘数据存进 Board 对象（真相源），DOM 只是投影。
      putBoard("astrology", rk, d, { params: qs }, "");
      preserveOutputs(asRoot, function () {
      var big = '<div class="as-big3">' +
        posLine("太阳 ☉", "☉", d.sun.sign, d.sun.degree, d.sun.house) +
        posLine("月亮 ☽", "☽", d.moon.sign, d.moon.degree, d.moon.house) +
        posLine("上升 ↑", "↑", d.asc.sign, d.asc.degree, null) +
        posLine("中天", "◈", d.mc.sign, d.mc.degree, null) +
      '</div>';
      var planets = (d.planets || []).filter(function (p) { return p.key !== "sun" && p.key !== "moon"; })
        .map(function (p) {
          return '<div class="as-planet"><b>' + esc(p.name) + '</b><span>' + signSym(p.sign) + ' ' + esc(p.sign) + ' ' + esc(p.degree) + '</span>' +
            '<em>第' + (p.house || "—") + '宫' + (p.retro ? ' · 逆行' : '') + '</em>' +
            (p.meaning ? '<div class="as-mean">主管' + esc(p.meaning) + '，落在' + esc(p.sign) + '使这一主题带上该星座的表达方式</div>' : '') +
          '</div>';
        }).join("");
      var houses = (d.houses || []).map(function (h) {
        return '<div class="as-house">' +
          '<div class="as-house-h"><i>' + h.num + '</i><span>' + signSym(h.sign) + ' ' + esc(h.sign) + '</span><em>' + esc(h.degree) + '</em></div>' +
          (h.meaning ? '<div class="as-house-mean">' + esc(h.meaning) + '</div>' : '') +
        '</div>';
      }).join("");
      var aspects = (d.aspects || []).map(function (a) {
        return '<div class="as-aspect"><b>' + esc(a.name) + '</b><span>' + esc(a.a) + ' — ' + esc(a.b) + '</span><em>容许 ' + a.orb + '°</em>' +
          (a.tone ? '<div class="as-mean">' + esc(a.tone) + '</div>' : '') + '</div>';
      }).join("") || '<p class="p-note">主要相位较少</p>';
      var elem = d.element || {};
      var elemLine = ['火','土','风','水'].map(function (k) { return k + (elem[k] || 0); }).join(' · ');

      $("#as-result").innerHTML = '<div class="p-result">' +
          '<div class="result-head">' + resultTitle("本命盘") + profileAside() + '</div>' +
          '<div class="p-card as-card">' +
            '<div class="as-meta">公历 ' + pa.y + '-' + String(pa.m).padStart(2,"0") + '-' + String(pa.d).padStart(2,"0") +
              ' ' + String(pa.h).padStart(2,"0") + ':' + String(pa.mi).padStart(2,"0") + ' · ' + esc(pa.place) +
              ' · ' + esc(d.house_system || "") + '宫制 · 元素 ' + elemLine + '</div>' +
            big +
            '<div class="as-sub-h">行星落座</div><div class="as-planets">' + planets + '</div>' +
            '<div class="as-sub-h">十二宫</div><div class="as-houses">' + houses + '</div>' +
            '<div class="as-sub-h">主要相位</div><div class="as-aspects">' + aspects + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="bz-ask as-ask">' +
          '<div class="bz-ask-h">就这张盘提问</div>' +
          '<div class="p-suggest zw-chips">' + ASTRO_CHIPS.map(function (c) {
            return '<button type="button" data-q="' + esc(c.q) + '">' + esc(c.t) + '</button>';
          }).join("") + '</div>' +
          '<div class="zw-ask-row"><input class="ti" id="as-q" placeholder="例如：我现阶段适合怎样发展事业？" />' +
            '<button class="tool-ai zw-ask-btn" id="as-ai" type="button">AI 解读</button></div>' +
        '</div>' +
        '<div id="as-ai-out"></div>';
      }, "astrology");
      $("#as-result").dataset.rk = rk;
      $("#as-result").dataset.roundQ = q || "";
      $$("#as-result .zw-chips button").forEach(function (b) { b.onclick = function () { pickQuestion(b.dataset.q, "#as-q"); }; });
      $("#as-ai").onclick = function () {
        var nq = $("#as-q").value.trim();
        if (!nq) { toast("请先写下你想问的事"); $("#as-q").focus(); return; }
        if (requireLogin()) return;
        streamAI("astrology", qs + "&q=" + encodeURIComponent(nq) + authParam(), nq, $("#as-ai-out"), rk);
      };
      $("#as-q").onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); $("#as-ai").click(); } };
      if (S.profile && !asEditing) collapseBirth();
    }
    // 排盘核心：命中缓存直接渲染（不请求），否则请求后端并写缓存
    function doCast(pa, auto) {
      var qs = buildQS(pa);
      var key = astroKey(pa);
      // 身份含经纬度/时区：同城同名但坐标或时区不同，星盘会变，必须另起一轮而非命中旧解读
      var rk = "astro|" + pa.y + "-" + pa.m + "-" + pa.d + "|" + pa.h + ":" + pa.mi + "|" + pa.place +
        "|" + pa.lat + "," + pa.lon + "," + pa.tz;
      var paint = function (d) {
        asDrawing = false;
        if (d.birth_saved) {
          profileBirthChanged(); asEditing = false;
          toast("出生信息已同步到个人档案，其它功能将使用新信息");
        }
        if (S.profile && !asEditing) chartCacheSet("astrology", { key: key, uid: S.profile.id, data: d });
        paintAstro(d, pa, qs, rk, auto ? "" : ($("#as-result").dataset.roundQ || ""));
        if (!auto) $("#as-result").scrollIntoView({ behavior: "smooth", block: "nearest" });
      };
      var cached = S.profile ? chartCacheGet("astrology") : null;
      if (cached && cached.key === key && cached.uid === S.profile.id && cached.data) { paint(cached.data); return; }
      asDrawing = true;
      $("#as-err").textContent = "";
      fetch("/api/astrology/calc?" + qs).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { asDrawing = false; $("#as-err").textContent = d.error || "排盘失败"; return; }
        paint(d);
      }).catch(function () { asDrawing = false; $("#as-err").textContent = "排盘失败，请检查出生资料后重试"; });
    }
    function castAstro() {
      if (asDrawing) return;
      if (S.busyKeys && S.busyKeys["as-ai-out"]) { toast("当前解读进行中，请稍候"); return; }
      var pa = asParams();
      if (!pa.y || !pa.m || !pa.d) { toast(S.profile ? "档案尚无出生日期" : "请在出生资料里选择出生日期"); return; }
      if (pa.lat == null || pa.lon == null) { toast(S.profile ? "档案还没有出生地，请到个人中心补全" : "请选择出生国家 / 省份 / 城市"); return; }
      doCast(pa, false);
    }
    function autoCastAstro() {
      if (asDrawing) return;
      var pa = asParams();
      if (!pa.y || !pa.m || !pa.d || pa.lat == null || pa.lon == null) return;
      doCast(pa, true);
    }
    $("#as-calc").onclick = function () { castAstro(); };
    applyGate("astrology");
  }

  /* ================= 黄历（月历视图 + 默认当日历注 + AI 问事） ================= */
  function renderHuangli() {
    var isPair = false;          // 当前子功能：个人今日运势 / 双人择日
    var feat = "huangli";        // 双人择日沿用后端 huangli_pair 端点（历史分类不变）
    var pfxA = "hlpa", pfxB = "hlpb";
    var now = new Date();
    var view = { y: now.getFullYear(), m: now.getMonth() + 1 };
    var sel = { y: view.y, m: view.m, d: now.getDate() };

    /* 两个子功能共用同一张日历与当日历注（上方），只切换下方提问卡。
       此前拆成两个 stage 会重复 #hl-cal/#hl-day id，全局选择器命中隐藏舞台 → 日历恒「加载中」。 */
    function formCard() {
      if (isPair) return '<div class="p-bazi-gate ok hl-bazi-gate"><span class="bg-ic">◈</span><span class="bg-txt">双人择日会并列男女双方八字，与上方所选日子的干支双向核对；任一方都可手动填写或导入本人档案。</span></div>' +
        pairFormHTML(pfxA, pfxB, "男女双方分别填写，性别可按需调整；出生地用于真太阳时校正。") +
        '<div class="tf-group" style="margin-top:14px"><div class="tf-gt">你想问什么？（结合上方所选日期）</div>' +
          '<input class="ti" id="hl-q" placeholder="例如：这天适合我们订婚吗？" />' +
          '<div class="p-suggest"><button data-q="这天适合我们订婚吗？">订婚择日</button><button data-q="这天适合我们一起搬家吗？">共同搬家</button><button data-q="这天签约对双方都合适吗？">共同签约</button></div>' +
        '</div>' +
        '<button class="tool-ai" id="hl-ai">AI 双人择日</button>';
      return (S.profile
          ? '<div class="p-bazi-gate ok hl-bazi-gate"><span class="bg-ic">◈</span><span class="bg-txt">择日答疑将自动结合您档案中的八字（日主与喜忌），让答案更贴合本人。</span></div>'
          : '<div class="p-bazi-gate warn hl-bazi-gate"><span class="bg-ic">◈</span><span class="bg-txt">登录后，择日答疑将自动结合档案里的八字（日主与喜忌），让答案更贴合本人。</span></div>') +
        '<div class="tf-group"><div class="tf-gt">AI 择日答疑</div>' +
          '<p class="p-note" style="margin:0">结合上方所选日期的完整历注，解释宜忌与你所想之事的关系。</p>' +
        '</div>' +
        '<div class="tf-field"><label>你想问什么？（结合上方所选日期）</label>' +
          '<input class="ti" id="hl-q" placeholder="例如：这天适合搬家吗？" />' +
          '<div class="p-suggest"><button data-q="今天适合做什么事情？">今天适合做什么</button><button data-q="这周哪天最适合搬家？">本周搬家吉日</button><button data-q="这天适合签约开业吗？">签约开业</button></div>' +
        '</div>' +
        '<label class="p-switch hl-bazi-switch"><input type="checkbox" id="hl-bazi"' + (S.profile ? ' checked' : ' disabled') + ' /><span>导入本人八字信息</span></label>' +
        '<button class="tool-ai" id="hl-ai">AI 择日答疑</button>';
    }
    function bindAI() {
      $("#hl-ai").onclick = function () {
        var q = $("#hl-q").value.trim();
        if (!q) { toast("请先写下想问的事"); $("#hl-q").focus(); return; }
        var extra = "";
        if (isPair) {
          // 双人择日：复用合婚并列表单，双方出生参数纳入去重身份
          var pairQs = pairFormParams(pfxA, pfxB, "#hl-err");
          if (!pairQs) return;
          extra = pairQs;
        } else {
          // 个人今日运势：勾选「导入本人八字信息」时把档案八字一并交给 AI 作择日参考
          extra = $("#hl-bazi") && $("#hl-bazi").checked && S.profile ? "&use_bazi=1" : "";
        }
        // 身份含个人约束：同日同问题先不导入八字、后导入，是两轮，不能被 findAnswered 命中旧卡
        var rk = "day|" + sel.y + "-" + sel.m + "-" + sel.d + (extra ? "|" + extra : "");
        streamAI(feat, hlParam() + "&q=" + encodeURIComponent(q) + extra + authParam(), q, $("#hl-result"), rk);
      };
    }
    function drawForm() {
      var card = $("#hl-ai-card");
      card.className = "tool-card hl-ai-card" + (isPair ? " hl-pair-ai-card" : "");
      card.innerHTML = '<div class="tool-form" id="hl-form">' + formCard() + '<div class="p-err" id="hl-err"></div></div>';
      if (isPair) pairFormBind(pfxA, pfxB);
      $$(".p-suggest button", card).forEach(function (b) { b.onclick = function () { pickQuestion(b.dataset.q, "#hl-q"); }; });
      bindAI();
      applyGate(isPair ? "huangli_pair" : "huangli");
    }
    function setMode(v) {
      var next = v === "pair";
      if (next === isPair) return;
      isPair = next;
      feat = isPair ? "huangli_pair" : "huangli";
      segSet($("#hl-tabs"), isPair ? "pair" : "personal");
      // 切子功能 = 新盘面身份：旧对话按「旧 rk + 问题」归档（对象与 DOM 同步），
      // 不再直接 innerHTML 清空——此前对象仍留在 session 里，刷新后又冒出来。
      archiveBeforeRepaint($("#hl-result"), feat);
      $("#hl-result").innerHTML = "";
      drawForm();
    }
    // 旧链接 #/huangli_pair 直达双人择日子功能：切回来时也能定位
    hlApplyMode = function (v) { setMode(v); };
    stageEl().innerHTML =
      toolHero("老黄历", "以干支、节气与日值辨一日之宜忌。上方日历与历注供两个子功能共用；看完历注再选择「个人今日运势」或「双人择日」，就在同一历注上继续提问。") +
      '<div class="tool-card hl-cal" id="hl-cal"><p class="p-note" style="text-align:center">日历加载中…</p></div>' +
      '<div id="hl-day"><p class="p-note" style="text-align:center;margin:18px 0">当日历注加载中…</p></div>' +
      '<div class="p-seg hl-subfn" id="hl-tabs"><button class="on" data-v="personal">个人今日运势</button><button data-v="pair">双人择日</button></div>' +
      '<div class="tool-card hl-ai-card" id="hl-ai-card"></div>' +
      '<div id="hl-result"></div>' +
      aboutDetails("关于黄历与双人择日", [
        '<b>宜 / 忌</b>：传统上认为适合或不适合进行的事项类别；<b>值神</b>分黄道黑道，<b>十二建星</b>（建除满平定执破危成收开闭）描述日的性质；<b>冲煞空亡</b>、神位与物候是辅助参考层。',
        '<b>个人今日运势</b>：结合所选日期的完整历注（登录后可带本人八字），解释宜忌与你所想之事的关系。',
        '<b>双人择日</b>：先由程序定日，再并列双方八字作双向参照；分别看当日干支与男女双方年柱/日柱的合冲刑害，不偏袒任一方。'
      ], "黄历描述「这一天在传统体系中的位置」，不是针对某个人的命运判断；双人择日属民俗参考，不保证关系结果。所有字段由程序确定性计算，重大事项请以现实证据与专业意见为准。");

    $("#hl-tabs").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-v]");
      if (b) setMode(b.dataset.v);
    });
    drawForm();
    function hlParam() { return "year=" + sel.y + "&month=" + sel.m + "&day=" + sel.d; }

    /* ---- 月历 ---- */
    function renderCal() {
      fetch("/api/huangli/month?year=" + view.y + "&month=" + view.m)
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { $("#hl-cal").innerHTML = '<p class="p-err">' + esc(d.error || "加载失败") + '</p>'; return; }
          var years = [], y0 = view.y - 6;
          for (var i = 0; i < 13; i++) years.push(y0 + i);
          var html =
            '<div class="hl-head">' +
              '<div><div class="hl-title">' + view.y + '年' + view.m + '月</div>' +
              '<div class="hl-sub">农历' + esc(d.lunar_year) + '年' + esc(d.lunar_month) + '</div></div>' +
              '<div class="hl-ctl">' +
                '<select class="ti" id="hl-year">' + years.map(function (y) { return '<option value="' + y + '"' + (y === view.y ? ' selected' : '') + '>' + y + '年</option>'; }).join("") + '</select>' +
                '<select class="ti" id="hl-month">' + [1,2,3,4,5,6,7,8,9,10,11,12].map(function (m) { return '<option value="' + m + '"' + (m === view.m ? ' selected' : '') + '>' + m + '月</option>'; }).join("") + '</select>' +
                '<button class="hl-nav" id="hl-prev" aria-label="上个月">‹</button>' +
                '<button class="hl-nav" id="hl-next" aria-label="下个月">›</button>' +
              '</div>' +
            '</div>' +
            '<div class="hl-week">' + ["日","一","二","三","四","五","六"].map(function (w) { return '<div>' + w + '</div>'; }).join("") + '</div>' +
            '<div class="hl-grid">' + d.lead.concat(d.days, d.tail).map(function (c) {
              var cls = "hl-cell" + (c.off ? " dim" : "") + (c.today ? " today" : "") +
                (c.off === 0 && c.d === sel.d && sel.y === view.y && sel.m === view.m ? " sel" : "");
              return '<div class="' + cls + '" data-d="' + c.d + '" data-off="' + c.off + '" data-today="' + (c.today ? 1 : 0) + '">' +
                '<b>' + c.d + '</b><span>' + esc(c.lunar) + '</span>' + (c.mark ? '<em>' + esc(c.mark) + '</em>' : '') + '</div>';
            }).join("") + '</div>';
          $("#hl-cal").innerHTML = html;
          function jump(delta) {
            var m = view.m + delta;
            if (m < 1) { m = 12; view.y--; } else if (m > 12) { m = 1; view.y++; }
            view.m = m; renderCal();
          }
          $("#hl-prev").onclick = function () { jump(-1); };
          $("#hl-next").onclick = function () { jump(1); };
          $("#hl-year").onchange = function () { view.y = +this.value; renderCal(); };
          $("#hl-month").onchange = function () { view.m = +this.value; renderCal(); };
          $$(".hl-cell", $("#hl-cal")).forEach(function (cell) {
            cell.onclick = function () {
              var off = +cell.dataset.off, dd = +cell.dataset.d;
              if (off) {   // 点击前后月补位天：翻到对应月份再选中
                var m = view.m + off, y = view.y;
                if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
                view = { y: y, m: m };
                sel = { y: y, m: m, d: dd };
                renderCal();
              } else {
                sel = { y: view.y, m: view.m, d: dd };
                $$(".hl-cell.sel", $("#hl-cal")).forEach(function (x) { x.classList.remove("sel"); });
                cell.classList.add("sel");
              }
              loadDay();
            };
          });
        }).catch(function () { $("#hl-cal").innerHTML = '<p class="p-err">日历加载失败，请刷新重试</p>'; });
    }

    /* ---- 当日历注（开放式面板，按参考样式排版） ---- */
    function loadDay() {
      fetch("/api/huangli/calc?" + hlParam()).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { $("#hl-day").innerHTML = '<p class="p-err" style="text-align:center">' + esc(d.error || "查询失败") + '</p>'; return; }
        // v126：历注数据存进 Board 对象（真相源）；日期身份让追问/归档能按盘回看。
        putBoard(feat, "day|" + sel.y + "-" + sel.m + "-" + sel.d, d,
          { date: sel.y + "-" + sel.m + "-" + sel.d }, "");
        var yiItems = (d.yi || []).slice(0, 14), jiItems = (d.ji || []).slice(0, 14);
        var yi = yiItems.length ? yiItems.map(function (t) { return "• " + esc(t); }).join("  ") : "诸事不宜";
        var ji = jiItems.length ? jiItems.map(function (t) { return "• " + esc(t); }).join("  ") : "—";
        var jq = d.jieqi_info || {};
        var cur = jq.current || jq.prev || { name: "—" };
        var curTime = (cur.time || "").replace(" ", " · ");
        var nx = jq.next || { name: "—" };
        var nxTime = (nx.time || "").replace(" ", " · ");
        $("#hl-day").innerHTML =
          '<div class="hl-panel">' +
            '<div class="hlp-top"><span class="hlp-tag">当日历注</span>' +
              '<button class="hlp-share" id="hl-share"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="6" cy="12" r="2.6"/><circle cx="17" cy="6" r="2.6"/><circle cx="17" cy="18" r="2.6"/><path d="M8.3 10.8l6.4-3.5M8.3 13.2l6.4 3.5"/></svg>分享图片</button></div>' +
            '<h2 class="hlp-date">' + sel.y + '年' + sel.m + '月' + sel.d + '日</h2>' +
            '<div class="hlp-sub"><span>农历 ' + esc(d.lunar) + '</span><span>星期' + esc(d.week) + '</span></div>' +
            '<div class="hlp-tri">' +
              '<div><i>生肖</i><b>' + esc([d.shengxiao.year, d.shengxiao.month, d.shengxiao.day].join(" · ")) + '</b></div>' +
              '<div><i>干支</i><b>' + esc(d.ganzhi.year) + ' · ' + esc(d.ganzhi.month) + ' · ' + esc(d.ganzhi.day) + '</b></div>' +
              '<div><i>纳音</i><b>' + esc([d.nayin.year, d.nayin.month, d.nayin.day].join(" · ")) + '</b></div>' +
            '</div>' +
            '<div class="hlp-jq">' +
              '<div><i>当前节气</i><b>' + esc(cur.name) + '</b><span>' + esc(curTime) + '</span></div>' +
              '<div class="hlp-dotline"><i></i><em></em></div>' +
              '<div class="r"><i>下一节气</i><b>' + esc(nx.name) + '</b><span>' + esc(nxTime) + '</span></div>' +
            '</div>' +
            '<div class="hlp-yiji">' +
              '<div class="col"><h4>宜</h4><div class="items">' + yi + '</div>' +
                '<div class="hlp-foot"><i>吉神</i><b>' + esc((d.jishen || []).join("、") || "—") + '</b></div></div>' +
              '<div class="col"><h4>忌</h4><div class="items">' + ji + '</div>' +
                '<div class="hlp-foot"><i>凶煞</i><b>' + esc((d.xiongsha || []).join("、") || "—") + '</b></div></div>' +
            '</div>' +
            '<div class="hlp-two">' +
              '<div class="hlp-block"><h4>日值关系</h4><div class="hlp-grid">' +
                '<div><i>冲煞</i><b>' + esc(d.shengxiao.day) + '日冲' + esc(d.chong_desc) + ' 煞' + esc(d.sha) + '</b></div>' +
                '<div><i>空亡</i><b>' + esc(d.kongwang || "—") + '</b></div>' +
                '<div><i>胎神</i><b>' + esc(d.taishen || "—") + '</b></div>' +
                '<div><i>天神</i><b>' + esc(d.tianshen) + '(' + esc(d.tianshen_type) + '日)</b></div>' +
              '</div></div>' +
              '<div class="hlp-block"><h4>神位方位</h4><div class="hlp-grid">' +
                '<div><i>财神位</i><b>' + esc(d.positions.cai || "—") + '</b></div>' +
                '<div><i>喜神位</i><b>' + esc(d.positions.xi || "—") + '</b></div>' +
                '<div><i>福神位</i><b>' + esc(d.positions.fu || "—") + '</b></div>' +
                '<div><i>阳贵神</i><b>' + esc(d.positions.yanggui || "—") + '</b></div>' +
              '</div></div>' +
            '</div>' +
            '<div class="hlp-xing"><h4>星历物候</h4><div class="hlp-grid wide">' +
              '<div><i>二十八宿</i><b>' + esc(d.xiu_full || d.xiu) + ' (' + esc(d.xiu_luck) + ')</b></div>' +
              '<div><i>月相</i><b>' + esc(d.yue_xiang || "—") + '</b></div>' +
              '<div><i>九星</i><b>' + esc(d.nine_star || "—") + '</b></div>' +
              '<div><i>物候</i><b>' + esc(d.hou || "") + ' ' + esc(d.wuhou || "") + '</b></div>' +
            '</div></div>' +
          '</div>';
        $("#hl-share").onclick = function () { shareDay(d); };
      }).catch(function () { $("#hl-day").innerHTML = '<p class="p-err" style="text-align:center">历注加载失败，请重试</p>'; });
    }
    /* 分享图片：把当日历注要点绘成 PNG 下载 */
    function shareDay(d) {
      var c = document.createElement("canvas");
      c.width = 900; c.height = 640;
      var ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 900, 640);
      ctx.fillStyle = "#9ca3af"; ctx.font = "22px sans-serif";
      ctx.fillText("当日历注 · Destiny Master", 60, 70);
      ctx.fillStyle = "#111827"; ctx.font = "bold 52px sans-serif";
      ctx.fillText(sel.y + "年" + sel.m + "月" + sel.d + "日", 60, 150);
      ctx.fillStyle = "#6b7280"; ctx.font = "26px sans-serif";
      ctx.fillText("农历 " + d.lunar + "　星期" + d.week, 60, 200);
      ctx.fillStyle = "#374151"; ctx.font = "28px sans-serif";
      ctx.fillText("干支 " + d.ganzhi.year + " · " + d.ganzhi.month + " · " + d.ganzhi.day, 60, 260);
      ctx.fillText("冲煞 " + d.shengxiao.day + "日冲" + d.chong_desc + "　财神位 " + d.positions.cai, 60, 310);
      ctx.font = "bold 30px sans-serif"; ctx.fillStyle = "#111827";
      ctx.fillText("宜", 60, 390);
      ctx.font = "26px sans-serif"; ctx.fillStyle = "#374151";
      wrapText(ctx, (d.yi || []).slice(0, 10).join(" · ") || "诸事不宜", 60, 430, 780, 38);
      ctx.font = "bold 30px sans-serif"; ctx.fillStyle = "#111827";
      ctx.fillText("忌", 470, 390);
      ctx.font = "26px sans-serif"; ctx.fillStyle = "#374151";
      wrapText(ctx, (d.ji || []).slice(0, 10).join(" · ") || "—", 470, 430, 370, 38);
      ctx.fillStyle = "#9ca3af"; ctx.font = "20px sans-serif";
      ctx.fillText("仅供自我探索与文化娱乐，不构成现实决策建议", 60, 600);
      var a = document.createElement("a");
      a.download = "huangli-" + sel.y + "-" + sel.m + "-" + sel.d + ".png";
      a.href = c.toDataURL("image/png");
      a.click();
      toast("历注图片已生成");
      function wrapText(ctx2, text, x, y, maxW, lh) {
        var line = "", yy = y;
        for (var i = 0; i < text.length; i++) {
          if (ctx2.measureText(line + text[i]).width > maxW) { ctx2.fillText(line, x, yy); line = text[i]; yy += lh; }
          else line += text[i];
        }
        ctx2.fillText(line, x, yy);
      }
    }

    renderCal();
    loadDay();   // 打开页面默认直接给出当日历注
    // 门禁已由 drawForm() 按当前子功能插入，此处不再重复插入
  }

  /* ================= 轮次管理：「新提问」与「追问」严格区分 =================
     一次「提问」= 确定性问题结果（牌面/卦象/盘面/历注）+ AI 解读 + 追问链，合称一轮。
     · 追问：沿用本轮牌/卦/盘继续问，插在本轮卡内，不动结果、不归档。
     · 新提问：换新问题 → 旧的一整轮折叠归档（功能页内可展开回看）→ 按新问题从头开始。
       塔罗/梅花还会真正重新抽牌/起卦；八字/紫微/黄历的盘固定，只换问题重解。
     归档区挂在结果容器【之外】（stage 层），因为塔罗/梅花重新抽牌会 innerHTML 重建结果容器。 */
  /* v116：选择器不再各功能抄一张表，统一从对象模型的注册表读取（单一来源）。 */
  function rootSel(feature) { var d = Core.def(feature || S.feature); return d ? d.root : null; }
  function qboxSel(feature) { var d = Core.def(feature || S.feature); return d ? d.qbox : null; }
  // 兼容旧变量名（其余代码仍有引用），值来自注册表。
  var ROOT_SEL = {}, QBOX_SEL = {};
  Object.keys(Core.FEATURES).forEach(function (f) { ROOT_SEL[f] = Core.def(f).root; QBOX_SEL[f] = Core.def(f).qbox; });

  function archiveHost(container) {
    var st = container.closest(".p-wrap") || stageEl();
    var host = st.querySelector(":scope > .round-archive");
    if (!host) {
      host = document.createElement("div");
      host.className = "round-archive";
      var root = st.querySelector(rootSel()) || container;
      if (root.parentNode) root.parentNode.insertBefore(host, root.nextSibling);
      else st.appendChild(host);
    }
    return host;
  }
  /* 归档轮只读化：移除会「触发新一轮解读」的控件（AI 解读按钮、快捷问题 chips、开关），
     保留解读正文、追问结果链与追问输入框——在归档轮里继续追问仍沿用本轮旧牌/旧卦，是合理的。
     这样归档轮不会再用旧牌去解读一个新问题（历史对话点 AI 解读触发新解读的怪逻辑）。 */
  /* 只读化：剥掉会触发新一轮解读的控件（AI 按钮/快捷问题/开关）。
     追问条用 .ai-follow-btn，不在清理名单内——归档轮沿用旧盘继续追问是合理的。 */
  function stripArchiveControls(node) {
    var clone = node.cloneNode(true);
    Array.prototype.slice.call(clone.querySelectorAll(".tool-ai, .p-suggest, .p-switch")).forEach(function (c) {
      if (c.parentNode) c.parentNode.removeChild(c);
    });
    return clone.innerHTML;
  }
  /* 从一轮的解读卡里提取可归档的正文（去掉卡壳/控制控件），用于装进归档卡卡体。 */
  function extractReviewBody(node) {
    var body = $(".p-ai-body", node);
    if (!body) return "";
    return stripArchiveControls(body);
  }
  /* 把 container 当前一轮打包成【一张 .p-ai.p-ai-archived 卡】归档。
     结构刻意与「新提问的解读卡」完全同构：卡头=问题（点按折叠/展开），卡体=解读正文。
     彻底摒弃旧的 .round-item-hd + .round-item-bd 双层套壳（卡套卡的嵌套感来源）。
     原子记录门禁：只有 AI 解读卡（.p-ai）存在才算一条记录；纯抽卡/起卦轮直接丢弃。 */
  function archiveRound(container, question, rk) {
    if (!container) return 0;
    var ais = Array.prototype.slice.call(container.querySelectorAll(".p-ai"));
    // 排除追问子卡（在 .ai-follow-slot 内）：只归档顶层解读卡
    ais = ais.filter(function (n) { return !n.closest(".ai-follow"); });
    if (!ais.length) {
      // 无解读卡：清掉本轮的纯结果卡（盘面）后返回 0
      Array.prototype.slice.call(container.children).forEach(function (n) {
        if (n.classList && n.classList.contains("p-result") && n.parentNode) n.parentNode.removeChild(n);
      });
      return 0;
    }
    var main = ais[0];
    var bodyHtml = extractReviewBody(main);
    // 追问链并入归档卡正文，保证回看时能读到完整对话。
    // v127：追问已内联成 .pf-hist-fu（自带「追问：问 + 答」），直接取其 HTML；
    // 兼容存量快照里旧结构 .p-ai（从 .p-ai-body 提取）。
    var slot = $(".ai-follow-slot", main);
    if (slot && slot.children.length) {
      bodyHtml += Array.prototype.slice.call(slot.children).map(function (fu) {
        if (fu.classList && fu.classList.contains("pf-hist-fu")) return fu.innerHTML;
        return '<div class="pf-hist-fu">' + (extractReviewBody(fu) || (fu.textContent || "")) + '</div>';
      }).join("");
    }
    // 盘面摘要并入卡体顶部，避免再套一层结果卡。
    // v126：优先从 Board 对象重新投影（只读、天然无按钮/事件）——盘面是对象，
    // 历史回看读的是解读那一刻冻结的盘面数据，不是从旧 DOM 复制 HTML。
    // 仅当该轮尚未登记 Board（老快照/未接入功能）才回退到 DOM 并清理控件。
    var factHtml = "";
    var roundSess = sessOf(container);
    // 盘面身份未必与轮次身份同键：双人择日/导入八字的 rk 还含双方出生参数，
    // 而 loadDay 登记 Board 时只有日期键。此时 Reading.board 才是该轮真相源，
    // 必须回退到它，不能只查 boards[rk]（曾导致归档卡摘要整段消失）。
    var roundReading = roundSess.find(question, rk);
    if (!roundReading) {
      var rounds = roundSess.all();
      for (var ri = 0; ri < rounds.length; ri++) {
        if (rounds[ri].rk === rk) { roundReading = rounds[ri]; break; }
      }
    }
    // 最可靠的一端是解读卡自身的 hid：全局定位该轮 Reading，直接读取它冻结的 Board。
    var cardHid = Number(main.dataset.hid || 0);
    var located = cardHid ? Core.findReadingById(cardHid) : null;
    var board = Core.findBoard(roundSess.feature, rk) ||
      (located && located.reading && located.reading.board) ||
      (roundReading && roundReading.board) || (main.board || null);
    var projected = boardView(roundSess.feature, board);
    if (projected) {
      factHtml = '<div class="pf-arch-fact">' + projected + '</div>';
    } else {
      var resultCard = container.querySelector(":scope > .p-result");
      if (resultCard) {
        var rc = $(".p-ai-body", resultCard) || resultCard;
        factHtml = '<div class="pf-arch-fact">' + stripArchiveControls(rc) + '</div>';
      }
    }
    var host = archiveHost(container);
    var item = document.createElement("div");
    item.className = "p-ai p-ai-archived";       // 与新提问解读卡同构的单卡
    if (rk) item.dataset.rk = rk;
    item.dataset.archQ = question || "上一轮提问";
    // 归档轮保留追问能力：沿用本轮 hid，追问仍写回同一条历史链（沿用旧盘面）。
    // 用户反馈「历史卡里追问框不见了」——此前只把追问结果文本并入正文，却丢了可交互的追问条。
    var archHid = main.dataset.hid;
    if (archHid) item.dataset.hid = archHid;
    item.innerHTML = '<div class="p-ai-head"><span class="dot"></span>' +
      '<span class="p-ai-title">历史 · ' + esc(question || "上一轮提问") + '</span></div>' +
      '<div class="p-ai-body">' + factHtml + bodyHtml + '</div>';
    host.insertBefore(item, host.firstChild);   // 最新一轮置顶
    if (archHid) attachFollow(item, archHid, followNote(S.feature));
    // v116：对象状态同步归档——DOM 投影归档后，真相源也必须从 current 移到 archived。
    // 用 DOM 上的 hid 校正对象（流式落盘可能晚于归档发生），保证追问挂回同一条历史链。
    var sess = sessOf(container);
    if (sess.current) {
      if (archHid) sess.current.id = Number(archHid) || sess.current.id;
      sess.current.answer = sess.current.answer || $(".p-ai-body", main).textContent;
      sess.archive();
    }
    // 清空本轮结果容器（盘面 + 解读 + 追问槽一次性移除）
    Array.prototype.slice.call(container.children).forEach(function (n) { n.parentNode.removeChild(n); });
    container.dataset.lastQ = "";
    return 1;
  }
  function qboxFor(container) {
    if (S.feature === "ziwei") return container.id === "zw-d-ai-out" ? "#zw-dq" : "#zw-q";
    return QBOX_SEL[S.feature] || "#bz-q";
  }
  /* 在本会话已解读的问题里查找「问题文本 q + 确定性结果身份 rk」：先查归档轮 .round-item，再查当前轮 .p-ai。
     rk 为空（模板问题点击、当前尚未起局）时跨所有轮匹配；rk 非空时【严格】只匹配同一结果身份的轮。
     塔罗三张牌/凯尔特十字、梅花不同卦、奇门不同局、黄历不同日期——同问题不同 rk 属于不同轮，不算重复。
     返回 {node, isArchive} 或 null。供模板问题点击与重复解读拦截共用。 */
  function findAnswered(st, q, rk) {
    if (!st || !q) return null;
    // v116：真相源是 ReadingSession 对象——严格按 question + rk 判断，不再扫 DOM 文本。
    // rk 为空时对象只按 question 跨轮匹配（模板定位）。
    // 多 slot 功能（紫微宫位）必须跨槽查，否则已解读问题在另一个槽里找不到。
    var hit = null;
    var sessions = Core.sessionsOf(S.feature);
    for (var si = 0; si < sessions.length; si++) {
      var sess = sessions[si];
      hit = sess.find(q, rk);
      if (hit) break;
    }
    if (!hit) return null;
    // 对象命中后再到 DOM 找到对应视觉节点（供滚动/展开）；DOM 找不到只说明尚未渲染，
    // 不影响「已解读」判断——这正是对象模型带来的健壮性。
    var node = null;
    if (hit.archived) {
      var items = st.querySelectorAll(".round-archive .p-ai-archived");
      for (var i = 0; i < items.length; i++) {
        if (items[i].dataset.archQ === hit.reading.question &&
            (!rk || items[i].dataset.rk === hit.reading.rk)) { node = items[i]; break; }
      }
    } else {
      var ais = st.querySelectorAll(".p-ai:not(.p-ai-archived)");
      for (var j = 0; j < ais.length; j++) {
        if (ais[j].closest(".round-archive") || ais[j].closest(".ai-follow")) continue;
        if (ais[j].dataset.hid && hit.reading.id && Number(ais[j].dataset.hid) === hit.reading.id) {
          node = ais[j]; break;
        }
        if (!hit.reading.id && (!rk || ais[j].dataset.rk === hit.reading.rk)) { node = ais[j]; break; }
      }
    }
    return { node: node, isArchive: hit.archived, reading: hit.reading };
  }
  /* 定位到某次已解读：归档卡展开、滚动到视野，给出提示。
     归档卡是只读回看（不再挂追问框），追问请回到当前轮。 */
  function revealAnswered(hit, msg) {
    if (!hit) return;
    var target = hit.node;
    if (hit.isArchive) target.classList.add("p-ai-open");
    else target.classList.remove("p-ai-folded");   // 当前卡若被收起，定位时展开
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    toast(msg || "已定位到这次解读，点卡头可展开回看");
  }
  /* 当前轮的确定性结果身份：结果容器（或当前解读卡）的 data-rk。
     重新起卦/抽牌/排盘后容器 rk 已更新，快捷问题也必须按新的 rk 判断，
     否则「同一问题 + 新卦」会被误认成旧轮、只定位回旧解读。 */
  function currentRoundRk() {
    // v116：从对象读当前盘面身份；DOM dataset 作为兜底（例如对象尚未 begin 的模板定位场景）。
    var sessions = Core.sessionsOf(S.feature);
    for (var si = 0; si < sessions.length; si++) {
      var liveRk = sessions[si].boardRk || "";
      if (liveRk) return liveRk;
    }
    var rk = "";
    var st = stageEl();
    var sel = rootSel();
    var c = sel && st.querySelector(sel);
    rk = c && c.dataset ? (c.dataset.rk || "") : "";
    if (!rk) {
      var ai = st.querySelector(".p-ai:not(.p-ai-archived):not(.ai-follow)[data-rk]");
      rk = ai ? (ai.dataset.rk || "") : "";
    }
    return rk;
  }
  /* 模板/快捷问题点击：先填入输入框；只有「问题文本 + 当前结果身份」都相同才算已解读，
     才定位回看；重新起卦/抽牌/换宫位后同问题视为新问题，只填框等待手动解读。 */
  function pickQuestion(question, inputSel) {
    var q = (question || "").trim();
    var inp = $(inputSel || qboxForDefault());
    if (inp) { inp.value = q; inp.focus(); }
    if (!q) return;
    var hit = findAnswered(stageEl(), q, currentRoundRk());
    if (hit) revealAnswered(hit);
  }
  function qboxForDefault() { return QBOX_SEL[S.feature] || "#bz-q"; }
  /* 某结果容器当前是否有解读在流式输出中（与 streamToUrl 的 busy key 规则一致） */
  function containerBusy(container) {
    if (!container) return false;
    var key = container.id || (container.dataset && container.dataset.bkey);
    return !!(key && S.busyKeys && S.busyKeys[key]);
  }
  /* 新提问前置：并发保护 + 结果身份/问题变化则归档旧轮 + 同一「问题+结果身份」拦截。返回 true 表示可继续解读。
     rk = 本轮确定性结果身份。关键：仅当问题文本【且】结果身份都相同才算重复；换了牌阵/卦象/日期
     即使文字一样也是新一轮，旧轮必须平级归档，不能留在同一容器里造成嵌套。 */
  function prepareNewQuestion(container, question, rk) {
    // 并发保护：本轮解读仍在流式输出时，任何新解读/归档都拦下，避免清空正在写入的容器导致卡死
    if (containerBusy(container)) { toast("当前解读进行中，请等解读完成后再提问"); return false; }
    var oldQ = container.dataset.lastQ || "";
    var oldRk = container.dataset.rk || "";
    // 同一「问题 + 结果身份」才算重复：同问题换了牌阵/卦象/日期属不同轮，不拦截
    var hit = findAnswered(stageEl(), question, rk);
    if (hit) {
      revealAnswered(hit, "这一轮已解读过该问题，已定位到那次对话；换牌阵/换卦/换日期会作为新一轮");
      return false;
    }
    // 问题变了【或】结果身份变了 = 新一轮 → 把上一整轮平级归档（含旧的 rk），绝不再往旧轮里塞
    if ((oldQ && oldQ !== question) || (oldRk && oldRk !== rk)) {
      archiveRound(container, oldQ || "上一轮提问", oldRk);
    }
    container.dataset.lastQ = question;
    container.dataset.rk = rk || "";
    sessOf(container).setBoard(question, rk);   // v116：盘面身份写入对象，供 currentRoundRk 读取
    return true;
  }
  /* ================= AI 流式解读（共用） ================= */
  /* 从 deduce URL 反推 feature：全功能统一 /api/<feat>/deduce（含紫微） */
  function featureOfUrl(url) {
    var m = /\/api\/([a-z_]+)\/deduce/.exec(url);
    return m ? m[1] : "ziwei";
  }
  /* 对话导入用户信息：按注册表 arity 造 Person 快照。
     本人来自登录档案 S.profile / S.profileBirth；对方信息由双人功能在发起解读前
     调用 setPartner() 写入临时槽（见下）。追究其来源统一收口于此，功能代码不各自拼。 */
  var _partnerDraft = null;
  function setPartner(person) { _partnerDraft = person; }
  function currentPersons(feature) {
    var d = Core.def(feature);
    if (!d || !d.needsBirth || !S.profile) return [];
    var self = new Core.Person({
      role: "self", name: S.profile.name || "", profileId: S.profile.id || 0,
      birth: S.profileBirth || null
    });
    var persons = [self];
    if (d.arity === 2) {
      var mate = _partnerDraft ? Core.Person.fromJSON(_partnerDraft) : new Core.Person({ role: "partner" });
      persons.push(mate);
    }
    return persons;
  }
  function streamAI(feature, query, question, container, rk) {
    if (!prepareNewQuestion(container, question, rk)) return;
    // v126：解读发起时把「最近排出的盘面」绑定到本轮 rk（rk 含提问后才确定的 scope，
    // 如八字大运/流年）。盘面数据已在 calc 时存进 Board，这里只补索引键；
    // 追问/归档凭 rk 从对象仓库取回同一张盘，不依赖 DOM。
    var sess = sessOf(container, feature);
    sess.bindBoardToRound(rk);
    streamToUrl("/api/" + feature + "/deduce?" + query, "AI 解读", question, container, false, rk);
  }
  /* 通用 SSE 流式渲染：解读 / 历史追问共用 */
  function streamToUrl(url, tag, question, container, noRefresh, rk, onDone) {
    // AI 解读与追问一律要求登录（后端也要鉴权，这里先拦一层给出明确引导）
    if (requireLogin()) return;
    // busy 按容器隔离：一个功能在解读，不影响切到别的功能发起新解读（后台并行）
    var bkey = container.id || (container.dataset && container.dataset.bkey) || ("c" + Math.random());
    if (!container.id && container.dataset) container.dataset.bkey = bkey;
    if (!S.busyKeys) S.busyKeys = {};
    if (S.busyKeys[bkey]) { toast("此处解读进行中，请稍候"); return; }
    S.busyKeys[bkey] = true;
    var holderId = "ai-" + Date.now();
    // 新提问的旧轮归档已在 streamAI / 抽牌流程里完成（整轮移出结果容器）。
    // v127：追问不再渲染成独立 .p-ai 卡（带卡头/展开按钮的一条条），而是内联段落
    // （「问+答」连续铺在解读卡正文里，与个人中心历史详情同构）——取消追问卡壳与展开。
    var isNewQuestion = tag === "AI 解读";
    var isFollow = tag === "追问";
    var headLabel = isNewQuestion ? "新提问" : esc(tag);
    var html = isFollow
      ? '<div class="pf-hist-fu" id="' + holderId + '"><p class="pf-fu-q"><b>追问：</b>' + esc(question) + '</p>' +
        '<div class="pf-fu-body"><span class="p-cursor"></span></div></div>'
      : '<div class="p-ai" id="' + holderId + '"' + (rk ? ' data-rk="' + esc(rk) + '"' : '') + '><div class="p-ai-head"><span class="dot"></span>' +
        '<span class="p-ai-title">' + headLabel + ' · ' + esc(question) + '</span></div>' +
        '<div class="p-ai-body"><span class="p-cursor"></span></div></div>';
    if (isNewQuestion) {
      // 解读卡一律排在【提问框下方】：先提问、再解读，符合阅读顺序。
      // 六爻/奇门的提问框(.bz-ask)与盘面(.p-result)同在结果容器内，若插到盘面之后会
      // 落在提问框上方（截图反馈的问题）；故优先插到提问框之后。
      // 塔罗/梅花提问框在表单区、容器内只有盘面卡 → 插到盘面之后；
      // 八字/紫微/占星/合婚的 AI 输出是独立空容器 → 插到容器内即可。
      var askCard = container.querySelector(":scope > .bz-ask, :scope > .zw-ask");
      if (askCard) askCard.insertAdjacentHTML("afterend", html);
      else {
        var resultCard = container.querySelector(":scope > .p-result");
        if (resultCard) resultCard.insertAdjacentHTML("afterend", html);
        else container.insertAdjacentHTML("afterbegin", html);
      }
    } else container.insertAdjacentHTML("beforeend", html);
    var holder = $("#" + holderId);
    var body = $(".pf-fu-body", holder) || $(".p-ai-body", holder);
    // 点击 AI 解读后立即滚到解读框，避免停留在结果上方
    $("#" + holderId).scrollIntoView({ behavior: "smooth", block: "nearest" });
    var full = "", buf = "", hid = 0;
    // v116：对象联动。新解读=创建 Reading（带参与人快照）；追问=定位所属 Reading。
    // 参与人快照从当前登录档案构造，解读一旦开始即冻结，追问沿用同一份。
    var sess = sessOf(container);
    var reading = null, sourceFeature = "";
    if (isNewQuestion) {
      reading = sess.begin(question, rk, currentPersons(featureOfUrl(url)));
    } else {
      var m = /[?&]id=([^&]+)/.exec(url);
      var rootId = m ? Number(decodeURIComponent(m[1])) : 0;
      // 个人中心历史详情卡的追问：会话属于原功能（不是 profile），必须全局按 hid 找，
      // 否则回答只写进 DOM、Reading 对象丢追问链——「画面在、对象丢」。
      var located = Core.findReadingById(rootId);
      if (located) {
        reading = located.reading;
        sourceFeature = located.feature;
      } else {
        reading = sess.findById(rootId) || sess.current;
        sourceFeature = sess.feature;
      }
    }

    fetch(url)
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        // 错误路径后端返回 JSON（非 SSE）：直接在卡内显示明确原因，不留空白卡
        var ct = resp.headers.get("content-type") || "";
        if (ct.indexOf("event-stream") < 0) {
          return resp.json().then(function (o) {
            throw new Error((o && o.error) || "解读失败，请稍后重试");
          });
        }
        var reader = resp.body.getReader(), decoder = new TextDecoder();
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) { finish(); return; }
            buf += decoder.decode(res.value, { stream: true });
            var lines = buf.split("\n\n"); buf = lines.pop();
            lines.forEach(function (line) {
              if (!line.indexOf("data:")) {
                var data = line.slice(5).trim();
                if (data === "[DONE]") { return; }
                try {
                  var o = JSON.parse(data);
                  if (o.cached) { full = ""; }
                  if (o.delta) { full += o.delta; render(); }
                  if (o.hid) { hid = o.hid; }
                } catch (e) { warn("跳过一条非 JSON 的 SSE 增量", e); }
              }
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        body.innerHTML = '<div style="color:var(--cinnabar)">解读失败：' + esc(e.message) + '</div>';
        S.busyKeys[bkey] = false;
        if (onDone) onDone(false);
      });
    function render() {
      try { body.innerHTML = (window.marked ? marked.parse(full) : esc(full)) + '<span class="p-cursor"></span>'; }
      catch (e) { body.innerHTML = esc(full) + '<span class="p-cursor"></span>'; }
      body.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    function finish() {
      S.busyKeys[bkey] = false;
      try { body.innerHTML = (window.marked ? marked.parse(full) : esc(full)); }
      catch (e) { body.innerHTML = esc(full); }
      // 免责声明由后端在正文之后统一附加并计入落盘，前端不再重复追加（避免一次解读出现多条声明）。
      // 用 .done 作为「流结束」信号，供测试与追问定位。
      var card = $("#" + holderId);
      if (card) card.classList.add("done");
      // v116：流结束把结果写回对象——对象才是真相源，DOM 只是投影。
      if (reading && !isFollow) sess.finish(hid || reading.id, full);
      if (reading && isFollow) reading.addFollowup(question, full, hid);
      // 每一处【首轮解读】都支持「继续追问」：有 hid（登录且已落盘）时在卡底挂追问条。
      // 追问结果卡（tag=追问）不再挂新追问框——追问链沿用触发它的那条追问条继续输入，
      // 避免每追问一次就多堆叠一个追问框（用户反馈「追问后仍有追问框」）。
      if (hid && tag !== "追问") attachFollow(card, hid, followNote(S.feature));
      if (!noRefresh && S.feature === "profile") renderProfile();
      // 解读/追问稳定后存会话快照：reload 后仍能恢复本会话提问。
      // 历史追问写回的是原功能会话，快照也要存到原功能键，否则刷新后追问丢失。
      // 快照必须按 Reading 所属功能存：双人择日舞台的 S.feature 是 huangli，
      // 但对象/历史属于 huangli_pair，否则刷新后对象恢复不到正确会话。
      saveStageSnap(isNewQuestion ? featureOfUrl(url) : (sourceFeature || S.feature));
      if (isFollow && sourceFeature && sourceFeature !== S.feature) saveStageSnap(sourceFeature);
      if (onDone) onDone(true);
    }
  }

  /* 追问备注：文案由 reading-core 注册表统一维护（单一来源），此处只做转发。 */
  function followNote(feature) { return Core.followNote(feature); }

  /* AI 解读卡通用追问条：复用 /api/history/followup，沿用本次盘面事实，可无限多轮。
     card 为 .p-ai 节点，hid 为该解读落盘后的历史 id。追问结果由 streamToUrl 渲染进
     追问条内的子容器，子结果卡再挂新的追问条，形成连续对话。 */
  function attachFollow(card, hid, noteText) {
    if (!card || !hid) return;
    card.dataset.hid = String(hid);   // 供会话快照恢复后重绑
    var old = $(".ai-follow", card);
    if (old) old.remove();
    // 追问结果槽（slot）与追问输入栏（wrap）分离：slot 在输入栏上方，
    // 每次追问结果追加进 slot，输入栏永远留在所有追问结果的最下方——
    // 用户要的是「追问栏一直在问题下方，包括追问后的追问」。
    var slot = $(".ai-follow-slot", card);
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "ai-follow-slot";
      card.appendChild(slot);
    }
    var wrap = document.createElement("div");
    wrap.className = "ai-follow";
    // 追问提示放在追问条内部、输入框上方，作为追问区域的说明。
    wrap.innerHTML = (noteText ? '<p class="p-note pf-follow-note">' + esc(noteText) + '</p>' : '') +
      '<div class="ai-follow-row">' +
        '<input class="ti" placeholder="就这次解读继续追问…" />' +
        '<button class="ai-follow-btn" type="button">追问</button></div>';
    // 输入栏紧跟 slot 之后（而非把 slot 塞进输入栏内部）
    if (slot.parentNode === card) card.insertBefore(wrap, slot.nextSibling);
    else card.appendChild(wrap);
    bindFollowBar(card);
  }
  /* 把一张解读卡的追问框绑定到它的 hid（可重复调用，供会话快照恢复后重绑）。
     用 onclick 覆盖式赋值，避免重复绑定叠加。 */
  function bindFollowBar(card) {
    var wrap = $(".ai-follow", card);
    if (!wrap || card.dataset.bound === "1") return;
    var hid = card.dataset.hid;
    if (!hid) return;
    card.dataset.bound = "1";
    var inp = $("input", wrap), btn = $(".ai-follow-btn", wrap);
    function ask() {
      var q = inp.value.trim();
      if (!q) { toast("请输入追问内容"); inp.focus(); return; }
      if (btn.disabled) { toast("追问进行中，请稍候"); return; }
      btn.disabled = true; inp.value = "";
      var slot = $(".ai-follow-slot", card);
      var url = "/api/history/followup?" + pfAuth() + "&id=" + hid + "&q=" + encodeURIComponent(q);
      streamToUrl(url, "追问", q, slot, true);
      setTimeout(function () { btn.disabled = false; }, 1200);
    }
    btn.onclick = ask;
    inp.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); ask(); } };
  }
  /* 会话快照恢复后：重新绑定所有带 data-hid 的解读卡追问框 */
  function rebindFollows(root) {
    var scope = root || document;
    // v127：存量快照里的追问曾是可折叠 .p-ai 卡，清掉折叠类让「问+答」常开内联呈现。
    $$(".ai-follow-slot > .p-ai.p-ai-folded", scope).forEach(function (c) { c.classList.remove("p-ai-folded"); });
    $$(".p-ai[data-hid]", scope).forEach(function (card) { bindFollowBar(card); });
  }

  /* ================= 个人中心 ================= */
  /* 个人中心统计与首页同分类：双人择日已并入老黄历，不再单列卡片；
     后端仍按 huangli_pair 存历史，筛选「黄历」时一并取回两种记录。 */
  var PF_GROUPS = [
    { tag: "八字命理", feats: [["bazi", "八字"], ["bazi_marriage", "八字合婚"]] },
    { tag: "紫微斗数", feats: [["ziwei", "紫微"], ["ziwei_marriage", "紫微合婚"]] },
    { tag: "周易占卜", feats: [["meihua", "梅花"], ["liuyao", "六爻"], ["qimen", "奇门"]] },
    { tag: "西方占卜", feats: [["astrology", "占星"], ["astrology_marriage", "占星合盘"], ["tarot", "塔罗"]] },
    { tag: "其他功能", feats: [["huangli", "黄历"]] }
  ];
  var PF_FEATS = [].concat.apply([], PF_GROUPS.map(function (g) { return g.feats; }));
  function pfFeaturesOf(key) { return key === "huangli" ? "huangli,huangli_pair" : key; }
  var pfState = { filter: "", date: "", items: [], dates: [], editBirth: false, editAccount: false,
    birth: null, memories: [], editMem: 0, memDraft: "", memCat: "综合", memImportOpen: false, memSelected: [], memBusy: false,
    batchMode: false, selected: {} };

  function pfAuth() {
    return "profile_id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token);
  }
  function renderProfile() {
    var stage = stageEl();
    if (!S.profile) {
      stage.innerHTML = hero("PROFILE", "个人中心", "登录后在此查看你的档案与全部历史提问。") +
        '<div class="p-card" style="text-align:center;padding:50px"><p>尚未登录</p><button class="p-primary" style="width:200px;margin-top:10px" onclick="document.getElementById(\'p-auth-btn\').click()">登录 / 注册</button></div>';
      return;
    }
    stage.innerHTML = hero("PROFILE", "个人中心 · " + esc(S.profile.name), "你的出生档案与各功能的提问历史都保存在云端，随时回看、继续追问。") +
      '<div class="p-card" id="pf-body"><p>加载中…</p></div>';
    pfState.filter = "";
    pfState.date = "";
    loadProfile();
  }
  function loadProfile() {
    var ap = pfAuth();
    var apP = "id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token);
    var listUrl = "/api/history/list?" + ap + "&limit=60" +
      (pfState.filter ? "&feature=" + encodeURIComponent(pfFeaturesOf(pfState.filter)) : "") +
      (pfState.date ? "&date=" + encodeURIComponent(pfState.date) : "");
    Promise.all([
      fetch("/api/history/stats?" + ap).then(function (r) { return r.json(); }),
      fetch(listUrl).then(function (r) { return r.json(); }),
      fetch("/api/profile/get?" + apP).then(function (r) { return r.json(); }),
      fetch("/api/memory/list?" + ap).then(function (r) { return r.json(); })
    ]).then(function (res) {
      pfState.items = (res[1] && res[1].items) || [];
      pfState.dates = (res[0] && res[0].dates) || [];
      pfState.memories = (res[3] && res[3].items) || [];
      paintProfile(res[0] || {}, res[1] || {}, res[2] || {});
    }).catch(function (e) {
      var body = $("#pf-body");
      if (body) body.innerHTML = '<p style="color:var(--cinnabar)">加载失败：' + esc(e.message) + '</p>';
    });
  }
  function paintProfile(stats, list, prof) {
    var by = stats.by_feature || {};
    var birth = (prof.profile && prof.profile.birth) ? prof.profile.birth : {};
    pfState.birth = birth;
    var bSeg = birthSegment(birth);
    var cur = PF_FEATS.filter(function (f) { return f[0] === pfState.filter; })[0];
    // 功能卡片：按首页分类分组，可点击 → 只看该功能的历史对话；黄历含双人择日子功能
    function countOf(key) {
      return key === "huangli" ? (by.huangli || 0) + (by.huangli_pair || 0) : (by[key] || 0);
    }
    var cards = PF_GROUPS.map(function (g) {
      var chips = g.feats.map(function (f) {
        var on = pfState.filter === f[0];
        return '<button type="button" class="p-stat p-stat-btn' + (on ? ' on' : '') + '" data-f="' + f[0] + '">' +
          '<div class="n">' + countOf(f[0]) + '</div><div class="l">' + f[1] + '</div></button>';
      }).join("");
      return '<div class="pf-stat-group"><div class="pf-stat-gt">' + esc(g.tag) + '</div>' +
        '<div class="p-stat-row">' + chips + '</div></div>';
    }).join("");
    // 批量删除模式：全选 / 单选由 pfState.batchMode + pfState.selected 驱动
    var batch = !!pfState.batchMode;
    var selCount = pfState.items.filter(function (h) { return !!pfState.selected[h.id]; }).length;
    var allChecked = batch && pfState.items.length > 0 && selCount === pfState.items.length;
    // 历史缩略卡：功能 + 日期 + 单行问题摘要；纵向列表在固定高度内上下滚动，点击查看详情/追问
    var items = pfState.items.map(function (h) {
      var summary = String(h.question || "").replace(/\s+/g, " ");
      if (summary.length > 54) summary = summary.slice(0, 54) + "…";
      var sel = batch && !!pfState.selected[h.id];
      var inner = '<div class="pf-hcard-top"><span class="p-hist-feat">' + esc(h.feature_name) + '</span>' +
        '<span class="pf-hcard-tools"><span class="pf-hcard-date">' + esc(h.ts || "") + '</span>' +
        (batch ? '' : '<button type="button" class="p-hist-del" data-del="' + h.id + '">删除</button>') +
        '</span></div>' +
        '<span class="pf-hcard-q">' + esc(summary) + '</span>';
      return '<div class="pf-hcard' + (batch ? ' batch' : '') + (sel ? ' checked' : '') + '" data-hid="' + h.id + '" role="button" tabindex="0">' +
        (batch ? '<input type="checkbox" class="pf-hcard-ck" data-id="' + h.id + '"' + (sel ? ' checked' : '') + ' />' : '') +
        (batch ? '<div class="pf-hcard-main">' + inner + '</div>' : inner) +
        '</div>';
    }).join("") || ('<p class="p-note">' + (pfState.date ? "这一天没有提问记录。" : (cur ? "「" + cur[1] + "」还没有提问记录。" : "还没有提问记录，去各功能里问一句吧。")) + '</p>');
    $("#pf-body").innerHTML =
      '<div class="p-profile-head"><div class="p-profile-avatar">' + esc(S.profile.name.charAt(0).toUpperCase()) + '</div>' +
      '<div><h3>' + esc(S.profile.name) + '</h3>' +
      '<p class="p-profile-sub">累计 ' + (stats.total || 0) + ' 次提问</p></div></div>' +
      '<div class="pf-birth">' +
        '<div class="pf-birth-h"><h3>基本信息</h3>' +
          '<button type="button" class="p-navitem pf-birth-edit">' +
            (pfState.editBirth ? "收起" : "编辑") + '</button></div>' +
        (pfState.editBirth ? pfBirthForm(birth) :
          '<div class="pf-birth-list">' + bSeg.map(function (x) {
            return '<div class="pf-birth-item"><span class="k">' + esc(x[0]) + '</span><span class="v">' + esc(x[1]) + '</span></div>';
          }).join("") + '</div>' +
          '<p class="p-note pf-hint pf-birth-tip">此处出生信息是八字、紫微、黄历共用的唯一来源；修改后各功能会同步更新。</p>') +
      '</div>' +
      '<div class="pf-account">' +
        '<div class="pf-birth-h"><h3>账号设置</h3>' +
          '<button type="button" class="p-navitem pf-account-toggle">' +
            (pfState.editAccount ? "收起" : "修改") + '</button></div>' +
        (pfState.editAccount ? pfAccountForm() : '<p class="p-note pf-hint">可修改用户名与登录密码，不影响你的历史对话。</p>') +
      '</div>' +
      pfMemoryHTML() +
      '<div class="pf-stat-h"><h3>历史统计</h3>' +
        '<span class="pf-hint">点击卡片查看该功能的历史对话</span></div>' +
      '<div class="pf-stat-groups">' + cards + '</div>' +
      '<div class="pf-hist-zone"><div class="pf-hist-head"><h3>' +
        (cur ? esc(cur[1]) + ' · 历史对话' : '历史提问') + '</h3>' +
        '<div class="pf-hist-tools">' +
          (batch
            ? '<label class="pf-selall"><input type="checkbox" id="pf-selall"' + (allChecked ? ' checked' : '') + ' /> 全选</label>' +
              '<span class="pf-selcount">已选 ' + selCount + '</span>' +
              '<button type="button" class="p-navitem pf-batch-del"' + (selCount ? '' : ' disabled') + '>删除选中</button>' +
              '<button type="button" class="p-navitem pf-batch-exit" style="width:auto;padding:4px 10px">退出批量</button>'
            : (pfState.date ? '<button type="button" class="pf-dateclear" title="清除日期">' + esc(pfState.date) + ' ✕</button>' : '') +
              '<button type="button" class="pf-date-btn" id="pf-date-btn">' + CAL_ICON + '<span>' + (pfState.date ? '更改日期' : '按日期查找') + '</span></button>' +
              (cur || pfState.date ? '<button class="p-navitem pf-clear" style="width:auto;padding:4px 10px">清除筛选</button>' : '') +
              '<button type="button" class="p-navitem pf-batch-enter" style="width:auto;padding:4px 10px">批量删除</button>') +
        '</div>' +
      '</div>' +
      '<div class="pf-hscroll">' + items + '</div>' +
      '<p class="p-note pf-hint">' + (batch ? '勾选要删除的提问，点「删除选中」并确认；追问会随原问题一起删除' : '上下滚动查看更多；点击卡片查看完整解读并继续追问') + '</p>' +
      '</div>';
    $$(".p-stat-btn", $("#pf-body")).forEach(function (b) {
      b.onclick = function () {
        pfState.filter = pfState.filter === b.dataset.f ? "" : b.dataset.f;
        loadProfile();
      };
    });
    var be = $(".pf-birth-edit", $("#pf-body"));
    if (be) be.onclick = function () { pfState.editBirth = !pfState.editBirth; paintProfile(stats, list, prof); };
    // 编辑态：用共用组件回填档案出生资料（日期时间 + 三级出生地）
    if (pfState.editBirth && $("#pfb-date")) pfBirthFormBind(birth);
    var bs = $("#pf-birth-save", $("#pf-body"));
    if (bs) bs.onclick = function () { pfSaveBirth(birth); };
    var at = $(".pf-account-toggle", $("#pf-body"));
    if (at) at.onclick = function () { pfState.editAccount = !pfState.editAccount; paintProfile(stats, list, prof); };
    var an = $("#pf-name-save", $("#pf-body"));
    if (an) an.onclick = function () { pfSaveAccount("name"); };
    var ap = $("#pf-pass-save", $("#pf-body"));
    if (ap) ap.onclick = function () { pfSaveAccount("password"); };
    var clr = $(".pf-clear", $("#pf-body"));
    if (clr) clr.onclick = function () { pfState.filter = ""; pfState.date = ""; loadProfile(); };
    // 日期查找：右侧按钮 → 弹出与出生日期同款的日历，选完按日期过滤历史
    var db = $("#pf-date-btn", $("#pf-body"));
    if (db) db.onclick = function () {
      openDateLookup(pfState.date, function (y, m, d) {
        pfState.date = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
        loadProfile();
      });
    };
    var dclr = $(".pf-dateclear", $("#pf-body"));
    if (dclr) dclr.onclick = function () { pfState.date = ""; loadProfile(); };
    // 批量删除：进入/退出/全选/单选/删除选中
    function repaintBatch() { paintProfile(stats, list, prof); }
    var be = $(".pf-batch-enter", $("#pf-body"));
    if (be) be.onclick = function () {
      pfState.batchMode = true; pfState.selected = {}; repaintBatch();
    };
    var bx = $(".pf-batch-exit", $("#pf-body"));
    if (bx) bx.onclick = function () {
      pfState.batchMode = false; pfState.selected = {}; repaintBatch();
    };
    var sa = $("#pf-selall", $("#pf-body"));
    if (sa) sa.onchange = function () {
      $$(".pf-hcard", $("#pf-body")).forEach(function (card) {
        var id = +card.dataset.hid;
        pfState.selected[id] = sa.checked;
        var ck = $(".pf-hcard-ck", card); if (ck) ck.checked = sa.checked;
        card.classList.toggle("checked", sa.checked);
      });
      updateBatchBar();
    };
    function updateBatchBar() {
      var n = pfState.items.filter(function (h) { return !!pfState.selected[h.id]; }).length;
      var cnt = $(".pf-selcount", $("#pf-body")); if (cnt) cnt.textContent = "已选 " + n;
      var del = $(".pf-batch-del", $("#pf-body")); if (del) del.disabled = !n;
      var all = $("#pf-selall", $("#pf-body"));
      if (all) all.checked = pfState.items.length > 0 && n === pfState.items.length;
    }
    // 缩略卡：批量模式下点卡片切换选中；普通模式点卡片查看；点卡内「删除」按钮两步确认，并阻止冒泡
    $$(".pf-hcard", $("#pf-body")).forEach(function (card) {
      card.onclick = function (e) {
        var id = +card.dataset.hid;
        if (pfState.batchMode) {
          if (e && e.target && e.target.classList && e.target.classList.contains("pf-hcard-ck")) return; // checkbox 自己处理
          pfState.selected[id] = !pfState.selected[id];
          var ck = $(".pf-hcard-ck", card); if (ck) ck.checked = !!pfState.selected[id];
          card.classList.toggle("checked", !!pfState.selected[id]);
          updateBatchBar();
          return;
        }
        toggleHistory(id, card);
      };
    });
    $$(".pf-hcard-ck", $("#pf-body")).forEach(function (ck) {
      ck.onclick = function (e) { e.stopPropagation(); };
      ck.onchange = function () {
        var id = +ck.dataset.id;
        pfState.selected[id] = ck.checked;
        ck.closest(".pf-hcard").classList.toggle("checked", ck.checked);
        updateBatchBar();
      };
    });
    var bd = $(".pf-batch-del", $("#pf-body"));
    if (bd) bd.onclick = function () {
      var ids = pfState.items.filter(function (h) { return !!pfState.selected[h.id]; }).map(function (h) { return h.id; });
      if (!ids.length) { toast("请先勾选要删除的提问"); return; }
      if (!bd.classList.contains("arm")) {
        bd.classList.add("arm"); bd.textContent = "确认删除 " + ids.length + " 项";
        setTimeout(function () { if (bd.isConnected) { bd.classList.remove("arm"); bd.textContent = "删除选中"; } }, 5000);
        return;
      }
      bd.disabled = true;
      fetch("/api/history/delete_batch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile_id: S.profile.id, token: S.profile.token, ids: ids })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { toast(d.error || "删除失败"); bd.disabled = false; return; }
        toast("已删除 " + (d.deleted != null ? d.deleted : ids.length) + " 条");
        pfState.batchMode = false; pfState.selected = {}; loadProfile();
      }).catch(function () { toast("删除失败，请稍后再试"); bd.disabled = false; });
    };
    $$(".p-hist-del", $("#pf-body")).forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        if (!b.classList.contains("arm")) {
          b.classList.add("arm"); b.textContent = "确认删除";
          setTimeout(function () { b.classList.remove("arm"); b.textContent = "删除"; }, 4000);
          return;
        }
        fetch("/api/history/delete", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile_id: S.profile.id, token: S.profile.token, id: +b.dataset.del })
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { toast(d.error || "删除失败"); return; }
          toast("已删除"); loadProfile();
        }).catch(function () { toast("删除失败，请稍后再试"); });
      };
    });
    bindMemory();
  }
  /* 档案出生信息 → 展示用的键值对 */
  function birthSegment(birth) {
    birth = birth || {};
    var y = birth.year, m = birth.month, d = birth.day;
    if (!(y && m && d) && birth.date) {
      var seg = String(birth.date).split("-");
      y = +seg[0]; m = +seg[1]; d = +seg[2];
    }
    var g = birth.gender;
    if (g === "male") g = "男"; else if (g === "female") g = "女";
    var knowTime = birth.know_time !== false;
    var hh = birth.hour != null ? birth.hour : null;
    var mm = birth.minute != null ? birth.minute : null;
    var place = [birth.country, birth.province, birth.city].filter(function (x) { return !!x; }).join(" · ");
    return [
      ["出生日期", (y && m && d) ? (y + "年" + m + "月" + d + "日") : "未填写"],
      ["出生时间", knowTime ? (hh != null ? (hh + "时" + (mm || 0) + "分") : "未填写") : "未知（按午时排盘）"],
      ["出生地", place || "未填写"],
      ["性别", g || "未填写"]
    ];
  }
  /* 个人中心里的档案出生信息编辑表单：与占星页共用同一套出生资料模板 */
  function pfBirthForm(birth) {
    birth = birth || {};
    var g = birth.gender === "male" ? "男" : (birth.gender === "female" ? "女" : (birth.gender || "男"));
    // 档案编辑：保留阳历/农历互转（后端写入端统一转公历），只隐藏「八字输入」这种非日期方式。
    return '<div class="pf-birth-form">' +
      birthFieldsHTML("pfb", { noBazi: true, compact: true }) +
      '<div class="pf-birth-gender"><label>性别</label><div class="p-seg" id="pfb-gender">' +
        '<button type="button" class="' + (g === "男" ? "on" : "") + '" data-v="男">男</button>' +
        '<button type="button" class="' + (g === "女" ? "on" : "") + '" data-v="女">女</button></div></div>' +
      placeFieldsHTML("pfb") +
      '<div class="pf-form-foot">' +
        '<button class="pf-btn" type="button" id="pf-birth-save">保存出生信息</button>' +
        '<span class="p-note" style="margin:0">保存后八字、紫微、黄历、占星会同步使用这份出生信息</span>' +
      '</div>' +
    '</div>';
  }
  /* 渲染档案编辑表单后，用共用组件回填档案值 */
  function pfBirthFormBind(birth) {
    birth = birth || {};
    var y = birth.year, m = birth.month, d = birth.day;
    if (!(y && m && d) && birth.date) {
      var s = String(birth.date).split("-"); y = +s[0]; m = +s[1]; d = +s[2];
    }
    birthFieldsBind("pfb", { calendar: "solar", year: y || 1990, month: m || 1, day: d || 1,
      hour: birth.hour != null ? birth.hour : 12, minute: birth.minute != null ? birth.minute : 0,
      know_time: birth.know_time !== false });
    placeFieldsBind("pfb", birth);
    // 性别分段：档案存的是「男/女」，回填到 .p-seg 选中态
    var g = birth.gender === "male" ? "男" : (birth.gender === "female" ? "女" : (birth.gender || "男"));
    if ($("#pfb-gender")) segSet($("#pfb-gender"), g);
  }
  /* 保存档案出生信息 */
  function pfSaveBirth(old) {
    var b = birthCollect("pfb");
    if (!b.year || !b.month || !b.day) { toast("请选择出生日期"); return; }
    var pl = placeCollect("pfb");
    var birth = {
      year: b.year, month: b.month, day: b.day,
      hour: b.hour, minute: b.minute,
      gender: segVal($("#pfb-gender")) || "男",
      know_time: b.know_time, calendar: b.calendar || "solar"
    };
    ["country", "province", "city", "lat", "lon", "tz"].forEach(function (k) {
      if (pl[k] != null && pl[k] !== "") birth[k] = pl[k];
    });
    var body = { profile_id: S.profile.id, token: S.profile.token, birth: birth };
    fetch("/api/profile/update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { toast(d.error || "保存失败"); return; }
      pfState.editBirth = false;
      profileBirthChanged();
      toast("基本信息已更新");
      loadProfile();
    }).catch(function () { toast("保存失败，请稍后再试"); });
  }
  /* 账号设置表单：用户名 + 密码（改密码须填当前密码） */
  function pfAccountForm() {
    return '<div class="pf-acct-form">' +
      '<div class="pf-acct-row"><div class="tf-field"><label>用户名</label>' +
        '<input class="ti" id="pf-newname" value="' + esc(S.profile.name) + '" placeholder="2~24 位字母/数字/下划线" /></div>' +
        '<button class="pf-btn" type="button" id="pf-name-save">保存用户名</button></div>' +
      '<div class="pf-acct-sep"></div>' +
      '<div class="pf-acct-row"><div class="tf-field"><label>当前密码</label>' +
        '<input class="ti" type="password" id="pf-oldpass" placeholder="修改密码时必填" /></div>' +
        '<div class="tf-field"><label>新密码</label>' +
        '<input class="ti" type="password" id="pf-newpass" placeholder="至少 6 位" /></div>' +
        '<button class="pf-btn" type="button" id="pf-pass-save">修改密码</button></div>' +
      '<p class="p-note pf-hint">密码修改后会退出其他设备的登录状态。</p>' +
      '</div>';
  }
  var MEM_CATS = ["性格特质", "事业方向", "感情关系", "健康作息", "综合"];
  /* 个人记忆卡片区：稳定自我认知的沉淀，支持编辑 / 删除 / 从历史导入 AI 压缩 */
  /* AI 画像卡：展示 AI 从历史对话中提炼的长期记忆（独立于历史提问表），
     让用户看清「它记住了什么」并可一键清空——删除历史提问并不会清除画像。 */
  function pfMemoryHTML() {
    var mems = pfState.memories || [];
    var cards = mems.map(function (m) {
      if (pfState.editMem === m.id) {
        return '<div class="pf-mem-card editing" data-mid="' + m.id + '">' +
          '<div class="pf-mem-cats">' + MEM_CATS.map(function (c) {
            return '<button type="button" data-mem-cat="' + c + '" class="' + (pfState.memCat === c ? "on" : "") + '">' + c + '</button>';
          }).join("") + '</div>' +
          '<textarea class="ti pf-mem-edit" rows="4">' + esc(pfState.memDraft || m.content) + '</textarea>' +
          '<div class="pf-mem-acts"><button type="button" class="pf-btn pf-mem-save" data-mid="' + m.id + '">保存</button>' +
          '<button type="button" class="pf-btn pf-mem-cancel">取消</button></div></div>';
      }
      return '<div class="pf-mem-card" data-mid="' + m.id + '">' +
        '<div class="pf-mem-top"><span class="pf-mem-cat">' + esc(m.category || "综合") + '</span>' +
        '<span class="pf-mem-tools"><button type="button" class="pf-mem-editbtn" data-mid="' + m.id + '">编辑</button>' +
        '<button type="button" class="pf-mem-del" data-mid="' + m.id + '">删除</button></span></div>' +
        '<div class="pf-mem-text">' + esc(m.content) + '</div>' +
        '<div class="pf-mem-src">来源：' + esc(m.source || "手动添加") + (m.updated_at && m.updated_at !== m.ts ? ' · 更新于 ' + esc(m.updated_at) : '') + '</div>' +
        '</div>';
    }).join("");

    // 新建草稿
    var draft = pfState.editMem === -1 ?
      '<div class="pf-mem-card editing">' +
        '<div class="pf-mem-cats">' + MEM_CATS.map(function (c) {
          return '<button type="button" data-mem-cat="' + c + '" class="' + (pfState.memCat === c ? "on" : "") + '">' + c + '</button>';
        }).join("") + '</div>' +
        '<textarea class="ti pf-mem-edit" rows="4" placeholder="写下一条关于自己的稳定认知…">' + esc(pfState.memDraft || "") + '</textarea>' +
        '<div class="pf-mem-acts"><button type="button" class="pf-btn pf-mem-save" data-mid="0">保存</button>' +
        '<button type="button" class="pf-btn pf-mem-cancel">取消</button></div></div>' : "";

    // 从历史导入面板
    var importPanel = "";
    if (pfState.memImportOpen) {
      var hist = (pfState.items || []).slice(0, 30);
      importPanel = '<div class="pf-mem-import">' +
        '<div class="pf-mem-import-h">选择要导入的历史解读（可多选，最多 8 条），AI 会压缩成一条记忆</div>' +
        '<div class="pf-mem-import-list">' + (hist.map(function (h) {
          return '<label class="pf-mem-opt"><input type="checkbox" value="' + h.id + '"' +
            (pfState.memSelected.indexOf(h.id) >= 0 ? " checked" : "") + '/>' +
            '<span class="pf-mem-opt-f">' + esc(h.feature_name || "") + '</span>' +
            '<span class="pf-mem-opt-q">' + esc(String(h.question || "").slice(0, 40)) + '</span></label>';
        }).join("") || '<p class="p-note">暂无历史对话可导入</p>') + '</div>' +
        '<div class="pf-mem-acts"><button type="button" class="pf-btn pf-mem-doimport"' + (pfState.memBusy ? " disabled" : "") + '>' +
          (pfState.memBusy ? "正在压缩生成…" : "AI 压缩生成记忆") + '</button>' +
          '<button type="button" class="pf-btn pf-mem-closeimport">取消</button></div></div>';
    }

    return '<div class="pf-memory">' +
      '<div class="pf-birth-h"><h3>个人记忆</h3>' +
      '<span class="pf-mem-actions">' +
        '<button type="button" class="p-navitem pf-mem-new">新建</button>' +
        '<button type="button" class="p-navitem pf-mem-importbtn">从历史导入</button>' +
      '</span></div>' +
      '<p class="p-note pf-hint">把解读中对你稳定成立的认知沉淀成卡片，随时编辑；也可从历史对话导入并让 AI 压缩生成。</p>' +
      (draft || cards || (!importPanel ? '<p class="p-note pf-mem-empty">还没有记忆卡片，点「新建」或「从历史导入」开始沉淀。</p>' : "")) +
      importPanel +
      '</div>';
  }
  /* 个人记忆区事件绑定 */
  function bindMemory() {
    var root = $("#pf-body");
    if (!root) return;
    var newBtn = $(".pf-mem-new", root);
    if (newBtn) newBtn.onclick = function () {
      pfState.editMem = -1; pfState.memDraft = ""; pfState.memCat = "综合"; pfState.memImportOpen = false;
      loadProfile();
    };
    var impBtn = $(".pf-mem-importbtn", root);
    if (impBtn) impBtn.onclick = function () {
      pfState.memImportOpen = !pfState.memImportOpen; pfState.editMem = 0; pfState.memSelected = [];
      loadProfile();
    };
    var closeImp = $(".pf-mem-closeimport", root);
    if (closeImp) closeImp.onclick = function () { pfState.memImportOpen = false; loadProfile(); };
    // 分类分段（新建/编辑态）
    $$(".pf-mem-cats button", root).forEach(function (b) {
      b.onclick = function () { pfState.memCat = b.dataset.memCat; loadProfile(); };
    });
    // 编辑草稿随输入保存（不重绘，避免光标丢失）
    var ta = $(".pf-mem-edit", root);
    if (ta) ta.oninput = function () { pfState.memDraft = ta.value; };
    var cancel = $(".pf-mem-cancel", root);
    if (cancel) cancel.onclick = function () { pfState.editMem = 0; pfState.memDraft = ""; loadProfile(); };
    var save = $(".pf-mem-save", root);
    if (save) save.onclick = function () {
      var text = (pfState.memDraft || (ta ? ta.value : "") || "").trim();
      if (!text) { toast("请先填写记忆内容"); return; }
      var mid = +save.dataset.mid || 0;
      fetch("/api/memory/save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile_id: S.profile.id, token: S.profile.token,
          id: mid, content: text, category: pfState.memCat })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { toast(d.error || "保存失败"); return; }
        toast(mid ? "记忆已更新" : "记忆已添加");
        pfState.editMem = 0; pfState.memDraft = ""; loadProfile();
      }).catch(function () { toast("保存失败，请稍后再试"); });
    };
    $$(".pf-mem-editbtn", root).forEach(function (b) {
      b.onclick = function () {
        var m = pfState.memories.filter(function (x) { return x.id === +b.dataset.mid; })[0];
        if (!m) return;
        pfState.editMem = m.id; pfState.memDraft = m.content; pfState.memCat = m.category || "综合";
        pfState.memImportOpen = false; loadProfile();
      };
    });
    $$(".pf-mem-del", root).forEach(function (b) {
      b.onclick = function () {
        if (!b.classList.contains("arm")) {
          b.classList.add("arm"); b.textContent = "确认删除";
          setTimeout(function () { b.classList.remove("arm"); b.textContent = "删除"; }, 4000);
          return;
        }
        fetch("/api/memory/delete", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile_id: S.profile.id, token: S.profile.token, id: +b.dataset.mid })
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { toast(d.error || "删除失败"); return; }
          toast("已删除"); loadProfile();
        }).catch(function () { toast("删除失败，请稍后再试"); });
      };
    });
    // 导入面板：勾选历史
    $$(".pf-mem-opt input", root).forEach(function (cb) {
      cb.onchange = function () {
        var v = +cb.value, arr = pfState.memSelected.slice();
        if (cb.checked) { if (arr.indexOf(v) < 0 && arr.length < 8) arr.push(v); else cb.checked = false; }
        else arr = arr.filter(function (x) { return x !== v; });
        pfState.memSelected = arr;
      };
    });
    var doImp = $(".pf-mem-doimport", root);
    if (doImp) doImp.onclick = function () {
      if (!pfState.memSelected.length) { toast("请先选择要导入的历史对话"); return; }
      pfState.memBusy = true; loadProfile();
      fetch("/api/memory/compress", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile_id: S.profile.id, token: S.profile.token, ids: pfState.memSelected,
          category: pfState.memCat })
      }).then(function (r) { return r.json(); }).then(function (d) {
        pfState.memBusy = false;
        if (!d.ok) { toast(d.error || "生成失败"); loadProfile(); return; }
        // 生成后进入编辑态让用户确认/微调再保存
        pfState.memImportOpen = false; pfState.editMem = -1;
        pfState.memDraft = d.content; pfState.memCat = "综合";
        toast("已生成，确认后保存"); loadProfile();
      }).catch(function () { pfState.memBusy = false; toast("生成失败，请稍后再试"); loadProfile(); });
    };
  }
  function pfSaveAccount(kind) {
    var body = { profile_id: S.profile.id, token: S.profile.token };
    if (kind === "name") {
      var nm = (($("#pf-newname") || {}).value || "").trim();
      if (!nm) { toast("请输入用户名"); return; }
      body.name = nm;
    } else {
      var op = (($("#pf-oldpass") || {}).value || "");
      var np = (($("#pf-newpass") || {}).value || "");
      if (!op || !np) { toast("请填写当前密码与新密码"); return; }
      if (np.length < 6) { toast("新密码至少 6 位"); return; }
      body.old_password = op; body.new_password = np;
    }
    fetch("/api/profile/update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { toast(d.error || "保存失败"); return; }
      if (kind === "name" && d.name) {
        S.profile.name = d.name;
        try { localStorage.setItem("zw-profile", JSON.stringify(S.profile)); }
        catch (e) { warn("保存登录态失败", e); }
        renderUser();
      }
      pfState.editAccount = false;
      var opEl = $("#pf-oldpass"), npEl = $("#pf-newpass");
      if (opEl) opEl.value = ""; if (npEl) npEl.value = "";
      toast(kind === "name" ? "用户名已更新" : "密码已修改");
      loadProfile();
    }).catch(function () { toast("保存失败，请稍后再试"); });
  }
  // 历史解读：同一项再点一次收起；切换项时先收起旧项，避免重复堆积
  function toggleHistory(id, btn) {
    var existing = $("#pf-body").querySelector('[data-hbox="' + id + '"]');
    if (existing) { existing.remove(); if (btn) btn.classList.remove("on"); return; }
    $$("#pf-body [data-hbox]").forEach(function (n) { n.remove(); });
    $$("#pf-body .pf-hcard").forEach(function (x) { x.classList.remove("on"); });
    if (btn) btn.classList.add("on");
    var ap = pfAuth() + "&id=" + id;
    fetch("/api/history/detail?" + ap).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { toast("未找到该记录"); return; }
      var it = d.item;
      // 历史解读不再套 .p-card 外壳（外层卡 + 内层 p-ai 两层边框 = 嵌套感）。
      // 直接用 .p-ai 卡作为同宽平级元素，宽度走统一 var(--content-w)，与上方问题卡对齐。
      var card = document.createElement("div");
      card.className = "p-ai p-hist-detail";
      card.dataset.hbox = id;
      // 追问已合并进这一条：在同一张详情卡里按时间正序铺出「原问题 + 各轮追问」的完整对话，
      // 不再让追问散落成多条历史。每轮之间用细分隔线区分。
      var chain = '<p><b>问：</b>' + esc(it.question) + '</p><hr/>' +
        (window.marked ? marked.parse(it.answer) : esc(it.answer));
      (it.followups || []).forEach(function (fu) {
        chain += '<div class="pf-hist-fu">' +
          '<p><b>追问：</b>' + esc(fu.question) + '</p>' +
          (window.marked ? marked.parse(fu.answer) : esc(fu.answer)) + '</div>';
      });
      card.innerHTML = '<div class="p-ai-head"><span class="dot"></span>历史解读 · ' + esc(it.ts) + '</div>' +
        '<div class="p-ai-body">' + chain + '</div>';
      $("#pf-body").appendChild(card);
      // 小字灰色备注放在追问条内部（输入框上方），不再紧跟免责声明、避免像答案的一部分。
      attachFollow(card, id, followNote(it.feature));
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  /* ================= 紫微斗数：站内原生命盘（固定尺寸，无 iframe） =================
     数据来自 /api/chart（十二宫星曜）+ /api/horoscope（大限流年）。
     三视图：命格（格局概览+十二宫主星）/ 本命盘（固定尺寸命盘）/ 运势盘（大限流年叠加）。 */
  var ZW_SLOT = [3, 4, 5, 6, 2, -1, -1, 7, 1, -1, -1, 8, 0, 11, 10, 9];   // 4×4 槽位 → 宫索引
  var ZW_ABBR = { "命宫": "命", "兄弟": "兄", "夫妻": "夫", "子女": "子", "财帛": "财", "疾厄": "疾",
    "迁移": "迁", "仆役": "友", "交友": "友", "官禄": "官", "田宅": "田", "福德": "福", "父母": "父" };
  var ZW_MUT = ["禄", "权", "科", "忌"];
  function zwPN(n) { return n && n.slice(-1) === "宫" ? n : (n || "") + "宫"; }   // 命宫本身即含「宫」，避免出现「命宫宫」
  function zwS() { return S.zw || (S.zw = { chart: null, id: null, key: null, birth: null, year: new Date().getFullYear(), view: "plate", sel: null, horo: null, busy: false }); }  /* 命盘缓存：同一组出生信息（含星座参数）直接复用，登录用户不必每次重新起盘 */
  var ZW_STORE = "zw-chart-v1";
  function zwBirthKey(b) {
    return [b.date, b.timeIndex, b.gender || "男", b.calendar || "solar"].join("|");
  }
  function zwStoreGet() {
    try { return JSON.parse(sessionStorage.getItem(ZW_STORE) || "null"); } catch (e) { return null; }
  }
  function zwStoreSet(o) {
    try { sessionStorage.setItem(ZW_STORE, JSON.stringify(o)); } catch (e) { warn("紫微会话缓存写入失败", e); }
  }
  function zwStoreSync() {
    var st = zwS();
    if (!st.id || !st.chart || !st.key) return;
    zwStoreSet({ key: st.key, id: st.id, chart: st.chart, birth: st.birth,
      uid: S.profile ? S.profile.id : 0, view: st.view, year: st.year,
      fromProfile: !!S.zwFromProfile });
  }
  function zwPalaces() {
    var st = zwS(), out = {};
    (st.chart && st.chart.palaces || []).forEach(function (p) { out[p.index] = p; });
    return out;
  }
  /* 某颗星落在第几宫（用于把运限四化填进对应宫位） */
  function zwStarPalaceIdx(name) {
    var pals = (zwS().chart && zwS().chart.palaces) || [];
    for (var i = 0; i < pals.length; i++) {
      var p = pals[i], all = (p.majorStars || []).concat(p.minorStars || []);
      for (var j = 0; j < all.length; j++) if (all[j].name === name) return p.index;
    }
    return -1;
  }
  /* 四化表：{ 宫索引: [{n:星名, i:0..3}] } */
  function zwMutMap(mutagen) {
    var m = {};
    (mutagen || []).forEach(function (nm, i) {
      var pi = zwStarPalaceIdx(nm);
      if (pi < 0) return;
      (m[pi] = m[pi] || []).push({ n: nm, i: i });
    });
    return m;
  }
  function zwMutOf(star, mutagenList) {
    if (!mutagenList || !star || !star.name) return "";
    var i = mutagenList.indexOf(star.name);
    return i >= 0 ? ZW_MUT[i] : "";
  }
  function zwStarHTML(name, extra, mut) {
    return '<span class="zw-star">' + esc(name) +
      (extra ? '<i>' + esc(extra) + '</i>' : '') +
      (mut ? '<b class="zw-mut m' + ZW_MUT.indexOf(mut) + '">' + mut + '</b>' : '') + '</span>';
  }
  /* 手机端命盘改为纵向宫位列表：按十二宫逆时针顺序（命→兄→夫→子→财→疾→迁→友→官→田→福→父）排列。
     桌面端命盘是 4×4 网格、每个宫位已显式定位 grid-column/grid-row，order 不改变其排布。 */
  function zwOrder(p) {
    var pals = (zwS().chart && zwS().chart.palaces) || [], soul = 0, i;
    for (i = 0; i < pals.length; i++) {
      if (pals[i].isSoulPalace || pals[i].name === "命宫") { soul = pals[i].index; break; }
    }
    return (soul - p.index + 12) % 12;
  }
  function zwPalaceHTML(p, slot, overlay) {
    var st = zwS(), cls = "zw-pal";
    var isSoul = !!(p.isSoulPalace || p.name === "命宫");
    /* 运势盘的「运命」与本命盘的「命宫」用同一套金色标记（淡金底 + 金色描边），两盘视觉语言一致 */
    if (overlay && overlay.decadalIdx === p.index) cls += " hl-d soulpal";
    if (overlay && overlay.yearlyIdx === p.index) cls += " hl-y";
    if (st.sel === p.index) cls += " sel";
    /* 本命盘：命宫同样给淡金底 + 金色描边，明确「特意展示」 */
    if (st.view !== "fortune" && isSoul) cls += " soulpal";
    /* 四化直接标在对应星曜下方：生年 / 大限 / 流年各占一行，只出一个字 */
    var dMap = {}, yMap = {};
    if (overlay) {
      (overlay.dMut && overlay.dMut[p.index] || []).forEach(function (x) { dMap[x.n] = x.i; });
      (overlay.yMut && overlay.yMut[p.index] || []).forEach(function (x) { yMap[x.n] = x.i; });
    }
    /* 每颗星固定四层：名 → 庙旺 → 生年 → 大限 → 流年；空位留占位，四化永远落在同一行 */
    function starCell(s, showBright, isMajor) {
      function slot(mut, extra) {
        return '<span class="zw-scslot">' +
          (mut ? '<b class="zw-sc' + extra + ' m' + ZW_MUT.indexOf(mut) + '">' + esc(mut) + '</b>' : '') + '</span>';
      }
      var br = showBright && s.brightness ? s.brightness : "";
      return '<span class="zw-starwrap">' +
        '<span class="zw-star' + (isMajor ? " major" : "") + '">' + esc(s.name) + '</span>' +
        '<span class="zw-scslot br">' + (br ? '<i>' + esc(br) + '</i>' : '') + '</span>' +
        slot(s.mutagen || "", "") +
        slot(dMap[s.name] != null ? ZW_MUT[dMap[s.name]] : "", "") +
        slot(yMap[s.name] != null ? ZW_MUT[yMap[s.name]] : "", "") +
      '</span>';
    }
    var majors = (p.majorStars || []).map(function (s) { return starCell(s, true, true); }).join("");
    var minors = (p.minorStars || []).map(function (s) { return starCell(s, false, false); }).join("");
    /* 杂曜与主星同行展示：同样竖写一列，字号更小颜色更淡 */
    var adj = (p.adjectiveStars || []).slice(0, 8).map(function (s) {
      return '<span class="zw-star adj">' + esc(s.name) + '</span>';
    }).join("");
    var pills = "";
    if (overlay && overlay.dNames && overlay.dNames[p.index]) {
      var dn = ZW_ABBR[overlay.dNames[p.index]] || overlay.dNames[p.index];
      pills += '<i class="zw-pill d' + (overlay.decadalIdx === p.index ? " soul" : "") + '">运' + esc(dn) + '</i>';
    }
    if (overlay && overlay.yNames && overlay.yNames[p.index]) {
      var yn = ZW_ABBR[overlay.yNames[p.index]] || overlay.yNames[p.index];
      pills += '<i class="zw-pill y' + (overlay.yearlyIdx === p.index ? " soul" : "") + '">流' + esc(yn) + '</i>';
    }
    /* 命宫标记提到宫名旁（与「身」「来因」同级），不再缩在宫格右下角 */
    if (pills) cls += " has-pill";
    var rng = p.decadal && p.decadal.range ? p.decadal.range[0] + "-" + p.decadal.range[1] : "";
    var col = slot % 4 + 1, row = Math.floor(slot / 4) + 1;
    return '<div class="' + cls + ' zw-o-' + zwOrder(p) + '" data-bi="' + p.index + '" style="grid-column:' + col + ';grid-row:' + row + '">' +
      '<div class="zw-pal-h"><b>' + esc(zwPN(p.name)) + '</b>' +
        (isSoul ? '<em class="soul">命</em>' : '') +
        (p.isBodyPalace ? '<em>身</em>' : '') + (p.isOriginalPalace ? '<em class="g">来因</em>' : '') +
        '<span>' + esc(p.heavenlyStem + p.earthlyBranch) + '</span></div>' +
      '<div class="zw-pal-stars">' + majors + minors + adj + '</div>' +
      ((pills || rng) ? '<div class="zw-pal-foot">' +
        '<span class="zw-pal-rng">' + rng + '</span>' +
        (pills ? '<span class="zw-pal-pills">' + pills + '</span>' : "") + '</div>' : "") +
    '</div>';
  }
  function zwCenterHTML() {
    var c = zwS().chart;
    if (!c) return "";
    var pillars = String(c.chineseDate || "").trim().split(/\s+/).slice(0, 4);
    var pl = ["年", "月", "日", "时"];
    var yearStem = (pillars[0] || "")[0] || "";
    var yy = ("甲丙戊庚壬".indexOf(yearStem) >= 0 ? "阳" : "阴") + (c.gender || "男");
    var row = pillars.map(function (t, i) {
      return '<div class="zw-p2"><i>' + pl[i] + '</i><b>' + esc(t[0] || "") + '</b><span>' + esc(t.slice(1)) + '</span></div>';
    }).join("");
    return '<div class="zw-center">' +
      '<div class="zw-c1">' + esc(yy) + ' · ' + esc(c.fiveElementsClass || "") + '</div>' +
      '<div class="zw-c2">阳历 ' + esc(String(c.solarDate || "").replace(/-/g, ".")) + ' ' + esc(c.timeRange || "") + '</div>' +
      '<div class="zw-c2">农历 ' + esc(c.lunarDate || "") + ' · ' + esc(c.time || "") + '</div>' +
      '<div class="zw-cp">' + row + '</div>' +
      '<div class="zw-c3"><span>命主 <b>' + esc(c.soul || "") + '</b></span><span>身主 <b>' + esc(c.body || "") + '</b></span>' +
        '<span>生肖 <b>' + esc(c.zodiac || "") + '</b></span><span>星座 <b>' + esc(c.sign || "") + '</b></span></div>' +
    '</div>';
  }
  function zwOverlay() {
    var st = zwS(), h = st.horo;
    if (!h) return null;
    var grid = st.view === "fortune";
    return {
      dNames: grid && h.decadal ? h.decadal.palaceNames : null,
      decadalIdx: grid && h.decadal ? h.decadal.index : -1,
      yNames: grid && h.yearly ? h.yearly.palaceNames : null,
      yearlyIdx: grid && h.yearly ? h.yearly.index : -1,
      dMut: grid && h.decadal ? zwMutMap(h.decadal.mutagen) : null,
      yMut: grid && h.yearly ? zwMutMap(h.yearly.mutagen) : null
    };
  }
  /* 三方四正虚线：已按需求移除，命盘不再绘制任何连线 */
  /* 固定尺寸十二宫盘：4×4 网格，中宫跨 2×2 */
  function zwPlate() {
    var pals = zwPalaces(), ov = zwOverlay(), html = "";
    for (var slot = 0; slot < 16; slot++) {
      var bi = ZW_SLOT[slot];
      if (bi === -1) { if (slot === 5) html += zwCenterHTML(); continue; }
      var p = pals[bi];
      if (p) html += zwPalaceHTML(p, slot, ov);
    }
    return '<div class="zw-plate" id="zw-plate">' + html + '</div>';
  }
  function zwDetailHTML() {
    var st = zwS(), p = zwPalaces()[st.sel];
    if (!p) return '<p class="p-note zw-detail-hint">点选任一宫位，查看该宫的星曜与运限细节。</p>';
    function starLine(list) {
      if (!list || !list.length) return '<span class="zw-none">—</span>';
      return list.map(function (s) {
        return '<span class="zw-dstar">' + esc(s.name) +
          (s.brightness ? '<i>' + esc(s.brightness) + '</i>' : '') +
          (s.mutagen ? '<b class="zw-mut m' + ZW_MUT.indexOf(s.mutagen) + '">' + esc(s.mutagen) + '</b>' : '') + '</span>';
      }).join("");
    }
    // 三方四正 = 本宫 + 三合二宫(+4/+8) + 对宫(+6)，与命格解析口径一致；旧值 [1,5,7] 是错的
    var trine = [4, 8, 6].map(function (d) { return zwPalaces()[(p.index + d) % 12]; }).filter(Boolean)
      .map(function (x) { return '<button class="zw-jump" data-bi="' + x.index + '">' + esc(zwPN(x.name)) + '</button>'; }).join("");
    var dom = ZW_DOMAIN[p.name] || "人生", pn = zwPN(p.name);
    var chips = [
      { t: "这一宫的特点", q: "以「" + pn + "」为主体，结合三方四正与四化，说明我在" + dom + "上有什么特点？" },
      { t: "优势与警惕", q: "以「" + pn + "」为主体，结合三方四正与四化，我的优势与需要警惕之处分别是什么？" },
      { t: "如何改善", q: "想改善" + dom + "，以「" + pn + "」为主体，结合三方四正与四化看该怎么做？" }
    ].map(function (c) { return '<button data-q="' + esc(c.q) + '">' + esc(c.t) + '</button>'; }).join("");
    return '<div class="zw-detail">' +
      '<div class="zw-d-h"><b>' + esc(zwPN(p.name)) + '</b><span>' + esc(p.heavenlyStem + p.earthlyBranch) + '</span>' +
        (p.isBodyPalace ? '<em>身宫</em>' : '') +
        '<button class="zw-close" id="zw-close" type="button">收起</button></div>' +
      '<div class="zw-d-row"><label>主星</label><div>' + starLine(p.majorStars) + '</div></div>' +
      '<div class="zw-d-row"><label>辅星</label><div>' + starLine(p.minorStars) + '</div></div>' +
      '<div class="zw-d-row"><label>杂曜</label><div>' + starLine(p.adjectiveStars) + '</div></div>' +
      '<div class="zw-d-row"><label>十二神</label><div class="zw-d-small">长生 ' + esc(p.changsheng12 || "—") +
        ' · 博士 ' + esc(p.boshi12 || "—") + ' · 将前 ' + esc(p.jiangqian12 || "—") + ' · 岁前 ' + esc(p.suiqian12 || "—") + '</div></div>' +
      '<div class="zw-d-row"><label>大限</label><div class="zw-d-small">' +
        (p.decadal && p.decadal.range ? p.decadal.range[0] + "–" + p.decadal.range[1] + " 岁（" + esc(p.decadal.heavenlyStem + p.decadal.earthlyBranch) + "）" : "—") + '</div></div>' +
      '<div class="zw-d-row"><label>三方四正</label><div>' + trine + '</div></div>' +
    '</div>' +
    // 结构统一：宫位提问区独立成卡（带边框），从宫位详情卡里移出，AI 输出紧随其后
    '<div class="zw-ask zw-d-ask">' +
      '<div class="zw-d-ask-h">就「' + esc(pn) + '」提问<span>' + esc(dom) + '</span></div>' +
      '<div class="p-suggest zw-chips zw-dchips">' + chips + '</div>' +
      '<div class="zw-ask-row"><input class="ti" id="zw-dq" placeholder="例如：以这一宫为主体，结合三方四正与四化，我在' + esc(dom) + '上会怎样？" />' +
        '<button class="tool-ai zw-ask-btn" id="zw-dask" type="button">AI 解读</button></div>' +
    '</div>' +
    '<div id="zw-d-ai-out"></div>';
  }
  /* 格局启发式、星曜/四化含义（沿用原紫微服务的命盘总览口径） */
  var ZW_GE = [
    { stars: ["七杀", "破军", "贪狼"], name: "杀破狼格", type: "开创型", desc: "人生主旋律是开新局、破旧局，变动中成事。" },
    { stars: ["紫微", "天府", "廉贞", "武曲", "天相"], name: "紫府相格", type: "领导型", desc: "稳中掌局，善统御资源、组织人事，以守成与经营见长。" },
    { stars: ["太阳", "巨门", "天机"], name: "巨日格", type: "支援型", desc: "以言才与专业策动他人，宜传播、参谋与专业路线。" },
    { stars: ["天同", "天梁", "太阴"], name: "机月同梁格", type: "合作型", desc: "温和周全，长于协调稳健，细水长流。" }
  ];
  var ZW_STAR_MEAN = {
    "紫微": "帝座主尊贵领导", "天府": "库星主稳健守成", "武曲": "财星主刚毅执行", "天相": "印星主辅佐公正",
    "廉贞": "主事业心与原则", "七杀": "主变革冲劲", "破军": "主破旧立新", "贪狼": "主多才交际",
    "太阳": "主博爱名声", "太阴": "主细腻蓄藏", "天梁": "荫星主原则庇荫", "天同": "福星主安逸亲和",
    "天机": "智星主谋略机变", "巨门": "主口才思辨"
  };
  var ZW_MUT_MEAN = { "禄": "财禄顺遂", "权": "掌控主导", "科": "名誉贵人", "忌": "执念阻滞" };
  var ZW_STAR_NICK = {
    "紫微": "帝座", "天府": "库星", "武曲": "财星", "天相": "印星", "廉贞": "事业之星",
    "七杀": "将星", "破军": "耗星", "贪狼": "桃花星", "太阳": "光明星", "太阴": "富星",
    "天梁": "荫星", "天同": "福星", "天机": "智星", "巨门": "口舌星"
  };
  var ZW_MUT_TAIL = {
    "禄": "机遇在此流通，进益顺遂，易得实质好处与人脉助力",
    "权": "能量强势主导，掌控与成就欲在此放大，有成亦有压力",
    "科": "名声显扬于此，贵人多助，处事得体有分寸",
    "忌": "执念与阻滞较重，易纠结内耗，需防反复与是非"
  };
  var ZW_DOMAIN = {
    "命宫": "性格本质", "兄弟": "平辈情缘", "夫妻": "感情婚姻", "子女": "子嗣晚辈",
    "财帛": "理财进财", "疾厄": "健康体质", "迁移": "在外机遇", "仆役": "人脉合作",
    "官禄": "事业模式", "田宅": "家运不动产", "福德": "精神生活", "父母": "长上缘"
  };
  var ZW_BR_W = { "庙": 3, "旺": 2.5, "得": 2, "利": 1.5, "平": 1, "不": 0.5, "陷": 0 };
  function zwMingGe(soul, pals) {
    var names = (soul.majorStars || []).map(function (s) { return s.name; });
    if (!names.length) {
      var opp = pals[(soul.index + 6) % 12];
      names = opp ? (opp.majorStars || []).map(function (s) { return s.name; }) : [];
    }
    var hit = null;
    for (var i = 0; i < ZW_GE.length; i++) {
      if (ZW_GE[i].stars.some(function (n) { return names.indexOf(n) >= 0; })) { hit = ZW_GE[i]; break; }
    }
    hit = hit || ZW_GE[3];
    return { name: hit.name, type: hit.type, desc: hit.desc, starNames: names };
  }
  function zwMeaning(p) {
    var majors = (p.majorStars || []).slice().sort(function (a, b) {
      return (ZW_BR_W[b.brightness] != null ? ZW_BR_W[b.brightness] : 1.5) - (ZW_BR_W[a.brightness] != null ? ZW_BR_W[a.brightness] : 1.5);
    });
    if (!majors.length) return "无主星，格局随对宫与夹宫流动，断事需借参。";
    return majors.slice(0, 2).map(function (s) {
      var t = s.name + (ZW_STAR_MEAN[s.name] || "");
      if (s.brightness === "陷" || s.brightness === "不") t += "（落" + s.brightness + "力弱）";
      if (s.mutagen && ZW_MUT_MEAN[s.mutagen]) t += "，化" + s.mutagen + "主" + ZW_MUT_MEAN[s.mutagen];
      return t;
    }).join("；") + "。";
  }
  /* 命格：原「命盘总览」的格局解析 / 生年四化 + 十二宫一览 + 提问 */
  function zwPatternHTML() {
    var st = zwS(), c = st.chart;
    if (!c) return "";
    var pals = (c.palaces || []).slice().sort(function (a, b) { return a.index - b.index; });
    var soul = null;
    for (var i = 0; i < pals.length; i++) if (pals[i].name === "命宫") soul = pals[i];
    if (!soul) return "";
    var ge = zwMingGe(soul, pals);
    var pillars = String(c.chineseDate || "").trim().split(/\s+/);
    var yy = ("甲丙戊庚壬".indexOf((pillars[0] || "")[0] || "") >= 0 ? "阳" : "阴") + (c.gender || "男");
    var soulStars = (soul.majorStars || []).map(function (s) { return s.name + (s.brightness || ""); }).join("·") ||
      "空宫（借对宫" + ge.starNames.join("·") + "）";

    // 格局解析：命宫 + 三方四正
    var tri = [soul.index, (soul.index + 4) % 12, (soul.index + 8) % 12, (soul.index + 6) % 12];
    var cards = tri.map(function (idx, k) {
      var p = pals[idx];
      if (!p) return "";
      var stars = (p.majorStars || []).map(function (s) {
        return '<span class="zw-tstar">' + esc(s.name) + (s.brightness ? '<i>' + esc(s.brightness) + '</i>' : '') +
          (s.mutagen ? '<b class="zw-mut m' + ZW_MUT.indexOf(s.mutagen) + '">' + esc(s.mutagen) + '</b>' : '') + '</span>';
      }).join("") || '<span class="zw-none">无主星</span>';
      var minors = (p.minorStars || []).slice(0, 3).map(function (s) { return esc(s.name); }).join(" ");
      return '<div class="zw-gcard' + (k === 0 ? " life" : "") + '">' +
        '<div class="zw-gcard-h"><b>' + esc(zwPN(p.name)) + '</b>' + (k === 0 ? '<em>' + esc(p.earthlyBranch) + '</em>' : "") +
          (p.isBodyPalace ? '<em>身</em>' : "") + '<span>' + esc(p.heavenlyStem + p.earthlyBranch) + '</span></div>' +
        '<div class="zw-gcard-stars">' + stars + (minors ? '<span class="zw-gcard-minor">' + minors + '</span>' : "") + '</div>' +
        '<div class="zw-gcard-mean"><b>' + esc(ZW_DOMAIN[p.name] || "") + '</b>：' + esc(zwMeaning(p)) + '</div>' +
      '</div>';
    }).join("");

    // 生年四化
    var found = {};
    pals.forEach(function (p) {
      [(p.majorStars || []), (p.minorStars || [])].forEach(function (list) {
        list.forEach(function (s) { if (s.mutagen && !found[s.mutagen]) found[s.mutagen] = { star: s.name, palace: p.name }; });
      });
    });
    var mutLine = ["禄", "权", "科", "忌"].filter(function (m) { return found[m]; }).map(function (m) {
      var f = found[m];
      return '<div class="zw-mutitem"><div class="zw-mutitem-h"><b>' + esc(f.star) + '</b>' +
        '<span class="zw-mut m' + ZW_MUT.indexOf(m) + '">' + m + '</span>' +
        '<i>落' + esc(f.palace) + '宫 · ' + esc(ZW_DOMAIN[f.palace] || "人生领域") + '</i></div>' +
        '<p>' + esc((ZW_STAR_NICK[f.star] ? ZW_STAR_NICK[f.star] + "化" + m + "，" : "") + ZW_MUT_TAIL[m]) + '。</p></div>';
    }).join("");

    // 十二宫一览（从命宫起）
    var ORDER = ["命宫", "兄弟", "夫妻", "子女", "财帛", "疾厄", "迁移", "仆役", "官禄", "田宅", "福德", "父母"];
    var soulIdx = ORDER.indexOf("命宫");
    var rows = pals.slice().sort(function (a, b) {
      var ia = (ORDER.indexOf(a.name) - soulIdx + 12) % 12, ib = (ORDER.indexOf(b.name) - soulIdx + 12) % 12;
      return ia - ib;
    }).map(function (p) {
      var majors = (p.majorStars || []).map(function (s) {
        return esc(s.name) + (s.brightness ? '<i>' + esc(s.brightness) + '</i>' : '') +
          (s.mutagen ? '<b class="zw-mut m' + ZW_MUT.indexOf(s.mutagen) + '">' + esc(s.mutagen) + '</b>' : '');
      }).join("、") || '<span class="zw-none">空宫</span>';
      var minors = (p.minorStars || []).slice(0, 3).map(function (s) { return esc(s.name); }).join("、");
      var rng = p.decadal && p.decadal.range ? p.decadal.range[0] + "-" + p.decadal.range[1] : "";
      return '<tr><td class="zw-td-n">' + esc(zwPN(p.name)) + (p.isBodyPalace ? '<em>身</em>' : '') + '</td>' +
        '<td>' + esc(p.heavenlyStem + p.earthlyBranch) + '</td>' +
        '<td>' + majors + '</td><td class="zw-td-m">' + minors + '</td><td class="zw-td-r">' + rng + '</td></tr>';
    }).join("");

    return '<div class="zw-pattern">' +
      '<div class="zw-hero">' +
        '<div class="zw-hero-n">' + esc(ge.name) + '<span>· ' + esc(ge.type) + '</span></div>' +
        '<div class="zw-hero-d">' + esc(ge.desc) + '</div>' +
        '<div class="zw-hero-m"><b>' + esc(soulStars) + '</b> 坐命' + esc(soul.earthlyBranch) + '宫 · ' + esc(yy) +
          ' · ' + esc(c.fiveElementsClass || "") + ' · 命主' + esc(c.soul || "") + ' 身主' + esc(c.body || "") + '</div>' +
      '</div>' +
      '<div class="zw-sec-h">格局解析<span>命宫三方四正 · 每宫含义</span></div>' +
      '<div class="zw-gcards">' + cards + '</div>' +
      (mutLine ? '<div class="zw-sec-h">生年四化<span>这一生的能量落点</span></div><div class="zw-muts">' + mutLine + '</div>' : "") +
      '<div class="zw-sec-h">十二宫一览<span>主星 · 辅星 · 大限</span></div>' +
      '<div class="zw-tbl-wrap"><table class="zw-tbl"><thead><tr><th>宫位</th><th>干支</th><th>主星</th><th>辅星</th><th>大限</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
    '</div>' +
    // 结构统一：提问区（带边框独立卡）+ AI 输出与命格内容卡平级，提问框不再嵌在内容卡内
    '<div class="zw-ask">' +
      '<div class="zw-ask-h">就这张命盘提问</div>' +
      '<div class="p-suggest zw-chips"><button data-q="我的命格格局如何？优势与短板分别是什么？">格局与性格</button>' +
        '<button data-q="事业方向适合什么？有哪些需要注意的短板？">事业方向</button>' +
        '<button data-q="财运格局如何？哪些阶段财运会明显转好？">财运</button></div>' +
      '<div class="zw-ask-row"><input class="ti" id="zw-q" placeholder="输入你想问的问题…" />' +
        '<button class="tool-ai zw-ask-btn" id="zw-ask">AI 解读</button></div>' +
    '</div>' +
    '<div id="zw-ai-out"></div>';
  }

  /* 运势盘：大限 / 流年直接点选（不用左右箭头），选中后叠加显示四化与宫位标注 */
  function zwGZ(y) {
    var g = "甲乙丙丁戊己庚辛壬癸", z = "子丑寅卯辰巳午未申酉戌亥";
    return g[((y - 4) % 10 + 10) % 10] + z[((y - 4) % 12 + 12) % 12];
  }
  function zwFortuneHTML() {
    var st = zwS(), h = st.horo, c = st.chart;
    if (!c) return "";
    var by = parseInt(String(c.solarDate || "").slice(0, 4), 10) || 0;
    var decs = (c.palaces || []).filter(function (p) { return p.decadal && p.decadal.range; })
      .sort(function (a, b) { return a.decadal.range[0] - b.decadal.range[0]; });
    var curIdx = 0;
    decs.forEach(function (p, i) {
      var s = by + p.decadal.range[0] - 1, e = by + p.decadal.range[1] - 1;
      if (st.year >= s && st.year <= e) curIdx = i;
    });
    var cur = decs[curIdx];
    var ys = cur ? by + cur.decadal.range[0] - 1 : st.year;
    var ye = cur ? by + cur.decadal.range[1] - 1 : st.year;
    var decBtns = decs.map(function (p, i) {
      var s = by + p.decadal.range[0] - 1, e = by + p.decadal.range[1] - 1;
      return '<button class="zw-pickb' + (i === curIdx ? " on" : "") + '" type="button" data-at="' + s + '">' +
        '<b>' + p.decadal.range[0] + '-' + p.decadal.range[1] + '</b><span>' + s + '-' + e + '</span></button>';
    }).join("");
    var yearBtns = "";
    for (var y = ys; y <= ye; y++) {
      yearBtns += '<button class="zw-pickb y' + (y === st.year ? " on" : "") + '" type="button" data-at="' + y + '">' +
        '<b>' + y + '</b><span>' + (y - by + 1) + ' 岁</span></button>';
    }
    /* 选择栏放命盘下方：本命 / 运势两盘的命盘位置一致，切换视图不跳动 */
    return '<div class="zw-fortune">' +
      zwPlate() +
      '<div class="zw-pick">' +
        '<div class="zw-pick-h"><span class="zw-pick-l">大限</span>' +
          '<span class="zw-pick-n">' + esc(cur ? zwPN(cur.name) : "") + ' · ' + ys + '-' + ye +
            (h && h.decadal ? ' · ' + esc(h.decadal.heavenlyStem + h.decadal.earthlyBranch) : "") + '</span>' +
          '<button class="zw-ynow" id="zw-ynow" type="button">回到今年</button></div>' +
        '<div class="zw-pick-grid">' + decBtns + '</div>' +
        '<div class="zw-pick-h"><span class="zw-pick-l">流年</span>' +
          '<span class="zw-pick-n">' + st.year + ' 年 · ' + zwGZ(st.year) + '</span></div>' +
        '<div class="zw-pick-grid y">' + yearBtns + '</div>' +
      '</div>' +
      zwDetailHTML() +
    '</div>';
  }
  /* 紫微点宫位/切视图的重绘走全功能共用的 preserveOutputs（容器清单来自注册表）。 */
  /* 渲染当前视图 */
  function zwRender() {
    var st = zwS(), wrap = $("#zw-result");
    if (!wrap) return;
    if (!st.chart) { wrap.innerHTML = ""; return; }
    var body;
    if (st.view === "pattern") body = zwPatternHTML();
    else if (st.view === "fortune") body = zwFortuneHTML();
    else body = zwPlate() + zwDetailHTML();
    preserveOutputs(wrap, function () {
      wrap.innerHTML =
        '<div class="zw-bar">' +
          '<div class="zw-tabs" id="zw-tabs">' +
            '<button type="button" data-v="pattern"' + (st.view === "pattern" ? ' class="on"' : "") + '>命格</button>' +
            '<button type="button" data-v="plate"' + (st.view === "plate" ? ' class="on"' : "") + '>本命</button>' +
            '<button type="button" data-v="fortune"' + (st.view === "fortune" ? ' class="on"' : "") + '>运势</button>' +
          '</div>' +
          zwProfileAside() +
        '</div>' +
        '<div class="zw-body">' + body + '</div>';
    });
    zwBind();
  }
  /* 紫微结果标题行右侧的档案来源提示（与八字同一套措辞与样式） */
  function zwProfileAside() {
    if (!S.zwFromProfile) return "";
    return '<span class="result-aside" id="zw-edit">已使用档案中的出生信息 · ' +
      '<button type="button" class="link-btn" data-zw-edit="1">修改出生信息</button></span>';
  }
  // 「修改出生信息」：展开紫微表单并移除提示（结果区会重绘，用事件委托）
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-zw-edit]");
    if (!b) return;
    S.zwFromProfile = false;
    // 标记「本次排盘后写回档案」：用户在档案态改过出生信息，档案要跟着更新
    S.zwSaveBirth = true;
    var fw = $("#zw-form-wrap"); if (fw) fw.style.display = "";
    var aside = $("#zw-edit"); if (aside) aside.remove();
    var g = $("#zw-form .tf-group"); if (g) g.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  function zwBind() {
    var st = zwS();
    $$("#zw-tabs button").forEach(function (b) {
      b.onclick = function () {
        st.view = b.dataset.v; st.sel = null;
        zwRender(); zwStoreSync();
        // 运势盘的大限 / 流年叠加数据按需拉取（刷新后直接切到运势时 horo 还没加载）
        if (st.view === "fortune" && !st.horo) zwHoro().then(zwRender);
      };
    });
    $$("#zw-plate .zw-pal").forEach(function (el) {
      el.onclick = function () {
        var bi = +el.dataset.bi;
        st.sel = st.sel === bi ? null : bi;
        zwRender();
        var d = $(".zw-detail") || $(".zw-detail-hint");
        if (d && st.sel != null) d.scrollIntoView({ behavior: "smooth", block: "nearest" });
      };
    });
    var close = $("#zw-close");
    if (close) close.onclick = function () { st.sel = null; zwRender(); };
    $$(".zw-jump").forEach(function (b) {
      b.onclick = function () { st.sel = +b.dataset.bi; zwRender(); };
    });
    if (st.view === "fortune") {
      var load = function (y) { st.year = y; return zwHoro().then(zwRender); };
      $$(".zw-pickb").forEach(function (b) {
        b.onclick = function () { load(+b.dataset.at); };
      });
      var ynow = $("#zw-ynow");
      if (ynow) ynow.onclick = function () { load(new Date().getFullYear()); };
      // 选中项居中（用 rect 计算，offsetLeft 会受定位祖先影响导致滚到最右、选中项被滚出视野）
      $$(".zw-pick-grid").forEach(function (g) {
        var on = $(".zw-pickb.on", g);
        if (!on) return;
        var center = function () {
          var gr = g.getBoundingClientRect(), br = on.getBoundingClientRect();
          var d = (br.left - gr.left) - (g.clientWidth - on.offsetWidth) / 2;
          g.scrollLeft = Math.max(0, Math.min(g.scrollWidth - g.clientWidth, g.scrollLeft + d));
        };
        center();
        requestAnimationFrame(center);
      });
    }
    // 宫位详情里的「就此宫提问」（本命盘 / 运势盘通用）
    var dq = $("#zw-dq"), dask = $("#zw-dask"), psel = zwPalaces()[st.sel];
    if (dq && dask && psel) {
      var runPalAsk = function () {
        var v = dq.value.trim();
        if (!v) { toast("请先写下你想问的问题"); dq.focus(); return; }
        // 点名某宫 = 以它为主体、据其三方四正与四化展开解读，不是孤立只看这一宫。
        // chips 里已含完整主体措辞（以「X宫」为主体…）时不重复添加。
        var q = v.indexOf("为主体") >= 0 ? v : "（以「" + zwPN(psel.name) + "」为主体，结合三方四正与四化）" + v;
        zwAsk(q, "#zw-d-ai-out", "#zw-dq", zwPN(psel.name));
      };
      dask.onclick = runPalAsk;
      dq.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); runPalAsk(); } };
      $$(".zw-dchips button").forEach(function (b) {
        b.onclick = function () { pickQuestion(b.dataset.q, "#zw-dq"); };
      });
    }
    if (st.view === "pattern") {
      $$(".zw-chips button").forEach(function (b) {
        b.onclick = function () { pickQuestion(b.dataset.q, "#zw-q"); };
      });
      var ask = $("#zw-ask"), input = $("#zw-q");
      if (ask) ask.onclick = function () { zwAsk(input ? input.value.trim() : ""); };
      if (input) input.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); zwAsk(input.value.trim()); } };
    }
  }
  /* AI 推演：紫微与其余功能走同一个统一工厂（/api/ziwei/deduce → SSE → hid → 追问）。
     出生参数用通用 year/month/day/hour，目标流年像八字一样拼进问题文本（不造专属参数），
     宫位主体措辞本身已在问题里；盘面事实由后端从出生参数确定性重建。 */
  function zwAsk(q, outSel, inputSel, focusPalace) {
    var st = zwS();
    if (!q) { toast("请先写下你想问的问题"); var i0 = $(inputSel || "#zw-q"); if (i0) i0.focus(); return; }
    if (!st.id || !st.birth) { toast("命盘未就绪，请稍候"); return; }
    var out = $(outSel || "#zw-ai-out");
    if (!out) return;
    // 运势盘选中的流年拼进问题文本——与八字「只看 2027 流年」同一套语义，
    // 后端从问题解析目标时点；命格/本命视图不拼，保持只论本命的口径。
    var year = st.view === "fortune" ? (parseInt(st.year, 10) || "") : "";
    if (year && q.indexOf(String(year)) < 0) q = "（只看 " + year + " 年流年）" + q;
    // 轮次身份与后端 payload 对齐：命盘身份 + 时点 + 主体宫。变化即新一轮。
    var focus = focusPalace ? ("|" + focusPalace) : "";
    var rk = "chart|" + st.id + (year ? "|" + year : "") + focus;
    if (!prepareNewQuestion(out, q, rk)) return;
    var birth = st.birth;
    var seg = String(birth.date || "").split("-");
    var params = new URLSearchParams({
      year: seg[0] || "", month: seg[1] || "", day: seg[2] || "",
      hour: birth.hour != null ? birth.hour : (birth.timeIndex === 12 ? 23 : (birth.timeIndex === 0 ? 0 : birth.timeIndex * 2 - 1)),
      minute: birth.minute || 0, gender: birth.gender || "男",
      calendar: birth.calendar || "solar", q: q
    });
    var url = "/api/ziwei/deduce?" + params.toString() + authParam();
    streamToUrl(url, "AI 解读", q, out, false, rk);
  }
  function zwHoro(retried) {
    var st = zwS();
    if (!st.id) return Promise.resolve();
    return fetch("/api/horoscope?id=" + encodeURIComponent(st.id) + "&year=" + st.year)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) { st.horo = d.horoscope; return; }
        st.horo = null;
        // 缓存的盘 id 失效（服务重启 / 记录过期）：清缓存后按档案重排一次，保留当前视图。
        // 必须限一次：重排会生成新 id，若运算接口持续失败，旧逻辑会无限重排、
        // 结果区一直停在「正在起盘」，任何解读/追问都无从谈起。
        if (!retried && st.birth && !st._horoRebuilt) {
          st._horoRebuilt = true;
          try { sessionStorage.removeItem(ZW_STORE); } catch (e) { warn("清理紫微会话缓存失败", e); }
          st.key = null;
          return zwStart(st.birth, true, true);
        }
        warn("紫微运限暂不可用，本轮不叠加运限", new Error(d.error || "接口返回失败"));
      })
      .catch(function (e) { st.horo = null; warn("紫微运限请求失败", e); });
  }
  function zwStart(birth, force, keepView) {
    var wrap = $("#zw-result");
    if (!wrap) return;
    var st = zwS();
    var key = zwBirthKey(birth);
    var hit = force ? null : zwStoreGet();
    if (hit && hit.key === key && hit.chart && hit.id) {
      // 命中缓存：直接出盘，没有「正在起盘」闪屏，也不发请求
      st.chart = hit.chart; st.id = hit.id; st.key = key; st.birth = birth;
      st.sel = null; st.view = keepView && st.view ? st.view : (hit.view || "plate");
      st.year = hit.year || new Date().getFullYear();
      // v126：紫微命盘数据存进 Board 对象（真相源），DOM/宫位渲染只是投影。
      putBoard("ziwei", "chart|" + st.id, st.chart, { chartId: st.id, birthKey: key }, "");
      zwRender();
      if (st.view === "fortune") zwHoro().then(zwRender);
      return;
    }
    // 真正换盘（不是命中缓存）：先按「旧盘 rk + 问题」归档旧轮（对象与 DOM 一起），
    // 再清输出容器缓存，避免旧盘解读卡被挂回新盘造成「对象与画面脱节」。
    archiveBeforeRepaint(wrap, "ziwei");
    wrap.innerHTML = '<p class="p-note" style="text-align:center;margin:16px 0">正在起盘…</p>';
    st.chart = null; st.id = null; st.sel = null;
    if (!(keepView && st.view)) st.view = "plate";
    st.year = new Date().getFullYear();
    st.key = key; st.birth = birth;
    var p = new URLSearchParams({
      date: birth.date, timeIndex: birth.timeIndex, gender: birth.gender || "男",
      calendar: birth.calendar || "solar", fixLeap: "true"
    });
    // 用户主动改过出生信息 → 写回档案（档案是全站唯一数据源）
    if (S.zwSaveBirth && S.profile) {
      p.set("save", "1");
      p.set("profile_id", String(S.profile.id));
      p.set("token", S.profile.token);
      if (birth.hour != null) p.set("hour", String(birth.hour));
      if (birth.minute != null) p.set("minute", String(birth.minute));
      if (birth.know_time != null) p.set("know_time", birth.know_time ? "1" : "0");
    }
    fetch("/api/chart?" + p.toString()).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || "排盘失败");
      st.chart = d.chart; st.id = d.id;
      // v126：命盘数据存进 Board 对象（真相源）。
      putBoard("ziwei", "chart|" + st.id, st.chart, { chartId: st.id }, "");
      if (S.zwSaveBirth && S.profile) {
        S.zwSaveBirth = false;
        toast("出生信息已同步到个人档案，其它功能将使用新信息");
        profileBirthChanged();
      }
      zwStoreSync();
      return zwHoro();
    }).then(function () {
      zwRender();
      var bar = $(".zw-bar");
      if (bar) bar.scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function (e) {
      wrap.innerHTML = '<p class="p-err" style="text-align:center">' + esc(e.message || "排盘失败") + '</p>';
      var fw = $("#zw-form-wrap"); if (fw) fw.style.display = "";
    });
  }

  function renderZiweiEntry() {
    stageEl().innerHTML =
      toolHero("紫微斗数", "以命盘十二宫观人生格局：命宫、财帛、事业、姻缘一目了然；登录后自动带入档案出生信息。") +
      '<div id="zw-form-wrap"><div class="tool-card"><div class="tool-form" id="zw-form">' +
        '<div class="tf-group"><div class="tf-gt">基本信息</div>' +
          '<div class="tf-grid">' +
            '<div class="tf-field"><label>性别</label><select class="ti" id="zw-gender"><option>男</option><option>女</option></select></div>' +
          '</div>' +
        '</div>' +
        '<div class="tf-group">' + birthFieldsHTML("zw", { title: "时间信息" }) + '</div>' +
        '<button class="tool-submit" id="zw-calc">开始排盘</button>' +
        '<div class="p-err" id="zw-err"></div>' +
      '</div></div></div>' +
      '<div id="zw-result"></div>' +
      aboutDetails("关于紫微斗数", [
        '<b>命盘</b>：以出生时间安十二宫与主星，命宫为自我根基，财帛、事业、迁移等宫位各司其职。',
        '<b>四化</b>：化禄、化权、化科、化忌描述星曜能量的流动方向，是看运势变化的关键。',
        '<b>大限流年</b>：十年一大限、一年一流年，命盘随时间推移呈现不同阶段的主题。'
      ], "全部排盘由程序确定性计算；登录后档案出生信息自动带入，无需重复填写。");
    birthFieldsBind("zw");
    S.zwFromProfile = false;
    S.zwSaveBirth = false;
    $("#zw-calc").onclick = function () {
      var b = birthCollect("zw");
      if (b.mode === "bazi") { $("#zw-err").textContent = "紫微排盘请使用「日期」方式输入"; return; }
      if (!b.year || !b.month || !b.day) { $("#zw-err").textContent = "请先选择出生日期"; return; }
      $("#zw-err").textContent = "";
      // 时辰序数：0=早子…12=晚子；未知出生时间默认午时（与档案口径一致）
      var ti = b.know_time ? (b.hour === 23 ? 12 : Math.floor((b.hour + 1) / 2)) : 6;
      S.zwFromProfile = false;
      zwStart({ date: b.year + "-" + b.month + "-" + b.day, timeIndex: ti,
        gender: $("#zw-gender").value, calendar: b.calendar,
        hour: b.hour, minute: b.minute, know_time: b.know_time });
    };
    // 已有缓存的命盘：直接出盘（登录用户不再每次重新排盘）
    var cached = zwStoreGet();
    var restoreCache = function () {
      if (!cached || !cached.birth || !cached.chart) return false;
      if (S.profile && cached.uid !== S.profile.id) return false;
      // 先把表单回填好（点「修改出生信息」时不会是一张空表），再直接出盘
      var seg = String(cached.birth.date || "").split("-"), ti0 = +cached.birth.timeIndex || 0;
      var hr0 = ti0 === 12 ? 23 : (ti0 === 0 ? 0 : ti0 * 2 - 1);
      birthFieldsBind("zw", { calendar: cached.birth.calendar || "solar",
        year: +seg[0], month: +seg[1], day: +seg[2], hour: hr0, minute: 0, know_time: true });
      if ($("#zw-gender")) $("#zw-gender").value = cached.birth.gender || "男";
      zwStart(cached.birth);
      return true;
    };
    // 登录态：始终以档案出生信息为准（与八字一致），不再让缓存抢先决定走哪条路径
    if (S.profile) {
      fetch("/api/profile/get?id=" + S.profile.id + "&token=" + encodeURIComponent(S.profile.token))
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok && d.profile && d.profile.birth) {
            var b = d.profile.birth;
            var yyyy = b.year, mm = b.month, dd = b.day;
            if ((yyyy == null || mm == null || dd == null) && b.date) {
              var seg = String(b.date).split("-"); yyyy = +seg[0]; mm = +seg[1]; dd = +seg[2];
            }
            birthFieldsBind("zw", { calendar: "solar", year: yyyy, month: mm, day: dd,
              hour: b.hour != null ? b.hour : 12, minute: b.minute != null ? b.minute : 0,
              know_time: b.know_time !== false });
            if (b.gender) $("#zw-gender").value = (b.gender === "male" ? "男" : b.gender === "female" ? "女" : b.gender);
            var ti = b.know_time === false ? 6 : (b.hour === 23 ? 12 : Math.floor(((b.hour != null ? b.hour : 12) + 1) / 2));
            // 档案带入：与八字一致，收起表单并给出「已使用档案中的出生信息」提示
            S.zwFromProfile = true;
            var fw = $("#zw-form-wrap"); if (fw) fw.style.display = "none";
            zwStart({ date: yyyy + "-" + mm + "-" + dd, timeIndex: ti,
              gender: $("#zw-gender").value, calendar: b.calendar || "solar",
              hour: b.hour != null ? b.hour : 12, minute: b.minute != null ? b.minute : 0,
              know_time: b.know_time !== false });
          } else {
            // 档案里没有出生信息：退回手动填写
            restoreCache();
          }
        }).catch(function () { restoreCache(); });
      return;
    }
    // 未登录：用上次的手动排盘结果，否则展示表单
    restoreCache();
    applyGate("ziwei");
  }


  /* ================= 合婚（八字 / 紫微）=================
     双人盘由确定性引擎先算完，再交给 AI 解读；不给匹配分数，只给可回到柱位/宫位核对的论据。 */
  function renderMarriage(kind) {
    var isBazi = kind === "bazi", isAstro = kind === "astro";
    var feat = isBazi ? "bazi_marriage" : (isAstro ? "astrology_marriage" : "ziwei_marriage");
    var title = isBazi ? "八字合婚" : (isAstro ? "占星合盘" : "紫微合婚");
    var pfxA = isBazi ? "bza" : (isAstro ? "asa" : "zwa");
    var pfxB = isBazi ? "bzb" : (isAstro ? "asb" : "zwb");
    var pre = isBazi ? "bzm" : (isAstro ? "asm" : "zm");
    var plateWord = isAstro ? "本命盘" : (isBazi ? "四柱" : "命盘");
    stageEl().innerHTML =
      toolHero(title, isBazi
        ? "分别排定两人四柱，再从日柱夫妻宫、十神交叉与大运流年读出相处中的省力与费力之处。本功能不给匹配分数。"
        : (isAstro
          ? "对照两张本命盘，从跨盘相位、金星火星落宫与日月要素读出相处的吸引与摩擦。本功能不给匹配分数。"
          : "对照两张完整紫微命盘，从夫妻宫、命宫、福德宫与双向四化交叉看清关系结构。本功能不给匹配分数。")) +
      '<div class="tool-card" id="' + pre + '-form-card"><div class="tool-form" id="' + pre + '-form">' +
        pairFormHTML(pfxA, pfxB, isAstro
          ? "双方分别填写出生日期、精确时分与出生城市（占星按出生地经纬度算宫位）；点「导入本人信息」可带入档案。盘面生成后，在下方提问卡里另起问题。"
          : "男女双方分别填写（或点「导入本人信息」带入档案），性别可按需调整；出生地用于真太阳时校正。盘面生成后，在下方提问卡里另起问题。") +
        '<button class="tool-submit" id="' + pre + '-calc" style="margin-top:14px">生成双人' + plateWord + '</button>' +
        '<div class="p-err" id="' + pre + '-err"></div>' +
      '</div></div>' +
      '<div id="' + pre + '-result"></div>' +
      aboutDetails("关于" + title, isBazi ? [
        '<b>三层结构</b>：各自命局 → 两盘交互 → 大运流年同步；每层都给出具体柱位与十神作为论据。',
        '<b>16 组柱位对照</b>：双方四柱逐一配对，判定天干五合/相冲、地支六合/半合/暗合/相冲/相刑/相害/相破；日柱夫妻宫权重最高。',
        '<b>神煞</b>：红鸾、天喜等只作辅助证据，须与喜忌、十神、柱位交叉验证，不作单星断言。'
      ] : (isAstro ? [
        '<b>先定盘再合盘</b>：按双方生日与出生地用 Swiss Ephemeris 排出两张本命盘，再建立跨盘关系，问题不改变盘面。',
        '<b>跨盘相位</b>：一方每颗个人星与对方的太阳/月亮/金星/火星等逐一比对合冲刑拱六合，标明容许度与基调。',
        '<b>落宫与要素</b>：金星/火星落入对方第几宫、双方日月星座要素配对，均可回到星曜-星座-宫位核对。'
      ] : [
        '<b>先定盘再合盘</b>：两张命盘的十二宫、星曜亮度、四化先由程序确定，再建立跨盘关系，问题不改变盘面。',
        '<b>六个维度</b>：夫妻宫、命宫、福德宫、四化交叉、桃花星、大限流年时间线，均可回到具体宫位核对。',
        '<b>四化交叉</b>：一方禄权科忌落在哪一地支宫位，映射到对方同地支的生活领域，双向各做一次。'
      ]), "合盘是关系观察框架，不证明谁是「正缘」，也不能替代真实相处、共同选择与专业建议。");

    pairFormBind(pfxA, pfxB);
    function pairQS(errSel) { return pairFormParams(pfxA, pfxB, errSel || null, { bothPlaces: isAstro }); }
    var lastPair = "";                       // 已生成双人盘的参数串；出生信息不变则盘面一次生成
    var calcBtn = $("#" + pre + "-calc");
    function calcLabel() {
      var now = pairQS();
      calcBtn.textContent = !lastPair ? "生成双人" + plateWord
        : (now === lastPair ? "沿用本次双人盘（在下方提问）" : "重新生成双人" + plateWord);
    }
    $("#" + pre + "-form").addEventListener("input", calcLabel);
    $("#" + pre + "-form").addEventListener("change", calcLabel);
    calcLabel();

    function ask(q, qs) {
      var root = $("#" + pre + "-result"), out = $("#" + pre + "-ai-out");
      if (!root || !root.dataset.rk || !out) { toast("请先生成双人" + plateWord); return; }
      streamAI(feat, qs + "&q=" + encodeURIComponent(q) + authParam(), q, out, root.dataset.rk);
    }
    function bindAsk() {
      var inp = $("#" + pre + "-q2"), askBtn = $("#" + pre + "-ask");
      if (!inp || !askBtn) return;
      $$("#" + pre + "-result .zw-chips button").forEach(function (b) {
        b.onclick = function () { pickQuestion(b.dataset.q, "#" + pre + "-q2"); };
      });
      var fire = function () {
        var q = (inp.value || "").trim();
        if (!q) { toast("请先写下你想问的问题"); inp.focus(); return; }
        if (requireLogin()) return;
        ask(q, lastPair);
      };
      askBtn.onclick = fire;
      inp.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); fire(); } };
    }
    function generate(qs) {
      var out = $("#" + pre + "-ai-out"), root = $("#" + pre + "-result");
      if (out && containerBusy(out)) { toast("解读进行中，请等完成后再重排"); return; }
      $("#" + pre + "-err").textContent = "";
      calcBtn.disabled = true;
      fetch("/api/" + feat + "/calc?" + qs).then(function (r) { return r.json(); }).then(function (d) {
        calcBtn.disabled = false;
        if (!d.ok) { $("#" + pre + "-err").textContent = d.error || "排盘失败"; return; }
        // 换双人信息 = 新盘：旧轮（解读 + 追问）先平级归档，再重建盘面与提问卡。
        if (out && root.dataset.rk) archiveRound(out, out.dataset.lastQ || title, root.dataset.rk);
        lastPair = qs;
        var pairRoundKey = (isBazi ? "bazi-mar|" : (isAstro ? "astro-mar|" : "ziwei-mar|")) + qs;
        root.dataset.rk = pairRoundKey;
        // v126：双人合盘数据存进 Board 对象（真相源），DOM 只是投影。
        putBoard(feat, pairRoundKey, d, { params: qs }, "");
        root.dataset.lastQ = "";
        root.innerHTML = renderPairResult(d, isBazi, pre, isAstro);
        bindAsk();
        calcLabel();
        root.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }).catch(function () { calcBtn.disabled = false; });
    }
    calcBtn.onclick = function () {
      var qs = pairQS("#" + pre + "-err");
      if (!qs) return;
      var root = $("#" + pre + "-result");
      // 出生信息未变：盘面一次生成；换问题只在下方提问卡里走 AI，绝不重排双人盘。
      if (lastPair && qs === lastPair && root.dataset.rk) {
        var inp = $("#" + pre + "-q2");
        if (inp) { inp.scrollIntoView({ behavior: "smooth", block: "center" }); inp.focus(); }
        toast("双人盘未变化，请在下方提问卡里另起问题");
        return;
      }
      generate(qs);
    };
    applyGate(feat);
  }
  function renderPairResult(d, isBazi, pre, isAstro) {
    var a = d.a_data || {}, b = d.b_data || {}, cross = d.cross || {};
    function stars(list) {
      return (list || []).map(function (s) {
        return '<span class="mrg-star">' + esc(s.name) + (s.brightness ? '<i>' + esc(s.brightness) + '</i>' : '') +
          (s.mutagen ? '<b>' + esc(s.mutagen) + '</b>' : '') + '</span>';
      }).join("");
    }
    function astroCard(p, who) {
      var head = '<div class="mrg-p-hd"><b>' + esc(p.name || who) + '</b><span>' + esc(p.gender || "") + '</span></div>';
      var core = [["☉太阳", p.sun], ["☽月亮", p.moon], ["↑上升", p.asc]].map(function (x) {
        var o = x[1] || {};
        return '<div class="mrg-pal"><span>' + x[0] + '</span><div>' + esc(o.symbol || "") + ' ' +
          esc(o.sign || "—") + ' <i>' + esc(o.degree || "") + '</i></div></div>';
      }).join("");
      var venus = (p.planets || []).filter(function (x) { return x.key === "venus" || x.key === "mars"; })
        .map(function (x) {
          return '<div class="mrg-pal"><span>' + esc(x.name) + '</span><div>' + esc(x.symbol || "") + ' ' +
            esc(x.sign || "—") + ' · 第' + esc(x.house || "—") + '宫' + (x.retro ? '（逆行）' : '') + '</div></div>';
        }).join("");
      var el = p.element || {};
      var elLine = '<div class="mrg-line">' + ["火","土","风","水"].map(function (k) {
        return '<span>' + k + ' <b>' + esc(el[k] || 0) + '</b></span>';
      }).join("") + '</div>';
      return '<div class="mrg-p-card">' + head + core + venus + elLine + '</div>';
    }
    function personCard(p, who) {
      if (isAstro) return astroCard(p, who);
      var head = '<div class="mrg-p-hd"><b>' + esc(p.name || who) + '</b><span>' + esc(p.gender || "") +
        ' · ' + esc(p.chineseDate || ((p.pillars ? [p.pillars.year, p.pillars.month, p.pillars.day, p.pillars.hour].join(" ") : ""))) + '</span></div>';
      if (isBazi) {
        return '<div class="mrg-p-card">' + head +
          '<div class="mrg-pillars">' + ["year","month","day","hour"].map(function (k) {
            var gz = (p.pillars || {})[k]; if (!gz) return "";
            return '<div class="mrg-pil"><span>' + ({year:"年",month:"月",day:"日",hour:"时"})[k] + '</span><b>' + esc(gz) + '</b>' +
              '<i>' + esc((p.ten_gods || {})[k] || "") + '</i></div>';
          }).join("") + '</div>' +
          '<div class="mrg-line"><span>日主 <b>' + esc(p.day_master || "—") + '</b></span>' +
          '<span>强弱 <b>' + esc((p.strength || {}).level || "—") + '</b></span>' +
          '<span>喜忌 <b>' + esc((p.strength || {}).favor || "—") + '</b></span></div></div>';
      }
      return '<div class="mrg-p-card">' + head +
        ["命宫","夫妻宫","福德宫"].map(function (pn) {
          var pc = p[pn] || {};
          return '<div class="mrg-pal"><span>' + pn + ' · ' + esc(pc.branch || "—") + '</span><div>' +
            stars(pc.majorStars) + stars(pc.minorStars) + '</div></div>';
        }).join("") + '</div>';
    }
    var groups = (cross.pillar_groups || []).filter(function (g) {
      return (g.relations || []).some(function (r) { return !/无合冲刑害破/.test(r.relation || ""); });
    }).slice(0, 8);
    var crossHtml;
    if (isAstro) {
      var rows = (cross.aspects || []).slice(0, 10);
      crossHtml = '<div class="mrg-cross-h">跨盘相位（synastry · 节选）</div>' +
        (rows.length ? '<div class="mrg-rels">' + rows.map(function (r) {
          return '<div class="mrg-rel"><b>' + esc(r.name) + '</b><span>' + esc(r.a) + ' — ' + esc(r.b) +
            '（容许 ' + esc(r.orb) + '°）</span></div>';
        }).join("") + '</div>' : '<p class="p-note">两盘个人星之间未见主要相位。</p>');
    } else if (isBazi) {
      crossHtml = '<div class="mrg-cross-h">命中柱位关系（节选）</div>' +
        (groups.length ? '<div class="mrg-rels">' + groups.map(function (g) {
          return '<div class="mrg-rel"><b>' + esc(g.who) + '</b><span>' +
            (g.relations || []).filter(function (r) { return !/无合冲刑害破/.test(r.relation || ""); })
              .map(function (r) { return esc(r.relation); }).join("；") + '</span></div>';
        }).join("") + '</div>' : '<p class="p-note">两盘四柱之间未见显著合冲刑害。</p>');
    } else {
      crossHtml = '<div class="mrg-cross-h">四化交叉与关系宫位</div><div class="mrg-rels">' +
        Object.keys(cross).filter(function (k) { return cross[k] && typeof cross[k] === "object"; }).slice(0, 6).map(function (k) {
          return '<div class="mrg-rel"><b>' + esc(k) + '</b><span>已由引擎按双方落宫建立对照</span></div>';
        }).join("") + '</div>';
    }
    return '<div class="p-result">' + resultTitle(titleForPair(isBazi, isAstro)) +
      '<div class="p-card"><div class="mrg-pair">' + personCard(a, "甲方") + personCard(b, "乙方") + '</div>' +
        crossHtml +
      '</div></div>' +
      // 与八字/紫微命盘同构：盘面卡 + 独立提问卡 + AI 解读输出三段平级
      '<div class="bz-ask"><div class="bz-ask-h">就这段关系提问<span>解读基于以上双人盘面，不改变盘面本身</span></div>' +
        '<div class="p-suggest zw-chips">' +
          [["相处摩擦", "我们相处中反复出现的摩擦来自哪里？"],
           ["需求互补", "双方在感情中的需求与表达方式如何互补？"],
           ["阶段节奏", "未来两年关系推进需要注意哪些阶段？"]].map(function (c) {
            return '<button type="button" data-q="' + esc(c[1]) + '">' + esc(c[0]) + '</button>';
          }).join("") + '</div>' +
        '<div class="zw-ask-row"><input class="ti" id="' + pre + '-q2" placeholder="例如：我们相处中反复出现的摩擦来自哪里？" />' +
          '<button class="tool-ai zw-ask-btn" id="' + pre + '-ask" type="button">AI 解读</button></div>' +
      '</div>' +
      '<div id="' + pre + '-ai-out"></div>';
  }
  function titleForPair(isBazi, isAstro) { return isBazi ? "八字合婚 · 双人四柱对照" : (isAstro ? "占星合盘 · 双人本命盘对照" : "紫微合婚 · 双人命盘对照"); }
  function renderBaziMarriage() { renderMarriage("bazi"); }
  function renderZiweiMarriage() { renderMarriage("ziwei"); }
  function renderAstrologyMarriage() { renderMarriage("astro"); }

  /* ================= 六爻 ================= */
  function renderLiuyao() {
    stageEl().innerHTML =
      toolHero("六爻占卜", "一事一占：先确定本卦、动爻与变卦，再装入纳甲、六亲、六神、世应与旬空。AI 只基于已排定的卦盘解读。") +
      '<div class="tool-card" id="ly-form-card"><div class="tool-form" id="ly-form">' +
        '<div class="tf-group"><div class="tf-gt">提出一个具体的问题</div>' +
          '<p class="p-note" style="margin:0 0 10px">一次只问一件事，并写明必要背景与时间范围；起卦后请专注这一卦。</p>' +
          '<input class="ti" id="ly-q" placeholder="例如：未来三个月是否适合接受这份外地工作？" />' +
          '<div class="p-suggest"><button data-q="这份工作机会是否值得接受？">工作机会</button>' +
          '<button data-q="这次合作能否顺利推进？">合作推进</button>' +
          '<button data-q="遗失的物品还能否找到？">遗失寻找</button></div></div>' +
        '<div class="tf-group"><div class="tf-gt">起卦方式</div>' +
          '<div class="p-seg" id="ly-method"><button class="on" data-v="coin">铜钱摇卦</button>' +
          '<button data-v="time">时间起卦</button><button data-v="number">数字起卦</button>' +
          '<button data-v="random">随机起卦</button><button data-v="manual">手动起卦</button></div>' +
          '<div id="ly-inputs"></div></div>' +
        '<button class="tool-submit" id="ly-cast">起卦</button><div class="p-err" id="ly-err"></div>' +
      '</div></div>' +
      '<div id="ly-result"></div>' +
      aboutDetails("关于六爻", [
        '<b>六层规则链</b>：起卦成爻 → 本卦/动爻/变卦 → 纳甲装干支 → 卦宫六亲世应 → 月建日辰旬空 → 取用神综合判断。',
        '<b>用神</b>：问工作看官鬼、问财看妻财、问文书长辈看父母；判断须能回到具体爻位。',
        '<b>起卦方式</b>：四种方式只决定六爻如何得到；卦成之后，装卦与解读规则完全一致。'
      ], "六爻卦盘是传统规则生成的结构，AI 解读是有依据的参考而非确定预言；重大事项请以现实证据与专业意见为准。");
    $$(".p-suggest button", stageEl()).forEach(function (b) { b.onclick = function () { pickQuestion(b.dataset.q, "#ly-q"); }; });
    var manualYaos = [7, 7, 7, 7, 7, 7];  // 自下而上，7少阳 8少阴 9老阳动 6老阴动
    function renderInputs() {
      var m = segVal($("#ly-method")), box = $("#ly-inputs");
      if (m === "time") {
        var nw = new Date();
        box.innerHTML = dateTimeHTML("lyt", { dateLabel: "起卦日期", timeLabel: "起卦时刻" });
        dateTimeBind("lyt", { year: nw.getFullYear(), month: nw.getMonth() + 1, day: nw.getDate(),
          hour: nw.getHours(), minute: nw.getMinutes() });
      } else if (m === "number") {
        box.innerHTML = '<div class="tf-grid" style="margin-top:12px">' +
          '<div class="tf-field"><label>第一个数字（下卦）</label><input class="ti" id="ly-n1" type="number" value="23" /></div>' +
          '<div class="tf-field"><label>第二个数字（上卦）</label><input class="ti" id="ly-n2" type="number" value="45" /></div></div>';
      } else if (m === "manual") {
        box.innerHTML = '<div class="mh-yaos" id="ly-editor" style="margin-top:12px"></div>';
        drawManual();
      } else {
        box.innerHTML = '<p class="p-note">铜钱摇卦由程序按三枚铜钱的六种组合生成六次结果；所问之事与当下时刻共同参与，问题不是唯一决定因素。</p>';
      }
    }
    function drawManual() {
      var box = $("#ly-editor"); if (!box) return;
      box.innerHTML = [6,5,4,3,2,1].map(function (i) {
        var v = manualYaos[i - 1];
        return '<div class="mh-yao-row"><span class="pos">' + (i === 1 ? "初爻" : i === 6 ? "上爻" : ["","二爻","三爻","四爻","五爻"][i-1]) + '</span>' +
          '<select class="ti ly-yao-sel" data-i="' + i + '" style="width:auto">' +
          [[7,"少阳 —"],[8,"少阴 - -"],[9,"老阳 ○ 动"],[6,"老阴 × 动"]].map(function (o) {
            return '<option value="' + o[0] + '"' + (v === o[0] ? " selected" : "") + '>' + o[1] + '</option>';
          }).join("") + '</select></div>';
      }).join("");
      $$(".ly-yao-sel", box).forEach(function (s) {
        s.onchange = function () { manualYaos[+s.dataset.i - 1] = +s.value; };
      });
    }
    renderInputs();
    $$("#ly-method button").forEach(function (b) { b.onclick = function () { segSet($("#ly-method"), b.dataset.v); renderInputs(); }; });
    function castQS() {
      var m = segVal($("#ly-method")), q = "method=" + m;
      if (m === "time") q += "&when=" + encodeURIComponent(dateTimeCollect("lyt").when);
      if (m === "number") q += "&num1=" + ($("#ly-n1").value || 1) + "&num2=" + ($("#ly-n2").value || 1);
      if (m === "manual") q += "&yaos=" + manualYaos.join(",");
      return q;
    }
    $("#ly-cast").onclick = function () {
      var question = $("#ly-q").value.trim();
      if (!question) { toast("请先写下所问之事"); $("#ly-q").focus(); return; }
      $("#ly-err").textContent = "";
      fetch("/api/liuyao/calc?" + castQS() + "&question=" + encodeURIComponent(question))
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { $("#ly-err").textContent = d.error || "起卦失败"; return; }
          var root = $("#ly-result");
          archiveRound(root, question, root.dataset.rk);
          root.innerHTML = renderLiuyaoResult(d);
          // 身份 = 起卦时刻 + 六爻 deck；同一爻象不同月建日辰也属不同轮
          var lyRk = "liuyao|" + (d.when || "") + "|" + d.deck;
          root.dataset.rk = lyRk;
          var lock = "deck=" + encodeURIComponent(d.deck) + "&when=" + encodeURIComponent(d.when || "");
          // v126：卦象数据存进 Board 对象（真相源），DOM 只是投影。
          putBoard("liuyao", lyRk, d, { lock: lock, deck: d.deck }, d.when);
          $("#ly-ask").onclick = function () {
            var q = $("#ly-q").value.trim();
            if (!q) { toast("请先写下所问之事"); return; }
            if (q !== question) { toast("问题已更改，请重新起卦"); return; }
            if (requireLogin()) return;
            streamAI("liuyao", lock + "&q=" + encodeURIComponent(q) + authParam(), q, root, root.dataset.rk);
          };
          root.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }).catch(function (e) {
          warn("六爻起卦请求失败", e);
          $("#ly-err").textContent = "起卦失败：网络或服务异常，请重试";
        });
    };
    applyGate("liuyao");
  }
  function renderLiuyaoResult(boardData) {
    return liuyaoBoardView(boardData) +
      '<div class="bz-ask"><div class="bz-ask-h">就这一卦提问<span>卦盘已锁定，追问与解读使用同一卦</span></div>' +
        '<button class="tool-ai" id="ly-ask">AI 解卦</button></div>';
  }
  /* v126：六爻盘面投影（纯函数）——从 Board.data 重建盘面卡，归档/快照走它。 */
  function liuyaoBoardView(boardData) {
    function renderGua(gua) {
      return '<div class="ly-gua' + (gua && boardData.bian_gua && gua.name === boardData.bian_gua.name ? ' bian' : '') + '">' +
        '<div class="ly-gua-tag">' + (gua && boardData.bian_gua && gua.name === boardData.bian_gua.name ? '变卦' : '本卦') + '</div>' +
        '<div class="ly-gua-nm">' + esc((gua || {}).name || "—") + '</div>' +
        '<div class="ly-gua-sub">第' + esc((gua || {}).index || "—") + '卦 · 上' + esc((gua || {}).upper || "") + '下' + esc((gua || {}).lower || "") + '</div>' +
        '<div class="ly-gua-sub">' + esc((gua || {}).gong || "") + '宫 · ' + esc((gua || {}).gong_wuxing || "") + '</div></div>';
    }
    var yaoRows = (boardData.yaos || []).slice().reverse().map(function (yao) {
      var movingMark = yao.value === 9 ? ' <b>○</b>' : yao.value === 6 ? ' <b>×</b>' : '';
      return '<div class="ly-yao' + (yao.moving ? ' moving' : '') + '">' +
        '<span class="ly-pos">' + esc(yao.name) + '</span>' +
        '<span class="ly-line ' + (yao.yang ? 'yang' : 'yin') + '">' +
          (yao.yang ? '<i></i>' : '<i></i><i></i>') + '</span><span class="ly-mv">' + movingMark + '</span>' +
        '<span>' + esc(yao.gan || "") + esc(yao.zhi || "") + '(' + esc(yao.wuxing || "") + ')</span>' +
        '<span>' + esc(yao.liuqin || "") + '</span><span>' + esc(yao.liushen || "") + '</span>' +
        '<span class="ly-sy">' + esc(yao.shiying || "") + '</span></div>';
    }).join("");
    var movingYaos = (boardData.yaos || []).filter(function (yao) { return yao.moving; });
    var movingNote = movingYaos.length
      ? '动爻 ' + movingYaos.length + ' 个（' + movingYaos.map(function (yao) { return yao.name; }).join('、') + '）'
      : '六爻皆静（无动爻），传统称「静卦」，故无变卦——这是正常的起卦结果，不是缺漏';
    var coinDetail = '';
    if (boardData.method === 'coin' && boardData.deck) {
      var names = ['初爻','二爻','三爻','四爻','五爻','上爻'];
      var valueNames = { 6: '老阴×动', 7: '少阳', 8: '少阴', 9: '老阳○动' };
      coinDetail = '<div class="ly-coins"><div class="ly-coins-h">铜钱六掷明细（自下而上）</div><div class="ly-coins-row">' +
        names.map(function (name, index) {
          var value = +String(boardData.deck)[index];
          return '<span class="' + (value === 6 || value === 9 ? 'mv' : '') + '">' + name + ' ' + (valueNames[value] || value) + '</span>';
        }).join('') + '</div><div class="ly-coins-note">三枚铜钱每掷求和：三阳=9老阳、二阳一阴=8少阴、一阳二阴=7少阳、三阴=6老阴；老阴老阳为动爻，其余为静爻。</div></div>';
    }
    return '<div class="p-result">' + resultTitle("六爻卦盘") +
      '<div class="p-card"><div class="ly-gua-row">' + renderGua(boardData.ben_gua) + (boardData.bian_gua ? renderGua(boardData.bian_gua) : '') + '</div>' +
        '<div class="ly-meta">月建 ' + esc(boardData.yuejian || "—") + '　日辰 ' + esc(boardData.richen || "—") + '　旬空 ' + esc(boardData.xunkong || "—") + '</div>' +
        '<div class="ly-meta">' + esc(movingNote) + '</div>' + coinDetail +
        '<div class="ly-yaos">' + yaoRows + '</div>' +
      '</div></div>';
  }
  BOARD_VIEWS.liuyao = liuyaoBoardView;

  /* 奇门表单的「?」是真正的备注触发器：点击弹出说明，再点/点外部/ESC 关闭。
     舞台会整体重绘，故用 document 事件委托，气泡全局单例。 */
  var qmNoteEl = null, qmNoteFor = null;
  function qmNoteClose() {
    if (qmNoteEl) qmNoteEl.classList.add("hidden");
    qmNoteFor = null;
  }
  function qmNoteOpen(el) {
    if (qmNoteFor === el && qmNoteEl && !qmNoteEl.classList.contains("hidden")) { qmNoteClose(); return; }
    if (!qmNoteEl) {
      qmNoteEl = document.createElement("div");
      qmNoteEl.className = "qm-note hidden";
      qmNoteEl.setAttribute("role", "tooltip");
      document.body.appendChild(qmNoteEl);
    }
    qmNoteFor = el;
    qmNoteEl.textContent = el.getAttribute("data-note") || "";
    qmNoteEl.classList.remove("hidden");
    var r = el.getBoundingClientRect(), w = qmNoteEl.offsetWidth, h = qmNoteEl.offsetHeight;
    qmNoteEl.style.left = Math.max(8, Math.min(r.left - 8, window.innerWidth - w - 8)) + "px";
    var top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    qmNoteEl.style.top = top + "px";
  }
  document.addEventListener("click", function (e) {
    var h = e.target.closest && e.target.closest(".qm-help");
    if (h) { e.preventDefault(); qmNoteOpen(h); return; }
    if (qmNoteEl && !qmNoteEl.classList.contains("hidden")) qmNoteClose();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { qmNoteClose(); return; }
    if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("qm-help")) {
      e.preventDefault(); qmNoteOpen(e.target);
    }
  });
  window.addEventListener("scroll", qmNoteClose, true);

  /* ================= 奇门遁甲 ================= */
  function renderQimen() {
    stageEl().innerHTML =
      toolHero("奇门遁甲", "时家奇门 · 转盘排宫：可选拆补法或置闰法定局，以起局时刻排定九宫、八门、九星、八神与三奇六仪；问题只决定阅读焦点，不改变局数星门。") +
      '<div class="tool-card" id="qm-form-card"><div class="tool-form" id="qm-form">' +
        '<div class="tf-group"><div class="tf-gt">提出一个具体的问题</div>' +
          '<p class="p-note" style="margin:0 0 10px">写明事情进行到哪一步、有哪些选项、最担心什么；聚焦一件事更容易得到有用的解读。</p>' +
          '<input class="ti" id="qm-q" placeholder="例如：两个工作机会之间，未来三个月应重点核对哪些风险？" />' +
          '<div class="p-suggest"><button data-q="这次合作最大的推进阻力在哪里？">合作阻力</button>' +
          '<button data-q="当前阶段该如何推进这段关系？">关系推进</button>' +
          '<button data-q="近期出行需要注意什么？">出行决策</button></div></div>' +
        '<div class="tf-group"><div class="tf-gt">排盘方式 <i class="qm-help" role="button" tabindex="0" data-note="拆补法以节气为君，交节即换；置闰法以符头为纲，按正授/超神/接气定局，在芒种、大雪处置闰。两种口径局数可能不同，解读会标明本局所用口径。">?</i></div>' +
          '<div class="p-seg" id="qm-method"><button class="on" data-v="chaibu">拆补法</button><button data-v="zhirun">置闰法</button></div>' +
          '<p class="p-note qm-method-note" id="qm-method-note">拆补法：交节即换节气，三元由最近符头判定；不置闰，局数可逐宫复算。</p></div>' +
        '<div class="tf-group"><label class="p-switch qm-toggle"><input type="checkbox" id="qm-na-on" /><span>以年命代表求测人 <i class="qm-help" role="button" tabindex="0" data-note="可选。按出生年份取年命地支，标注求测人自身的参照宫；不参与起局定盘。">?</i></span></label>' +
          '<div id="qm-na-fields" style="display:none"><select class="ti" id="qm-na">' +
            (function () { var out = '', y = new Date().getFullYear(); for (var i = 0; i <= 70; i++) out += '<option value="' + (y - i) + '">' + (y - i) + ' 年生</option>'; return out; })() +
          '</select><p class="p-note qm-opt-note">选填。不填则以日干代表求测人。</p></div></div>' +
        '<div class="tf-group"><label class="p-switch qm-toggle"><input type="checkbox" id="qm-ys-on" /><span>指定用神 <i class="qm-help" role="button" tabindex="0" data-note="可选。选定后 AI 以此为解读主线；不参与起局定盘。未指定则按日干/时干取用。">?</i></span></label>' +
          '<div id="qm-ys-fields" style="display:none"><select class="ti" id="qm-ys">' +
            '<optgroup label="所测之人">' +
              '<option value="父母长辈（本局年干）">父母长辈（本局年干）</option>' +
              '<option value="兄弟同辈（本局月干）">兄弟同辈（本局月干）</option>' +
              '<option value="子女晚辈（本局时干）">子女晚辈（本局时干）</option>' +
              '<option value="丈夫（庚）">丈夫（庚）</option><option value="妻子（乙）">妻子（乙）</option>' +
            '</optgroup><optgroup label="专项">' +
              '<option value="事业（开门）">事业（开门）</option><option value="求财（生门、戊）">求财（生门、戊）</option>' +
              '<option value="感情婚姻（六合、乙、庚）">感情婚姻（六合、乙、庚）</option>' +
              '<option value="健康疾病（天芮、天心）">健康疾病（天芮、天心）</option>' +
              '<option value="考试文书（景门、丁）">考试文书（景门、丁）</option>' +
              '<option value="寻物失物（本局时干、六合、玄武）">寻物失物（本局时干、六合、玄武）</option>' +
            '</optgroup><optgroup label="指定八门">' +
              '休门 生门 伤门 杜门 景门 死门 惊门 开门'.split(" ").map(function (m) {
                return '<option value="' + m + '">' + m + '</option>';
              }).join("") +
            '</optgroup><optgroup label="指定天干">' +
              '甲乙丙丁戊己庚辛壬癸'.split("").map(function (g) { return '<option value="' + g + '">' + g + '</option>'; }).join("") +
            '</optgroup></select><p class="p-note qm-opt-note">选填。用神只决定阅读焦点，不改变局数星门。</p></div></div>' +
        '<div class="tf-group"><label class="p-switch qm-toggle"><input type="checkbox" id="qm-when-on" /><span>指定起局时间 <i class="qm-help" role="button" tabindex="0" data-note="可选。不指定则以当下时刻起局；复盘已发生的事可指定当时时刻，并在问题中说明。">?</i></span></label>' +
          '<div id="qm-when-fields" style="display:none">' +
            dateTimeHTML("qmt", { dateLabel: "起局日期", timeLabel: "起局时刻" }) +
          '</div><p class="p-note qm-opt-note">选填。带明确问题来问通常取起念当下；复盘往事才指定当时时刻。</p></div>' +
        '<button class="tool-submit" id="qm-start">立即起局</button><div class="p-err" id="qm-err"></div>' +
      '</div></div>' +
      '<div id="qm-result"></div>' +
      aboutDetails("关于奇门遁甲", [
        '<b>两种定局口径</b>：拆补法以节气为君，交节即换、不置闰；置闰法以符头为纲，按正授/超神/接气定局，在芒种、大雪处置闰。同刻两法局数可能不同，盘面会标明本局所用口径。',
        '<b>先定盘</b>：四柱 → 节气与阴阳遁 → 符头三元定局 → 三奇六仪地盘 → 值符值使 → 天盘九星 → 八门 → 八神。',
        '<b>九宫承载多层</b>：每宫同时看地盘干、天盘干、星、门、神，再叠加旬空、驿马、门迫、击刑、入墓等修正。',
        '<b>读盘顺序</b>：先定日干（求测人）与时干（所问之事）落宫，可选用年命或指定用神聚焦；再看宫与宫的生克，最后才讨论应期与行动。'
      ], "奇门为传统时空象征体系，盘面可逐宫复算；不同排盘流派不可直接比高低，解读不替代医疗、法律、财务或人身安全的专业判断。");
    $$(".p-suggest button", stageEl()).forEach(function (b) { b.onclick = function () { pickQuestion(b.dataset.q, "#qm-q"); }; });
    // 三个开关均为可选：关闭时不向后端传对应参数，由引擎用当下时刻 / 日干时干默认取用。
    function toggleOnce(id, fieldId, bind) {
      var t = $("#" + id), f = $("#" + fieldId);
      if (!t || !f) return;
      t.onchange = function () {
        f.style.display = t.checked ? "" : "none";
        if (t.checked && bind) bind();
      };
    }
    var nw = new Date();
    toggleOnce("qm-na-on", "qm-na-fields");
    toggleOnce("qm-ys-on", "qm-ys-fields");
    toggleOnce("qm-when-on", "qm-when-fields", function () {
      if ($("#qmt-date") && !$("#qmt-date").value) {
        dateTimeBind("qmt", { year: nw.getFullYear(), month: nw.getMonth() + 1,
          day: nw.getDate(), hour: nw.getHours(), minute: nw.getMinutes() });
      }
    });
    var METHOD_NOTE = {
      chaibu: "拆补法：交节即换节气，三元由最近符头判定；不置闰，局数可逐宫复算。",
      zhirun: "置闰法：以符头为纲，按正授/超神/接气定局，芒种与大雪处置闰；与拆补法局数可能不同。"
    };
    $$("#qm-method button").forEach(function (b) {
      b.onclick = function () {
        segSet($("#qm-method"), b.dataset.v);
        $("#qm-method-note").textContent = METHOD_NOTE[b.dataset.v] || METHOD_NOTE.chaibu;
      };
    });
    $("#qm-start").onclick = function () {
      var question = $("#qm-q").value.trim();
      if (!question) { toast("请先写下所问之事"); $("#qm-q").focus(); return; }
      $("#qm-err").textContent = "";
      var method = segVal($("#qm-method")) || "chaibu";
      var qs = "method=" + method;
      if ($("#qm-na-on").checked) qs += "&year_na=" + encodeURIComponent($("#qm-na").value);
      if ($("#qm-ys-on").checked && $("#qm-ys").value) qs += "&yongshen=" + encodeURIComponent($("#qm-ys").value);
      var when = "";
      if ($("#qm-when-on").checked) {
        when = dateTimeCollect("qmt").when;
        if (!when) { toast("请选择起局时间"); return; }
        qs += "&when=" + encodeURIComponent(when);
      }
      fetch("/api/qimen/calc?" + qs + "&question=" + encodeURIComponent(question))
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { $("#qm-err").textContent = d.error || "起局失败"; return; }
          var root = $("#qm-result");
          archiveRound(root, question, root.dataset.rk);
          root.innerHTML = renderQimenResult(d);
          // 轮次身份 = 起局时刻 + 定局口径 + 实际局数/状态 + 年命/用神；同问题重新起局会成新一轮
          var qmRk = "qimen|" + d.when + "|" + method + "|" + d.ju_jieqi + d.ju + "|" + d.dingju_state +
            "|" + ($("#qm-na-on").checked ? $("#qm-na").value : "") +
            "|" + ($("#qm-ys-on").checked ? $("#qm-ys").value : "");
          root.dataset.rk = qmRk;
          // 起局时刻必须回传 calc 实际使用的 d.when：否则用户未勾选指定时间时，
          // deduce 会按「此刻」另起一局，AI 解读的盘与屏幕上看到的盘可能不同。
          var lock = "method=" + method +
            ($("#qm-na-on").checked ? "&year_na=" + encodeURIComponent($("#qm-na").value) : "") +
            ($("#qm-ys-on").checked && $("#qm-ys").value ? "&yongshen=" + encodeURIComponent($("#qm-ys").value) : "") +
            "&when=" + encodeURIComponent(d.when || "");
          // v126：局盘数据存进 Board 对象（真相源），DOM 只是投影。
          putBoard("qimen", qmRk, d, { lock: lock, method: method }, d.when);
          $("#qm-ask").onclick = function () {
            var q = $("#qm-q").value.trim();
            if (!q) { toast("请先写下所问之事"); return; }
            if (q !== question) { toast("问题已更改，请重新起局"); return; }
            if (requireLogin()) return;
            streamAI("qimen", lock + "&q=" + encodeURIComponent(q) + authParam(), q, root, root.dataset.rk);
          };
          root.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }).catch(function (e) {
          warn("奇门起局请求失败", e);
          $("#qm-err").textContent = "起局失败：网络或服务异常，请重试";
        });
    };
    applyGate("qimen");
  }
  function renderQimenResult(boardData) {
    return qmBoardView(boardData) +
      '<div class="bz-ask"><div class="bz-ask-h">就这一局提问<span>局数星门已锁定，问题只决定阅读焦点</span></div>' +
        '<button class="tool-ai" id="qm-ask">AI 解盘</button></div>';
  }
  /* v126：奇门盘面投影（纯函数）——从 Board.data 重建九宫盘，归档/快照走它。 */
  function qmBoardView(boardData) {
    // 洛书九宫展示顺序：4 9 2 / 3 5 7 / 8 1 6
    var order = [4, 9, 2, 3, 5, 7, 8, 1, 6];
    var byGong = {}; (boardData.palaces || []).forEach(function (palace) { byGong[palace.gong] = palace; });
    var cells = order.map(function (gong) {
      var palace = byGong[gong] || {};
      return '<div class="qm-cell' + (palace.xunkong ? ' kong' : '') + '">' +
        '<div class="qm-c-h"><b>' + esc(palace.name || "") + '</b><span>' + esc(palace.dir || "") + '</span></div>' +
        '<div class="qm-c-main"><span class="qm-c-tg">' + esc(palace.tiangan || "—") + '</span><i>天</i>' +
          '<span class="qm-c-dg">' + esc(palace.digan || "—") + '</span><i>地</i></div>' +
        '<div class="qm-c-row"><b>' + esc(palace.star || "—") + '</b><span>' + esc(palace.door || "—") + '</span></div>' +
        '<div class="qm-c-god">' + esc(palace.god || "—") + '</div>' +
        (palace.note ? '<div class="qm-c-note">' + esc(palace.note) + '</div>' : '') + '</div>';
    }).join("");
    var fourPillars = boardData.sizhu || {};
    return '<div class="p-result">' + resultTitle("奇门遁甲 · 九宫盘") +
      '<div class="p-card"><div class="qm-head">' +
        '<span>四柱 ' + esc([fourPillars.year, fourPillars.month, fourPillars.day, fourPillars.hour].join(" ")) + '</span>' +
        '<span>' + esc(boardData.jieqi || "") + ' · ' + esc(boardData.yinyang || "") + esc(boardData.ju || "") + '局 · ' + esc(boardData.yuan || "") +
          (boardData.method === 'zhirun' ? ' · 置闰法' + (boardData.dingju_state ? '（' + esc(boardData.dingju_state) + '）' : '') : ' · 拆补法') + '</span>' +
        '<span>值符 ' + esc(boardData.zhi_fu || "") + ' · 值使 ' + esc(boardData.zhi_shi || "") + '</span></div>' +
        (boardData.focus && (boardData.focus.year_na || boardData.focus.yongshen)
          ? '<div class="qm-focus">' +
            (boardData.focus.year_na ? '<span>年命 <b>' + esc(boardData.focus.year_na.ganzhi) + '</b> 寄' +
              esc(boardData.focus.year_na.gong ? boardData.focus.year_na.gong + '宫' : '—') +
              (boardData.focus.year_na.palace ? '（' + esc(boardData.focus.year_na.palace) + '）' : '') + '</span>' : '') +
            (boardData.focus.yongshen ? '<span>用神 <b>' + esc(boardData.focus.yongshen.name) + '</b>' +
              (boardData.focus.yongshen.gong ? ' 落' + esc(boardData.focus.yongshen.gong) + '宫（' + esc(boardData.focus.yongshen.palace) + '）' : '') + '</span>' : '') +
            '</div>' : '') +
        '<div class="qm-grid">' + cells + '</div>' +
      '</div></div>';
  }
  BOARD_VIEWS.qimen = qmBoardView;

  /* ---------------- 启动 ---------------- */
  // 盘面事实不再对用户展开：所有功能由引擎确定性运算保证正确，结果区只展示可读盘面。
  window.addEventListener("hashchange", function () {
    navigate(parseHash());
  });
  $("#p-navlist").addEventListener("click", function (e) {
    var btn = e.target.closest(".p-navitem");
    if (btn) { e.preventDefault(); go(btn.dataset.feature); }
  });
  // 移动端抽屉：汉堡开合 / 遮罩关闭 / Esc 关闭
  var burger = $("#p-burger");
  if (burger) burger.onclick = toggleNav;
  var navMask = $("#p-nav-mask");
  if (navMask) navMask.onclick = closeNav;
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeNav();
  });
  // 桌面↔移动切换时清掉残留的抽屉状态
  window.addEventListener("resize", function () {
    if (window.innerWidth > 900) closeNav();
  });
  /* iOS Safari 聚焦字号 < 16px 的输入框会自动放大整页。提问框按卡片层级用 14px，
     因此在手指按下（聚焦之前）临时提到 16px，失焦后再还原：既不缩放页面，也不牺牲字号层级 */
  (function () {
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (!isIOS) return;
    document.addEventListener("touchstart", function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains("ti")) t.style.fontSize = "16px";
    }, true);
    document.addEventListener("focusout", function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains("ti")) t.style.fontSize = "";
    }, true);
  })();
  $("#p-theme").onclick = function () {
    var cur = document.documentElement.dataset.theme;
    var next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("zw-theme", next); } catch (e) { warn("保存主题偏好失败", e); }
  };
  $("#p-modal-x").onclick = function () { $("#p-modal").classList.add("hidden"); };
  $("#p-modal").addEventListener("click", function (e) { if (e.target === this) this.classList.add("hidden"); });

  /* ================= 管理员（口令存内存，不落盘；只看用户名与运行日志，不看任何对话内容） ================= */
  var adminKey = "", adminTab = "users";
  function adminHeaders() { return { "x-admin-key": adminKey }; }
  function openAdmin() {
    var modal = $("#p-admin-modal"), box = $("#p-admin-content");
    modal.classList.remove("hidden");
    if (adminKey) { adminPanel(); return; }
    box.innerHTML = '<div class="ad-login"><h3>管理员登录</h3>' +
      '<p class="p-note pf-hint">管理入口仅用于账号管理与运行日志，不提供任何用户对话内容的查看。</p>' +
      '<div class="tf-field"><label>管理员口令</label><input class="ti" type="password" id="admin-key-in" placeholder="输入管理员口令" /></div>' +
      '<button class="tool-submit" type="button" id="admin-login-btn" style="width:100%;margin-top:12px">进入管理台</button></div>';
    $("#admin-login-btn").onclick = function () {
      var k = (($("#admin-key-in") || {}).value || "").trim();
      if (!k) { toast("请输入管理员口令"); return; }
      fetch("/api/admin/list", { headers: { "x-admin-key": k } })
        .then(function (r) { if (!r.ok) throw new Error("口令不正确"); return r.json(); })
        .then(function (d) {
          if (!d.ok) throw new Error("口令不正确");
          adminKey = k; adminPanel();
        }).catch(function (e) { toast(e.message || "验证失败"); });
    };
    var ki = $("#admin-key-in");
    if (ki) ki.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); $("#admin-login-btn").click(); } };
  }
  function adminPanel() {
    var box = $("#p-admin-content");
    box.innerHTML = '<div class="ad-head"><h3>管理台</h3>' +
      '<div class="ad-tabs">' +
        '<button class="ad-tab' + (adminTab === "users" ? " on" : "") + '" data-tab="users">用户管理</button>' +
        '<button class="ad-tab' + (adminTab === "logs" ? " on" : "") + '" data-tab="logs">运行日志</button>' +
      '</div><button class="ad-logout" id="admin-logout">退出</button></div>' +
      '<div id="admin-pane"><p class="p-note">加载中…</p></div>';
    $$(".ad-tab", box).forEach(function (b) {
      b.onclick = function () { adminTab = b.dataset.tab; adminPanel(); };
    });
    $("#admin-logout").onclick = function () { adminKey = ""; openAdmin(); };
    if (adminTab === "users") adminLoadUsers(); else adminLoadLogs();
  }
  function adminLoadUsers() {
    var pane = $("#admin-pane");
    fetch("/api/admin/list", { headers: adminHeaders() })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { pane.innerHTML = '<p class="p-note">加载失败</p>'; return; }
        var rows = (d.users || []).map(function (u) {
          return '<div class="ad-user"><div class="ad-user-info"><b>' + esc(u.name) + '</b>' +
            '<span>注册于 ' + esc(u.created) + '</span></div>' +
            '<button class="ad-del" data-name="' + esc(u.name) + '">删除</button></div>';
        }).join("") || '<p class="p-note">暂无用户</p>';
        pane.innerHTML = '<p class="p-note pf-hint">共 ' + (d.users || []).length + ' 位用户；仅显示用户名与注册时间，不含任何对话或出生信息。</p>' +
          '<div class="ad-users">' + rows + '</div>';
        $$(".ad-del", pane).forEach(function (b) {
          b.onclick = function () {
            if (!b.classList.contains("arm")) {
              b.classList.add("arm"); b.textContent = "确认删除?";
              setTimeout(function () { b.classList.remove("arm"); b.textContent = "删除"; }, 4000);
              return;
            }
            fetch("/api/admin/delete", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
              body: JSON.stringify({ name: b.dataset.name })
            }).then(function (r) { return r.json(); }).then(function (d) {
              if (!d.ok) { toast(d.error || "删除失败"); return; }
              adminLoadUsers(); toast("已删除用户");
            }).catch(function () { toast("删除失败"); });
          };
        });
      }).catch(function () { pane.innerHTML = '<p class="p-note">加载失败</p>'; });
  }
  function adminLoadLogs() {
    var pane = $("#admin-pane");
    fetch("/api/admin/logs?limit=200", { headers: adminHeaders() })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { pane.innerHTML = '<p class="p-note">加载失败</p>'; return; }
        var rows = (d.items || []).map(function (x) {
          var cls = x.status >= 500 ? "err" : (x.status >= 400 ? "warn" : "");
          return '<div class="ad-log ' + cls + '"><span class="ad-log-ts">' + esc(x.ts) + '</span>' +
            '<span class="ad-log-m">' + esc(x.method) + '</span>' +
            '<span class="ad-log-p">' + esc(x.path) + '</span>' +
            '<span class="ad-log-s">' + esc(x.status) + '</span>' +
            '<span class="ad-log-t">' + x.ms + 'ms</span></div>';
        }).join("") || '<p class="p-note">暂无日志</p>';
        pane.innerHTML = '<p class="p-note pf-hint">仅记录访问方法与脱敏路径，已过滤问题、密码、出生信息等全部对话相关内容。</p>' +
          '<div class="ad-logs">' + rows + '</div>';
      }).catch(function () { pane.innerHTML = '<p class="p-note">加载失败</p>'; });
  }
  $("#p-admin-link").onclick = openAdmin;
  $("#p-admin-x").onclick = function () { $("#p-admin-modal").classList.add("hidden"); };
  $("#p-admin-modal").addEventListener("click", function (e) { if (e.target === this) this.classList.add("hidden"); });

  // 解读卡点卡头收起/展开（事件委托，切页后仍有效）：归档卡默认收起 → p-ai-open 展开；
  // 当前卡与追问子卡默认展开 → p-ai-folded 收起。两类卡同一交互规则。
  document.addEventListener("click", function (e) {
    var h = e.target.closest && e.target.closest(".p-ai > .p-ai-head");
    if (!h || !h.parentElement) return;
    var card = h.parentElement;
    if (card.classList.contains("p-ai-archived")) card.classList.toggle("p-ai-open");
    else card.classList.toggle("p-ai-folded");
  });
  // 「关于本功能」开合：委托到 document，页面重渲染后依然有效
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".ad-toggle");
    if (!b || !b.parentElement) return;
    var box = b.parentElement;
    if (!box.classList.contains("about-details")) return;
    var body = box.querySelector(".ad-body");
    if (!body) return;
    var open = !box.classList.contains("open");
    box.classList.toggle("open", open);
    b.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) setTimeout(function () { body.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, 40);
  });

  // 全站会话同步：内嵌紫微服务内登录/退出会写 zw-profile，此处实时跟随（写入方自身不触发 storage，故不自激）
  window.addEventListener("storage", function (e) {
    if (e.key !== "zw-profile") return;
    var p = null;
    try { p = e.newValue ? JSON.parse(e.newValue) : null; } catch (err) { warn("跨标签页登录态解析失败，忽略本次同步", err); }
    if (JSON.stringify(p) === JSON.stringify(S.profile)) return;
    var wasLogged = !!S.profile;
    S.profile = p && p.id && p.token ? { id: p.id, token: p.token, name: p.name } : null;
    var changed = wasLogged !== !!S.profile;
    if (changed) {
      if (!S.profile) clearUserData();   // 他处退出：同步清空本地缓存
      else dropStages();                  // 他处登录：清掉未登录态舞台，避免残留门禁
    }
    renderUser();
    // 同步视图：个人中心刷新统计；登录态切换时强制重建当前页（含门禁 / 档案带入）
    if (changed && S.feature === "profile") renderProfile();
    else if (changed) navigate(S.feature, true);
  });

  renderUser();
  loadProfileBirth();   // localStorage 恢复的登录态没走 setProfile，这里补加载档案出生资料
  var init = parseHash();
  // 品牌区点击返回首页
  var brand = $(".p-brand");
  if (brand) {
    brand.setAttribute("role", "link");
    brand.setAttribute("tabindex", "0");
    brand.style.cursor = "pointer";
    brand.title = "返回首页";
    var goHome = function () { go("home"); };
    brand.addEventListener("click", goHome);
    brand.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); } });
  }
  navigate(init);
})();
