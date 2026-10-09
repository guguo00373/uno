/* UNO纸牌 — 玩法逻辑 */
(function () {
  "use strict";

  var COLORS = ["red", "yellow", "green", "blue"];
  var COLOR_HEX = { red: "#e23c45", yellow: "#efb02a", green: "#2f9e52", blue: "#2b6fd4" };
  var COLOR_CN = { red: "红色", yellow: "黄色", green: "绿色", blue: "蓝色" };
  var COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
  var VALUE_ORDER = { skip: 10, reverse: 11, draw2: 12, wild: 13, wild4: 14 };

  // ---------------- 音效 ----------------
  var soundOn = true;
  var audioCtx = null;
  function beep(freq, dur, type, gain) {
    if (!soundOn) return;
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audioCtx = new AC();
      }
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = type || "sine";
      o.frequency.value = freq;
      g.gain.value = gain == null ? 0.05 : gain;
      o.connect(g);
      g.connect(audioCtx.destination);
      var t = audioCtx.currentTime;
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t);
      o.stop(t + dur);
    } catch (e) { /* 忽略音频错误 */ }
  }
  var SFX = {
    click: function () { beep(320, 0.08, "triangle", 0.05); },
    play: function () { beep(520, 0.10, "sine", 0.06); },
    draw: function () { beep(240, 0.09, "sawtooth", 0.035); },
    uno: function () { beep(660, 0.16, "square", 0.05); },
    win: function () { beep(523, 0.16, "sine", 0.07); setTimeout(function () { beep(784, 0.24, "sine", 0.07); }, 140); },
    nope: function () { beep(150, 0.14, "sawtooth", 0.05); }
  };

  // ---------------- 牌 ----------------
  var uid = 1;
  function buildDeck() {
    var deck = [];
    COLORS.forEach(function (c) {
      deck.push({ c: c, v: "0", id: uid++ });
      for (var n = 1; n <= 9; n++) {
        deck.push({ c: c, v: String(n), id: uid++ });
        deck.push({ c: c, v: String(n), id: uid++ });
      }
      ["skip", "reverse", "draw2"].forEach(function (v) {
        deck.push({ c: c, v: v, id: uid++ });
        deck.push({ c: c, v: v, id: uid++ });
      });
    });
    for (var i = 0; i < 4; i++) {
      deck.push({ c: "wild", v: "wild", id: uid++ });
      deck.push({ c: "wild", v: "wild4", id: uid++ });
    }
    return deck;
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function cardLabel(card) {
    if (card.v === "wild") return "";
    if (card.v === "wild4") return "+4";
    if (card.v === "skip") return "\u2298";
    if (card.v === "reverse") return "\u21bb";
    if (card.v === "draw2") return "+2";
    return card.v;
  }
  function cardPoints(card) {
    if (card.c === "wild") return 50;
    if (card.v === "skip" || card.v === "reverse" || card.v === "draw2") return 20;
    return Number(card.v);
  }
  function canPlay(card) {
    var top = state.discard[state.discard.length - 1];
    if (!top) return true;
    if (card.c === "wild") return true;
    if (card.c === state.color) return true;
    if (top.c !== "wild" && card.v === top.v) return true;
    return false;
  }
  function sortHand(p) {
    p.hand.sort(function (a, b) {
      var ca = COLOR_ORDER[a.c], cb = COLOR_ORDER[b.c];
      if (ca !== cb) return ca - cb;
      var va = VALUE_ORDER[a.v] != null ? VALUE_ORDER[a.v] : Number(a.v);
      var vb = VALUE_ORDER[b.v] != null ? VALUE_ORDER[b.v] : Number(b.v);
      return va - vb;
    });
  }

  // ---------------- 状态 ----------------
  var state = {
    players: [], deck: [], discard: [], turn: 0, dir: 1, color: null,
    mode: "bot", count: 4, round: 1, scores: [], wins: [], seat: 0, role: "local", roster: null, winnerIndex: null,
    over: true, canPass: false, unoCalled: [], revealed: true,
    busy: false, timer: null, graceTimer: null, graceLeft: 0, botDelay: 780
  };

  function n() { return state.players.length; }
  function idxAfter(from, k) {
    var x = (from + state.dir * k) % n();
    return x < 0 ? x + n() : x;
  }
  function isBot(i) { var p = state.players[i]; return p ? !!p.bot : false; }
  function isHuman(i) { return !isBot(i); }
  function cur() { return state.players[state.turn]; }

  // ---------------- DOM ----------------
  var els = {};
  function $(id) { return document.getElementById(id); }

  // ---------------- 渲染 ----------------
  function cardFaceEl(card) {
    var el = document.createElement("div");
    el.className = "card " + (card.c === "wild" ? "wild" : card.c);
    var label = cardLabel(card);
    var oval = document.createElement("div");
    oval.className = "oval";
    var big = document.createElement("span");
    big.className = "big";
    big.textContent = label;
    oval.appendChild(big);
    el.appendChild(oval);
    if (label) {
      var tl = document.createElement("span"); tl.className = "corner tl"; tl.textContent = label;
      var br = document.createElement("span"); br.className = "corner br"; br.textContent = label;
      el.appendChild(tl); el.appendChild(br);
    }
    return el;
  }
  function cardBackEl() {
    var el = document.createElement("div");
    el.className = "card back";
    var oval = document.createElement("div");
    oval.className = "oval";
    var i = document.createElement("i");
    i.textContent = "UNO";
    oval.appendChild(i);
    el.appendChild(oval);
    return el;
  }

  function bottomIndex() { if (state.mode === "net") return state.seat || 0; return state.mode === "bot" ? 0 : state.turn; }

  function render() {
    renderOpponents();
    renderTable();
    renderHand();
    renderBar();
    if (window.__UNO_API__ && window.__UNO_API__.onRender) window.__UNO_API__.onRender();
  }

  function renderOpponents() {
    var host = els.opponents;
    host.innerHTML = "";
    var bottom = bottomIndex();
    state.players.forEach(function (p, i) {
      if (i === bottom) return;
      var box = document.createElement("div");
      box.className = "opponent" + (i === state.turn && !state.over ? " is-turn" : "");
      var head = document.createElement("div");
      head.className = "opponent-head";
      var left = document.createElement("span");
      left.textContent = p.name;
      var right = document.createElement("span");
      right.className = "card-count";
      right.textContent = p.hand.length + " 张";
      head.appendChild(left);
      head.appendChild(right);
      var hand = document.createElement("div");
      hand.className = "opponent-hand";
      var show = Math.min(p.hand.length, 7);
      for (var k = 0; k < show; k++) hand.appendChild(cardBackEl());
      box.appendChild(head);
      box.appendChild(hand);
      if (p.hand.length === 1) {
        var tag = document.createElement("span");
        tag.className = "opponent-said-uno";
        tag.textContent = "UNO!";
        box.appendChild(tag);
      }
      host.appendChild(box);
    });
  }

  function renderTable() {
    els.deckCount.textContent = state.deck.length;
    els.dirBadge.textContent = state.dir === 1 ? "顺时针" : "逆时针";
    els.roundBadge.textContent = "第 " + state.round + " 局";
    var cb = els.colorBadge;
    if (state.color) {
      cb.textContent = "当前颜色 · " + COLOR_CN[state.color];
      cb.style.background = COLOR_HEX[state.color];
      cb.style.display = "";
    } else {
      cb.style.display = "none";
    }
    els.discard.innerHTML = "";
    var top = state.discard[state.discard.length - 1];
    if (top) {
      var el = cardFaceEl(top);
      el.classList.remove("dim");
      els.discard.appendChild(el);
    }
    var banner = els.turnBanner;
    if (state.over) {
      banner.textContent = "";
      banner.classList.remove("hot");
    } else if (isBot(state.turn)) {
      banner.textContent = cur().name + " 正在想…";
      banner.classList.remove("hot");
    } else if (state.mode === "local") {
      banner.textContent = "轮到 " + cur().name;
      banner.classList.add("hot");
    } else {
      banner.textContent = "轮到你出牌";
      banner.classList.add("hot");
    }
  }

  function renderHand() {
    var host = els.myHand;
    host.innerHTML = "";
    var idx = bottomIndex();
    var p = state.players[idx];
    if (!p) return;
    els.myName.textContent = p.name;
    els.myCount.textContent = p.hand.length + " 张";

    var needReveal = state.mode === "local" && !state.revealed && !state.over;
    if (needReveal) {
      host.classList.remove("tight");
      var cover = document.createElement("div");
      cover.className = "cover";
      var txt = document.createElement("p");
      txt.innerHTML = "轮到 <strong>" + p.name + "</strong>";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "primary-btn";
      btn.id = "revealBtn";
      btn.textContent = "看牌";
      cover.appendChild(txt);
      cover.appendChild(btn);
      host.appendChild(cover);
      return;
    }

    var mine = isHuman(idx) && idx === state.turn && !state.over && !state.busy;
    host.classList.toggle("tight", p.hand.length > 6);
    p.hand.forEach(function (card) {
      var el = cardFaceEl(card);
      var ok = canPlay(card);
      if (mine) {
        el.classList.add(ok ? "playable" : "dim");
        el.dataset.cardId = card.id;
      }
      host.appendChild(el);
    });
  }

  function renderBar() {
    var uno = els.unoBtn;
    var idx = bottomIndex();
    var p = state.players[idx];
    var humanTurn = p && isHuman(idx) && idx === state.turn && !state.over;
    var armed = state.graceTimer && state.graceLeft > 0 && idx === state.turn;
    uno.disabled = !(humanTurn && p.hand.length <= 2);
    uno.classList.toggle("armed", !!armed);
    if (armed) uno.textContent = "UNO! " + state.graceLeft;
    else uno.textContent = "UNO!";
    els.passBtn.hidden = !(state.canPass && humanTurn);
    els.scoreLine.textContent = state.scores.map(function (s, i) {
      return state.players[i].name + " " + s + " 分";
    }).join(" · ");
  }

  // ---------------- 工具 ----------------
  var toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove("show"); }, 1900);
  }
  function log(msg) {
    var d = document.createElement("div");
    d.textContent = msg;
    els.log.appendChild(d);
    while (els.log.children.length > 3) els.log.removeChild(els.log.firstChild);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 3200);
  }

  function ensureDeck() {
    if (state.deck.length) return;
    if (state.discard.length <= 1) return;
    var top = state.discard.pop();
    state.deck = shuffle(state.discard.map(function (c) { return { c: c.c, v: c.v, id: uid++ }; }));
    state.discard = [top];
    log("牌堆用完，重新洗牌");
  }
  function drawTo(p, k) {
    var got = [];
    for (var i = 0; i < k; i++) {
      ensureDeck();
      if (!state.deck.length) break;
      var c = state.deck.pop();
      p.hand.push(c);
      got.push(c);
    }
    if (got.length) sortHand(p);
    return got;
  }

  // ---------------- 出牌 ----------------
  function playCard(pi, card, chosenColor) {
    if (state.over) return;
    var p = state.players[pi];
    var at = p.hand.indexOf(card);
    if (at < 0) return;
    p.hand.splice(at, 1);
    state.discard.push(card);
    state.color = card.c === "wild" ? chosenColor : card.c;
    state.canPass = false;
    if (p.hand.length > 1) state.unoCalled[pi] = false;
    SFX.play();

    if (p.hand.length === 1 && !state.unoCalled[pi]) {
      if (isBot(pi)) {
        state.unoCalled[pi] = true;
        log(p.name + "：UNO！");
      } else {
        startGrace(pi);
      }
    }
    if (p.hand.length === 0) { finish(pi); return; }

    applyEffect(card, pi);
    render();
  }

  function applyEffect(card, pi) {
    if (card.v === "reverse") {
      if (n() === 2) { passTurn(pi, 2); }
      else { state.dir *= -1; passTurn(pi, 1); }
    } else if (card.v === "skip") {
      log(state.players[idxAfter(pi, 1)].name + " 被跳过");
      passTurn(pi, 2);
    } else if (card.v === "draw2") {
      var t2 = idxAfter(pi, 1);
      drawTo(state.players[t2], 2);
      log(state.players[t2].name + " 抽 2 张并停一轮");
      passTurn(pi, 2);
    } else if (card.v === "wild4") {
      var t4 = idxAfter(pi, 1);
      drawTo(state.players[t4], 4);
      log(state.players[t4].name + " 抽 4 张并停一轮");
      passTurn(pi, 2);
    } else {
      passTurn(pi, 1);
    }
  }

  function passTurn(from, steps) {
    state.turn = (from + state.dir * steps + n() * 10) % n();
    afterTurnChange();
  }

  function afterTurnChange() {
    state.canPass = false;
    if (state.mode === "local") state.revealed = isBot(state.turn);
    render();
    maybeScheduleBot();
  }

  function maybeScheduleBot() {
    clearTimeout(state.timer);
    if (state.over) return;
    if (state.role === "guest") return;
    if (!isBot(state.turn)) return;
    state.busy = true;
    render();
    state.timer = setTimeout(function () {
      state.busy = false;
      botMove();
    }, state.botDelay);
  }

  // ---------------- 电脑出牌 ----------------
  function botScore(pi, card) {
    var nextP = state.players[idxAfter(pi, 1)];
    var nextFew = nextP.hand.length <= 2;
    if (card.c === "wild") return card.v === "wild4" ? 12 : 22;
    if (card.v === "draw2") return nextFew ? 72 : 46;
    if (card.v === "skip" || card.v === "reverse") return nextFew ? 66 : 44;
    return 50 + Number(card.v) * 0.4;
  }
  function bestColor(pi, excluding) {
    var counts = { red: 0, yellow: 0, green: 0, blue: 0 };
    state.players[pi].hand.forEach(function (c) {
      if (c === excluding) return;
      if (c.c !== "wild") counts[c.c] += 1;
    });
    var best = "red", bv = -1;
    COLORS.forEach(function (c) { if (counts[c] > bv) { bv = counts[c]; best = c; } });
    return best;
  }
  function botMove() {
    if (state.over) return;
    var pi = state.turn;
    var p = state.players[pi];
    var playable = p.hand.filter(canPlay);
    if (playable.length) {
      var pick = playable[0];
      playable.forEach(function (c) { if (botScore(pi, c) > botScore(pi, pick)) pick = c; });
      playCard(pi, pick, pick.c === "wild" ? bestColor(pi, pick) : null);
      return;
    }
    var got = drawTo(p, 1);
    render();
    if (got.length && canPlay(got[0])) {
      var c = got[0];
      log(p.name + " 抽到一张能打的牌");
      setTimeout(function () {
        if (state.over || state.turn !== pi) return;
        playCard(pi, c, c.c === "wild" ? bestColor(pi, c) : null);
      }, Math.max(60, state.botDelay * 0.7));
      return;
    }
    log(p.name + " 抽了一张，过牌");
    SFX.draw();
    state.turn = idxAfter(pi, 1);
    afterTurnChange();
  }

  // ---------------- 玩家操作 ----------------
  function humanPlay(card) {
    if (state.over || state.busy) return;
    var pi = state.turn;
    if (!isHuman(pi)) return;
    if (state.mode === "local" && !state.revealed) return;
    if (!canPlay(card)) { SFX.nope(); toast("这张牌接不上，换一张或抽牌"); return; }
    if (card.c === "wild") { pendingWild = card; els.colorPicker.hidden = false; return; }
    if (window.__UNO_API__ && window.__UNO_API__.netAction && state.role === "guest") { window.__UNO_API__.netAction({ type: "play", id: card.id, color: null }); return; }
    playCard(pi, card, null);
  }

  var pendingWild = null;

  function humanDraw() {
    if (state.over || state.busy) return;
    var pi = state.turn;
    if (!isHuman(pi)) return;
    if (state.mode === "local" && !state.revealed) return;
    if (window.__UNO_API__ && window.__UNO_API__.netAction && state.role === "guest") { window.__UNO_API__.netAction({ type: "draw" }); return; }
    if (state.canPass) { toast("已经抽过了，打出去或者点「过牌」"); return; }
    var p = state.players[pi];
    var got = drawTo(p, 1);
    SFX.draw();
    render();
    if (!got.length) { toast("牌堆空了"); passTurn(pi, 1); return; }
    var c = got[0];
    if (canPlay(c)) {
      state.canPass = true;
      toast("抽到一张能打的牌，打出去或点「过牌」");
      render();
    } else {
      toast("抽到一张打不出去的牌，轮到下家");
      setTimeout(function () { if (!state.over && state.turn === pi) passTurn(pi, 1); }, 700);
    }
  }

  function startGrace(pi) {
    state.unoCalled[pi] = false;
    state.graceLeft = 5;
    clearInterval(state.graceTimer);
    render();
    state.graceTimer = setInterval(function () {
      state.graceLeft -= 1;
      render();
      if (state.graceLeft <= 0) {
        clearInterval(state.graceTimer);
        state.graceTimer = null;
        if (!state.over && state.players[pi].hand.length === 1 && !state.unoCalled[pi]) {
          drawTo(state.players[pi], 2);
          log(state.players[pi].name + " 忘记喊 UNO，罚抽 2 张");
          toast("忘记喊 UNO，罚抽 2 张");
          SFX.nope();
          state.unoCalled[pi] = false;
          render();
        }
      }
    }, 1000);
  }

  function callUno() {
    var pi = state.turn;
    if (state.over) return;
    if (!isHuman(pi)) return;
    var p = state.players[pi];
    if (p.hand.length > 2) { toast("牌还多着呢"); return; }
    if (window.__UNO_API__ && window.__UNO_API__.netAction && state.role === "guest") { window.__UNO_API__.netAction({ type: "uno" }); return; }
    state.unoCalled[pi] = true;
    clearInterval(state.graceTimer);
    state.graceTimer = null;
    state.graceLeft = 0;
    SFX.uno();
    toast("UNO！");
    log(p.name + " 喊了 UNO！");
    render();
  }

  // ---------------- 联机：房主代客机执行 ----------------
  function drawForSeat(seat) {
    if (state.over) return;
    var p = state.players[seat];
    if (!p || state.canPass) return;
    var got = drawTo(p, 1);
    SFX.draw();
    if (!got.length) { passTurn(seat, 1); return; }
    if (canPlay(got[0])) {
      state.canPass = true;
      log(p.name + " 抽了一张能打的牌");
      render();
    } else {
      log(p.name + " 抽了一张，过牌");
      passTurn(seat, 1);
    }
  }
  function passForSeat(seat) {
    if (state.over || !state.canPass) return;
    state.canPass = false;
    passTurn(seat, 1);
  }
  function callUnoFor(seat) {
    if (state.over) return;
    var p = state.players[seat];
    if (!p || p.hand.length > 2) return;
    state.unoCalled[seat] = true;
    clearInterval(state.graceTimer);
    state.graceTimer = null;
    state.graceLeft = 0;
    SFX.uno();
    log(p.name + " 喊了 UNO！");
    render();
  }

  // ---------------- 结束 ----------------
  function finish(pi) {
    state.over = true;
    state.winnerIndex = pi;
    clearTimeout(state.timer);
    clearInterval(state.graceTimer);
    state.graceTimer = null;
    var gained = 0;
    state.players.forEach(function (p, i) {
      if (i === pi) return;
      p.hand.forEach(function (c) { gained += cardPoints(c); });
    });
    state.scores[pi] = (state.scores[pi] || 0) + gained;
    state.wins[pi] = (state.wins[pi] || 0) + 1;
    SFX.win();
    render();
    var you = state.mode === "bot" ? pi === 0 : false;
    els.resultEmoji.textContent = you ? "\uD83C\uDF89" : (state.mode === "bot" ? "\uD83E\uDD16" : "\uD83C\uDF89");
    els.resultTitle.textContent = state.players[pi].name + " 赢下这一局";
    els.resultDetail.textContent = "本局获得 " + gained + " 分。其他玩家手里还剩 " +
      state.players.reduce(function (a, p, i) { return i === pi ? a : a + p.hand.length; }, 0) + " 张牌。";
    els.resultOverlay.hidden = false;
    els.againBtn.hidden = (state.mode === "net");
    if (window.__UNO_API__ && window.__UNO_API__.onGameEnd) window.__UNO_API__.onGameEnd();
  }

  // ---------------- 开局 ----------------
  function startGame(keepScores) {
    var roster = state.roster;
    if (state.mode !== "net") state.roster = null;
    var count = roster ? roster.length : state.count;
    var mode = state.mode;
    state.count = count;
    var deck = shuffle(buildDeck());
    var names = roster
      ? roster.map(function (r) { return r.name; })
      : (mode === "bot"
        ? ["你", "电脑 A", "电脑 B", "电脑 C"]
        : ["玩家 1", "玩家 2", "玩家 3", "玩家 4"]);
    var players = [];
    for (var i = 0; i < count; i++) players.push({ name: names[i], hand: [], bot: roster ? !!roster[i].bot : (mode === "bot" && i !== 0) });

    // 发牌
    for (var r = 0; r < 7; r++) {
      players.forEach(function (p) { p.hand.push(deck.pop()); });
    }
    players.forEach(sortHand);

    // 起始牌：取一张数字牌
    var idx = deck.length - 1;
    while (idx >= 0 && /^(skip|reverse|draw2|wild|wild4)$/.test(deck[idx].v)) idx--;
    var first = deck.splice(idx, 1)[0];
    if (!first) { first = deck.pop(); }

    var prevScores = keepScores ? state.scores : [];
    var prevWins = keepScores ? state.wins : [];
    state.players = players;
    state.deck = deck;
    state.discard = [first];
    state.color = first.c;
    state.turn = 0;
    state.dir = 1;
    state.over = false;
    state.canPass = false;
    state.unoCalled = players.map(function () { return false; });
    state.revealed = mode !== "local";
    state.busy = false;
    state.scores = prevScores;
    state.wins = prevWins;
    while (state.scores.length < count) state.scores.push(0);
    while (state.wins.length < count) state.wins.push(0);
    state.scores.length = count;
    state.wins.length = count;

    els.home.hidden = true;
    els.game.hidden = false;
    els.resultOverlay.hidden = true;
    els.colorPicker.hidden = true;
    els.log.innerHTML = "";
    window.scrollTo({ top: 0, behavior: "smooth" });

    log("开局！起手牌：" + cardLabel(first) + " · " + COLOR_CN[first.c]);
    render();
    maybeScheduleBot();
  }

  function goHome() {
    if (window.__UNO_API__ && window.__UNO_API__.onQuit) window.__UNO_API__.onQuit();
    clearTimeout(state.timer);
    clearInterval(state.graceTimer);
    state.graceTimer = null;
    state.over = true;
    els.game.hidden = true;
    els.home.hidden = false;
    els.resultOverlay.hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------------- 绑定 ----------------
  function bind() {
    els.home = $("home");
    els.game = $("game");
    els.opponents = $("opponents");
    els.discard = $("discardPile");
    els.deckCount = $("deckCount");
    els.dirBadge = $("dirBadge");
    els.colorBadge = $("colorBadge");
    els.roundBadge = $("roundBadge");
    els.turnBanner = $("turnBanner");
    els.myHand = $("myHand");
    els.myName = document.querySelector(".my-name");
    els.myCount = $("myCount");
    els.unoBtn = $("unoBtn");
    els.passBtn = $("passBtn");
    els.scoreLine = $("scoreLine");
    els.colorPicker = $("colorPicker");
    els.resultOverlay = $("resultOverlay");
    els.resultEmoji = $("resultEmoji");
    els.resultTitle = $("resultTitle");
    els.resultDetail = $("resultDetail");
    els.toast = $("toast");
    els.log = $("log");

    $("countSeg").addEventListener("click", function (e) {
      var b = e.target.closest(".seg-btn"); if (!b) return;
      state.count = Number(b.dataset.count);
      this.querySelectorAll(".seg-btn").forEach(function (x) { x.classList.remove("is-active"); });
      b.classList.add("is-active");
    });
    $("modeSeg").addEventListener("click", function (e) {
      var b = e.target.closest(".seg-btn"); if (!b) return;
      state.mode = b.dataset.mode;
      this.querySelectorAll(".seg-btn").forEach(function (x) { x.classList.remove("is-active"); });
      b.classList.add("is-active");
      var isNet = state.mode === "net";
      var netRow = $("netRow"), soloRow = $("soloRow");
      if (netRow) netRow.hidden = !isNet;
      if (soloRow) soloRow.hidden = isNet;
      $("startBtn").textContent = state.mode === "bot" ? "开始游戏" : "开一局（轮流上手）";
    });

    $("startBtn").addEventListener("click", function () { startGame(false); });
    $("againBtn").addEventListener("click", function () { state.round += 1; startGame(true); });
    $("homeBtn").addEventListener("click", goHome);
    $("quitBtn").addEventListener("click", goHome);

    els.myHand.addEventListener("click", function (e) {
      var rb = e.target.closest("#revealBtn");
      if (rb) { state.revealed = true; render(); return; }
      var el = e.target.closest(".card");
      if (!el || !el.dataset.cardId) return;
      var pi = state.turn;
      var card = state.players[pi].hand.filter(function (c) { return String(c.id) === el.dataset.cardId; })[0];
      if (card) humanPlay(card);
    });

    $("drawPile").addEventListener("click", humanDraw);
    els.passBtn.addEventListener("click", function () {
      if (state.over || !state.canPass) return;
      if (window.__UNO_API__ && window.__UNO_API__.netAction && state.role === "guest") { window.__UNO_API__.netAction({ type: "pass" }); return; }
      var pi = state.turn;
      state.canPass = false;
      passTurn(pi, 1);
    });
    els.unoBtn.addEventListener("click", callUno);

    els.colorPicker.addEventListener("click", function (e) {
      var b = e.target.closest(".color-choice"); if (!b) return;
      els.colorPicker.hidden = true;
      if (pendingWild) {
        var c = pendingWild; pendingWild = null;
        if (window.__UNO_API__ && window.__UNO_API__.netAction && state.role === "guest") window.__UNO_API__.netAction({ type: "play", id: c.id, color: b.dataset.color });
        else playCard(state.turn, c, b.dataset.color);
      }
    });

    $("soundToggle").addEventListener("click", function () {
      soundOn = !soundOn;
      this.setAttribute("aria-pressed", String(soundOn));
      this.textContent = soundOn ? "\uD83D\uDD0A" : "\uD83D\uDD07";
      if (soundOn) SFX.click();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { els.colorPicker.hidden = true; pendingWild = null; }
      if (e.key.toLowerCase() === "u") callUno();
    });
  }

  bind();
  render();

  // 首屏渲染首页
  window.__UNO__ = state;
  window.__UNO_API__ = {
    state: state,
    render: render,
    startGame: startGame,
    playCard: playCard,
    drawTo: drawTo,
    canPlay: canPlay,
    toast: toast,
    log: log,
    cardFaceEl: cardFaceEl,
    callUnoFor: callUnoFor,
    humanDrawFor: drawForSeat,
    passFor: passForSeat,
    netAction: null,
    onRender: null,
    onGameEnd: null,
    onQuit: null
  };
  els.home.hidden = false;
  els.game.hidden = true;
})();