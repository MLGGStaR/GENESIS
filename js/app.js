// ============================================================
// GENESIS — fully static, P2P via PeerJS.
// Host registers as `genesis-impv1-<CODE>` on the PeerJS broker.
// Guests connect to that ID. Host is authoritative for game state.
// ============================================================

import { QUESTION_PAIRS } from './questions.js';

const PEER_PREFIX = 'genesis-impv1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_LEN = 4;

const TOTAL_ROUNDS = 5;
const POINTS_CORRECT_GUESS = 1000;
const POINTS_IMPOSTER_SURVIVES = 1500;
const POINTS_IMPOSTER_CAUGHT_PARTIAL = 250;

const PLAYER_COLORS = [
  '#ff3d8a', '#7c3aed', '#06b6d4', '#f59e0b',
  '#22c55e', '#ef4444', '#0ea5e9', '#d946ef',
  '#f97316', '#14b8a6', '#eab308', '#a855f7',
  '#ec4899', '#3b82f6', '#84cc16', '#f43f5e',
];

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shortName = (n) => !n ? '?' : n.length <= 6 ? n : n.slice(0, 5) + '…';

// ============================================================
// Global app state
// ============================================================

const app = {
  mode: 'menu',         // 'menu' | 'entry' | 'host' | 'player' | 'disconnected'
  selectedGame: null,
  isHost: false,
  peer: null,           // PeerJS Peer instance
  // host-side
  roomCode: null,
  guestConns: new Map(), // peerId -> conn (host)
  game: null,            // running ImposterGame (host only)
  // guest-side
  hostConn: null,
  myId: null,
  myName: null,
  myColor: null,
  voteCandidates: [],
  // shared
  lastScores: new Map(),
};

// ============================================================
// Screen switching
// ============================================================

const ALL_SCREENS = [
  'screen-menu', 'screen-entry', 'screen-disconnected',
  'host-lobby', 'host-answering', 'host-reveal-answers',
  'host-reveal-question', 'host-voting', 'host-round-results', 'host-final',
  'player-lobby', 'player-answering', 'player-waiting',
  'player-voting', 'player-voted', 'player-round-results', 'player-final',
];

function show(id) {
  for (const s of ALL_SCREENS) {
    const el = document.getElementById(s);
    if (el) el.classList.toggle('active', s === id);
  }
}

function applyPlayerColor() {
  if (!app.myColor) return;
  document.querySelectorAll('.player-color-banner').forEach(el => {
    el.style.background = app.myColor;
    el.style.color = app.myColor;
  });
}

// ============================================================
// Imposter game (host-only). Pure logic; UI/network via callbacks.
// ============================================================

