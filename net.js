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
    hostSeen: 0,
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
      if (onReady) onReady();
    });
    client.on("reconnect", function () { setStatus("正在重连…"); });
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

  // ---------- 房主 ----------
  function createRoom(name) {
    net.role = "host";
    net.myId = randId();
    net.myName = name || "房主";
    net.room = randCode();
    net.roster = [{ id: net.myId, name: net.myName, bot: false }];
    net.mySeat = 0;
    connect(function () {
      sub(pubTopic());
      publishRoster();
      startHeartbeat();
      showLobby();
    });
  }

  function joinRoom(room, name) {
    net.role = "guest";
    net.myId = randId();
    net.myName = name || "玩家";
    net.room = room.toUpperCase();
    connect(function () {
      sub(pubTopic());
      sub(privTopic(net.myId));
      publish(pubTopic(), { t: "join", id: net.myId, name: net.myName });
      startHeartbeat();
      showLobby();
      var n = 0;
      var timer = setInterval(function () {
        if (net.started || net.role !== "guest") { clearInterval(timer); return; }
        if (++n > 20) { clearInterval(timer); setStatus("找不到这个房间，检查一下房间号？"); return; }
        publish(pubTopic(), { t: "join", id: net.myId, name: net.myName });
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
        if (!net.started) publishRoster();
        else publishState();
      } else {
        if (!net.started) publish(pubTopic(), { t: "join", id: net.myId, name: net.myName });
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
        if (net.started) { publish(privTopic(msg.id), { t: "deny", why: "游戏已经开始了" }); return; }
        if (net.roster.length >= (S.count || 4)) { publish(privTopic(msg.id), { t: "deny", why: "房间满了" }); return; }
        if (!net.roster.some(function (p) { return p.id === msg.id; })) {
          net.roster.push({ id: msg.id, name: (msg.name || "玩家").slice(0, 10), bot: false });
          API.toast((msg.name || "玩家") + " 加入了房间");
        } else {
          net.roster.forEach(function (p) { if (p.id === msg.id) p.name = (msg.name || p.name).slice(0, 10); });
        }
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
        return;
      }
      return;
    }
    // 私有话题
    if (msg.t === "hand") { applyHand(msg); return; }
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
      if (S.turn === seat && S.players[seat].hand.length <= 2) API.callUnoFor(seat);
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
    S.roster = net.roster.map(function (p) { return { name: p.name, bot: !!p.bot }; });
    publishRoster();
    API.startGame(false);
    switchToGame();
    publishState();
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
    net.roster.push({ id: "bot_" + randId(), name: names[used] || ("电脑 " + (used + 1)), bot: true });
    publishRoster();
    renderLobby();
  }

  // ---------- 界面 ----------
  function showLobby() {
    el.home.hidden = true;
    el.game.hidden = true;
    el.lobby.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    el.roomCode.textContent = net.room;
    var link = location.origin + location.pathname + "?room=" + encodeURIComponent(net.room);
    el.shareLink.value = link;
    el.beginBtn.hidden = net.role !== "host";
    el.addBotBtn.hidden = net.role !== "host";
    el.removeBotBtn.hidden = net.role !== "host";
    renderLobby();
  }

  function renderLobby() {
    var host = el.lobbyPlayers;
    if (!host) return;
    host.innerHTML = "";
    net.roster.forEach(function (p, i) {
      var row = document.createElement("div");
      row.className = "lobby-player";
      var dot = document.createElement("span");
      dot.className = "seat-dot";
      dot.textContent = i + 1;
      var nm = document.createElement("span");
      nm.className = "lobby-name";
      nm.textContent = p.name + (p.id === net.myId ? "（你）" : "");
      var tag = document.createElement("span");
      tag.className = "lobby-tag";
      tag.textContent = p.bot ? "电脑" : (i === 0 ? "房主" : "玩家");
      row.appendChild(dot); row.appendChild(nm); row.appendChild(tag);
      if (p.bot && net.role === "host") {
        var del = document.createElement("button");
        del.type = "button"; del.className = "lobby-del"; del.textContent = "\u00d7"; del.title = "移除这个电脑";
        del.addEventListener("click", function () { removeBot(p.id); });
        row.appendChild(del);
      }
      host.appendChild(row);
    });
    for (var k = net.roster.length; k < (S.count || 4); k++) {
      var empty = document.createElement("div");
      empty.className = "lobby-player empty";
      var d2 = document.createElement("span"); d2.className = "seat-dot"; d2.textContent = k + 1;
      var t2 = document.createElement("span"); t2.className = "lobby-name"; t2.textContent = "等待加入…";
      empty.appendChild(d2); empty.appendChild(t2);
      host.appendChild(empty);
    }
    if (net.role === "host") {
      var botCount = net.roster.filter(function (p) { return p.bot; }).length;
      if (el.removeBotBtn) el.removeBotBtn.disabled = botCount === 0;
      if (el.addBotBtn) el.addBotBtn.disabled = net.roster.length >= (S.count || 4);
      setStatus(net.roster.length + " / " + (S.count || 4) + " 人已就位，可以开始了");
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
    }
  }

  window.__NET__ = net;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();