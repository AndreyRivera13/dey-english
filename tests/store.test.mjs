import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import { getLevel } from '../js/curriculum.js';

const A2 = getLevel('A2');

function memoryStorage() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
}

test('load devuelve el estado inicial si no hay nada o está dañado', () => {
  assert.equal(store.load(memoryStorage()).level, 'A1');
  const broken = memoryStorage();
  broken.setItem('devtalk.v1', '{nope');
  assert.deepEqual(store.load(broken), store.emptyState());
});

test('save y load conservan el progreso', () => {
  const storage = memoryStorage();
  const state = store.emptyState();
  state.level = 'B1';
  store.recordSession(state, { level: 'B1', scenarioId: 'b1-review', turns: 7, score: 80 });
  store.save(state, storage);
  const loaded = store.load(storage);
  assert.equal(loaded.level, 'B1');
  assert.equal(loaded.sessions.length, 1);
});

test('un escenario se supera con 6 frases o más y puntaje de 60 o más', () => {
  const state = store.emptyState();
  store.recordSession(state, { level: 'A2', scenarioId: 'a2-standup', turns: 5, score: 100 });
  assert.equal(store.scenarioStatus(state, 'a2-standup').passed, false);
  store.recordSession(state, { level: 'A2', scenarioId: 'a2-standup', turns: 8, score: 55 });
  assert.equal(store.scenarioStatus(state, 'a2-standup').passed, false);
  store.recordSession(state, { level: 'A2', scenarioId: 'a2-standup', turns: 6, score: 60 });
  const status = store.scenarioStatus(state, 'a2-standup');
  assert.equal(status.passed, true);
  assert.equal(status.best, 100);
  assert.equal(status.attempts, 3);
});

test('levelProgress cuenta solo escenarios calificables y avisa cuándo subir', () => {
  const state = store.emptyState();
  store.recordSession(state, { level: 'A2', scenarioId: 'a2-free', turns: 10, score: 100 });
  assert.deepEqual(store.levelProgress(state, A2), { passed: 0, total: 6, ready: false });
  for (const id of ['a2-standup', 'a2-bug', 'a2-access', 'a2-plans']) {
    store.recordSession(state, { level: 'A2', scenarioId: id, turns: 6, score: 75 });
  }
  assert.deepEqual(store.levelProgress(state, A2), { passed: 4, total: 6, ready: true });
});

test('streak cuenta días seguidos y tolera que hoy aún no haya sesión', () => {
  const state = store.emptyState();
  const day = (n) => new Date(2026, 10, n, 12);
  assert.equal(store.streak(state, day(16)), 0);
  for (const n of [13, 14, 15]) store.recordSession(state, { level: 'A1', scenarioId: 'a1-intro', turns: 6, score: 70 }, day(n));
  assert.equal(store.streak(state, day(15)), 3);
  assert.equal(store.streak(state, day(16)), 3);
  assert.equal(store.streak(state, day(17)), 0);
});

test('errores: agregar, dominar y eliminar', () => {
  const state = store.emptyState();
  const review = { corrected: 'I agree', errors: [{ wrong: 'I am agree', right: 'I agree', type: 'grammar', why: '' }], natural: '' };
  const a = store.addMistake(state, { level: 'A2', original: 'I am agree', review }, new Date(2026, 10, 1));
  const b = store.addMistake(state, { level: 'A2', original: 'I am agree too', review }, new Date(2026, 10, 2));
  assert.notEqual(a.id, b.id);
  assert.equal(state.mistakes[0].id, b.id);
  store.setMastered(state, a.id);
  assert.equal(state.mistakes.find((m) => m.id === a.id).mastered, true);
  store.removeMistake(state, b.id);
  assert.deepEqual(state.mistakes.map((m) => m.id), [a.id]);
});