function createImposterGame({ getPlayers, broadcastPublic, sendPrivate }) {
  const state = {
    phase: 'LOBBY',
    round: 0,
    totalRounds: TOTAL_ROUNDS,
    imposterId: null,
    imposterRotation: [],
    questionPair: null,
    answers: new Map(),
    votes: new Map(),
    usedPairIndexes: new Set(),
    lastResults: null,
  };

  function pickPair() {
    if (state.usedPairIndexes.size >= QUESTION_PAIRS.length) state.usedPairIndexes.clear();
    let idx;
    do {
      idx = Math.floor(Math.random() * QUESTION_PAIRS.length);
    } while (state.usedPairIndexes.has(idx));
    state.usedPairIndexes.add(idx);
    const pair = QUESTION_PAIRS[idx];
    if (Math.random() < 0.5) return { common: pair[0], imposter: pair[1] };
    return { common: pair[1], imposter: pair[0] };
  }

  function pickImposter() {
    const ids = getPlayers().map(p => p.id);
    if (ids.length === 0) return null;
    state.imposterRotation = state.imposterRotation.filter(id => ids.includes(id));
    if (state.imposterRotation.length === 0) {
      state.imposterRotation = [...ids].sort(() => Math.random() - 0.5);
    }
    return state.imposterRotation.shift();
  }

  function publicState() {
    const players = getPlayers().map(p => ({
      id: p.id, name: p.name, color: p.color, score: p.score,
    }));
    const base = { phase: state.phase, round: state.round, totalRounds: state.totalRounds, players };

    if (state.phase === 'ANSWERING') {
      base.submittedCount = state.answers.size;
      base.totalCount = players.length;
      base.submittedIds = [...state.answers.keys()];
    }
    if (state.phase === 'REVEAL_ANSWERS' || state.phase === 'REVEAL_QUESTION' || state.phase === 'VOTING') {
      base.answers = [...state.answers.entries()].map(([id, ans]) => {
        const p = getPlayers().find(p => p.id === id);
        return { id, name: p?.name || '?', color: p?.color || '#888', answer: ans };
      });
    }
    if (state.phase === 'REVEAL_QUESTION' || state.phase === 'VOTING') {
      base.commonQuestion = state.questionPair?.common;
    }
    if (state.phase === 'VOTING') {
      base.votedCount = state.votes.size;
      base.totalCount = players.length;
      base.votedIds = [...state.votes.keys()];
    }
    if (state.phase === 'ROUND_RESULTS') {
      const imp = getPlayers().find(p => p.id === state.imposterId);
      base.imposterId = state.imposterId;
      base.imposterName = imp?.name || '?';
      base.imposterColor = imp?.color || '#888';
      base.commonQuestion = state.questionPair.common;
      base.imposterQuestion = state.questionPair.imposter;
      base.lastResults = state.lastResults;
      base.answers = [...state.answers.entries()].map(([id, ans]) => {
        const p = getPlayers().find(p => p.id === id);
        return { id, name: p?.name || '?', color: p?.color || '#888', answer: ans };
      });
    }
    if (state.phase === 'FINAL_RESULTS') {
      base.standings = [...players].sort((a, b) => b.score - a.score);
    }
    return base;
  }

  function emitPublic() { broadcastPublic(publicState()); }

  function sendQuestionsToPlayers() {
    for (const p of getPlayers()) {
      const isImp = p.id === state.imposterId;
      sendPrivate(p.id, {
        phase: 'ANSWERING',
        question: isImp ? state.questionPair.imposter : state.questionPair.common,
        isImposter: isImp,
        round: state.round,
        totalRounds: state.totalRounds,
      });
    }
  }

  function startRound() {
    state.round++;
    state.answers.clear();
    state.votes.clear();
    state.questionPair = pickPair();
    state.imposterId = pickImposter();
    state.phase = 'ANSWERING';
    emitPublic();
    sendQuestionsToPlayers();
  }

  function endRound() {
    const voteCounts = new Map();
    for (const target of state.votes.values()) {
      voteCounts.set(target, (voteCounts.get(target) || 0) + 1);
    }
    let topVoted = null, topCount = -1, tied = false;
    for (const [id, count] of voteCounts) {
      if (count > topCount) { topCount = count; topVoted = id; tied = false; }
      else if (count === topCount) { tied = true; }
    }

    const players = getPlayers();
    const correctGuessers = [];
    for (const [voterId, targetId] of state.votes) {
      if (targetId === state.imposterId) {
        const p = players.find(p => p.id === voterId);
        if (p) {
          p.score += POINTS_CORRECT_GUESS;
          correctGuessers.push({ id: voterId, name: p.name, color: p.color });
        }
      }
    }

    const imposterCaught = !tied && topVoted === state.imposterId;
    const imp = players.find(p => p.id === state.imposterId);
    let imposterPoints = 0;
    if (!imposterCaught) imposterPoints = POINTS_IMPOSTER_SURVIVES;
    else if (correctGuessers.length < players.length - 1) imposterPoints = POINTS_IMPOSTER_CAUGHT_PARTIAL;
    if (imp) imp.score += imposterPoints;

    state.lastResults = {
      imposterCaught,
      imposterId: state.imposterId,
      imposterName: imp?.name || '?',
      imposterColor: imp?.color || '#888',
      imposterPoints,
      correctGuessers,
      pointsCorrect: POINTS_CORRECT_GUESS,
      voteBreakdown: [...voteCounts.entries()].map(([id, count]) => {
        const p = players.find(p => p.id === id);
        return { id, name: p?.name || '?', color: p?.color || '#888', count };
      }).sort((a, b) => b.count - a.count),
    };

    state.phase = 'ROUND_RESULTS';
    emitPublic();
    for (const p of players) sendPrivate(p.id, { phase: 'ROUND_RESULTS' });
  }

  function advance() {
    if (state.phase === 'REVEAL_ANSWERS') {
      state.phase = 'REVEAL_QUESTION';
      emitPublic();
    } else if (state.phase === 'REVEAL_QUESTION') {
      state.phase = 'VOTING';
      emitPublic();
      const players = getPlayers();
      for (const p of players) {
        const others = players.filter(o => o.id !== p.id).map(o => ({ id: o.id, name: o.name, color: o.color }));
        sendPrivate(p.id, { phase: 'VOTING', candidates: others });
      }
    } else if (state.phase === 'ANSWERING') {
      state.phase = 'REVEAL_ANSWERS';
      emitPublic();
    } else if (state.phase === 'VOTING') {
      endRound();
    } else if (state.phase === 'ROUND_RESULTS') {
      if (state.round >= state.totalRounds) {
        state.phase = 'FINAL_RESULTS';
        emitPublic();
        for (const p of getPlayers()) sendPrivate(p.id, { phase: 'FINAL_RESULTS' });
      } else {
        startRound();
      }
    }
  }

  return {
    get phase() { return state.phase; },
    publicState,
    start() {
      if (getPlayers().length < 2) return;
      startRound();
    },
    submitAnswer(playerId, answer) {
      if (state.phase !== 'ANSWERING') return;
      const players = getPlayers();
      if (!players.find(p => p.id === playerId)) return;
      const clean = String(answer || '').slice(0, 80).trim();
      if (!clean) return;
      state.answers.set(playerId, clean);
      sendPrivate(playerId, { phase: 'WAITING_OTHERS', answer: clean });
      emitPublic();
      if (state.answers.size >= players.length) {
        state.phase = 'REVEAL_ANSWERS';
        emitPublic();
      }
    },
    submitVote(voterId, targetId) {
      if (state.phase !== 'VOTING') return;
      const players = getPlayers();
      if (!players.find(p => p.id === voterId)) return;
      if (!players.find(p => p.id === targetId)) return;
      if (voterId === targetId) return;
      state.votes.set(voterId, targetId);
      sendPrivate(voterId, { phase: 'VOTED', targetId });
      emitPublic();
      if (state.votes.size >= players.length) endRound();
    },
    advance,
    handleDisconnect(playerId) {
      state.answers.delete(playerId);
      state.votes.delete(playerId);
      const players = getPlayers();
      if (state.phase === 'ANSWERING' && players.length > 0 && state.answers.size >= players.length) {
        state.phase = 'REVEAL_ANSWERS';
        emitPublic();
      }
      if (state.phase === 'VOTING' && players.length > 0 && state.votes.size >= players.length) {
        endRound();
      }
      if (playerId === state.imposterId &&
          (state.phase === 'ANSWERING' || state.phase === 'REVEAL_ANSWERS' ||
           state.phase === 'REVEAL_QUESTION' || state.phase === 'VOTING')) {
        endRound();
      }
    },
  };
}

