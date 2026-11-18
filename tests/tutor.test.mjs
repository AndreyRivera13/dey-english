import test from 'node:test';
import assert from 'node:assert/strict';
import * as tutor from '../js/tutor.js';
import { LEVELS, findScenario, getLevel } from '../js/curriculum.js';

const B1 = getLevel('B1');

test('looseEqual ignora mayúsculas, puntuación y tipo de apóstrofo', () => {
  assert.ok(tutor.looseEqual('I’m fine, thanks.', "i'm fine thanks"));
  assert.ok(!tutor.looseEqual('I work here', 'I worked here'));
});

test('diffWords marca solo las palabras que cambian', () => {
  const diff = tutor.diffWords('yesterday I work in the bug', 'Yesterday I worked on the bug.');
  assert.deepEqual(diff, [
    { type: 'same', text: 'Yesterday I' },
    { type: 'del', text: 'work in' },
    { type: 'add', text: 'worked on' },
    { type: 'same', text: 'the bug.' },
  ]);
});

test('diffWords no marca cambios de pura puntuación', () => {
  const diff = tutor.diffWords('ok let us start', 'OK, let us start.');
  assert.ok(diff.every((part) => part.type === 'same'));
});

test('parseCorrection: frase correcta queda aprobada', () => {
  const raw = JSON.stringify({ corrected: 'I think we should merge it.', errors: [], natural: '' });
  const review = tutor.parseCorrection(raw, 'i think we should merge it');
  assert.equal(review.status, 'ok');
  assert.equal(tutor.messageScore(review), 1);
});

test('parseCorrection: ignora errores si la frase corregida es igual a la original', () => {
  const raw = JSON.stringify({
    corrected: 'I agree with you',
    errors: [{ wrong: 'agree', right: 'am agree', type: 'grammar', why: 'x' }],
    natural: '',
  });
  assert.equal(tutor.parseCorrection(raw, 'I agree with you').status, 'ok');
});

test('parseCorrection: conserva errores reales y descarta los inventados', () => {
  const raw = JSON.stringify({
    corrected: 'I agree with you but I have a question',
    errors: [
      { wrong: 'I am agree', right: 'I agree', type: 'grammar', why: '"Agree" ya es verbo.' },
      { wrong: 'a doubt', right: 'a question', type: 'vocabulary', why: 'Se usa question.' },
      { wrong: 'the database', right: 'the databases', type: 'grammar', why: 'no está en la frase' },
      { wrong: 'with you', right: 'with you', type: 'grammar', why: 'sin cambio' },
      { wrong: 'a doubt', right: 'a question', type: 'bogus', why: 'repetido' },
    ],
    natural: '',
  });
  const review = tutor.parseCorrection(raw, 'I am agree with you but I have a doubt');
  assert.equal(review.status, 'changes');
  assert.deepEqual(review.errors.map((e) => e.wrong), ['I am agree', 'a doubt']);
  assert.equal(tutor.changeCount(review), 2);
  assert.equal(tutor.messageScore(review), 0.3);
});

test('parseCorrection: si el modelo responde en vez de corregir, falla', () => {
  const raw = JSON.stringify({ corrected: 'Sure, I can help you with the deployment today.', errors: [], natural: '' });
  assert.equal(tutor.parseCorrection(raw, 'yesterday I fix the login bug').status, 'failed');
});

test('parseCorrection: tolera texto alrededor del JSON y JSON roto', () => {
  const wrapped = 'Here you go:\n{"corrected": "I worked on it yesterday", "errors": [], "natural": ""}\nDone';
  assert.equal(tutor.parseCorrection(wrapped, 'I work on it yesterday').status, 'changes');
  assert.equal(tutor.parseCorrection('{"corrected": "I wor', 'I work on it yesterday').status, 'failed');
  assert.equal(tutor.parseCorrection('', 'I work on it yesterday').status, 'failed');
});

test('parseCorrection: frases de una palabra no se revisan', () => {
  assert.equal(tutor.parseCorrection('{}', 'Yes.').status, 'skip');
  assert.equal(tutor.messageScore({ status: 'skip' }), null);
});

