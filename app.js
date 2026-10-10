/* UNO纸牌 — 玩法逻辑 */
(function () {
  "use strict";

  var COLORS = ["red", "yellow", "green", "blue"];
  var COLOR_HEX = { red: "#e23c45", yellow: "#efb02a", green: "#2f9e52", blue: "#2b6fd4" };
  var COLOR_CN = { red: "红色", yellow: "黄色", green: "绿色", blue: "蓝色" };
  var COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
  var VALUE_ORDER = { skip: 10, reverse: 11, draw2: 12, wild: 13, wild4: 14 };
  var AVATARS = ["cat", "panda", "duck", "bunny", "bear", "frog", "fox", "octopus"];
  function avatarName(i) { var k = AVATARS.length; var n = Math.floor(Number(i) || 0) % k; return AVATARS[n < 0 ? n + k : n]; }
  function avatarEl(player, cls) {
    var img = document.createElement("img");
    img.className = "avatar" + (cls ? " " + cls : "");
    img.alt = "";
    img.src = "./avatars/" + avatarName(player && player.avatar != null ? player.avatar : 0) + ".svg";
    return img;
  }

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
    over: true, canPass: false, unoCalled: [], exposed: [], revealed: true, challenge: null, reveal: null, aiThinking: null, autoPlay: false, aiLastError: "", aiFailStreak: 0, logs: [],
    busy: false, timer: null, graceTimer: null, graceLeft: 0, botDelay: 1150
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

  function renderChallenge() {
    if (!els.challengeBox) return;
    var ch = state.challenge;
    var mySeat = bottomIndex();
    var show = !!ch && Number(ch.victim) === Number(mySeat) && isHuman(mySeat) && !state.over;
    els.challengeBox.hidden = !show;
    if (show) {
      els.challengeWho.textContent = state.players[ch.by] ? state.players[ch.by].name : "对手";
      var left = Math.max(0, Math.ceil((ch.deadline - Date.now()) / 1000));
      els.challengeTimer.textContent = left + " 秒后自动认了";
    } else if (ch) {
      els.challengeBox.hidden = false;
      els.challengeWho.textContent = state.players[ch.victim] ? state.players[ch.victim].name : "对方";
      els.challengeTimer.textContent = "正在等 TA 决定是否质疑…";
      var acts = els.challengeBox.querySelector(".challenge-actions");
      if (acts) acts.style.display = "none";
    }
    if (els.challengeBox && !show) {
      var acts2 = els.challengeBox.querySelector(".challenge-actions");
      if (acts2) acts2.style.display = ch ? "none" : "";
    } else if (els.challengeBox) {
      var acts3 = els.challengeBox.querySelector(".challenge-actions");
      if (acts3) acts3.style.display = "";
    }
    var rv = state.reveal;
    if (els.revealBox) {
      els.revealBox.hidden = !rv;
      if (rv) {
        els.revealTitle.textContent = (rv.guilty ? "质疑成功 ✊ " : "质疑失败 ✋ ") + (state.players[rv.seat] ? state.players[rv.seat].name : "") + " 出 +4 时的手牌：";
        els.revealCards.innerHTML = "";
        (rv.cards || []).forEach(function (c) { els.revealCards.appendChild(cardFaceEl(c)); });
      }
    }
  }
  function bottomIndex() {
    if (state.mode === "net") return state.seat || 0;
    if (state.mode === "local") return state.turn;
    return 0;
  }

  function render() {
    renderOpponents();
    renderTable();
    renderHand();
    renderBar();
    renderChallenge();
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
      var who = document.createElement("span");
      who.className = "who";
      who.appendChild(avatarEl(p));
      var left = document.createElement("span");
      left.className = "who-name";
      left.textContent = p.name;
      who.appendChild(left);
      if (p.ai) {
        var aitag = document.createElement("span");
        aitag.className = "ai-tag"; aitag.textContent = "AI";
        who.appendChild(aitag);
      }
      var right = document.createElement("span");
      right.className = "card-count";
      right.textContent = p.hand.length + " 张";
      head.appendChild(who);
      head.appendChild(right);
      var hand = document.createElement("div");
      hand.className = "opponent-hand";
      var show = Math.min(p.hand.length, 7);
      for (var k = 0; k < show; k++) hand.appendChild(cardBackEl());
      box.appendChild(head);
      box.appendChild(hand);
      if (state.exposed[i] && !state.over) {
        var cb = document.createElement("button");
        cb.type = "button"; cb.className = "catch-btn";
        cb.textContent = "\uD83D\uDC40 举报 " + p.name + " 没喊 UNO";
        cb.addEventListener("click", function () { catchUno(i); });
        box.appendChild(cb);
      } else if (p.hand.length === 1) {
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
    } else if (state.challenge) {
      var cv = state.players[state.challenge.victim];
      banner.textContent = "等待 " + (cv ? cv.name : "对方") + " 决定是否质疑 +4…";
      banner.classList.remove("hot");
    } else if (state.aiThinking != null) {
      var ap = state.players[state.aiThinking];
      if (state.autoPlay && Number(state.aiThinking) === Number(bottomIndex())) {
        banner.textContent = "\uD83E\uDD16 AI 托管正在替你出牌…";
      } else {
        banner.textContent = (ap ? ap.name : "AI") + " 正在思考…";
      }
      banner.classList.remove("hot");
    } else if (state.busy && state.autoPlay && Number(state.turn) === Number(bottomIndex())) {
      banner.textContent = "\uD83E\uDD16 AI 托管正在替你思考…";
      banner.classList.remove("hot");
    } else if (isBot(state.turn)) {
      banner.textContent = cur().name + " 正在想…";
      banner.classList.remove("hot");
    } else {
      var myTurn = state.mode === "net" ? (state.turn === state.seat) : (state.turn === 0);
      banner.textContent = myTurn ? "轮到你出牌" : ("轮到 " + cur().name + " 出牌");
      banner.classList.toggle("hot", myTurn);
    }
  }

  function renderHand() {
    var host = els.myHand;
    host.innerHTML = "";
    var idx = bottomIndex();
    var p = state.players[idx];
    if (!p) return;
    showMyAvatar(p);
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

    var mine = isHuman(idx) && idx === state.turn && !state.over && !state.busy && !state.challenge;
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

  function showMyAvatar(p) {
    var head = els.myName.parentNode;
    if (!head) return;
    var img = head.querySelector(".avatar.mine");
    if (!img) { img = document.createElement("img"); img.className = "avatar mine"; img.alt = ""; head.insertBefore(img, els.myName); }
    img.src = "./avatars/" + avatarName(p && p.avatar != null ? p.avatar : 0) + ".svg";
    els.myName.textContent = p ? p.name : "你";
  }
  function renderBar() {
    var uno = els.unoBtn;
    var idx = bottomIndex();
    var p = state.players[idx];
    var mine = p && isHuman(idx) && !state.over;
    if (state.graceTimer) { clearInterval(state.graceTimer); state.graceTimer = null; }
    var canUno = mine && p.hand.length <= 2 && !state.unoCalled[idx];
    uno.disabled = !canUno;
    uno.classList.toggle("armed", !!canUno && p.hand.length === 1);
    uno.textContent = "UNO!";
    els.passBtn.hidden = !(state.canPass && mine && idx === state.turn);
    if (els.autoBtn) els.autoBtn.classList.toggle("is-on", !!state.autoPlay);
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
    state.logs.push({ t: Date.now(), text: msg });
    if (state.logs.length > 300) state.logs.shift();
    renderLogPanel();
  }
  function renderLogPanel() {
    if (!els.logList) return;
    els.logList.innerHTML = "";
    state.logs.forEach(function (e, i) {
      var row = document.createElement("div");
      row.className = "log-item";
      var idx = document.createElement("span");
      idx.className = "log-idx"; idx.textContent = i + 1;
      var tx = document.createElement("span");
      tx.textContent = e.text;
      row.appendChild(idx); row.appendChild(tx);
      els.logList.appendChild(row);
    });
    els.logList.scrollTop = els.logList.scrollHeight;
  }
  function logText() {
    var head = "UNO纸牌 对局记录  " + new Date().toLocaleString() + "\\n";
    return head + state.logs.map(function (e, i) { return (i + 1) + ". " + e.text; }).join("\\n");
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
    var prevColor = state.color;
    p.hand.splice(at, 1);
    state.discard.push(card);
    state.color = card.c === "wild" ? chosenColor : card.c;
    log(p.name + " 出牌：" + cardDesc(card) + (card.c === "wild" ? "（指定 " + (COLOR_CN[chosenColor] || chosenColor || "?") + "）" : ""));
    state.canPass = false;
    if (p.hand.length > 1) state.unoCalled[pi] = false;
    SFX.play();

    if (p.hand.length === 1 && !state.unoCalled[pi]) {
      if (isBot(pi)) {
        state.unoCalled[pi] = true;
        log(p.name + "：UNO！");
      } else {
        state.exposed[pi] = true;
        log(p.name + " 只剩最后一张，还没喊 UNO");
      }
    }
    if (p.hand.length === 0) { finish(pi); return; }

    if (card.v === "wild4") { startChallenge(pi, prevColor); render(); return; }

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

  function startChallenge(by, prevColor) {
    var victim = idxAfter(by, 1);
    state.challenge = { by: by, victim: victim, prevColor: prevColor, deadline: Date.now() + 8000 };
    log(state.players[by].name + " 打出 +4，等待 " + state.players[victim].name + " 决定是否质疑");
    clearTimeout(state.challengeTimer);
    if (isBot(victim)) {
      state.challengeTimer = setTimeout(function () { respondChallenge(victim, Math.random() < 0.35); }, 1300);
    } else {
      state.challengeTimer = setTimeout(function () { respondChallenge(victim, false, true); }, 8000);
    }
  }
  function respondChallenge(responder, yes, auto) {
    var ch = state.challenge;
    if (!ch) return;
    if (Number(ch.victim) !== Number(responder)) return;
    clearTimeout(state.challengeTimer);
    state.challengeTimer = null;
    state.challenge = null;
    var by = ch.by, victim = ch.victim;
    var guilty = state.players[by].hand.some(function (c) { return c.c === ch.prevColor; });
    state.reveal = { seat: by, cards: state.players[by].hand.map(function (c) { return { c: c.c, v: c.v, id: c.id }; }), guilty: guilty };
    if (!yes) {
      drawTo(state.players[victim], 4);
      log(state.players[victim].name + (auto ? " 超时未质疑，" : " 认了，") + "抽 4 张并停一轮");
      passTurn(by, 2);
    } else if (guilty) {
      drawTo(state.players[by], 4);
      log("质疑成功！" + state.players[by].name + " 手里还有 " + (COLOR_CN[ch.prevColor] || "") + "，改由 TA 抽 4 张");
      toast("质疑成功！TA 手里还有 " + (COLOR_CN[ch.prevColor] || "") + " 牌");
      passTurn(by, 1);
    } else {
      drawTo(state.players[victim], 6);
      log("质疑失败！" + state.players[victim].name + " 抽 6 张并停一轮");
      toast("质疑失败，抽 6 张");
      passTurn(by, 2);
    }
    SFX.nope();
    clearTimeout(state.revealTimer);
    state.revealTimer = setTimeout(function () { state.reveal = null; render(); }, 5000);
    render();
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
    maybeAutoPlay();
  }

  function botJitter(base) {
    var b = base || 1100;
    return Math.round(b + Math.random() * b * 0.9);
  }
  function mySeat() { return state.mode === "net" ? (state.seat || 0) : 0; }
  function maybeAutoPlay() {
    clearTimeout(state.autoTimer);
    if (!state.autoPlay || state.over || state.challenge || state.busy) return;
    var me = mySeat();
    if (state.turn !== me || isBot(me)) return;
    if (!state.players[me]) return;
    state.busy = true;
    render();
    state.autoTimer = setTimeout(function () {
      if (!state.autoPlay || state.over || state.challenge || state.turn !== me) { state.busy = false; render(); return; }
      state.busy = false;
      aiMove(me);
    }, botJitter(state.botDelay));
  }
  function maybeScheduleBot() {
    clearTimeout(state.timer);
    if (state.over) return;
    if (state.challenge) return;
    if (state.role === "guest") return;
    if (!isBot(state.turn)) return;
    var seat = state.turn;
    state.busy = true;
    render();
    state.timer = setTimeout(function () {
      if (state.over || state.turn !== seat || state.challenge) { state.busy = false; render(); return; }
      state.busy = false;
      var p = state.players[seat];
      if (p && p.ai) aiMove(seat);
      else botMove();
    }, botJitter(state.botDelay));
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
      }, botJitter(state.botDelay * 0.6));
      return;
    }
    log(p.name + " 抽了一张，过牌");
    SFX.draw();
    state.turn = idxAfter(pi, 1);
    afterTurnChange();
  }

  // ---------------- 玩家操作 ----------------
  function humanPlay(card) {
    if (state.over || state.busy || state.challenge) return;
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
    if (state.over || state.busy || state.challenge) return;
    var pi = state.turn;
    if (!isHuman(pi)) return;
    if (state.mode === "local" && !state.revealed) return;
    if (window.__UNO_API__ && window.__UNO_API__.netAction && state.role === "guest") { window.__UNO_API__.netAction({ type: "draw" }); return; }
    if (state.canPass) { toast("已经抽过了，打出去或者点「过牌」"); return; }
    var p = state.players[pi];
    var got = drawTo(p, 1);
    SFX.draw();
    log(p.name + " 抽了一张牌");
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
    var pi = bottomIndex();
    if (state.over) return;
    if (!isHuman(pi)) return;
    var p = state.players[pi];
    if (p.hand.length > 2) { toast("牌还多着呢"); return; }
    if (window.__UNO_API__ && window.__UNO_API__.netAction && state.role === "guest") { window.__UNO_API__.netAction({ type: "uno" }); return; }
    state.unoCalled[pi] = true;
    state.exposed[pi] = false;
    if (state.graceTimer) { clearInterval(state.graceTimer); state.graceTimer = null; }
    SFX.uno();
    toast("UNO！");
    log(p.name + " 喊了 UNO！");
    render();
  }

  // ---------------- 大模型 AI 对手 ----------------
  var AI_PRESETS = [
    { name: "OpenAI",   base: "https://api.openai.com/v1",                  model: "gpt-4o-mini" },
    { name: "DeepSeek", base: "https://api.deepseek.com/v1",                model: "deepseek-chat" },
    { name: "月之暗面", base: "https://api.moonshot.cn/v1",                 model: "moonshot-v1-8k" },
    { name: "智谱GLM",  base: "https://open.bigmodel.cn/api/paas/v4",       model: "glm-4-flash" },
    { name: "通义千问", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
    { name: "硅基流动", base: "https://api.siliconflow.cn/v1",              model: "Qwen/Qwen2.5-7B-Instruct" }
  ];
  function getAiConfig() {
    try {
      return {
        base: localStorage.getItem("uno-ai-base") || "",
        key: localStorage.getItem("uno-ai-key") || "",
        model: localStorage.getItem("uno-ai-model") || ""
      };
    } catch (e) { return { base: "", key: "", model: "" }; }
  }
  function saveAiConfig(c) {
    try {
      localStorage.setItem("uno-ai-base", c.base || "");
      localStorage.setItem("uno-ai-key", c.key || "");
      localStorage.setItem("uno-ai-model", c.model || "");
      return true;
    } catch (e) { return false; }
  }
  function cardDesc(c) {
    var col = COLOR_CN[c.c] || "";
    if (c.v === "wild") return "【变色牌】";
    if (c.v === "wild4") return "【+4变色牌】";
    if (c.v === "skip") return col + "跳过";
    if (c.v === "reverse") return col + "反转";
    if (c.v === "draw2") return col + "+2";
    return col + c.v;
  }
  var AI_SYSTEM = [
    "你是一名 UNO 牌手，正在和朋友对战。规则：",
    "1. 打出的牌要和「当前颜色」相同，或和牌堆顶的数字/符号相同；变色牌、+4 变色牌随时能出。",
    "2. +4 变色牌只有在你手里没有「当前颜色」的牌时才合法，否则会被质疑，你要自己抽 4 张。",
    "3. 打出变色牌或 +4 时必须指定新颜色。",
    "4. 手里有能打的牌时优先打出去，不要无故抽牌；确实没牌能打才抽。",
    "5. 对手快赢（剩 1-2 张）时，优先用 +2 / 跳过 / 反转 / +4 卡住他。",
    "只输出一个 JSON，不要任何解释文字：",
    "出牌 {\"action\":\"play\",\"id\":手牌里的id数字,\"color\":\"red|yellow|green|blue\"}",
    "抽牌 {\"action\":\"draw\"}"
  ].join("\n");
  function aiPrompt(seat) {
    var p = state.players[seat];
    var top = state.discard[state.discard.length - 1];
    var L = [];
    L.push("牌堆顶：" + cardDesc(top));
    L.push("当前颜色：" + (COLOR_CN[state.color] || state.color));
    L.push("出牌方向：" + (state.dir === 1 ? "顺时针" : "逆时针"));
    L.push("你的手牌（一共 " + p.hand.length + " 张）：");
    p.hand.forEach(function (c) { L.push("  id=" + c.id + "  " + cardDesc(c)); });
    L.push("其他玩家：" + state.players.map(function (x, i) {
      return i === seat ? null : x.name + " 剩 " + x.hand.length + " 张";
    }).filter(Boolean).join("，"));
    L.push("");
    L.push("请决定这一手怎么打。");
    return L.join("\n");
  }
  function parseAiAction(text) {
    if (!text) return null;
    var s = String(text).replace(/[\s\S]*?<\/think>/gi, "");
    var all = s.match(/\{[\s\S]*?\}/g) || [];
    for (var i = all.length - 1; i >= 0; i--) {
      try { var o = JSON.parse(all[i]); if (o && o.action) return o; } catch (e) {}
    }
    return null;
  }
  function refreshAiHome() {
    var box = document.getElementById("aiHomeStatus");
    if (!box) return;
    var c = getAiConfig();
    box.textContent = c.key
      ? ("✓ 已配置：" + (c.model || "未填模型") + "（点右边的按钮可以改）")
      : "还没配置 AI —— 点右边填一下 API Key，就能和它打牌了";
  }
  function aiSay(text, name) {
    if (!text) return;
    var api = window.__UNO_API__;
    if (api && api.chatSay) { try { api.chatSay(text, name); } catch (e) {} }
  }
  function aiApply(seat, act) {
    if (!act || state.over || state.turn !== seat || state.challenge) return false;
    var p = state.players[seat];
    if (!p) return false;
    var api = window.__UNO_API__;
    var isMe = (state.mode === "net") ? (Number(seat) === Number(state.seat)) : (Number(seat) === 0);
    if (api && api.netAction && state.role === "guest" && isMe) {
      if (act.action === "draw") { api.netAction({ type: "draw" }); return true; }
      if (act.action === "play") {
        var gc = p.hand.filter(function (c) { return String(c.id) === String(act.id); })[0];
        if (!gc || !canPlay(gc)) return false;
        api.netAction({ type: "play", id: gc.id, color: gc.c === "wild" ? (act.color || bestColor(seat, gc)) : null });
        return true;
      }
      return false;
    }
    if (act.action === "draw") {
      var drew = drawForSeat(seat);
      if (!drew) return false;
      if (state.canPass && state.turn === seat && !state.over) {
        setTimeout(function () {
          if (!state.over && state.turn === seat && state.canPass) aiMove(seat);
        }, botJitter(state.botDelay * 0.6));
      }
      return true;
    }
    if (act.action === "play") {
      var card = p.hand.filter(function (c) { return String(c.id) === String(act.id); })[0];
      if (!card || !canPlay(card)) return false;
      var color = card.c === "wild" ? (act.color || bestColor(seat, card)) : null;
      playCard(seat, card, color);
      return true;
    }
    return false;
  }
  function aiMove(seat) {
    var conf = getAiConfig();
    var p = state.players[seat];
    if (!conf.key || !conf.base || !conf.model) {
      log(p.name + " 还没配置模型，先用普通策略");
      botMove();
      return;
    }
    state.aiThinking = seat;
    render();
    var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 40000);
    var url = conf.base.replace(/\/+$/, "") + "/chat/completions";
    var reqBody = {
      model: conf.model,
      temperature: 0.6,
      max_tokens: 200,
      messages: [
        { role: "system", content: AI_SYSTEM },
        { role: "user", content: aiPrompt(seat) }
      ]
    };
    // 国内服务商支持关闭「思考模式」：推理模型开着思考会非常慢，容易超时
    var looksThink = /(siliconflow|dashscope|aliyuncs|bigmodel|moonshot)/i.test(conf.base) || /(qwen3|qwen-3|thinking|reasoner|qwq)/i.test(conf.model);
    if (looksThink) reqBody.enable_thinking = false;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + conf.key },
      body: JSON.stringify(reqBody),
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      return r.text().then(function (txt) {
        if (!r.ok) {
          var em = txt;
          try {
            var ej = JSON.parse(txt);
            em = ej.message || (ej.error && (ej.error.message || ej.error)) || txt;
          } catch (e2) {}
          throw new Error("HTTP " + r.status + "：" + String(em).slice(0, 90));
        }
        return JSON.parse(txt);
      });
    }).then(function (data) {
      clearTimeout(timer);
      state.aiThinking = null;
      state.aiLastError = ""; state.aiFailStreak = 0;
      var msg = (data && data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : "";
      var talk = String(msg || "").replace(/\{[\s\S]*\}/, "").trim();
      if (talk) { log(p.name + "：" + talk.slice(0, 50)); aiSay(talk.slice(0, 60), p.name); }
      var act = parseAiAction(msg);
      if (!aiApply(seat, act)) {
        log(p.name + " 这步没走通，改用自己的判断");
        botMove();
      } else { render(); }
    }).catch(function (err) {
      clearTimeout(timer);
      state.aiThinking = null;
      var why;
      if (err && err.name === "AbortError") why = "请求超时（25 秒没响应）";
      else if (err && /Failed to fetch|NetworkError|Load failed/i.test(err.message || "")) why = "连不上接口（多为跨域CORS被拦 / 网络不通 / 地址写错）";
      else why = (err && err.message) ? err.message : "网络问题";
      var detail = why + "  ←  " + url;
      state.aiLastError = detail;
      state.aiFailStreak = (state.aiFailStreak || 0) + 1;
      log(p.name + " 调用模型失败（第 " + state.aiFailStreak + " 次）：" + why);
      if (state.aiFailStreak === 2) toast("AI 连续失败，建议检查「AI 设置」或换个更快的模型");
      if (state.aiFailStreak >= 3 && state.autoPlay) {
        state.autoPlay = false;
        try { localStorage.setItem("uno-autoplay", "0"); } catch (e3) {}
        toast("AI 一直失败，已自动关闭托管，改用内置策略");
      }
      if (window.__UNO_API__ && window.__UNO_API__.onAiError) window.__UNO_API__.onAiError(detail);
      toast("AI 调用失败：" + why.slice(0, 40));
      botMove();
    });
  }
  // ---------------- 联机：房主代客机执行 ----------------
  function drawForSeat(seat) {
    if (state.over) return false;
    var p = state.players[seat];
    if (!p || state.canPass) return false;
    var got = drawTo(p, 1);
    SFX.draw();
    if (!got.length) { passTurn(seat, 1); return true; }
    if (canPlay(got[0])) {
      state.canPass = true;
      log(p.name + " 抽了一张能打的牌");
      render();
    } else {
      log(p.name + " 抽了一张，过牌");
      passTurn(seat, 1);
    }
    return true;
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
    if (state.unoCalled[seat] && !state.exposed[seat]) return;
    state.unoCalled[seat] = true;
    state.exposed[seat] = false;
    if (state.graceTimer) { clearInterval(state.graceTimer); state.graceTimer = null; }
    SFX.uno();
    log(p.name + " 喊了 UNO！");
    render();
  }
  function catchUnoFor(catcher, target) {
    if (state.over) return;
    if (!state.players[target]) return;
    if (!state.exposed[target] || state.unoCalled[target]) return;
    state.exposed[target] = false;
    if (state.players[target].hand.length !== 1) { render(); return; }
    drawTo(state.players[target], 2);
    var cn = state.players[catcher] ? state.players[catcher].name : "有人";
    log(cn + " 抓到 " + state.players[target].name + " 没喊 UNO，罚抽 2 张");
    toast(cn + " 抓到 " + state.players[target].name + " 没喊 UNO！罚抽 2 张");
    SFX.nope();
    render();
  }
  function answerChallenge(yes) {
    var mySeat = bottomIndex();
    if (!state.challenge || Number(state.challenge.victim) !== Number(mySeat)) return;
    if (window.__UNO_API__ && window.__UNO_API__.netAction && state.role === "guest") {
      state.challenge = null; renderChallenge();
      window.__UNO_API__.netAction({ type: "challenge", yes: !!yes });
      return;
    }
    respondChallenge(mySeat, !!yes);
  }
  function catchUno(target) {
    if (state.over) return;
    if (window.__UNO_API__ && window.__UNO_API__.netAction && state.role === "guest") {
      window.__UNO_API__.netAction({ type: "catch", target: target });
      return;
    }
    catchUnoFor(state.seat || 0, target);
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
        : (mode === "ai"
          ? ["你", "AI 小智", "AI 阿丙", "AI 老王"]
          : ["玩家 1", "玩家 2", "玩家 3", "玩家 4"]));
    var players = [];
    for (var i = 0; i < count; i++) players.push({ name: names[i], hand: [], bot: roster ? !!roster[i].bot : (mode === "ai" ? i !== 0 : (mode === "bot" && i !== 0)), avatar: roster && roster[i] && roster[i].avatar != null ? roster[i].avatar : i, ai: roster && roster[i] ? !!roster[i].ai : (mode === "ai" && i !== 0) });

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
    state.exposed = players.map(function () { return false; });
    state.aiThinking = null;
    clearTimeout(state.challengeTimer); state.challengeTimer = null;
    clearTimeout(state.revealTimer); state.revealTimer = null;
    state.challenge = null; state.reveal = null;
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
    var chatEl = document.getElementById("chatPanel");
    if (chatEl && state.mode !== "net") chatEl.hidden = true;
    state.logs = [];
    if (els.logPanel) { els.logPanel.hidden = false; els.logBody.hidden = true; }
    renderLogPanel();
    els.resultOverlay.hidden = true;
    els.colorPicker.hidden = true;
    els.log.innerHTML = "";
    window.scrollTo({ top: 0, behavior: "smooth" });

    log("开局！起手牌：" + cardLabel(first) + " · " + COLOR_CN[first.c]);
    render();
    maybeScheduleBot();
    maybeAutoPlay();
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
    if (els.logPanel) els.logPanel.hidden = true;
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
    els.autoBtn = $("autoBtn");
    els.passBtn = $("passBtn");
    els.scoreLine = $("scoreLine");
    els.colorPicker = $("colorPicker");
    els.resultOverlay = $("resultOverlay");
    els.resultEmoji = $("resultEmoji");
    els.resultTitle = $("resultTitle");
    els.resultDetail = $("resultDetail");
    els.againBtn = $("againBtn");
    els.homeBtn = $("homeBtn");
    els.challengeBox = $("challengeBox");
    els.challengeWho = $("challengeWho");
    els.challengeTimer = $("challengeTimer");
    els.revealBox = $("revealBox");
    els.revealTitle = $("revealTitle");
    els.revealCards = $("revealCards");
    els.logPanel = $("logPanel"); els.logBody = $("logBody"); els.logList = $("logList");
    var lt = $("logToggle");
    if (lt) lt.addEventListener("click", function () { els.logBody.hidden = !els.logBody.hidden; if (!els.logBody.hidden) renderLogPanel(); });
    var lc = $("logClose");
    if (lc) lc.addEventListener("click", function () { els.logBody.hidden = true; });
    var lcp = $("logCopy");
    if (lcp) lcp.addEventListener("click", function () {
      var txt = logText();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { toast("对局记录已复制，可以发给别人看"); }, function () { toast("复制失败，请手动选中"); });
      } else { toast("这个浏览器不支持一键复制"); }
    });
    if (els.challengeBox) {
      var cYes = $("challengeYesBtn"), cNo = $("challengeNoBtn");
      if (cYes) cYes.addEventListener("click", function () { answerChallenge(true); });
      if (cNo) cNo.addEventListener("click", function () { answerChallenge(false); });
    }
    setInterval(function () { if (state.challenge || state.reveal) render(); }, 1000);
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
      var netRow = $("netRow"), soloRow = $("soloRow"), aiRow = $("aiRow");
      if (netRow) netRow.hidden = !isNet;
      if (soloRow) soloRow.hidden = isNet;
      if (aiRow) aiRow.hidden = state.mode !== "ai";
      if (state.mode === "ai") refreshAiHome();
      $("startBtn").textContent = state.mode === "ai" ? "开始跟 AI 打" : (state.mode === "bot" ? "开始游戏" : "开一局（轮流上手）");
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
    if (els.autoBtn) els.autoBtn.addEventListener("click", function () {
      state.autoPlay = !state.autoPlay;
      try { localStorage.setItem("uno-autoplay", state.autoPlay ? "1" : "0"); } catch (e) {}
      toast(state.autoPlay ? "AI 托管已开启，它会替你出牌" : "AI 托管已关闭");
      render();
      if (state.autoPlay) maybeAutoPlay();
    });

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

    setInterval(function () {
      if (!state.autoPlay || state.over) return;
      var me = mySeat();
      var p = state.players[me];
      if (!p || isBot(me)) return;
      if (p.hand.length <= 2 && !state.unoCalled[me]) {
        if (window.__UNO_API__ && window.__UNO_API__.netAction && state.role === "guest") window.__UNO_API__.netAction({ type: "uno" });
        else callUnoFor(me);
      }
    }, 1500);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { els.colorPicker.hidden = true; pendingWild = null; }
      if (e.key.toLowerCase() === "u") callUno();
    });
  }

  try { if (localStorage.getItem("uno-autoplay") === "1") state.autoPlay = true; } catch (e) {}
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
    AVATARS: AVATARS,
    avatarName: avatarName,
    refreshAiHome: refreshAiHome,
    onAiError: null,
    callUnoFor: callUnoFor,
    catchUnoFor: catchUnoFor,
    chatSay: null,
    respondChallenge: respondChallenge,
    humanDrawFor: drawForSeat,
    passFor: passForSeat,
    netAction: null,
    onRender: null,
    onGameEnd: null,
    onQuit: null,
    onAiDone: null
  };
  els.home.hidden = false;
  els.game.hidden = true;
  refreshAiHome();
})();