// ============================================================
// HOST: room management + message dispatch
// ============================================================

const hostPlayers = []; // [{ id, name, color, score }]
function getPlayers() { return hostPlayers; }

function broadcastPublic(state) {
  // 1) Host's own UI
  renderHostGameOrLobby(state);
  // 2) Send to all guests
  const msg = { type: 'state', state };
  for (const conn of app.guestConns.values()) {
    if (conn && conn.open) conn.send(msg);
  }
}

function sendPrivate(playerId, msg) {
  const conn = app.guestConns.get(playerId);
  if (conn && conn.open) conn.send({ type: 'private', ...msg });
}

function generateCode() {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

function startHosting(game) {
  app.isHost = true;
  app.selectedGame = game;
  app.roomCode = generateCode();
  const peerId = PEER_PREFIX + game + '-' + app.roomCode;

  $('host-room-code').textContent = app.roomCode;
  $('host-lobby-title').textContent = game.toUpperCase();
  renderHostPlayers([]);
  show('host-lobby');

  app.peer = new Peer(peerId, { debug: 1 });

  app.peer.on('open', (id) => {
    app.mode = 'host';
    updateHostLobbyStatus();
  });

  app.peer.on('connection', (conn) => {
    conn.on('open', () => {
      // Don't add the player yet; wait for their 'join' message with name
    });
    conn.on('data', (data) => handleGuestMessage(conn, data));
    conn.on('close', () => handleGuestDisconnect(conn.peer));
    conn.on('error', (err) => console.warn('guest conn error', err));
  });

  app.peer.on('error', (err) => {
    console.error('peer error', err);
    if (err.type === 'unavailable-id') {
      // Code clash — regenerate and retry
      teardownPeer();
      setTimeout(() => startHosting(game), 50);
      return;
    }
    if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      app.mode = 'disconnected';
      show('screen-disconnected');
      return;
    }
  });
}

