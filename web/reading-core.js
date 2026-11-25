/*
 * reading-core.js — AI 解读统一对象模型（v116 重构）
 *
 * 职责：把「一次 AI 解读」建模为 Reading 对象，由 ReadingSession 统一管理
 * 当前轮 / 归档轮 / 追问链 / 去重身份 / 会话快照。纯数据层，不碰 DOM、不发请求，
 * 可在 node 下独立单测（tests/js/test_reading_core.js）。
 *
 * 为什么要有这一层：
 *   重构前「什么是当前轮、是否已解读、追问挂给谁」散落在 DOM 的 dataset.rk /
 *   data-hid / data-archQ 里，11 个功能各拼一份 rk，去重和归档靠扫 DOM 文本。
 *   六爻「所见非所解」就是状态与展示脱节的恶果。现在对象模型是唯一真相源，
 *   DOM 属性只是它的渲染投影（写出去给 CSS/E2E 用，读状态一律问对象）。
 *
 * 新增功能：在 FEATURES 加一行声明（选择器 + 追问提示），解读链路零改动。
 * 盘面渲染因功能而异，仍由 portal.js 的 renderXxx 负责——那是视图，不是状态。
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReadingCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ============ 功能注册表：新增功能 = 加一行 ============
   * root     = 盘面结果根容器（换盘/归档锚点）
   * qbox     = 该功能提问输入框
   * out      = AI 解读卡容器；留空表示与 root 同容器
   * note     = 追问提示文案（原 followNote 的散表收进这里）
   * arity    = 参与人数：1=单人，2=双人合婚/择日（决定 Reading.persons 长度）
   * needsBirth = 该功能的盘面是否由出生资料决定（决定对话要不要导入 Person 信息）
   */
  var FEATURES = {
    bazi: {
      name: "八字", root: "#bz-result", qbox: "#bz-q", out: "#bz-ai-out", arity: 1, needsBirth: true,
      note: "追问会沿用这一次的八字盘，不会重新排盘"
    },
    meihua: {
      name: "梅花", root: "#mh-result", qbox: "#mh-q", out: "", arity: 1, needsBirth: false,
      note: "追问会沿用这一次的卦象，不会重新起卦"
    },
    tarot: {
      name: "塔罗", root: "#tr-result", qbox: "#tr-q", out: "", arity: 1, needsBirth: false,
      note: "追问会沿用这一次的牌阵与抽牌结果，不会重新抽牌"
    },
    huangli: {
      name: "老黄历", root: "#hl-result", qbox: "#hl-q", out: "", arity: 1, needsBirth: false,
      note: "追问会沿用这一次的黄历信息，不会重新查询"
    },
    huangli_pair: {
      name: "双人择日", root: "#hl-result", qbox: "#hl-q", out: "", arity: 2, needsBirth: true,
      note: "追问会沿用这一天与双方八字，不会重新查询"
    },
    ziwei: {
      name: "紫微", root: "#zw-result", qbox: "#zw-q", out: "#zw-ai-out", arity: 1, needsBirth: true,
      note: "追问会沿用这一次的命盘，不会重新排盘"
    },
    astrology: {
      name: "占星", root: "#as-result", qbox: "#as-q", out: "#as-ai-out", arity: 1, needsBirth: true,
      note: "追问会沿用这一次的本命盘，不会重新排盘"
    },
    bazi_marriage: {
      name: "八字合婚", root: "#bzm-result", qbox: "#bzm-q2", out: "#bzm-ai-out", arity: 2, needsBirth: true,
      note: "追问会沿用这一次的双人四柱，不会重新排盘"
    },
    ziwei_marriage: {
      name: "紫微合婚", root: "#zm-result", qbox: "#zm-q2", out: "#zm-ai-out", arity: 2, needsBirth: true,
      note: "追问会沿用这一次的双人命盘，不会重新排盘"
    },
    astrology_marriage: {
      name: "占星合盘", root: "#asm-result", qbox: "#asm-q2", out: "#asm-ai-out", arity: 2, needsBirth: true,
      note: "追问会沿用这一次的双人合盘，不会重新排盘"
    },
    liuyao: {
      name: "六爻", root: "#ly-result", qbox: "#ly-q", out: "", arity: 1, needsBirth: false,
      note: "追问会沿用这一次的卦象，不会重新起卦"
    },
    qimen: {
      name: "奇门", root: "#qm-result", qbox: "#qm-q", out: "", arity: 1, needsBirth: false,
      note: "追问会沿用这一次的局，不会重新起局"
    }
  };
  Object.freeze(FEATURES);

  function def(feature) { return FEATURES[feature] || null; }

  function outSel(feature) {
    var d = def(feature);
    return d ? (d.out || d.root) : "";
  }

  function now() {
    try { return new Date().toISOString(); } catch (e) { return String(Date.now()); }
  }

  function normalizeFollowup(f) {
    f = f || {};
    return {
      id: f.id || 0,
      question: f.question || "",
      answer: f.answer || "",
      ts: f.ts || ""
    };
  }

  /* ============ Person：用户对象（对话参与人的信息快照） ============
   * 后端档案是用户的真相源；这里的 Person 是「这次解读用到的那个人」的冻结快照。
   * 为什么要快照：追问发生在几分钟后，若用户中途改了出生资料，追问必须沿用解读
   * 当时的信息，否则结论前后矛盾。双人功能持有两个 Person（本人 + 对方）。
   * role: "self" | "partner"
   */
  function Person(o) {
    o = o || {};
    this.role = o.role || "self";
    this.name = o.name || "";
    this.gender = o.gender || "";
    this.birth = o.birth ? normalizeBirth(o.birth) : null;   // 出生资料（含经纬度时区）
    this.memory = o.memory || "";                            // 个人记忆文本（个性化注入）
    this.profileId = o.profileId || 0;                       // 档案 id（登录后本人）
  }

  function normalizeBirth(b) {
    return {
      year: b.year || "", month: b.month || "", day: b.day || "",
      hour: b.hour != null ? b.hour : "", minute: b.minute != null ? b.minute : "",
      calendar: b.calendar || "solar",
      lat: b.lat != null ? b.lat : "", lon: b.lon != null ? b.lon : "", tz: b.tz || "",
      place: b.place || ""
    };
  }

  Person.prototype.hasBirth = function () {
    return !!(this.birth && this.birth.year && this.birth.month && this.birth.day);
  };

  Person.prototype.toJSON = function () {
    return {
      role: this.role, name: this.name, gender: this.gender,
      birth: this.birth ? normalizeBirth(this.birth) : null,
      memory: this.memory, profileId: this.profileId
    };
  };

  Person.fromJSON = function (o) { return new Person(o); };

  /* ============ Reading：一次 AI 解读 ============ */
  function Reading(o) {
    o = o || {};
    this.id = o.id || 0;                         // 后端 history id，落盘后才有
    this.feature = o.feature || "";
    this.question = o.question || "";
    this.rk = o.rk || "";                        // 确定性结果身份（问题 + 盘面）
    this.answer = o.answer || "";                // markdown 正文（含系统免责）
    this.followups = [];                         // [{id, question, answer, ts}]
    this.persons = [];                           // Person[]：参与人快照（单人 1，双人 2）
    this.status = o.status === "archived" ? "archived" : "active";
    this.ts = o.ts || "";
    var src = o.followups || [];
    for (var i = 0; i < src.length; i++) this.followups.push(normalizeFollowup(src[i]));
    var ps = o.persons || [];
    for (var j = 0; j < ps.length; j++) this.persons.push(Person.fromJSON(ps[j]));
  }

  Reading.prototype.person = function (role) {
    for (var i = 0; i < this.persons.length; i++) {
      if (this.persons[i].role === role) return this.persons[i];
    }
    return null;
  };

  /* 同一轮 = 问题文本【且】确定性身份严格相等；换卦/换牌/换日期即不同轮 */
  Reading.prototype.isSameRound = function (question, rk) {
    return this.question === question && this.rk === rk;
  };

  Reading.prototype.addFollowup = function (question, answer, id) {
    var f = normalizeFollowup({ question: question, answer: answer, id: id, ts: now() });
    this.followups.push(f);
    return f;
  };

  Reading.prototype.toJSON = function () {
    var fus = [];
    for (var i = 0; i < this.followups.length; i++) {
      var f = this.followups[i];
      fus.push({ id: f.id, question: f.question, answer: f.answer, ts: f.ts });
    }
    var persons = [];
    for (var k = 0; k < this.persons.length; k++) persons.push(this.persons[k].toJSON());
    return {
      id: this.id, feature: this.feature, question: this.question, rk: this.rk,
      answer: this.answer, followups: fus, persons: persons, status: this.status, ts: this.ts
    };
  };

  Reading.fromJSON = function (o) { return new Reading(o); };

  /* ============ ReadingSession：一个功能（或紫微的一个输出槽）的解读集合 ============ */
  function ReadingSession(feature, slot) {
    this.feature = feature || "";
    this.slot = slot || "";                      // 紫微命格盘/运势盘两个输出用不同 slot
    this.current = null;                         // Reading|null 当前未归档轮
    this.archived = [];                          // Reading[] 最新在前
    this.busy = false;                           // 是否有流在写 current
    this.lastQ = "";                             // 当前盘面上一次问的问题（归档标题用）
    this.boardRk = "";                           // 当前盘面身份（换盘时更新）
  }

  ReadingSession.prototype.all = function () {
    var out = [];
    if (this.current) out.push(this.current);
    for (var i = 0; i < this.archived.length; i++) out.push(this.archived[i]);
    return out;
  };

  /* 查已解读：归档轮优先（最新在前），再当前轮。
     rk 非空 → 严格按 question + rk（换卦/换牌/换日期是不同轮）；
     rk 为空 → 模板问题定位，只按 question 跨所有轮匹配。 */
  ReadingSession.prototype.find = function (question, rk) {
    function hit(r) {
      if (r.question !== question) return false;
      return !rk || r.rk === rk;
    }
    for (var i = 0; i < this.archived.length; i++) {
      if (hit(this.archived[i])) return { reading: this.archived[i], archived: true };
    }
    if (this.current && hit(this.current)) return { reading: this.current, archived: false };
    return null;
  };

  ReadingSession.prototype.findById = function (hid) {
    var all = this.all();
    for (var i = 0; i < all.length; i++) if (all[i].id === hid) return all[i];
    return null;
  };

  /* 开始新一轮：创建 current 并标记 streaming。调用方负责先归档旧轮。
     persons 是参与人快照（单人或双人），解读与追问都冻结在这一份上。 */
  ReadingSession.prototype.begin = function (question, rk, persons) {
    this.current = new Reading({ feature: this.feature, question: question, rk: rk, persons: persons });
    this.busy = true;
    this.lastQ = question;
    this.boardRk = rk || "";
    return this.current;
  };

  ReadingSession.prototype.finish = function (id, answer) {
    this.busy = false;
    if (this.current) {
      if (id) this.current.id = id;
      this.current.answer = answer || "";
    }
    return this.current;
  };

  /* 归档当前轮：移到 archived 顶部，清 current */
  ReadingSession.prototype.archive = function () {
    if (!this.current) return null;
    var r = this.current;
    r.status = "archived";
    this.archived.unshift(r);
    this.current = null;
    this.busy = false;
    return r;
  };

  ReadingSession.prototype.setBoard = function (question, rk) {
    this.lastQ = question || "";
    this.boardRk = rk || "";
  };

  ReadingSession.prototype.toJSON = function () {
    var arcs = [];
    for (var i = 0; i < this.archived.length; i++) arcs.push(this.archived[i].toJSON());
    return {
      feature: this.feature, slot: this.slot,
      current: this.current ? this.current.toJSON() : null,
      archived: arcs, busy: false,               // 快照恢复时不可能是 streaming
      lastQ: this.lastQ, boardRk: this.boardRk
    };
  };

  ReadingSession.fromJSON = function (o) {
    o = o || {};
    var s = new ReadingSession(o.feature, o.slot);
    s.current = o.current ? Reading.fromJSON(o.current) : null;
    var arcs = o.archived || [];
    for (var i = 0; i < arcs.length; i++) s.archived.push(Reading.fromJSON(arcs[i]));
    s.lastQ = o.lastQ || "";
    s.boardRk = o.boardRk || "";
    return s;
  };

  /* ============ 会话仓库：feature+slot → ReadingSession ============ */
  var _sessions = Object.create(null);

  function key(feature, slot) { return feature + "|" + (slot || ""); }

  function session(feature, slot) {
    var k = key(feature, slot);
    if (!_sessions[k]) _sessions[k] = new ReadingSession(feature, slot);
    return _sessions[k];
  }

  function drop(feature, slot) { delete _sessions[key(feature, slot)]; }

  function clearAll() { _sessions = Object.create(null); }

  /* 快照按功能序列化（含该功能所有 slot），与 portal.js 的 per-feature snapKey 对齐 */
  function serializeFeature(feature) {
    var out = {};
    Object.keys(_sessions).forEach(function (k) {
      var s = _sessions[k];
      if (s.feature === feature) out[k] = s.toJSON();
    });
    return out;
  }

  function restoreFeature(map) {
    Object.keys(map || {}).forEach(function (k) {
      _sessions[k] = ReadingSession.fromJSON(map[k]);
    });
  }

  function followNote(feature) {
    var d = def(feature);
    return d ? d.note : "追问会沿用这一次的解读内容，不会重新推演";
  }

  return {
    FEATURES: FEATURES,
    def: def,
    outSel: outSel,
    Person: Person,
    Reading: Reading,
    ReadingSession: ReadingSession,
    session: session,
    drop: drop,
    clearAll: clearAll,
    serializeFeature: serializeFeature,
    restoreFeature: restoreFeature,
    followNote: followNote
  };
});