test('parseCorrection: la versión natural solo aparece si el nivel la pide y aporta algo', () => {
  const raw = JSON.stringify({
    corrected: 'I have worked here for two years',
    errors: [],
    natural: 'I’ve been working here for two years',
  });
  const original = 'I have worked here since two years';
  assert.equal(tutor.parseCorrection(raw, original, { natural: true }).natural, 'I’ve been working here for two years');
  assert.equal(tutor.parseCorrection(raw, original, { natural: false }).natural, '');
});

test('sessionScore promedia las frases revisadas y cuenta tipos de error', () => {
  const ok = { status: 'ok' };
  const one = tutor.parseCorrection(
    JSON.stringify({ corrected: 'I worked on it', errors: [{ wrong: 'work', right: 'worked', type: 'grammar', why: '' }], natural: '' }),
    'I work on it');
  const result = tutor.sessionScore([ok, ok, one, { status: 'skip' }, { status: 'failed' }]);
  assert.equal(result.reviewed, 3);
  assert.equal(result.clean, 2);
  assert.equal(result.score, 87);
  assert.deepEqual(result.byType, { grammar: 1 });
});

test('buildChatMessages: sistema primero, alterna turnos y termina en el usuario', () => {
  const { level, scenario } = findScenario('b1-review');
  const history = [{ role: 'assistant', text: scenario.opener }];
  for (let i = 0; i < 10; i++) {
    history.push({ role: 'user', text: `u${i}` });
    if (i < 9) history.push({ role: 'assistant', text: `a${i}` });
  }
  const messages = tutor.buildChatMessages(level, scenario, history);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /CEFR level B1/);
  assert.equal(messages.at(-1).role, 'user');
  for (let i = 1; i < messages.length; i++) {
    assert.equal(messages[i].role, i % 2 === 1 ? 'user' : 'assistant');
  }
  assert.ok(messages.length <= 14);
});

test('buildCorrectionMessages incluye ejemplos y el mensaje a revisar', () => {
  const messages = tutor.buildCorrectionMessages(B1, 'I has a problem', 'What happened?');
  assert.equal(messages[0].role, 'system');
  assert.match(messages.at(-1).content, /I has a problem/);
  assert.match(messages.at(-1).content, /What happened\?/);
  // Los ejemplos deben pasar el mismo filtro que aplicamos al modelo.
  for (let i = 1; i < messages.length - 1; i += 2) {
    const original = messages[i].content.match(/"""([\s\S]*)"""/)[1];
    const review = tutor.parseCorrection(messages[i + 1].content, original);
    const expected = JSON.parse(messages[i + 1].content).errors.length;
    assert.equal(review.errors?.length ?? 0, expected);
  }
  assert.doesNotThrow(() => JSON.parse(tutor.CORRECTION_SCHEMA));
});

test('currículo: cuatro niveles con seis escenarios calificables e ids únicos', () => {
  assert.deepEqual(LEVELS.map((l) => l.id), ['A1', 'A2', 'B1', 'B2']);
  const ids = new Set();
  for (const level of LEVELS) {
    assert.equal(level.scenarios.filter((s) => !s.free).length, 6);
    assert.equal(level.scenarios.filter((s) => s.free).length, 1);
    for (const sc of level.scenarios) {
      assert.ok(!ids.has(sc.id), `id repetido: ${sc.id}`);
      ids.add(sc.id);
      assert.ok(sc.opener.trim().endsWith('?'), `${sc.id} debe abrir con una pregunta`);
      assert.ok(sc.phrases.length >= 3);
    }
  }
});

test('parseHints devuelve como máximo dos sugerencias limpias', () => {
  assert.deepEqual(tutor.parseHints('{"suggestions": ["I am a developer.", " ", "I use Java.", "extra"]}'), ['I am a developer.', 'I use Java.']);
  assert.deepEqual(tutor.parseHints('nope'), []);
});