function handleGuestMessage(conn, data) {
  if (!data || !data.type) return;

  if (data.type === 'join') {
    if (app.game) {
      conn.send({ type: 'error', message: 'Game already in progress' });
      conn.close();
      return;
    }
    const cleanName = String(data.name || '').slice(0, 16).trim();
    if (!cleanName) {
      conn.send({ type: 'error', message: 'Name required' });
      conn.close();
      return;
    }
    if (hostPlayers.some(p => p.name.toLowerCase() === cleanName.toLowerCase())) {
      conn.send({ type: 'error', message: 'Name taken in this room' });
      conn.close();
      return;
    }
    if (hostPlayers.length >= 12) {
      conn.send({ type: 'error', message: 'Room is full (12 max)' });
      conn.close();
      return;
    }
    const usedColors = new Set(hostPlayers.map(p => p.color));
    const color = PLAYER_COLORS.find(c => !usedColors.has(c)) || PLAYER_COLORS[hostPlayers.length % PLAYER_COLORS.length];
    const player = { id: conn.peer, name: cleanName, color, score: 0 };
    hostPlayers.push(player);
    app.guestConns.set(conn.peer, conn);
    conn.send({ type: 'joined', id: conn.peer, name: cleanName, color, code: app.roomCode, game: app.selectedGame });
    renderHostPlayers(hostPlayers);
    updateHostLobbyStatus();
    // Tell all guests about the updated player list
    broadcastLobbyState();
    return;
  }

  if (data.type === 'submit') {
    if (app.game) app.game.submitAnswer(conn.peer, data.answer);
    return;
  }

  if (data.type === 'vote') {
    if (app.game) app.game.submitVote(conn.peer, data.targetId);
    return;
  }
}

function handleGuestDisconnect(peerId) {
  app.guestConns.delete(peerId);
  const idx = hostPlayers.findIndex(p => p.id === peerId);
  if (idx >= 0) hostPlayers.splice(idx, 1);
  if (app.game) app.game.handleDisconnect(peerId);
  if (!app.game) {
    renderHostPlayers(hostPlayers);
    updateHostLobbyStatus();
    broadcastLobbyState();
  } else {
    // Re-broadcast public state so player count etc reflect new reality
    broadcastPublic(app.game.publicState());
  }
}

function broadcastLobbyState() {
  // For pre-game lobby; tells guests the player list
  const players = hostPlayers.map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score }));
  const msg = { type: 'lobby', players, code: app.roomCode, game: app.selectedGame };
  for (const conn of app.guestConns.values()) {
    if (conn && conn.open) conn.send(msg);
  }
}

