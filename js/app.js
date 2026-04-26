// ============================================================
// GENESIS — fully static, P2P via PeerJS.
// Host registers as `genesis-impv1-<CODE>` on the PeerJS broker.
// Guests connect to that ID. Host is authoritative for game state.
// ============================================================

import { QUESTION_PAIRS } from './questions.js';
import { POLL_QUESTIONS } from './guesspionage-questions.js';
import { POINT_QUESTIONS, FINGERS_QUESTIONS, RAISE_QUESTIONS } from './fakinit-questions.js';

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
  'host-gpn-guessing', 'host-gpn-voting', 'host-gpn-results',
  // Guesspionage — player
  'player-gpn-polled', 'player-gpn-spectate',
  'player-gpn-voting', 'player-gpn-voted', 'player-gpn-polled-waiting',
  // Fakin' It — host
  'host-fk-answering', 'host-fk-reveal', 'host-fk-voting', 'host-fk-round-results',
  // Fakin' It — player
  'player-fk-answering', 'player-fk-waiting',
  'player-fk-voting', 'player-fk-voted', 'player-fk-round-results',
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
  }

  function endRound() {
    const actual = state.question.a;
    const guess = state.polledGuess;
    const distance = Math.abs(actual - guess);

    // Polled scoring: exact = 2000, within 10 = 1000, within 20 = 500, else 0
    let polledPoints = 0;
    if (distance === 0)      polledPoints = 2000;
    else if (distance <= 10) polledPoints = 1000;
    else if (distance <= 20) polledPoints = 500;
    else                     polledPoints = 0;

    // Voter scoring: correct direction. "Much" votes (rounds 3+) = 1500, normal = 1000.
    const useMuchVotes = state.round >= 3;
    const diff = actual - guess; // + = actual is higher
    let correctDir;
    if (useMuchVotes) {
      if (diff > 20)        correctDir = 'muchHigher';
      else if (diff > 0)    correctDir = 'higher';
      else if (diff === 0)  correctDir = null;
      else if (diff >= -20) correctDir = 'lower';
      else                  correctDir = 'muchLower';
    } else {
      if (diff > 0)         correctDir = 'higher';
      else if (diff === 0)  correctDir = null;
      else                  correctDir = 'lower';
    }

    const players = getPlayers();
    const voterResults = [];
    for (const [voterId, direction] of state.votes) {
      const p = players.find(p => p.id === voterId);
      if (!p) continue;
      const correct = correctDir !== null && direction === correctDir;
      const isMuch = direction === 'muchHigher' || direction === 'muchLower';
      const points = correct ? (isMuch ? 1500 : 1000) : 0;
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
    const useMuchVotes = state.round >= 3;
    for (const p of getPlayers()) {
      if (p.id === state.polledId) continue;
      sendPrivate(p.id, {
        phase: 'GPN_VOTING',
        question: state.question.q,
        polledName: polled?.name || '?',
        polledGuess: v,
        useMuchVotes,
      });
    }
    const expectedVoters = getPlayers().length - 1;
    if (expectedVoters === 0) endRound();
  }

  function submitPollVote(voterId, direction) {
    if (state.phase !== 'GPN_VOTING') return;
    if (voterId === state.polledId) return;
    const validDirs = state.round >= 3
      ? ['higher', 'lower', 'muchHigher', 'muchLower']
      : ['higher', 'lower'];
    if (!validDirs.includes(direction)) return;
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
// Fakin' It game (host-only). Each round one player is the secret faker;
// they only learn the round TYPE (point / fingers / raise) and have to
// bluff a believable answer. Everyone else gets the actual prompt.
// ============================================================

const FK_TOTAL_ROUNDS = 5;
const FK_POINTS_CORRECT_GUESS = 1000;
const FK_POINTS_FAKER_SURVIVES = 1500;
const FK_POINTS_FAKER_PARTIAL = 250;
const FK_TYPES = ['point', 'fingers', 'raise'];

function createFakinItGame({ getPlayers, broadcastPublic, sendPrivate }) {
  const state = {
    phase: 'LOBBY',
    round: 0,
    totalRounds: FK_TOTAL_ROUNDS,
    fakerId: null,
    fakerRotation: [],
    type: null,           // 'point' | 'fingers' | 'raise'
    question: null,
    typeRotation: [],
    usedQuestions: { point: new Set(), fingers: new Set(), raise: new Set() },
    answers: new Map(),   // playerId -> answer (string for fingers/raise, peerId for point)
    votes: new Map(),     // voterId -> targetId
    lastResults: null,
  };

  function pickType() {
    if (state.typeRotation.length === 0) {
      state.typeRotation = [...FK_TYPES].sort(() => Math.random() - 0.5);
    }
    return state.typeRotation.shift();
  }

  function pickQuestion(type) {
    const pool = type === 'point' ? POINT_QUESTIONS
               : type === 'fingers' ? FINGERS_QUESTIONS
               : RAISE_QUESTIONS;
    const used = state.usedQuestions[type];
    if (used.size >= pool.length) used.clear();
    let idx;
    do { idx = Math.floor(Math.random() * pool.length); } while (used.has(idx));
    used.add(idx);
    return pool[idx];
  }

  function pickFaker() {
    // Fully random — same player can be the faker multiple rounds in a row.
    const ids = getPlayers().map(p => p.id);
    if (ids.length === 0) return null;
    return ids[Math.floor(Math.random() * ids.length)];
  }

  function publicState() {
    const players = getPlayers().map(p => ({
      id: p.id, name: p.name, color: p.color, score: p.score,
    }));
    const base = { phase: state.phase, round: state.round, totalRounds: state.totalRounds, players, type: state.type };

    if (state.phase === 'FK_ANSWERING') {
      // NOTE: question is intentionally NOT in the public state during
      // answering — host TV would let the faker peek otherwise.
      base.submittedCount = state.answers.size;
      base.totalCount = players.length;
      base.submittedIds = [...state.answers.keys()];
    }
    if (state.phase === 'FK_REVEAL' || state.phase === 'FK_VOTING') {
      base.question = state.question;
      base.answers = serializeAnswers(players);
    }
    if (state.phase === 'FK_VOTING') {
      base.votedCount = state.votes.size;
      base.totalCount = players.length;
      base.votedIds = [...state.votes.keys()];
    }
    if (state.phase === 'FK_ROUND_RESULTS') {
      const faker = players.find(p => p.id === state.fakerId);
      base.fakerId = state.fakerId;
      base.fakerName = faker?.name || '?';
      base.fakerColor = faker?.color || '#888';
      base.question = state.question;
      base.answers = serializeAnswers(players);
      base.lastResults = state.lastResults;
    }
    if (state.phase === 'FINAL_RESULTS') {
      base.standings = [...players].sort((a, b) => b.score - a.score);
    }
    return base;
  }

  function serializeAnswers(players) {
    return [...state.answers.entries()].map(([id, ans]) => {
      const p = players.find(p => p.id === id);
      let display = String(ans);
      if (state.type === 'point') {
        const target = players.find(p => p.id === ans);
        display = target?.name || '?';
      } else if (state.type === 'fingers') {
        display = String(ans);
      } else if (state.type === 'raise') {
        display = ans === 'raise' ? 'raise' : 'no';
      }
      return { id, name: p?.name || '?', color: p?.color || '#888', answer: ans, display };
    });
  }

  function emitPublic() { broadcastPublic(publicState()); }

  function startRound() {
    state.round++;
    state.answers.clear();
    state.votes.clear();
    state.type = pickType();
    state.question = pickQuestion(state.type);
    state.fakerId = pickFaker();
    state.phase = 'FK_ANSWERING';
    emitPublic();
    sendQuestionsToPlayers();
  }

  function sendQuestionsToPlayers() {
    const players = getPlayers();
    const candidates = state.type === 'point'
      ? players.map(p => ({ id: p.id, name: p.name, color: p.color }))
      : null;
    for (const p of players) {
      const isFaker = p.id === state.fakerId;
      sendPrivate(p.id, {
        phase: 'FK_ANSWERING',
        // Use `roundType` not `type` — `type` would collide with the envelope
        // {type:'private',...} spread and silently break the message.
        roundType: state.type,
        question: isFaker ? null : state.question,
        isFaker,
        candidates: state.type === 'point'
          ? candidates.filter(c => c.id !== p.id) // can't point at self
          : null,
        round: state.round,
        totalRounds: state.totalRounds,
      });
    }
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
      if (targetId === state.fakerId) {
        const p = players.find(p => p.id === voterId);
        if (p) {
          p.score += FK_POINTS_CORRECT_GUESS;
          correctGuessers.push({ id: voterId, name: p.name, color: p.color });
        }
      }
    }
    const fakerCaught = !tied && topVoted === state.fakerId;
    const faker = players.find(p => p.id === state.fakerId);
    let fakerPoints = 0;
    if (!fakerCaught) fakerPoints = FK_POINTS_FAKER_SURVIVES;
    else if (correctGuessers.length < players.length - 1) fakerPoints = FK_POINTS_FAKER_PARTIAL;
    if (faker) faker.score += fakerPoints;

    state.lastResults = {
      fakerCaught,
      fakerName: faker?.name || '?',
      fakerColor: faker?.color || '#888',
      fakerPoints,
      correctGuessers,
    };
    state.phase = 'FK_ROUND_RESULTS';
    emitPublic();
    for (const p of players) sendPrivate(p.id, { phase: 'FK_ROUND_RESULTS' });
  }

  function advance() {
    if (state.phase === 'FK_ANSWERING') {
      state.phase = 'FK_REVEAL';
      emitPublic();
    } else if (state.phase === 'FK_REVEAL') {
      state.phase = 'FK_VOTING';
      emitPublic();
      const players = getPlayers();
      for (const p of players) {
        const others = players.filter(o => o.id !== p.id).map(o => ({ id: o.id, name: o.name, color: o.color }));
        sendPrivate(p.id, { phase: 'FK_VOTING', candidates: others });
      }
    } else if (state.phase === 'FK_VOTING') {
      endRound();
    } else if (state.phase === 'FK_ROUND_RESULTS') {
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
      if (getPlayers().length < 3) return;
      startRound();
    },
    submitFkAnswer(playerId, answer) {
      if (state.phase !== 'FK_ANSWERING') return;
      const players = getPlayers();
      if (!players.find(p => p.id === playerId)) return;
      // Validate based on type
      let cleaned = null;
      if (state.type === 'point') {
        if (typeof answer !== 'string') return;
        if (answer === playerId) return;
        if (!players.find(p => p.id === answer)) return;
        cleaned = answer;
      } else if (state.type === 'fingers') {
        const n = Number(answer);
        if (!Number.isInteger(n) || n < 1 || n > 5) return;
        cleaned = n;
      } else if (state.type === 'raise') {
        if (answer !== 'raise' && answer !== 'no') return;
        cleaned = answer;
      } else return;
      state.answers.set(playerId, cleaned);
      sendPrivate(playerId, { phase: 'FK_WAITING', answer: cleaned, roundType: state.type });
      emitPublic();
      if (state.answers.size >= players.length) {
        state.phase = 'FK_REVEAL';
        emitPublic();
      }
    },
    submitVote(voterId, targetId) {
      if (state.phase !== 'FK_VOTING') return;
      const players = getPlayers();
      if (!players.find(p => p.id === voterId)) return;
      if (!players.find(p => p.id === targetId)) return;
      if (voterId === targetId) return;
      state.votes.set(voterId, targetId);
      sendPrivate(voterId, { phase: 'FK_VOTED', targetId });
      emitPublic();
      if (state.votes.size >= players.length) endRound();
    },
    advance,
    handleDisconnect(playerId) {
      state.answers.delete(playerId);
      state.votes.delete(playerId);
      const players = getPlayers();
      if (state.phase === 'FK_ANSWERING' && players.length > 0 && state.answers.size >= players.length) {
        state.phase = 'FK_REVEAL';
        emitPublic();
      }
      if (state.phase === 'FK_VOTING' && players.length > 0 && state.votes.size >= players.length) {
        endRound();
      }
      if (playerId === state.fakerId &&
          (state.phase === 'FK_ANSWERING' || state.phase === 'FK_REVEAL' || state.phase === 'FK_VOTING')) {
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

  if (data.type === 'fkAnswer') {
    if (app.game?.submitFkAnswer) app.game.submitFkAnswer(conn.peer, data.value);
    return;
  }
}

// Update the host TV's mirror fill ring while the polled player drags.
function updateHostLiveGuess(value) {
  const r = fillRings.get('gpn-fill-host');
  if (r) setFillValue(r, value);
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
  const needed = app.selectedGame === 'fakinit' ? 3 : 2;
  const enough = hostPlayers.length >= needed;
  $('host-start-btn').disabled = !enough;
  $('host-lobby-status').textContent = enough
    ? `${hostPlayers.length} players ready — let's go!`
    : `Need at least ${needed} players (${hostPlayers.length}/${needed})`;
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
  else if (msg.phase === 'GPN_GUESSING_POLLED') {
    $('gpn-player-question').textContent = msg.question;
    // Reset the polled fill ring to 0%
    const polledRing = fillRings.get('gpn-fill-polled');
    if (polledRing) setFillValue(polledRing, 0);
    applyPlayerColor();
    show('player-gpn-polled');
    sendPollLive(0);
  } else if (msg.phase === 'GPN_GUESSING_SPECTATE') {
    $('gpn-spectate-question').textContent = msg.question;
    $('gpn-spectate-name').textContent = msg.polledName || '?';
    updateSpectatorLive(0);
    applyPlayerColor();
    show('player-gpn-spectate');
  } else if (msg.phase === 'GPN_LIVE_GUESS') {
    updateSpectatorLive(msg.value);
  } else if (msg.phase === 'GPN_VOTING') {
    $('gpn-voting-question').textContent = msg.question;
    $('gpn-voting-name').textContent = msg.polledName || '?';
    $('gpn-voting-pct').textContent = (msg.polledGuess ?? 0) + '%';
    // Round 3+: show MUCH HIGHER / MUCH LOWER buttons
    const useMuch = !!msg.useMuchVotes;
    $('gpn-vote-much-higher').hidden = !useMuch;
    $('gpn-vote-much-lower').hidden = !useMuch;
    $('gpn-vote-buttons').classList.toggle('has-much', useMuch);
    // Update sub-labels: "by a little" only makes sense when "much" exists
    document.querySelectorAll('[data-vote-sub-higher], [data-vote-sub-lower]').forEach(el => {
      el.style.display = useMuch ? '' : 'none';
    });
    applyPlayerColor();
    show('player-gpn-voting');
  } else if (msg.phase === 'GPN_VOTED') {
    $('gpn-voted-direction').textContent = formatVoteDirection(msg.direction);
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
  // ----- Fakin' It -----
  else if (msg.phase === 'FK_ANSWERING') {
    renderFkPlayerAnswering(msg);
    applyPlayerColor();
    show('player-fk-answering');
  } else if (msg.phase === 'FK_WAITING') {
    $('fk-my-answer-display').textContent = formatFkAnswerForDisplay(msg.roundType, msg.answer);
    applyPlayerColor();
    show('player-fk-waiting');
  } else if (msg.phase === 'FK_VOTING') {
    app.voteCandidates = msg.candidates || [];
    renderFkVoteButtons(app.voteCandidates);
    applyPlayerColor();
    show('player-fk-voting');
  } else if (msg.phase === 'FK_VOTED') {
    const c = app.voteCandidates.find(c => c.id === msg.targetId);
    $('fk-voted-target').textContent = c ? c.name : '?';
    applyPlayerColor();
    show('player-fk-voted');
  } else if (msg.phase === 'FK_ROUND_RESULTS') {
    applyPlayerColor();
    show('player-fk-round-results');
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
  } else if (state.phase === 'GPN_GUESSING') {
    show('host-gpn-guessing');
    $('gpn-round').textContent = state.round;
    $('gpn-total-rounds').textContent = state.totalRounds;
    $('gpn-host-question-1').textContent = state.question || '';
    $('gpn-polled-name-1').textContent = (state.polledName || '?').toUpperCase();
    $('gpn-polled-dot-1').style.background = state.polledColor || '#888';
    updateHostLiveGuess(0);
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
    if (dir === 'muchHigher') { arrow.textContent = '▲▲'; arrow.classList.add('up');   $('gpn-results-direction').textContent = 'MUCH HIGHER'; }
    else if (dir === 'muchLower') { arrow.textContent = '▼▼'; arrow.classList.add('down'); $('gpn-results-direction').textContent = 'MUCH LOWER'; }
    else if (dir === 'higher') { arrow.textContent = '▲'; arrow.classList.add('up');   $('gpn-results-direction').textContent = 'HIGHER'; }
    else if (dir === 'lower')  { arrow.textContent = '▼'; arrow.classList.add('down'); $('gpn-results-direction').textContent = 'LOWER'; }
    else { arrow.textContent = '='; $('gpn-results-direction').textContent = 'EXACT MATCH'; }
    // BULLSEYE banner only on an exact guess (0 off)
    const distance = state.lastResults?.distance ?? 999;
    let bullseye = document.getElementById('gpn-bullseye');
    if (bullseye) bullseye.remove();
    if (distance === 0) {
      bullseye = document.createElement('div');
      bullseye.id = 'gpn-bullseye';
      bullseye.className = 'gpn-bullseye-banner';
      bullseye.textContent = '🎯 EXACT! +2000';
      $('gpn-results-arrow').parentElement.parentElement.appendChild(bullseye);
      setTimeout(() => spawnConfetti({ count: 120, spread: 700 }), 800);
    }
    // Animate actual % counting up from 0
    animateCountUp($('gpn-results-actual'), 0, state.actual ?? 0, 1400, '%');
    renderLeaderboard($('gpn-results-leaderboard'), state.players);
  }
  // ----- Fakin' It -----
  else if (state.phase === 'FK_ANSWERING') {
    show('host-fk-answering');
    $('fk-round').textContent = state.round;
    $('fk-total-rounds').textContent = state.totalRounds;
    const pill = $('fk-type-pill');
    pill.classList.remove('type-point', 'type-fingers', 'type-raise');
    pill.classList.add('type-' + state.type);
    pill.textContent = state.type === 'point' ? 'POINTING'
                     : state.type === 'fingers' ? 'HOLD UP FINGERS'
                     : 'RAISE YOUR HAND';
    // Question text is intentionally NOT shown on the host TV during answering
    // (would let the faker peek). It's revealed in the next phase.
    $('fk-answer-count').textContent = state.submittedCount || 0;
    $('fk-answer-total').textContent = state.totalCount || state.players.length;
    renderProgressCircles(state.players, state.submittedIds || [], 'fk-answering-progress');
  } else if (state.phase === 'FK_REVEAL') {
    show('host-fk-reveal');
    $('fk-reveal-question').textContent = state.question || '';
    renderFkRevealGrid($('fk-reveal-grid'), state.answers || [], state.type, state.players);
  } else if (state.phase === 'FK_VOTING') {
    show('host-fk-voting');
    $('fk-voting-question').textContent = state.question || '';
    renderFkRevealGrid($('fk-voting-grid'), state.answers || [], state.type, state.players);
    $('fk-vote-count').textContent = state.votedCount || 0;
    $('fk-vote-total').textContent = state.totalCount || state.players.length;
  } else if (state.phase === 'FK_ROUND_RESULTS') {
    show('host-fk-round-results');
    $('fk-results-faker-name').textContent = (state.fakerName || '?').toUpperCase();
    const status = $('fk-results-status');
    status.classList.remove('caught', 'escaped');
    if (state.lastResults?.fakerCaught) {
      status.classList.add('caught');
      status.textContent = `🎯 FAKER CAUGHT — ${state.lastResults.correctGuessers.length} player(s) saw through it`;
    } else {
      status.classList.add('escaped');
      status.textContent = `🤥 FAKER ESCAPED — +${state.lastResults.fakerPoints} points`;
    }
    renderLeaderboard($('fk-results-leaderboard'), state.players);
  } else if (state.phase === 'FINAL_RESULTS') {
    show('host-final');
    renderFinal(state.standings);
    // Big confetti finale
    setTimeout(() => spawnConfetti({ count: 140, spread: 800, fall: 900 }), 250);
    setTimeout(() => spawnConfetti({ count: 100, spread: 800, fall: 900, originY: window.innerHeight / 4 }), 900);
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

function renderProgressCircles(players, submittedIds, targetId) {
  const el = $(targetId || 'answering-progress');
  if (!el) return;
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
// Fakin' It UI helpers
// ============================================================

function renderFkPlayerAnswering(msg) {
  const isFaker = !!msg.isFaker;
  $('fk-faker-pill').hidden = !isFaker;
  if (isFaker) {
    $('fk-player-prompt-label').textContent = 'YOU\'RE THE FAKER';
    if (msg.roundType === 'point') {
      $('fk-player-question').textContent = 'Everyone is pointing at someone. Pick a player to point at.';
    } else if (msg.roundType === 'fingers') {
      $('fk-player-question').textContent = 'Everyone is holding up 1-5 fingers. Pick a number.';
    } else {
      $('fk-player-question').textContent = 'Everyone\'s deciding to raise their hand or not. Pick one.';
    }
    $('fk-player-tip').textContent = 'Bluff! Pick something that won\'t make you stand out.';
  } else {
    $('fk-player-prompt-label').textContent = 'YOUR PROMPT';
    $('fk-player-question').textContent = msg.question || '';
    $('fk-player-tip').textContent = 'Answer honestly — but try not to look like the faker either!';
  }

  const area = $('fk-answer-area');
  area.innerHTML = '';
  if (msg.roundType === 'point') {
    const grid = document.createElement('div');
    grid.className = 'fk-point-grid';
    for (const c of (msg.candidates || [])) {
      const btn = document.createElement('button');
      btn.className = 'vote-btn';
      btn.innerHTML = `<span class="vote-btn-dot" style="background:${c.color}"></span><span>${escape(c.name)}</span>`;
      btn.addEventListener('click', () => sendFkAnswer(c.id));
      grid.appendChild(btn);
    }
    area.appendChild(grid);
  } else if (msg.roundType === 'fingers') {
    const grid = document.createElement('div');
    grid.className = 'fk-fingers-grid';
    for (let i = 1; i <= 5; i++) {
      const btn = document.createElement('button');
      btn.className = 'fk-fingers-btn';
      btn.textContent = String(i);
      btn.addEventListener('click', () => sendFkAnswer(i));
      grid.appendChild(btn);
    }
    area.appendChild(grid);
  } else {
    const grid = document.createElement('div');
    grid.className = 'fk-raise-grid';
    const yes = document.createElement('button');
    yes.className = 'fk-raise-btn fk-raise-yes';
    yes.innerHTML = `<span class="fk-raise-btn-icon">🙋</span><span>RAISE HAND</span>`;
    yes.addEventListener('click', () => sendFkAnswer('raise'));
    const no = document.createElement('button');
    no.className = 'fk-raise-btn fk-raise-no';
    no.innerHTML = `<span class="fk-raise-btn-icon">🙅</span><span>DON'T</span>`;
    no.addEventListener('click', () => sendFkAnswer('no'));
    grid.appendChild(yes);
    grid.appendChild(no);
    area.appendChild(grid);
  }
}

function sendFkAnswer(value) {
  if (app.hostConn && app.hostConn.open) {
    app.hostConn.send({ type: 'fkAnswer', value });
  }
}

function renderFkVoteButtons(candidates) {
  const el = $('fk-vote-grid');
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

function formatFkAnswerForDisplay(type, raw) {
  if (type === 'fingers') return String(raw);
  if (type === 'raise') return raw === 'raise' ? '🙋 RAISED' : '🙅 NOT RAISED';
  if (type === 'point') {
    // raw is a peerId; show "→ <name>" by looking up in voteCandidates if available
    return '→ pointed';
  }
  return String(raw);
}

function renderFkRevealGrid(el, answers, type, players) {
  el.innerHTML = '';
  let i = 0;
  for (const a of answers) {
    const card = document.createElement('div');
    card.className = 'fk-reveal-card';
    card.style.animationDelay = `${i * 80}ms`;

    let answerHtml;
    if (type === 'point') {
      const target = players.find(p => p.id === a.answer);
      const name = target?.name || '?';
      const color = target?.color || '#888';
      answerHtml = `<div class="fk-reveal-answer"><span class="fk-reveal-arrow">→</span><span class="fk-reveal-dot" style="background:${color};display:inline-block;width:18px;height:18px;border-radius:50%;vertical-align:middle;margin-right:6px"></span>${escape(name)}</div>`;
    } else if (type === 'fingers') {
      answerHtml = `<div class="fk-reveal-answer fk-answer-fingers">${escape(a.display)}</div>`;
    } else {
      answerHtml = `<div class="fk-reveal-answer fk-answer-raise">${a.answer === 'raise' ? '🙋 RAISED' : '🙅 NOT RAISED'}</div>`;
    }
    card.innerHTML = `
      <div class="fk-reveal-card-head">
        <span class="fk-reveal-dot" style="background:${a.color}"></span>
        <span class="fk-reveal-name">${escape(a.name)}</span>
      </div>
      ${answerHtml}
    `;
    el.appendChild(card);
    i++;
  }
}

// ============================================================
// Guesspionage host extras: count-up animation
// ============================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

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
// CONFETTI — spawn a burst from the center of the screen (or an element).
// ============================================================
const CONFETTI_COLORS = ['#ff2e93', '#7c3aed', '#06b6d4', '#facc15', '#22c55e', '#f97316'];

function spawnConfetti({ count = 80, originX, originY, spread = 700, fall = 700 } = {}) {
  const sx = originX != null ? originX : window.innerWidth / 2;
  const sy = originY != null ? originY : window.innerHeight / 3;
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    const dx = (Math.random() - 0.5) * spread * 2;
    const dy = (Math.random() * 0.6 + 0.7) * fall;
    const dr = (Math.random() - 0.5) * 1080;
    const dur = 1800 + Math.random() * 900;
    piece.style.setProperty('--sx', sx + 'px');
    piece.style.setProperty('--sy', sy + 'px');
    piece.style.setProperty('--dx', dx.toFixed(0) + 'px');
    piece.style.setProperty('--dy', dy.toFixed(0) + 'px');
    piece.style.setProperty('--dr', dr.toFixed(0) + 'deg');
    piece.style.setProperty('--dur', dur + 'ms');
    // Random shape: half are squares, half are thinner rectangles
    if (i % 2) {
      piece.style.width = '8px';
      piece.style.height = '12px';
    }
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), dur + 200);
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
  // Fakin' It needs at least 3 players (faker + 2 voters); other games allow 2
  const needed = app.selectedGame === 'fakinit' ? 3 : 2;
  if (hostPlayers.length < needed) return;
  if (app.selectedGame === 'guesspionage') {
    app.game = createGuesspionageGame({ getPlayers, broadcastPublic, sendPrivate });
  } else if (app.selectedGame === 'fakinit') {
    app.game = createFakinItGame({ getPlayers, broadcastPublic, sendPrivate });
  } else {
    app.game = createImposterGame({ getPlayers, broadcastPublic, sendPrivate });
  }
  app.game.start();
});
$('reveal-answers-next').addEventListener('click', () => app.game?.advance());
$('reveal-question-next').addEventListener('click', () => app.game?.advance());
$('results-next').addEventListener('click', () => app.game?.advance());
$('gpn-results-next').addEventListener('click', () => app.game?.advance());
$('fk-reveal-next').addEventListener('click', () => app.game?.advance());
$('fk-results-next').addEventListener('click', () => app.game?.advance());
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

// ============================================================
// PERCENTAGE FILL RING (Apple-Watch-style ring that fills 0% → 100%)
//   Polled player drags around it; host TV + spectators mirror via pollLive.
// ============================================================

// Ring r=92 → circumference = 2π·92 ≈ 578.05
const FILL_CIRCUMFERENCE = 2 * Math.PI * 92;
const fillRings = new Map(); // containerId -> ring state

function initFillRing(containerId, options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return null;
  const arcEl = container.querySelector('[data-fill-arc]');
  const thumbEl = container.querySelector('[data-fill-thumb]');
  const pctEl = container.querySelector('[data-fill-pct]');
  if (arcEl) arcEl.setAttribute('stroke-dasharray', FILL_CIRCUMFERENCE.toFixed(2));
  const ring = { container, arcEl, thumbEl, pctEl, value: 0, interactive: !!options.interactive };
  fillRings.set(containerId, ring);
  if (options.interactive) setupRingDrag(ring, options.onChange);
  setFillValue(ring, 0);
  return ring;
}

function setFillValue(ring, value) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  ring.value = v;
  if (ring.arcEl) {
    const offset = FILL_CIRCUMFERENCE * (1 - v / 100);
    ring.arcEl.setAttribute('stroke-dashoffset', offset.toFixed(2));
  }
  if (ring.thumbEl) {
    // Place thumb at end of fill arc: angle = -90° (top) + (v/100) * 360° going CW
    const angle = (-90 + (v / 100) * 360) * Math.PI / 180;
    const x = 110 + 92 * Math.cos(angle);
    const y = 110 + 92 * Math.sin(angle);
    ring.thumbEl.setAttribute('cx', x.toFixed(2));
    ring.thumbEl.setAttribute('cy', y.toFixed(2));
  }
  if (ring.pctEl) ring.pctEl.textContent = v;
}

// Convert finger angle (atan2 result, where -90° = top) to a percentage 0..100
// going clockwise from the top.
function angleToPct(angleDeg) {
  let a = angleDeg + 90;          // shift so top = 0
  if (a < 0) a += 360;
  if (a >= 360) a -= 360;
  return a / 360 * 100;           // 0..100, fractional
}

function setupRingDrag(ring, onChange) {
  let dragging = false;

  function angleFromCenter(clientX, clientY) {
    const rect = ring.container.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return Math.atan2(clientY - cy, clientX - cx) * 180 / Math.PI;
  }

  // Absolute angle mapping: finger position around the ring directly maps to
  // the value. Detect wrap-around at the top so dragging just past 100% clamps
  // there instead of snapping to 0% (and vice versa).
  function applyAngle(angleDeg) {
    const newVal = angleToPct(angleDeg);
    const prev = ring.value;
    const diff = newVal - prev;
    let target = newVal;
    if (diff < -50) target = 100;       // crossed CW past top: clamp at 100
    else if (diff > 50) target = 0;     // crossed CCW past top: clamp at 0
    setFillValue(ring, target);
    if (onChange) onChange(ring.value);
  }

  function onDown(e) {
    dragging = true;
    ring.container.setPointerCapture && ring.container.setPointerCapture(e.pointerId);
    ring.container.classList.add('dragging');
    // For first touch, jump straight to the tapped angle (no wrap detection)
    const ang = angleFromCenter(e.clientX, e.clientY);
    setFillValue(ring, angleToPct(ang));
    if (onChange) onChange(ring.value);
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragging) return;
    applyAngle(angleFromCenter(e.clientX, e.clientY));
    e.preventDefault();
  }
  function onUp() {
    dragging = false;
    ring.container.classList.remove('dragging');
  }

  ring.container.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// Throttled live broadcast from polled player → host
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
    const r = fillRings.get('gpn-fill-polled');
    sendPollLive(r ? r.value : value);
  }, 80);
}

// Initialize all three fill rings
initFillRing('gpn-fill-polled', { interactive: true, onChange: throttleSendPollLive });
initFillRing('gpn-fill-host', {});
initFillRing('gpn-fill-spec', {});

$('gpn-poll-submit').addEventListener('click', () => {
  const r = fillRings.get('gpn-fill-polled');
  if (!r) return;
  if (app.hostConn && app.hostConn.open) {
    app.hostConn.send({ type: 'pollGuess', value: r.value });
  }
});

// Mirror updates triggered by incoming pollLive messages
function updateSpectatorLive(value) {
  const r = fillRings.get('gpn-fill-spec');
  if (r) setFillValue(r, value);
}

// Guesspionage: vote buttons (4 directions, MUCH variants only shown round 3+)
$('gpn-vote-higher').addEventListener('click', () => sendGpnVote('higher'));
$('gpn-vote-lower').addEventListener('click', () => sendGpnVote('lower'));
$('gpn-vote-much-higher').addEventListener('click', () => sendGpnVote('muchHigher'));
$('gpn-vote-much-lower').addEventListener('click', () => sendGpnVote('muchLower'));
function sendGpnVote(direction) {
  if (app.hostConn && app.hostConn.open) {
    app.hostConn.send({ type: 'pollVote', direction });
  }
}

function formatVoteDirection(d) {
  if (d === 'muchHigher') return 'MUCH HIGHER';
  if (d === 'muchLower')  return 'MUCH LOWER';
  if (d === 'higher')     return 'HIGHER';
  if (d === 'lower')      return 'LOWER';
  return '?';
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
} else if (qsGame === 'fakinit') {
  openEntry(qsGame, "FAKIN' IT", '3-12 players · spot the faker');
  if (qsCode) $('entry-code').value = qsCode.toUpperCase().slice(0, 4);
}
