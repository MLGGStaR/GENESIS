// ============================================================
// GENESIS — fully static, P2P via PeerJS.
// Host registers as `genesis-impv1-<CODE>` on the PeerJS broker.
// Guests connect to that ID. Host is authoritative for game state.
// ============================================================

import { QUESTION_PAIRS } from './questions.js';
import { POLL_QUESTIONS } from './guesspionage-questions.js';

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
  // Imposter — host
  'host-lobby', 'host-answering', 'host-reveal-answers',
  'host-reveal-question', 'host-voting', 'host-round-results', 'host-final',
  // Imposter — player
  'player-lobby', 'player-answering', 'player-waiting',
  'player-voting', 'player-voted', 'player-round-results', 'player-final',
  // Guesspionage — host
  'host-gpn-spin', 'host-gpn-guessing', 'host-gpn-voting', 'host-gpn-results',
  // Guesspionage — player
  'player-gpn-spin', 'player-gpn-polled', 'player-gpn-spectate',
  'player-gpn-voting', 'player-gpn-voted', 'player-gpn-polled-waiting',
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
// Guesspionage game (host-only). One polled player per round guesses a %,
// everyone else votes higher/lower vs the actual answer.
// ============================================================

function createGuesspionageGame({ getPlayers, broadcastPublic, sendPrivate }) {
  const state = {
    phase: 'LOBBY',
    round: 0,
    totalRounds: 5,
    polledRotation: [],
    usedQuestionIndexes: new Set(),
    polledId: null,
    question: null,        // { q, a, idx }
    polledGuess: null,     // 0-100
    votes: new Map(),      // voterId -> 'higher' | 'lower'
    lastResults: null,
  };

  function pickQuestion() {
    if (state.usedQuestionIndexes.size >= POLL_QUESTIONS.length) state.usedQuestionIndexes.clear();
    let idx;
    do { idx = Math.floor(Math.random() * POLL_QUESTIONS.length); }
    while (state.usedQuestionIndexes.has(idx));
    state.usedQuestionIndexes.add(idx);
    return { ...POLL_QUESTIONS[idx], idx };
  }

  function pickPolled() {
    const ids = getPlayers().map(p => p.id);
    if (ids.length === 0) return null;
    state.polledRotation = state.polledRotation.filter(id => ids.includes(id));
    if (state.polledRotation.length === 0) {
      state.polledRotation = [...ids].sort(() => Math.random() - 0.5);
    }
    return state.polledRotation.shift();
  }

  function publicState() {
    const players = getPlayers().map(p => ({
      id: p.id, name: p.name, color: p.color, score: p.score,
    }));
    const polled = players.find(p => p.id === state.polledId);
    const base = { phase: state.phase, round: state.round, totalRounds: state.totalRounds, players };
    if (state.phase === 'GPN_SPIN') {
      base.polledId = state.polledId;
      base.polledName = polled?.name || '?';
      base.polledColor = polled?.color || '#888';
    }
    if (state.phase === 'GPN_GUESSING') {
      base.question = state.question?.q;
      base.polledId = state.polledId;
      base.polledName = polled?.name || '?';
      base.polledColor = polled?.color || '#888';
    }
    if (state.phase === 'GPN_VOTING') {
      base.question = state.question?.q;
      base.polledId = state.polledId;
      base.polledName = polled?.name || '?';
      base.polledColor = polled?.color || '#888';
      base.polledGuess = state.polledGuess;
      base.voteCount = state.votes.size;
      base.totalVoters = Math.max(0, players.length - 1);
    }
    if (state.phase === 'GPN_ROUND_RESULTS') {
      base.question = state.question?.q;
      base.polledId = state.polledId;
      base.polledName = polled?.name || '?';
      base.polledColor = polled?.color || '#888';
      base.polledGuess = state.polledGuess;
      base.actual = state.question?.a;
      base.lastResults = state.lastResults;
    }
    if (state.phase === 'FINAL_RESULTS') {
      base.standings = [...players].sort((a, b) => b.score - a.score);
    }
    return base;
  }

  function emitPublic() { broadcastPublic(publicState()); }

  function startRound() {
    state.round++;
    state.votes.clear();
    state.polledGuess = null;
    state.question = pickQuestion();
    state.polledId = pickPolled();

    // Phase 1: spinning the wheel
    state.phase = 'GPN_SPIN';
    emitPublic();
    for (const p of getPlayers()) {
      sendPrivate(p.id, { phase: 'GPN_SPIN' });
    }

    // Phase 2 (after wheel animation): start the actual guessing
    setTimeout(() => {
      // Bail if game state has moved on (host closed room, etc.)
      if (state.phase !== 'GPN_SPIN') return;
      state.phase = 'GPN_GUESSING';
      emitPublic();
      const polled = getPlayers().find(p => p.id === state.polledId);
      for (const p of getPlayers()) {
        if (p.id === state.polledId) {
          sendPrivate(p.id, {
            phase: 'GPN_GUESSING_POLLED',
            question: state.question.q,
            round: state.round,
            totalRounds: state.totalRounds,
          });
        } else {
          sendPrivate(p.id, {
            phase: 'GPN_GUESSING_SPECTATE',
            question: state.question.q,
            polledName: polled?.name || '?',
          });
        }
      }
    }, 4200); // wheel spins ~3s + result reveal ~1.2s
  }

  function endRound() {
    const actual = state.question.a;
    const guess = state.polledGuess;
    const distance = Math.abs(actual - guess);

    let polledPoints = 0;
    if (distance <= 5)       polledPoints = 1500;
    else if (distance <= 15) polledPoints = 1000;
    else if (distance <= 30) polledPoints = 500;
    else                     polledPoints = 0;

    const correctDir = actual > guess ? 'higher' : actual < guess ? 'lower' : null;
    const players = getPlayers();
    const voterResults = [];
    for (const [voterId, direction] of state.votes) {
      const p = players.find(p => p.id === voterId);
      if (!p) continue;
      const correct = correctDir !== null && direction === correctDir;
      const points = correct ? 1000 : 0;
      p.score += points;
      voterResults.push({ id: voterId, name: p.name, color: p.color, direction, correct, points });
    }
    const polled = players.find(p => p.id === state.polledId);
    if (polled) polled.score += polledPoints;

    state.lastResults = {
      actual, guess, distance,
      correctDirection: correctDir,
      polledPoints, polledName: polled?.name || '?', polledColor: polled?.color || '#888',
      voterResults,
    };
    state.phase = 'GPN_ROUND_RESULTS';
    emitPublic();
    for (const p of players) sendPrivate(p.id, { phase: 'GPN_ROUND_RESULTS' });
  }

  function advance() {
    if (state.phase === 'GPN_GUESSING') {
      // Force-skip polled player who never submitted; treat as 50%.
      submitPollGuess(state.polledId, 50);
    } else if (state.phase === 'GPN_VOTING') {
      endRound();
    } else if (state.phase === 'GPN_ROUND_RESULTS') {
      if (state.round >= state.totalRounds) {
        state.phase = 'FINAL_RESULTS';
        emitPublic();
        for (const p of getPlayers()) sendPrivate(p.id, { phase: 'FINAL_RESULTS' });
      } else {
        startRound();
      }
    }
  }

  function submitPollGuess(playerId, value) {
    if (state.phase !== 'GPN_GUESSING') return;
    if (playerId !== state.polledId) return;
    const v = Math.max(0, Math.min(100, Math.round(Number(value))));
    if (Number.isNaN(v)) return;
    state.polledGuess = v;
    state.phase = 'GPN_VOTING';
    emitPublic();
    sendPrivate(state.polledId, { phase: 'GPN_POLLED_WAITING', guess: v });
    const polled = getPlayers().find(p => p.id === state.polledId);
    for (const p of getPlayers()) {
      if (p.id === state.polledId) continue;
      sendPrivate(p.id, {
        phase: 'GPN_VOTING',
        question: state.question.q,
        polledName: polled?.name || '?',
        polledGuess: v,
      });
    }
    // 2-player edge case: nobody is voting, end round immediately… actually
    // 2 players means 1 voter, normal flow works.
    const expectedVoters = getPlayers().length - 1;
    if (expectedVoters === 0) endRound();
  }

  function submitPollVote(voterId, direction) {
    if (state.phase !== 'GPN_VOTING') return;
    if (voterId === state.polledId) return;
    if (direction !== 'higher' && direction !== 'lower') return;
    const players = getPlayers();
    if (!players.find(p => p.id === voterId)) return;
    state.votes.set(voterId, direction);
    sendPrivate(voterId, { phase: 'GPN_VOTED', direction });
    emitPublic();
    if (state.votes.size >= players.length - 1) endRound();
  }

  function submitPollLive(playerId, value) {
    // Live slider value as the polled player drags. Cosmetic only — relayed
    // to spectators and host UI, not stored as the locked-in answer.
    if (state.phase !== 'GPN_GUESSING') return;
    if (playerId !== state.polledId) return;
    const v = Math.max(0, Math.min(100, Math.round(Number(value))));
    if (Number.isNaN(v)) return;
    // Update host UI
    if (typeof window !== 'undefined') updateHostLiveGuess(v);
    // Relay to spectators
    for (const p of getPlayers()) {
      if (p.id === state.polledId) continue;
      sendPrivate(p.id, { phase: 'GPN_LIVE_GUESS', value: v });
    }
  }

  return {
    get phase() { return state.phase; },
    publicState,
    start() {
      if (getPlayers().length < 2) return;
      startRound();
    },
    advance,
    submitPollGuess,
    submitPollVote,
    submitPollLive,
    handleDisconnect(playerId) {
      state.votes.delete(playerId);
      const players = getPlayers();
      if (playerId === state.polledId &&
          (state.phase === 'GPN_GUESSING' || state.phase === 'GPN_VOTING')) {
        // Polled player bailed — end the round with no scoring.
        state.lastResults = {
          actual: state.question?.a ?? 0,
          guess: state.polledGuess ?? 0,
          distance: 0, correctDirection: null,
          polledPoints: 0, polledName: '(left)', polledColor: '#888',
          voterResults: [],
        };
        state.phase = 'GPN_ROUND_RESULTS';
        emitPublic();
        for (const p of players) sendPrivate(p.id, { phase: 'GPN_ROUND_RESULTS' });
        return;
      }
      if (state.phase === 'GPN_VOTING') {
        const expectedVoters = players.length - 1;
        if (expectedVoters > 0 && state.votes.size >= expectedVoters) endRound();
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
    if (app.game?.submitAnswer) app.game.submitAnswer(conn.peer, data.answer);
    return;
  }

  if (data.type === 'vote') {
    if (app.game?.submitVote) app.game.submitVote(conn.peer, data.targetId);
    return;
  }

  if (data.type === 'pollGuess') {
    if (app.game?.submitPollGuess) app.game.submitPollGuess(conn.peer, data.value);
    return;
  }

  if (data.type === 'pollVote') {
    if (app.game?.submitPollVote) app.game.submitPollVote(conn.peer, data.direction);
    return;
  }

  if (data.type === 'pollLive') {
    if (app.game?.submitPollLive) app.game.submitPollLive(conn.peer, data.value);
    return;
  }
}

// Update the host's own live-% display while the polled player drags.
function updateHostLiveGuess(value) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value))));
  const pctEl = document.getElementById('gpn-live-host-pct');
  const barEl = document.getElementById('gpn-live-host-bar');
  const thumbEl = document.getElementById('gpn-live-host-thumb');
  if (pctEl) pctEl.firstChild.nodeValue = String(v);
  if (barEl) barEl.style.width = v + '%';
  if (thumbEl) thumbEl.style.left = v + '%';
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
  // ----- Guesspionage -----
  else if (msg.phase === 'GPN_SPIN') {
    applyPlayerColor();
    show('player-gpn-spin');
  } else if (msg.phase === 'GPN_GUESSING_POLLED') {
    $('gpn-player-question').textContent = msg.question;
    // Reset slider to 50
    $('gpn-poll-slider').value = 50;
    $('gpn-poll-percent-display').firstChild.nodeValue = '50';
    applyPlayerColor();
    show('player-gpn-polled');
    // Send initial live value so spectators don't see stale data
    sendPollLive(50);
  } else if (msg.phase === 'GPN_GUESSING_SPECTATE') {
    $('gpn-spectate-question').textContent = msg.question;
    $('gpn-spectate-name').textContent = msg.polledName || '?';
    // Reset live display to 50
    updateSpectatorLive(50);
    applyPlayerColor();
    show('player-gpn-spectate');
  } else if (msg.phase === 'GPN_LIVE_GUESS') {
    updateSpectatorLive(msg.value);
  } else if (msg.phase === 'GPN_VOTING') {
    $('gpn-voting-question').textContent = msg.question;
    $('gpn-voting-name').textContent = msg.polledName || '?';
    $('gpn-voting-pct').textContent = (msg.polledGuess ?? 0) + '%';
    applyPlayerColor();
    show('player-gpn-voting');
  } else if (msg.phase === 'GPN_VOTED') {
    $('gpn-voted-direction').textContent = (msg.direction || '?').toUpperCase();
    applyPlayerColor();
    show('player-gpn-voted');
  } else if (msg.phase === 'GPN_POLLED_WAITING') {
    $('gpn-polled-my-guess').textContent = msg.guess ?? '--';
    applyPlayerColor();
    show('player-gpn-polled-waiting');
  } else if (msg.phase === 'GPN_ROUND_RESULTS') {
    applyPlayerColor();
    show('player-round-results');
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
  } else if (state.phase === 'GPN_SPIN') {
    show('host-gpn-spin');
    $('gpn-spin-round').textContent = state.round;
    $('gpn-spin-total').textContent = state.totalRounds;
    renderAndSpinWheel(state.players, state.polledId, state.polledName, state.polledColor);
  } else if (state.phase === 'GPN_GUESSING') {
    show('host-gpn-guessing');
    $('gpn-round').textContent = state.round;
    $('gpn-total-rounds').textContent = state.totalRounds;
    $('gpn-host-question-1').textContent = state.question || '';
    $('gpn-polled-name-1').textContent = (state.polledName || '?').toUpperCase();
    $('gpn-polled-dot-1').style.background = state.polledColor || '#888';
    // Reset live bar to 50%
    updateHostLiveGuess(50);
  } else if (state.phase === 'GPN_VOTING') {
    show('host-gpn-voting');
    $('gpn-round-2').textContent = state.round;
    $('gpn-total-rounds-2').textContent = state.totalRounds;
    $('gpn-host-question-2').textContent = state.question || '';
    $('gpn-polled-name-2').textContent = (state.polledName || '?').toUpperCase();
    $('gpn-polled-dot-2').style.background = state.polledColor || '#888';
    $('gpn-guess-pct').textContent = (state.polledGuess ?? 0) + '%';
    $('gpn-vote-count').textContent = state.voteCount || 0;
    $('gpn-vote-total').textContent = state.totalVoters || 0;
  } else if (state.phase === 'GPN_ROUND_RESULTS') {
    show('host-gpn-results');
    $('gpn-results-question').textContent = state.question || '';
    $('gpn-results-guess').textContent = (state.polledGuess ?? 0) + '%';
    $('gpn-results-guess-name').textContent = state.polledName || '?';
    const dir = state.lastResults?.correctDirection;
    const arrow = $('gpn-results-arrow');
    arrow.classList.remove('up', 'down');
    if (dir === 'higher') { arrow.textContent = '▲'; arrow.classList.add('up'); $('gpn-results-direction').textContent = 'HIGHER'; }
    else if (dir === 'lower') { arrow.textContent = '▼'; arrow.classList.add('down'); $('gpn-results-direction').textContent = 'LOWER'; }
    else { arrow.textContent = '='; $('gpn-results-direction').textContent = 'EXACT MATCH'; }
    // Bullseye banner if very close
    const distance = state.lastResults?.distance ?? 999;
    let bullseye = document.getElementById('gpn-bullseye');
    if (bullseye) bullseye.remove();
    if (distance <= 5) {
      bullseye = document.createElement('div');
      bullseye.id = 'gpn-bullseye';
      bullseye.className = 'gpn-bullseye-banner';
      bullseye.textContent = '🎯 BULLSEYE!';
      $('gpn-results-arrow').parentElement.parentElement.appendChild(bullseye);
    }
    // Animate actual % counting up from 0
    animateCountUp($('gpn-results-actual'), 0, state.actual ?? 0, 1400, '%');
    renderLeaderboard($('gpn-results-leaderboard'), state.players);
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
// Guesspionage host extras: wheel spin + count-up animation
// ============================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

function renderAndSpinWheel(players, polledId, polledName, polledColor) {
  const wheelGroup = $('gpn-wheel-rotating');
  if (!wheelGroup) return;

  // Reset rotation instantly so each new spin starts fresh
  wheelGroup.style.transition = 'none';
  wheelGroup.style.transform = 'rotate(0deg)';
  // Force reflow so the transition restart is honored
  void wheelGroup.getBoundingClientRect();

  // Hide previous result label
  const resultEl = $('gpn-spin-result');
  resultEl.hidden = true;
  $('gpn-spin-sub').textContent = 'Picking the polled player...';

  // Build segments
  wheelGroup.innerHTML = '';
  const r = 100;
  const n = Math.max(1, players.length);
  const segDeg = 360 / n;
  const polledIdx = players.findIndex(p => p.id === polledId);

  players.forEach((p, i) => {
    // Start angle is at top (-90deg) so segment 0 is centered at -90 + segDeg/2.
    const startA = -90 + i * segDeg;
    const endA = -90 + (i + 1) * segDeg;
    const sA = startA * Math.PI / 180;
    const eA = endA * Math.PI / 180;
    const x1 = r * Math.cos(sA), y1 = r * Math.sin(sA);
    const x2 = r * Math.cos(eA), y2 = r * Math.sin(eA);
    const largeArc = segDeg > 180 ? 1 : 0;
    const d = `M0,0 L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${largeArc},1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', p.color || '#888');
    path.setAttribute('class', 'gpn-wheel-segment');
    path.style.color = p.color || '#888'; // for the winner glow
    path.dataset.player = p.id;
    wheelGroup.appendChild(path);

    // Player name (or initials if many players)
    const midA = (startA + endA) / 2;
    const tr = 0.65 * r;
    const tx = tr * Math.cos(midA * Math.PI / 180);
    const ty = tr * Math.sin(midA * Math.PI / 180);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', tx.toFixed(2));
    text.setAttribute('y', ty.toFixed(2));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('class', 'gpn-wheel-text');
    // Rotate text radially so it reads outward in each segment
    text.setAttribute('transform', `rotate(${midA + 90}, ${tx.toFixed(2)}, ${ty.toFixed(2)})`);
    const label = (p.name || '?').slice(0, n > 6 ? 4 : 8).toUpperCase();
    text.setAttribute('font-size', n > 8 ? '10' : n > 6 ? '11' : '13');
    text.textContent = label;
    wheelGroup.appendChild(text);
  });

  // Compute final rotation: land the polled segment center under the top pointer.
  // Segment i is centered at -90 + i*segDeg + segDeg/2 (in wheel-local coords).
  // We want that angle to end up at -90 (top), so rotate by -(segCenterOffset).
  // Add 5 full rotations for drama.
  const segCenterFromTop = polledIdx * segDeg + segDeg / 2; // 0..360
  const finalRot = 360 * 5 + (360 - segCenterFromTop);

  // Allow the browser to commit the reset, then animate
  requestAnimationFrame(() => {
    wheelGroup.style.transition = 'transform 3000ms cubic-bezier(0.18, 0.89, 0.21, 1)';
    wheelGroup.style.transform = `rotate(${finalRot}deg)`;
  });

  // After spin lands, highlight the winning segment + show the name
  setTimeout(() => {
    const winnerSeg = wheelGroup.querySelector(`path[data-player="${cssEscape(polledId)}"]`);
    if (winnerSeg) winnerSeg.classList.add('winner');
    $('gpn-spin-name').textContent = (polledName || '?').toUpperCase();
    $('gpn-spin-dot').style.background = polledColor || '#888';
    resultEl.hidden = false;
    $('gpn-spin-sub').textContent = 'You\'re up!';
  }, 3050);
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/"/g, '\\"');
}

function animateCountUp(el, from, to, durationMs, suffix) {
  if (!el) return;
  const start = performance.now();
  const fromV = Number(from) || 0;
  const toV = Number(to) || 0;
  const dur = Math.max(50, durationMs);
  function tick(now) {
    const t = Math.min(1, (now - start) / dur);
    // ease-out cubic
    const e = 1 - Math.pow(1 - t, 3);
    const v = Math.round(fromV + (toV - fromV) * e);
    el.textContent = v + (suffix || '');
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
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
  if (app.selectedGame === 'guesspionage') {
    app.game = createGuesspionageGame({ getPlayers, broadcastPublic, sendPrivate });
  } else {
    app.game = createImposterGame({ getPlayers, broadcastPublic, sendPrivate });
  }
  app.game.start();
});
$('reveal-answers-next').addEventListener('click', () => app.game?.advance());
$('reveal-question-next').addEventListener('click', () => app.game?.advance());
$('results-next').addEventListener('click', () => app.game?.advance());
$('gpn-results-next').addEventListener('click', () => app.game?.advance());
$('final-back').addEventListener('click', () => resetToLobby());

// Player answer submit (Imposter)
$('answer-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const ans = $('answer-input').value.trim();
  if (!ans) return;
  if (app.hostConn && app.hostConn.open) {
    app.hostConn.send({ type: 'submit', answer: ans });
  }
});

// Guesspionage: slider live update + poll guess submit
const gpnSlider = $('gpn-poll-slider');
const gpnPctDisplay = $('gpn-poll-percent-display');

let lastLiveSentAt = 0;
let lastLiveSentValue = -1;
let pendingLiveTimer = null;

function sendPollLive(value) {
  if (!(app.hostConn && app.hostConn.open)) return;
  if (value === lastLiveSentValue) return;
  lastLiveSentValue = value;
  app.hostConn.send({ type: 'pollLive', value });
}

function throttleSendPollLive(value) {
  // Throttle to ~15Hz so the slider feels live but doesn't flood the channel.
  // Always send a trailing update so the final position is in sync.
  const now = Date.now();
  if (now - lastLiveSentAt > 70) {
    lastLiveSentAt = now;
    sendPollLive(value);
    return;
  }
  if (pendingLiveTimer) clearTimeout(pendingLiveTimer);
  pendingLiveTimer = setTimeout(() => {
    lastLiveSentAt = Date.now();
    pendingLiveTimer = null;
    sendPollLive(Number(gpnSlider.value));
  }, 80);
}

gpnSlider.addEventListener('input', () => {
  // Local display
  gpnPctDisplay.firstChild.nodeValue = gpnSlider.value;
  throttleSendPollLive(Number(gpnSlider.value));
});

$('gpn-poll-submit').addEventListener('click', () => {
  const v = Number(gpnSlider.value);
  if (app.hostConn && app.hostConn.open) {
    app.hostConn.send({ type: 'pollGuess', value: v });
  }
});

// Spectator-side live display update
function updateSpectatorLive(value) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value))));
  const pctEl = $('gpn-live-spec-pct');
  const barEl = $('gpn-live-spec-bar');
  const thumbEl = $('gpn-live-spec-thumb');
  if (pctEl) pctEl.firstChild.nodeValue = String(v);
  if (barEl) barEl.style.width = v + '%';
  if (thumbEl) thumbEl.style.left = v + '%';
}

// Guesspionage: HIGHER / LOWER vote buttons
$('gpn-vote-higher').addEventListener('click', () => sendGpnVote('higher'));
$('gpn-vote-lower').addEventListener('click', () => sendGpnVote('lower'));
function sendGpnVote(direction) {
  if (app.hostConn && app.hostConn.open) {
    app.hostConn.send({ type: 'pollVote', direction });
  }
}

// ============================================================
// Boot
// ============================================================

show('screen-menu');

// Deep link: ?game=imposter|guesspionage&code=XXXX
const params = new URLSearchParams(window.location.search);
const qsGame = params.get('game');
const qsCode = params.get('code') || params.get('room');
if (qsGame === 'imposter') {
  openEntry(qsGame, 'IMPOSTER', '2-12 players · spot the bluffer');
  if (qsCode) $('entry-code').value = qsCode.toUpperCase().slice(0, 4);
} else if (qsGame === 'guesspionage') {
  openEntry(qsGame, 'GUESSPIONAGE', '2-12 players · higher or lower?');
  if (qsCode) $('entry-code').value = qsCode.toUpperCase().slice(0, 4);
}