function updateHostLobbyStatus() {
  const enough = hostPlayers.length >= 2;
  $('host-start-btn').disabled = !enough;
  $('host-lobby-status').textContent = enough
    ? `${hostPlayers.length} players ready — let's go!`
    : `Need at least 2 players (${hostPlayers.length}/2)`;
}

function teardownPeer() {
  try {
    if (app.peer) app.peer.destroy();
  } catch (e) {}
  app.peer = null;
  app.guestConns.clear();
  app.hostConn = null;
  app.game = null;
  hostPlayers.length = 0;
}

function closeRoom() {
  // Notify guests
  for (const conn of app.guestConns.values()) {
    try { if (conn && conn.open) conn.send({ type: 'closed' }); } catch (e) {}
  }
  teardownPeer();
  app.mode = 'menu';
  app.selectedGame = null;
  app.lastScores = new Map();
  show('screen-menu');
}

function resetToLobby() {
  app.game = null;
  for (const p of hostPlayers) p.score = 0;
  app.lastScores = new Map();
  for (const conn of app.guestConns.values()) {
    if (conn && conn.open) conn.send({ type: 'private', phase: 'LOBBY' });
  }
  show('host-lobby');
  renderHostPlayers(hostPlayers);
  updateHostLobbyStatus();
  broadcastLobbyState();
}

// ============================================================
// GUEST: connect to host, route messages
// ============================================================

function joinAsGuest(game, code, name) {
  app.isHost = false;
  app.selectedGame = game;
  $('entry-error').textContent = 'Connecting...';

  const targetId = PEER_PREFIX + game + '-' + code;
  app.peer = new Peer({ debug: 1 });

  app.peer.on('open', (id) => {
    app.myId = id;
    const conn = app.peer.connect(targetId, { reliable: true });
    app.hostConn = conn;

    conn.on('open', () => {
      conn.send({ type: 'join', name });
    });
    conn.on('data', (data) => handleHostMessage(data));
    conn.on('close', () => {
      if (app.mode === 'player') {
        app.mode = 'disconnected';
        show('screen-disconnected');
      }
    });
    conn.on('error', (err) => {
      console.error('host conn error', err);
      $('entry-error').textContent = 'Could not connect to host';
    });
  });

  app.peer.on('error', (err) => {
    console.error('peer error', err);
    if (err.type === 'peer-unavailable') {
      $('entry-error').textContent = 'Room not found';
    } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      $('entry-error').textContent = 'Cannot reach matchmaking server';
    } else {
      $('entry-error').textContent = 'Connection error: ' + err.type;
    }
    teardownPeer();
  });
}

function handleHostMessage(data) {
  if (!data || !data.type) return;

  if (data.type === 'error') {
    $('entry-error').textContent = data.message;
    return;
  }

  if (data.type === 'closed') {
    app.mode = 'disconnected';
    show('screen-disconnected');
    return;
  }

  if (data.type === 'joined') {
    app.mode = 'player';
    app.myName = data.name;
    app.myColor = data.color;
    $('entry-error').textContent = '';
    $('player-lobby-name').textContent = data.name;
    $('player-lobby-code').textContent = data.code;
    applyPlayerColor();
    show('player-lobby');
    try { localStorage.setItem('genesis-last-name', data.name); } catch (e) {}
    return;
  }

  if (data.type === 'lobby') {
    $('player-lobby-status').textContent = `Waiting for the host to start... (${data.players.length} in room)`;
    show('player-lobby');
    return;
  }

  if (data.type === 'state') {
    renderPlayerPublicGameState(data.state);
    return;
  }

  if (data.type === 'private') {
    handlePrivateMessage(data);
    return;
  }
}

