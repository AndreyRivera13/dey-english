// Progreso guardado en este navegador (localStorage). No hay servidor.
import { MIN_TURNS, PASS_SCORE } from './tutor.js';

const KEY = 'devtalk.v1';
export const READY_TO_MOVE_UP = 4; // escenarios superados para recomendar el siguiente nivel

export const emptyState = () => ({
  level: 'A1',
  tier: 'balanced',
  captions: true,
  voice: true,
  sessions: [], // {date, level, scenarioId, turns, score}
  mistakes: [], // {id, date, level, original, corrected, errors, natural, mastered}
});

export function load(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) || 'null');
    return saved && typeof saved === 'object' ? { ...emptyState(), ...saved } : emptyState();
  } catch {
    return emptyState();
  }
}

export function save(state, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, JSON.stringify(state)); } catch { /* almacenamiento lleno o bloqueado */ }
}

export const sessionPassed = (session) =>
  session.turns >= MIN_TURNS && session.score !== null && session.score >= PASS_SCORE;

export function recordSession(state, { level, scenarioId, turns, score }, now = new Date()) {
  const session = { date: now.toISOString(), level, scenarioId, turns, score };
  state.sessions.push(session);
  if (state.sessions.length > 400) state.sessions.splice(0, state.sessions.length - 400);
  return session;
}

export function scenarioStatus(state, scenarioId) {
  const sessions = state.sessions.filter((x) => x.scenarioId === scenarioId);
  const scores = sessions.map((x) => x.score).filter((v) => v !== null);
  return {
    attempts: sessions.length,
    best: scores.length ? Math.max(...scores) : null,
    passed: sessions.some(sessionPassed),
  };
}

export function levelProgress(state, level) {
  const graded = level.scenarios.filter((sc) => !sc.free);
  const passed = graded.filter((sc) => scenarioStatus(state, sc.id).passed).length;
  return { passed, total: graded.length, ready: passed >= Math.min(READY_TO_MOVE_UP, graded.length) };
}

const dayKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

// Días seguidos con al menos una sesión, contando hoy o ayer como último día válido.
export function streak(state, now = new Date()) {
  const days = new Set(state.sessions.map((x) => dayKey(x.date)));
  const cursor = new Date(now);
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (days.has(dayKey(cursor))) {
    count++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

export function addMistake(state, { level, original, review }, now = new Date()) {
  const mistake = {
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
    date: now.toISOString(),
    level,
    original,
    corrected: review.corrected,
    errors: review.errors,
    natural: review.natural || '',
    mastered: false,
  };
  state.mistakes.unshift(mistake);
  if (state.mistakes.length > 300) state.mistakes.length = 300;
  return mistake;
}

export function removeMistake(state, id) {
  state.mistakes = state.mistakes.filter((m) => m.id !== id);
}

export function setMastered(state, id, mastered = true) {
  const mistake = state.mistakes.find((m) => m.id === id);
  if (mistake) mistake.mastered = mastered;
}
