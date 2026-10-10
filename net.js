/* UNO纸牌 — 联机对战（业余无线电风格：公共 MQTT 中转，免注册免服务器） */
(function () {
  "use strict";

  var API = window.__UNO_API__;
  if (!API) { console.warn("net.js: API 未就绪"); return; }
  var S = API.state;

  var PREFIX = "unopaper/v2/";
  var BROKERS = [
    "wss://broker-cn.emqx.io:8084/mqtt",
    "wss://broker.emqx.io:8084/mqtt"
  ];
  var CODE_ALPHABET = "ACDEFGHJKLMNPQRTUVWXY34679";

  var net = {
    client: null,
    room: null,
    role: null,          // "host" | "guest"
    myId: null,
    myName: "",
    mySeat: -1,
    roster: [],
    connected: false,
    started: false,
    lastPub: 0,
    brokerIndex: 0,
    hostSeen: 0, confirmKick: null, chat: [], unread: 0, pending: [],
    pollTimer: null,
    hbTimer: null,
    pending: []
  };

  var el = {};
  function $(id) { return document.getElementById(id); }
  function randId() {
    var s = "";
    for (var i = 0; i < 10; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return s;
  }
  function randCode() {
    var s = "";
    for (var i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return "UNO-" + s;
  }
  function pubTopic() { return PREFIX + net.room + "/pub"; }
  function privTopic(id) { return PREFIX + net.room + "/p/" + id; }
  function now() { return Date.now(); }
  var FUN_NAMES = [
    "摸鱼大师", "手气爆棚", "专坑队友", "UNO女王", "卡牌刺客", "欧皇本皇", "非酋头子", "出牌机器",
    "忘喊UNO", "一手好牌", "摸牌童子", "全场最慢", "躺赢选手", "拆迁队长", "红牌警告", "变色龙先生",
    "压轴大王", "手里没牌", "淡定吃瓜", "炸弹专业户", "运气选手", "就是不出", "抽牌狂魔", "一张都不剩",
    "苟到最后", "反向操作", "默默变大", "全场焦点", "我要蓝色", "见红就慌", "出啥都赢", "划水冠军",
    "天选之子", "卡组玄学", "摸什么来什么", "只想赢一把", "再来一张", "谁先眨眼", "偷偷攒牌", "最后一张牌"
  ];
  var nameBatch = [];
  function shuffleNames() {
    var p = FUN_NAMES.slice();
    for (var i = p.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = p[i]; p[i] = p[j]; p[j] = t; }
    nameBatch = p.slice(0, 6);
    renderNameChips();
  }
  function renderNameChips() {
    var box = $("nameChips"); if (!box) return;
    var cur = (($("nickInput") || {}).value || "").trim();
    box.innerHTML = "";
    nameBatch.forEach(function (nm) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "name-chip"; b.textContent = nm;
      if (cur === nm) b.classList.add("is-on");
      b.addEventListener("click", function () {
        var inp = $("nickInput"); if (!inp) return;
        inp.value = nm;
        try { localStorage.setItem("uno-name", nm); } catch (e) {}
        renderNameChips();
      });
      box.appendChild(b);
    });
  }
  var AV = API.AVATARS || ["cat"];
  function avatarName(i) { var k = AV.length; var n = Math.floor(Number(i) || 0) % k; return AV[n < 0 ? n + k : n]; }
  function savedAvatar() { try { var v = localStorage.getItem("uno-avatar"); return v == null ? 0 : Number(v); } catch (e) { return 0; } }
  function firstFreeAvatar() {
    var used = {};
    net.roster.forEach(function (p) { if (p.avatar != null) used[p.avatar] = 1; });
    for (var i = 0; i < AV.length; i++) if (!used[i]) return i;
    return Math.floor(Math.random() * AV.length);
  }

  // ---------- 连接 ----------
  function connect(onReady) {
    if (net.client) { if (onReady) onReady(); return; }
    var url = BROKERS[net.brokerIndex % BROKERS.length];
    setStatus("正在连接联机服务器…");
    var client = mqtt.connect(url, {
      clientId: "uno_" + randId(),
      clean: true,
      connectTimeout: 9000,
      reconnectPeriod: 4000,
      keepalive: 30
    });
    net.client = client;
    client.on("connect", function () {
      net.connected = true;
      setStatus("已连接");
      setChatStatus("已连接", true);
      flushChat();
      if (onReady) onReady();
    });
    client.on("reconnect", function () { setStatus("正在重连…"); setChatStatus("重连中…", false); });
    client.on("close", function () { net.connected = false; setChatStatus("已断开", false); });
    client.on("offline", function () { net.connected = false; setChatStatus("已离线", false); });
    client.on("error", function (e) {
      console.warn("mqtt error", e && e.message);
      if (!net.connected) {
        net.brokerIndex++;
        try { client.end(true); } catch (err) {}
        net.client = null;
        setTimeout(function () { connect(onReady); }, 600);
      }
    });
    client.on("message", function (topic, payload) {
      var msg;
      try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
      handle(topic, msg);
    });
  }
  function sub(topic) { if (net.client) net.client.subscribe(topic, { qos: 0 }); }
  function publish(topic, obj) { if (net.client) net.client.publish(topic, JSON.stringify(obj), { qos: 0 }); }
  function publishChat(obj) {
    if (!net.client) return;
    net.client.publish(pubTopic(), JSON.stringify(obj), { qos: 1 });
  }

  // ---------- 房主 ----------
  function createRoom(name) {
    net.role = "host";
    net.myId = randId();
    net.myName = name || "房主";
    net.room = randCode();
    net.chat = []; net.unread = 0;
    net.roster = [{ id: net.myId, name: net.myName, bot: false, avatar: savedAvatar(), seen: now() }];
    net.myAvatar = net.roster[0].avatar;
    net.mySeat = 0;
    connect(function () {
      sub(pubTopic());
      publishRoster();
      startHeartbeat();
      showLobby();
    });
  }

  function joinRoom(room, name) {
    // 已经在这个房间里了就直接回大厅，别换身份
    if (net.client && net.room === String(room).toUpperCase()) { net.myName = name || net.myName; showLobby(); return; }
    net.role = "guest";
    net.myId = randId();
    net.myName = name || "玩家";
    net.room = room.toUpperCase();
    net.chat = []; net.unread = 0;
    connect(function () {
      sub(pubTopic());
      sub(privTopic(net.myId));
      net.myAvatar = savedAvatar();
      publish(pubTopic(), { t: "join", id: net.myId, name: net.myName, avatar: net.myAvatar });
      startHeartbeat();
      showLobby();
      var n = 0;
      var timer = setInterval(function () {
        if (net.started || net.role !== "guest") { clearInterval(timer); return; }
        if (++n > 20) { clearInterval(timer); setStatus("找不到这个房间，检查一下房间号？"); return; }
        publish(pubTopic(), { t: "join", id: net.myId, name: net.myName, avatar: net.myAvatar });
      }, 1500);
    });
  }

  function publishRoster() {
    publish(pubTopic(), {
      t: "room", host: net.myId, hostName: net.roster[0] ? net.roster[0].name : net.myName,
      players: net.roster, started: net.started, seats: S.count || 4
    });
  }

  function startHeartbeat() {
    clearInterval(net.hbTimer);
    net.hbTimer = setInterval(function () {
      if (!net.connected) return;
      if (net.role === "host") {
        if (!net.started) {
          var before = net.roster.length;
          net.roster = net.roster.filter(function (p) { return p.bot || p.id === net.myId || (now() - (p.seen || 0)) < 25000; });
          if (net.roster.length !== before) { renderLobby(); API.toast("有人离开了房间"); }
          publishRoster();
        }
        else publishState();
      } else {
        if (!net.started) publish(pubTopic(), { t: "join", id: net.myId, name: net.myName, avatar: net.myAvatar });
        else if (now() - net.hostSeen > 3500) publish(pubTopic(), { t: "sync", id: net.myId });
        if (net.started && now() - net.hostSeen > 20000) setStatus("房主好像掉线了…");
      }
    }, 2500);
  }

  // ---------- 状态广播 ----------
  function publicView() {
    var top = S.discard[S.discard.length - 1];
    return {
      t: "pub", seq: ++net.seq,
      names: S.players.map(function (p) { return p.name; }),
      bots: S.players.map(function (p) { return !!p.bot; }),
      counts: S.players.map(function (p) { return p.hand.length; }),
      turn: S.turn, dir: S.dir, color: S.color,
      deckCount: S.deck.length,
      discardTop: top ? { c: top.c, v: top.v, id: top.id } : null,
      over: !!S.over, winner: S.winnerIndex != null ? S.winnerIndex : null,
      exposed: (S.exposed || []).map(function (x) { return !!x; }),
      unoCalled: (S.unoCalled || []).map(function (x) { return !!x; }),
      challenge: S.challenge ? { by: S.challenge.by, victim: S.challenge.victim, prevColor: S.challenge.prevColor, in: Math.max(0, S.challenge.deadline - Date.now()) } : null,
      reveal: S.reveal ? { seat: S.reveal.seat, guilty: !!S.reveal.guilty, cards: S.reveal.cards } : null,
      scores: S.scores.slice(), round: S.round
    };
  }
  function publishState() {
    if (net.role !== "host" || !net.started) return;
    publish(pubTopic(), publicView());
    net.roster.forEach(function (p, i) {
      if (p.bot || p.id === net.myId) return;
      publish(privTopic(p.id), {
        t: "hand", seq: net.seq,
        cards: S.players[i].hand.map(function (c) { return { c: c.c, v: c.v, id: c.id }; }),
        canPass: !!S.canPass && S.turn === i
      });
    });
  }

  // ---------- 收到消息 ----------
  function handle(topic, msg) {
    net.lastMsg = msg.t;
    if (topic === pubTopic()) {
      if (msg.t === "join" && net.role === "host") {
        // 先判断是不是已经在房间里的人（心跳会反复发 join）
        var known = null;
        net.roster.forEach(function (p) { if (p.id === msg.id) known = p; });
        if (known) {
          known.seen = now();
          var nn = (msg.name || "").slice(0, 10);
          if (nn && nn !== known.name) { known.name = nn; publishRoster(); renderLobby(); }
          return;
        }
        if (net.started) { publish(privTopic(msg.id), { t: "deny", why: "游戏已经开始了" }); return; }
        if (net.roster.length >= (S.count || 4)) { publish(privTopic(msg.id), { t: "deny", why: "房间满了" }); return; }
        var want = (msg.avatar == null) ? -1 : Number(msg.avatar);
        var taken = net.roster.some(function (p) { return p.avatar === want; });
        net.roster.push({ id: msg.id, name: (msg.name || "玩家").slice(0, 10), bot: false, avatar: (want >= 0 && !taken) ? want : firstFreeAvatar(), seen: now() });
        API.toast((msg.name || "玩家") + " 加入了房间");
        publishChat({ t: "chat", id: "sys", mid: "sys-" + now() + "-" + Math.random(), sys: true, name: "系统", text: (msg.name || "玩家") + " 加入了房间" });
        publishRoster();
        renderLobby();
        return;
      }
      if (msg.t === "room") {
        net.hostSeen = now();
        net.roster = msg.players || [];
        net.started = !!msg.started;
        if (net.role === "guest") {
          var idx = net.roster.map(function (p) { return p.id; }).indexOf(net.myId);
          net.mySeat = idx;
          if (idx === -1 && !msg.started) setStatus("房间满了，或者被移出了");
        }
        renderLobby();
        if (net.started && S.mode === "net") switchToGame();
        return;
      }
      if (msg.t === "pub") {
        net.pubCount = (net.pubCount || 0) + 1; net.pubSeq = msg.seq; net.hostSeen = now();
        if (net.role !== "guest") return;
        net.started = true;
        applyPublic(msg);
        return;
      }
      if (net.role === "host" && (msg.t === "act" || msg.t === "profile" || msg.t === "sync")) {
        net.roster.forEach(function (p) { if (p.id === msg.id) p.seen = now(); });
      }
      if (msg.t === "profile" && net.role === "host") {
        net.roster.forEach(function (p) { if (p.id === msg.id && !p.bot && msg.avatar != null) p.avatar = Number(msg.avatar); });
        publishRoster();
        return;
      }
      if (msg.t === "chat") {
        if (msg.mid) {
          net.seenChat = net.seenChat || {};
          if (net.seenChat[msg.mid]) return;
          net.seenChat[msg.mid] = 1;
          var keys = Object.keys(net.seenChat);
          if (keys.length > 200) delete net.seenChat[keys[0]];
        }
        if (!msg.sys && msg.id === net.myId) return;
        addChat(msg.name || "玩家", msg.text || "", false, !!msg.sys);
        return;
      }
      if (msg.t === "sync" && net.role === "host") {
        publishState();
        return;
      }
      if (msg.t === "act" && net.role === "host") {
        hostApply(msg);
        return;
      }
      if (msg.t === "bye" && net.role === "host") {
        net.roster = net.roster.filter(function (p) { return p.id !== msg.id; });
        publishRoster();
        renderLobby();
        API.toast((msg.name || "一位玩家") + " 离开了");
        publishChat({ t: "chat", id: "sys", mid: "sys-" + now() + "-" + Math.random(), sys: true, name: "系统", text: (msg.name || "一位玩家") + " 离开了房间" });
        return;
      }
      return;
    }
    // 私有话题
    if (msg.t === "hand") { applyHand(msg); return; }
    if (msg.t === "kick") {
      API.toast(msg.why || "你被请出了房间");
      net.started = false;
      leave(true);
      return;
    }
    if (msg.t === "deny") {
      API.toast("无法加入：" + (msg.why || "房间不可用"));
      net.started = false;
      leave(true);
      return;
    }
  }

  // ---------- 客机：把房间状态映射进本地 state ----------
  function applyPublic(msg) {
    net.hostSeen = now();
    var seat = net.mySeat;
    S.mode = "net";
    S.role = "guest";
    S.seat = seat;
    S.round = msg.round || 1;
    S.scores = (msg.scores || []).slice();
    S.dir = msg.dir;
    S.turn = msg.turn;
    S.color = msg.color;
    S.exposed = (msg.exposed || []).map(function (x) { return !!x; });
    S.unoCalled = (msg.unoCalled || []).map(function (x) { return !!x; });
    S.challenge = msg.challenge ? { by: msg.challenge.by, victim: msg.challenge.victim, prevColor: msg.challenge.prevColor, deadline: Date.now() + (msg.challenge.in || 0) } : null;
    S.reveal = msg.reveal ? { seat: msg.reveal.seat, guilty: !!msg.reveal.guilty, cards: msg.reveal.cards || [] } : null;
    S.over = !!msg.over;
    S.winnerIndex = msg.winner;
    var prevHand = (S.players[seat] && S.players[seat].hand) || [];
    S.players = msg.names.map(function (nm, i) {
      var hand = i === seat ? prevHand : new Array(msg.counts[i]).fill(0);
      return { name: nm, hand: hand, bot: !!msg.bots[i] };
    });
    if (!S.players[seat]) { S.players[seat] = { name: net.myName, hand: [], bot: false }; }
    S.deck = new Array(msg.deckCount).fill(0);
    S.discard = msg.discardTop ? [msg.discardTop] : [];
    API.render();
    if (msg.over) showResult(msg.winner, msg.names);
  }
  function applyHand(msg) {
    var seat = net.mySeat;
    if (seat < 0 || !S.players[seat]) return;
    S.players[seat].hand = (msg.cards || []).map(function (c) { return { c: c.c, v: c.v, id: c.id }; });
    S.canPass = !!msg.canPass;
    API.render();
  }

  // ---------- 客机：把操作发给房主 ----------
  function send(action) {
    if (!net.connected) { API.toast("还没连上，稍等一下"); return; }
    publish(pubTopic(), { t: "act", id: net.myId, seat: net.mySeat, action: action });
  }

  // ---------- 房主：执行客机操作 ----------
  function hostApply(msg) {
    if (!net.started || S.over) return;
    var seat = -1;
    net.roster.forEach(function (p, i) { if (p.id === msg.id) seat = i; });
    if (seat < 0) return;
    var a = msg.action || {};
    if (a.type === "uno") {
      if (S.players[seat] && S.players[seat].hand.length <= 2) API.callUnoFor(seat);
      publishState();
      return;
    }
    if (a.type === "catch") {
      API.catchUnoFor(seat, Number(a.target));
      publishState();
      return;
    }
    if (a.type === "challenge") {
      if (S.challenge && Number(S.challenge.victim) === Number(seat)) API.respondChallenge(seat, !!a.yes);
      publishState();
      return;
    }
    if (S.turn !== seat || S.busy) return;
    if (a.type === "play") {
      var card = S.players[seat].hand.filter(function (c) { return String(c.id) === String(a.id); })[0];
      if (!card) return;
      if (S.mode === "net" && !API.canPlay(card)) return;
      API.playCard(seat, card, a.color || null);
      publishState();
      return;
    }
    if (a.type === "draw") { API.humanDrawFor(seat); publishState(); return; }
    if (a.type === "pass") { API.passFor(seat); publishState(); return; }
  }

  // ---------- 开局（房主） ----------
  function beginGame() {
    if (net.role !== "host") return;
    if (net.roster.length < 2) { API.toast("至少两个人（或者加个电脑）才能开局"); return; }
    net.started = true;
    S.mode = "net";
    S.role = "host";
    S.count = net.roster.length;
    S.seat = 0;
    S.roster = net.roster.map(function (p) { return { name: p.name, bot: !!p.bot, avatar: p.avatar, ai: !!p.ai }; });
    publishRoster();
    API.startGame(false);
    switchToGame();
    publishState();
  }

  function kickPlayer(id, name) {
    if (net.role !== "host") return;
    if (id === net.myId) return;
    publish(privTopic(id), { t: "kick", why: "房主把你请出了房间" });
    net.roster = net.roster.filter(function (p) { return p.id !== id; });
    publishRoster();
    renderLobby();
    API.toast("已把 " + (name || "对方") + " 请出房间");
  }
  function addAi() {
    if (net.role !== "host" || net.started) return;
    if (net.roster.length >= (S.count || 4)) { API.toast("人数已经满了"); return; }
    if (!getAiCfg().key) { API.toast("先在「AI 设置」里填 API Key"); openAiModal(); return; }
    var used = net.roster.filter(function (p) { return p.ai; }).length;
    var names = ["AI 小智", "AI 阿丙", "AI 老王"];
    net.roster.push({ id: "ai_" + randId(), name: names[used] || ("AI " + (used + 1)), bot: true, ai: true, avatar: firstFreeAvatar(), seen: now() });
    publishRoster();
    renderLobby();
    API.toast("AI 对手已加入，开局后会调用大模型");
  }
  var AI_PRESETS = [
    { name: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    { name: "DeepSeek", base: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    { name: "月之暗面", base: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
    { name: "智谱GLM", base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
    { name: "通义千问", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
    { name: "硅基流动", base: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct" }
  ];
  function getAiCfg() {
    try { return { base: localStorage.getItem("uno-ai-base") || "", key: localStorage.getItem("uno-ai-key") || "", model: localStorage.getItem("uno-ai-model") || "" }; }
    catch (e) { return { base: "", key: "", model: "" }; }
  }
  function renderAiPresets() {
    var box = $("aiPresets"); if (!box) return;
    box.innerHTML = "";
    AI_PRESETS.forEach(function (pz) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "preset-chip"; b.textContent = pz.name;
      b.addEventListener("click", function () {
        $("aiBase").value = pz.base; $("aiModel").value = pz.model;
        Array.prototype.forEach.call(box.children, function (x) { x.classList.remove("is-on"); });
        b.classList.add("is-on");
      });
      box.appendChild(b);
    });
  }
  function loadAiForm() {
    var c = getAiCfg();
    if ($("aiBase")) $("aiBase").value = c.base;
    if ($("aiKey")) $("aiKey").value = c.key;
    if ($("aiModel")) $("aiModel").value = c.model;
    if ($("aiStatus")) $("aiStatus").textContent = c.key ? "已保存配置 ✓" : "还没配置";
  }
  function removeBot(botId) {
    if (net.role !== "host" || net.started) return;
    var idx = -1;
    if (botId) {
      net.roster.forEach(function (p, i) { if (p.bot && p.id === botId) idx = i; });
    } else {
      for (var i = net.roster.length - 1; i >= 0; i--) { if (net.roster[i].bot) { idx = i; break; } }
    }
    if (idx < 0) return;
    var removed = net.roster[idx].name;
    net.roster.splice(idx, 1);
    API.toast("已移除 " + removed);
    publishRoster();
    renderLobby();
  }
  function addBot() {
    if (net.role !== "host" || net.started) return;
    if (net.roster.length >= (S.count || 4)) { API.toast("人数已经满了"); return; }
    var names = ["电脑 A", "电脑 B", "电脑 C"];
    var used = net.roster.filter(function (p) { return p.bot; }).length;
    net.roster.push({ id: "bot_" + randId(), name: names[used] || ("电脑 " + (used + 1)), bot: true, avatar: firstFreeAvatar(), seen: now() });
    publishRoster();
    renderLobby();
  }

  // ---------- 界面 ----------
  function showLobby() {
    el.home.hidden = true;
    el.game.hidden = true;
    el.lobby.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    el.chatPanel.hidden = false;
    renderChat(); updateBadge();
    el.roomCode.textContent = net.room;
    var link = location.origin + location.pathname + "?room=" + encodeURIComponent(net.room);
    el.shareLink.value = link;
    el.beginBtn.hidden = net.role !== "host";
    el.addBotBtn.hidden = net.role !== "host";
    el.removeBotBtn.hidden = net.role !== "host";
    if (el.addAiBtn === undefined) el.addAiBtn = $("addAiBtn");
    if (el.aiCfgToggle === undefined) el.aiCfgToggle = $("aiConfigToggle");
    if (el.addAiBtn) el.addAiBtn.hidden = net.role !== "host";
    if (el.aiCfgToggle) el.aiCfgToggle.hidden = net.role !== "host";
    renderLobby();
  }

  function renderLobby() {
    var host = el.lobbyPlayers;
    if (!host) return;
    host.innerHTML = "";
    net.roster.forEach(function (p, i) {
      var row = document.createElement("div");
      row.className = "lobby-player";
      var av = document.createElement("img");
      av.className = "avatar lobby-av";
      av.alt = "";
      av.src = "./avatars/" + avatarName(p.avatar) + ".svg";
      if (p.id === net.myId) {
        av.classList.add("mine");
        av.title = "点我换头像";
        av.addEventListener("click", cycleMyAvatar);
      }
      var nm = document.createElement("span");
      nm.className = "lobby-name";
      nm.textContent = p.name;
      var tag = document.createElement("span");
      tag.className = "lobby-tag";
      tag.textContent = p.ai ? "大模型" : (p.bot ? "电脑" : (p.id === net.myId ? "你" : (i === 0 ? "房主" : "玩家")));
      row.appendChild(av); row.appendChild(nm); row.appendChild(tag);
      if (net.role === "host" && p.id !== net.myId) {
        var confirming = !p.bot && net.confirmKick && net.confirmKick.id === p.id && now() < net.confirmKick.until;
        var del = document.createElement("button");
        del.type = "button";
        del.className = "lobby-del" + (confirming ? " confirm" : "");
        del.textContent = confirming ? "踢出?" : "\u00d7";
        del.title = p.bot ? "移除这个电脑" : "把 TA 踢出房间";
        del.addEventListener("click", function () {
          if (p.bot) { removeBot(p.id); return; }
          var hot = net.confirmKick && net.confirmKick.id === p.id && now() < net.confirmKick.until;
          if (!hot) {
            net.confirmKick = { id: p.id, until: now() + 3000 };
            renderLobby();
            setTimeout(function () {
              if (net.confirmKick && net.confirmKick.id === p.id && now() >= net.confirmKick.until) { net.confirmKick = null; renderLobby(); }
            }, 3100);
            return;
          }
          net.confirmKick = null;
          kickPlayer(p.id, p.name);
        });
        row.appendChild(del);
      }
      host.appendChild(row);
    });
    for (var k = net.roster.length; k < (S.count || 4); k++) {
      var empty = document.createElement("div");
      empty.className = "lobby-player empty";
      var d2 = document.createElement("span"); d2.className = "av-placeholder";
      var t2 = document.createElement("span"); t2.className = "lobby-name"; t2.textContent = "等待加入…";
      empty.appendChild(d2); empty.appendChild(t2);
      host.appendChild(empty);
    }
    if (net.role === "host") {
      var botCount = net.roster.filter(function (p) { return p.bot; }).length;
      if (el.removeBotBtn) el.removeBotBtn.disabled = botCount === 0;
      if (el.addBotBtn) el.addBotBtn.disabled = net.roster.length >= (S.count || 4);
      var guests = net.roster.filter(function (p) { return p.id !== net.myId; }).length;
      setStatus(net.roster.length + " / " + (S.count || 4) + " 人已就位，可以开始了" + (guests ? "（点玩家右边的 × 可以把 TA 请出去）" : ""));
    }
  }

  function switchToGame() {
    el.lobby.hidden = true;
    el.home.hidden = true;
    el.game.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showResult(winner, names) {
    var you = winner === net.mySeat;
    el.resultEmoji.textContent = you ? "\uD83C\uDF89" : "\uD83C\uDFC1";
    el.resultTitle.textContent = (names[winner] || "有人") + " 赢下这一局";
    el.resultDetail.textContent = "这局结束了。想再来一局，让房主重新开一局。";
    el.resultOverlay.hidden = false;
    el.againBtn.hidden = true;
  }

  function setChatStatus(text, ok) {
    if (!el.chatStatus) return;
    el.chatStatus.textContent = text;
    el.chatStatus.className = "chat-status" + (ok === true ? " ok" : (ok === false ? " bad" : ""));
  }
  function flushChat() {
    if (!net.pending || !net.pending.length) return;
    var q = net.pending.slice(); net.pending = [];
    q.forEach(function (m) { publishChat(m); });
    setChatStatus("已连接", true);
  }
  function updateBadge() {
    if (!el.chatBadge) return;
    el.chatBadge.textContent = net.unread || 0;
    el.chatBadge.hidden = !net.unread;
  }
  function renderChat() {
    if (!el.chatMessages) return;
    el.chatMessages.innerHTML = "";
    net.chat.forEach(function (m) {
      var d = document.createElement("div");
      d.className = "chat-msg" + (m.mine ? " mine" : "") + (m.sys ? " sys" : "");
      if (m.sys) { d.textContent = m.text; }
      else {
        var w = document.createElement("span"); w.className = "who"; w.textContent = m.name + "：";
        d.appendChild(w); d.appendChild(document.createTextNode(m.text));
      }
      el.chatMessages.appendChild(d);
    });
  }
  function scrollChat() { if (el.chatMessages) el.chatMessages.scrollTop = el.chatMessages.scrollHeight; }
  function addChat(name, text, mine, sys) {
    if (!text) return;
    net.chat.push({ name: name, text: String(text).slice(0, 80), mine: !!mine, sys: !!sys });
    if (net.chat.length > 60) net.chat.shift();
    renderChat();
    var open = el.chatBody && !el.chatBody.hidden;
    if (!open && !mine) { net.unread = (net.unread || 0) + 1; updateBadge(); }
    if (open) scrollChat();
  }
  function sendChat(text, asName) {
    var v = String(text || "").trim();
    if (!v) return;
    var nm = asName || net.myName;
    var mid = net.myId + "-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
    var packet = { t: "chat", id: asName ? "sys" : net.myId, mid: mid, name: nm, text: v.slice(0, 80) };
    if (!net.connected) {
      net.pending = net.pending || [];
      net.pending.push(packet);
      if (net.pending.length > 20) net.pending.shift();
      if (!asName) addChat(nm, v, true);
      setChatStatus("待发送 " + net.pending.length + " 条", false);
      API.toast("还没连上服务器，连上后会自动发出去");
      return;
    }
    publishChat(packet);
    if (!asName) addChat(nm, v, true);
  }
  function cycleMyAvatar() {
    var me = null;
    net.roster.forEach(function (p) { if (p.id === net.myId) me = p; });
    if (!me) return;
    var used = {};
    net.roster.forEach(function (p) { if (p.id !== net.myId && p.avatar != null) used[p.avatar] = 1; });
    var next = (Number(me.avatar) || 0);
    for (var k = 1; k <= AV.length; k++) { var cand = (next + k) % AV.length; if (!used[cand]) { next = cand; break; } }
    me.avatar = next;
    net.myAvatar = me.avatar;
    try { localStorage.setItem("uno-avatar", String(me.avatar)); } catch (e) {}
    if (net.role === "host") publishRoster();
    else publish(pubTopic(), { t: "profile", id: net.myId, avatar: me.avatar });
    renderLobby();
  }
  function openAiModal() {
    loadAiForm();
    if (el.aiModal) el.aiModal.hidden = false;
  }
  function testAi() {
    var c = { base: ($("aiBase").value || "").trim(), key: ($("aiKey").value || "").trim(), model: ($("aiModel").value || "").trim() };
    if (!c.base || !c.key || !c.model) { el.aiStatus.textContent = "三样都要填哦"; return; }
    el.aiStatus.textContent = "测试中…";
    fetch(c.base.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.key },
      body: JSON.stringify({ model: c.model, messages: [{ role: "user", content: "只回复两个字：可以" }] })
    }).then(function (r) { return r.text().then(function (x) { return { ok: r.ok, code: r.status, body: x }; }); })
      .then(function (res) {
        if (res.ok) { el.aiStatus.textContent = "✓ 接口通了，可以用"; API.toast("AI 接口测试成功"); }
        else { el.aiStatus.textContent = "✗ 返回 " + res.code + "：" + String(res.body).slice(0, 70); }
      })
      .catch(function (e) { el.aiStatus.textContent = "✗ 失败了：" + ((e && e.message) ? e.message.slice(0, 60) : "网络/跨域问题"); });
  }
  function setStatus(text) { if (el.lobbyStatus) el.lobbyStatus.textContent = text; }

  function leave(silent) {
    if (!silent && net.connected) publish(pubTopic(), { t: "bye", id: net.myId, name: net.myName });
    clearInterval(net.hbTimer); clearInterval(net.pollTimer);
    if (net.client) { try { net.client.end(true); } catch (e) {} }
    net.client = null; net.connected = false; net.started = false; net.room = null; net.role = null;
    S.role = "local"; S.mode = "bot"; S.seat = 0;
    el.lobby.hidden = true;
    el.home.hidden = false;
    el.game.hidden = true;
    if (el.chatPanel) el.chatPanel.hidden = true;
    net.chat = []; net.unread = 0; renderChat(); updateBadge();
    el.resultOverlay.hidden = true;
    el.againBtn.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function copyLink() {
    var v = el.shareLink.value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).then(function () { API.toast("链接已复制，发给朋友吧"); },
        function () { el.shareLink.select(); document.execCommand("copy"); API.toast("链接已复制"); });
    } else { el.shareLink.select(); document.execCommand("copy"); API.toast("链接已复制"); }
  }

  // ---------- 启动 ----------
  function init() {
    el.home = $("home"); el.game = $("game"); el.lobby = $("lobby");
    el.roomCode = $("lobbyRoomCode"); el.shareLink = $("shareLink"); el.copyLinkBtn = $("copyLinkBtn");
    el.lobbyPlayers = $("lobbyPlayers"); el.lobbyStatus = $("lobbyStatus");
    el.beginBtn = $("beginBtn"); el.addBotBtn = $("addBotBtn"); el.removeBotBtn = $("removeBotBtn"); el.lobbyLeaveBtn = $("lobbyLeaveBtn");
    el.resultOverlay = $("resultOverlay"); el.resultEmoji = $("resultEmoji");
    el.resultTitle = $("resultTitle"); el.resultDetail = $("resultDetail"); el.againBtn = $("againBtn");
    el.nickInput = $("nickInput"); el.roomInput = $("roomInput");
    el.aiModal = $("aiModal"); el.aiStatus = $("aiStatus");
    el.chatPanel = $("chatPanel"); el.chatBody = $("chatBody"); el.chatMessages = $("chatMessages");
    el.chatBadge = $("chatBadge"); el.chatInput = $("chatInput"); el.chatStatus = $("chatStatus");
    var ct = $("chatToggle");
    if (ct) ct.addEventListener("click", function () {
      el.chatBody.hidden = !el.chatBody.hidden;
      if (!el.chatBody.hidden) { net.unread = 0; updateBadge(); scrollChat(); }
    });
    var cc = $("chatClose");
    if (cc) cc.addEventListener("click", function () { el.chatBody.hidden = true; });
    var cf = $("chatForm");
    if (cf) cf.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = (el.chatInput.value || "").trim();
      if (!v) return;
      sendChat(v);
      el.chatInput.value = "";
      el.chatInput.focus();
    });
    var aib = $("addAiBtn");
    if (aib) aib.addEventListener("click", addAi);
    var act2 = $("aiConfigToggle");
    if (act2) act2.addEventListener("click", openAiModal);
    var asb = $("aiSetupBtn");
    if (asb) asb.addEventListener("click", openAiModal);
    var acb = $("aiCloseBtn");
    if (acb) acb.addEventListener("click", function () { if (el.aiModal) el.aiModal.hidden = true; });
    var amd = $("aiModal");
    if (amd) amd.addEventListener("click", function (e) { if (e.target === amd) amd.hidden = true; });
    var asv = $("aiSaveBtn");
    if (asv) asv.addEventListener("click", function () {
      try {
        localStorage.setItem("uno-ai-base", ($("aiBase").value || "").trim());
        localStorage.setItem("uno-ai-key", ($("aiKey").value || "").trim());
        localStorage.setItem("uno-ai-model", ($("aiModel").value || "").trim());
      } catch (e) {}
      if (el.aiStatus) el.aiStatus.textContent = getAiCfg().key ? "已保存 ✓ 只存在你这台设备" : "请填完整";
      API.toast("AI 配置已保存到本机");
      if (API.refreshAiHome) API.refreshAiHome();
    });
    var atb = $("aiTestBtn");
    if (atb) atb.addEventListener("click", testAi);
    renderAiPresets(); loadAiForm();

    $("createRoomBtn").addEventListener("click", function () {
      var nm = (el.nickInput.value || "").trim() || "房主";
      createRoom(nm);
    });
    $("joinRoomBtn").addEventListener("click", function () {
      var rm = (el.roomInput.value || "").trim().toUpperCase();
      if (!rm) { API.toast("先填房间号"); return; }
      if (rm.indexOf("UNO-") !== 0) rm = "UNO-" + rm.replace(/^UNO-?/i, "");
      var nm = (el.nickInput.value || "").trim() || "玩家";
      joinRoom(rm, nm);
    });
    el.copyLinkBtn.addEventListener("click", copyLink);
    el.lobbyLeaveBtn.addEventListener("click", function () { leave(false); });
    el.beginBtn.addEventListener("click", beginGame);
    el.addBotBtn.addEventListener("click", addBot);
    el.removeBotBtn.addEventListener("click", function () { removeBot(null); });

    API.netAction = function (action) { send(action); };
    API.chatSay = function (text, name) { if (net.role) sendChat(text, name || "AI"); };
    API.onQuit = function () { if (net.role) leave(false); };
    API.onRender = function () { if (net.role === "host" && net.started) publishState(); };
    API.onGameEnd = function () { if (net.role === "host" && net.started) publishState(); };

    // 分享链接自动加入
    var m = location.search.match(/[?&]room=([^&]+)/i);
    if (m) {
      var rm = decodeURIComponent(m[1]).toUpperCase();
      el.roomInput.value = rm;
      var seg = document.querySelector('#modeSeg .seg-btn[data-mode="net"]');
      if (seg) { document.getElementById('soloRow').hidden = true; document.getElementById('netRow').hidden = false; }
      var saved = localStorage.getItem("uno-name");
      if (saved) { el.nickInput.value = saved; joinRoom(rm, saved); }
      else {
        API.toast("输入名字后点「加入」进房间 " + rm);
        el.nickInput.focus();
        el.nickInput.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
    if (el.nickInput) {
      el.nickInput.addEventListener("change", function () { localStorage.setItem("uno-name", el.nickInput.value.trim()); });
      el.nickInput.addEventListener("input", function () { renderNameChips(); });
    }
    var shuf = $("shuffleNamesBtn");
    if (shuf) shuf.addEventListener("click", shuffleNames);
    shuffleNames();
  }

  window.__NET__ = net;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();