function handlePrivateMessage(msg) {
  if (msg.phase === 'ANSWERING') {
    $('play-question-text').textContent = msg.question;
    $('answer-input').value = '';
    $('imposter-pill').hidden = !msg.isImposter;
    $('play-tip').textContent = msg.isImposter
      ? "Tip: BLUFF! Give an answer that could fit the OTHER question."
      : "Tip: keep your answer short — one or two words is best.";
    applyPlayerColor();
    show('player-answering');
    setTimeout(() => $('answer-input').focus(), 60);
  } else if (msg.phase === 'WAITING_OTHERS') {
    $('player-my-answer').textContent = msg.answer || '';
    applyPlayerColor();
    show('player-waiting');
  } else if (msg.phase === 'VOTING') {
    app.voteCandidates = msg.candidates || [];
    renderVoteButtons(app.voteCandidates);
    applyPlayerColor();
    show('player-voting');
  } else if (msg.phase === 'VOTED') {
    const c = app.voteCandidates.find(c => c.id === msg.targetId);
    $('voted-target').textContent = c ? c.name : '?';
    applyPlayerColor();
    show('player-voted');
  } else if (msg.phase === 'ROUND_RESULTS') {
    applyPlayerColor();
    show('player-round-results');
  } else if (msg.phase === 'FINAL_RESULTS') {
    applyPlayerColor();
    show('player-final');
  } else if (msg.phase === 'LOBBY') {
    applyPlayerColor();
    show('player-lobby');
  }
}

// ============================================================
// HOST UI rendering
// ============================================================

function renderHostPlayers(players) {
  const el = $('host-players-grid');
  if (players.length === 0) {
    el.innerHTML = '<p class="lobby-empty">Waiting for players to join...</p>';
    return;
  }
  el.innerHTML = '';
  for (const p of players) {
    const tile = document.createElement('div');
    tile.className = 'player-tile';
    tile.innerHTML = `<span class="player-tile-dot" style="background:${p.color}"></span><span class="player-tile-name">${escape(p.name)}</span>`;
    el.appendChild(tile);
  }
}

function renderHostGameOrLobby(state) {
  // Only used while a game is active. (Lobby uses renderHostPlayers directly.)
  if (state.phase === 'ANSWERING') {
    show('host-answering');
    $('answering-round').textContent = state.round;
    $('answering-total').textContent = state.totalRounds;
    $('answering-count').textContent = state.submittedCount || 0;
    $('answering-total-count').textContent = state.totalCount || state.players.length;
    renderProgressCircles(state.players, state.submittedIds || []);
  } else if (state.phase === 'REVEAL_ANSWERS') {
    show('host-reveal-answers');
    renderAnswers($('reveal-answers-grid'), state.answers, false);
  } else if (state.phase === 'REVEAL_QUESTION') {
    show('host-reveal-question');
    $('reveal-question-text').textContent = state.commonQuestion;
    renderAnswers($('reveal-question-answers'), state.answers, false);
  } else if (state.phase === 'VOTING') {
    show('host-voting');
    $('voting-question-text').textContent = state.commonQuestion;
    $('voting-count').textContent = state.votedCount || 0;
    $('voting-total-count').textContent = state.totalCount || state.players.length;
    renderAnswers($('voting-answers'), state.answers, true, state.votedIds || []);
  } else if (state.phase === 'ROUND_RESULTS') {
    show('host-round-results');
    $('results-imposter-name').textContent = state.imposterName.toUpperCase();
    $('results-common-q').textContent = state.commonQuestion;
    $('results-imposter-q').textContent = state.imposterQuestion;
    const status = $('results-caught-status');
    status.classList.remove('caught', 'escaped');
    if (state.lastResults?.imposterCaught) {
      status.classList.add('caught');
      status.textContent = `🎯 IMPOSTER CAUGHT — ${state.lastResults.correctGuessers.length} player(s) saw through it`;
    } else {
      status.classList.add('escaped');
      status.textContent = `🦊 IMPOSTER ESCAPED — +${state.lastResults.imposterPoints} points`;
    }
    renderLeaderboard($('results-leaderboard'), state.players);
  } else if (state.phase === 'FINAL_RESULTS') {
    show('host-final');
    renderFinal(state.standings);
  }
}

function renderPlayerPublicGameState(gs) {
  // Mostly a fallback so phones that haven't received a private message yet
  // display "look at the screen" during reveal phases.
  if (gs.phase === 'REVEAL_ANSWERS' || gs.phase === 'REVEAL_QUESTION') {
    const visible = ['player-waiting', 'player-voted', 'player-round-results'];
    const anyVisible = visible.some(id => document.getElementById(id)?.classList.contains('active'));
    if (!anyVisible) {
      $('player-my-answer').textContent = '— look at the screen —';
      applyPlayerColor();
      show('player-waiting');
    }
  }
}

function renderProgressCircles(players, submittedIds) {
  const el = $('answering-progress');
  el.innerHTML = '';
  const submitted = new Set(submittedIds);
  for (const p of players) {
    const c = document.createElement('div');
    c.className = 'progress-circle' + (submitted.has(p.id) ? ' done' : '');
    c.style.background = p.color;
    c.style.color = p.color;
    const name = document.createElement('span');
    name.className = 'progress-circle-name';
    name.textContent = shortName(p.name);
    c.appendChild(name);
    el.appendChild(c);
  }
}

function renderAnswers(el, answers, dimVoted, votedIds = []) {
  el.innerHTML = '';
  const voted = new Set(votedIds);
  let i = 0;
  for (const a of answers) {
    const card = document.createElement('div');
    card.className = 'answer-card';
    card.style.animationDelay = `${i * 80}ms`;
    if (dimVoted && voted.has(a.id)) card.style.opacity = '0.55';
    card.innerHTML = `
      <div class="answer-card-head">
        <span class="answer-card-dot" style="background:${a.color}"></span>
        <span class="answer-card-name">${escape(a.name)}</span>
      </div>
      <div class="answer-card-text">${escape(a.answer)}</div>
    `;
    el.appendChild(card);
    i++;
  }
}

function renderLeaderboard(el, players) {
  el.innerHTML = '';
  const sorted = [...players].sort((a, b) => b.score - a.score);
  let rank = 0, prevScore = null;
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (p.score !== prevScore) rank = i + 1;
    prevScore = p.score;
    const prev = app.lastScores.get(p.id) || 0;
    const delta = p.score - prev;
    const row = document.createElement('div');
    row.className = 'lb-row';
    const deltaHtml = delta > 0 ? `<span class="lb-delta">+${delta}</span>` : '';
    row.innerHTML = `
      <span class="lb-rank">#${rank}</span>
      <span class="lb-dot" style="background:${p.color}"></span>
      <span class="lb-name">${escape(p.name)}</span>
      ${deltaHtml}
      <span class="lb-score">${p.score}</span>
    `;
    el.appendChild(row);
  }
  app.lastScores = new Map(players.map(p => [p.id, p.score]));
}

function renderFinal(standings) {
  const podiumEl = $('final-podium');
  const restEl = $('final-rest');
  podiumEl.innerHTML = '';
  restEl.innerHTML = '';
  const top3 = standings.slice(0, 3);
  const order = [1, 0, 2];
  const medals = ['🥇', '🥈', '🥉'];
  for (const idx of order) {
    const p = top3[idx];
    if (!p) continue;
    const spot = document.createElement('div');
    spot.className = `podium-spot podium-spot-${idx + 1}`;
    spot.innerHTML = `
      <div class="podium-medal">${medals[idx]}</div>
      <div class="podium-dot" style="background:${p.color}"></div>
      <div class="podium-name">${escape(p.name)}</div>
      <div class="podium-score">${p.score}</div>
    `;
    podiumEl.appendChild(spot);
  }
  for (let i = 3; i < standings.length; i++) {
    const p = standings[i];
    const row = document.createElement('div');
    row.className = 'lb-row';
    row.innerHTML = `
      <span class="lb-rank">#${i + 1}</span>
      <span class="lb-dot" style="background:${p.color}"></span>
      <span class="lb-name">${escape(p.name)}</span>
      <span class="lb-score">${p.score}</span>
    `;
    restEl.appendChild(row);
  }
}

function renderVoteButtons(candidates) {
  const el = $('vote-grid');
  el.innerHTML = '';
  for (const c of candidates) {
    const btn = document.createElement('button');
    btn.className = 'vote-btn';
    btn.innerHTML = `<span class="vote-btn-dot" style="background:${c.color}"></span><span>${escape(c.name)}</span>`;
    btn.addEventListener('click', () => {
      if (app.hostConn && app.hostConn.open) {
        app.hostConn.send({ type: 'vote', targetId: c.id });
      }
    });
    el.appendChild(btn);
  }
}

// ============================================================
// MENU + ENTRY UI wiring
// ============================================================

function openEntry(game, title, tag) {
  app.selectedGame = game;
  app.mode = 'entry';
  $('entry-title').textContent = title;
  $('entry-tag').textContent = tag;
  $('entry-error').textContent = '';
  try {
    const last = localStorage.getItem('genesis-last-name');
    if (last && !$('entry-name').value) $('entry-name').value = last;
  } catch (e) {}
  show('screen-entry');
}

function goToMenu() {
  app.mode = 'menu';
  app.selectedGame = null;
  show('screen-menu');
}

document.addEventListener('click', (e) => {
  const card = e.target.closest('.game-card[data-game]');
  if (!card) return;
  const game = card.dataset.game;
  const tag = card.dataset.tag || '';
  openEntry(game, card.querySelector('.game-card-title')?.textContent || game.toUpperCase(), tag);
});

$('entry-back').addEventListener('click', goToMenu);
$('disconnected-back').addEventListener('click', () => {
  teardownPeer();
  goToMenu();
});

$('entry-code').addEventListener('input', (e) => {
  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (e.target.value !== v) e.target.value = v;
});

$('entry-join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('entry-error').textContent = '';
  const name = $('entry-name').value.trim();
  const code = $('entry-code').value.trim().toUpperCase();
  if (!name) { $('entry-error').textContent = 'Enter a name'; return; }
  if (code.length !== CODE_LEN) { $('entry-error').textContent = `Room code is ${CODE_LEN} characters`; return; }
  joinAsGuest(app.selectedGame, code, name);
});

$('entry-host-btn').addEventListener('click', () => {
  startHosting(app.selectedGame);
});

// Host controls
$('host-back').addEventListener('click', () => {
  if (confirm('Close this room and return to menu? Players will be disconnected.')) {
    closeRoom();
  }
});
$('host-start-btn').addEventListener('click', () => {
  if (hostPlayers.length < 2) return;
  app.game = createImposterGame({ getPlayers, broadcastPublic, sendPrivate });
  app.game.start();
});
$('reveal-answers-next').addEventListener('click', () => app.game?.advance());
$('reveal-question-next').addEventListener('click', () => app.game?.advance());
$('results-next').addEventListener('click', () => app.game?.advance());
$('final-back').addEventListener('click', () => resetToLobby());

// Player answer submit
$('answer-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const ans = $('answer-input').value.trim();
  if (!ans) return;
  if (app.hostConn && app.hostConn.open) {
    app.hostConn.send({ type: 'submit', answer: ans });
  }
});

// ============================================================
// Boot
// ============================================================

show('screen-menu');

// Deep link: ?game=imposter&code=XXXX
const params = new URLSearchParams(window.location.search);
const qsGame = params.get('game');
const qsCode = params.get('code') || params.get('room');
if (qsGame === 'imposter') {
  openEntry(qsGame, 'IMPOSTER', '2-12 players · spot the bluffer');
  if (qsCode) $('entry-code').value = qsCode.toUpperCase().slice(0, 4);
}
