// Lógica del tutor: prompts, lectura de la corrección, diff y puntaje.
// Sin dependencias del navegador para poder probarla con node --test.

export const MIN_TURNS = 6;   // mensajes tuyos para que la sesión cuente
export const PASS_SCORE = 60; // puntaje mínimo para superar un escenario

export const ERROR_TYPES = {
  grammar: 'Gramática',
  vocabulary: 'Vocabulario',
  spelling: 'Ortografía',
  'word order': 'Orden',
  naturalness: 'Naturalidad',
};

// ---------- texto ----------

export const strip = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Igualdad que ignora mayúsculas y puntuación (el dictado por voz no las trae).
export const looseEqual = (a, b) => strip(a) === strip(b);

const tokens = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean);

function lcsTable(a, b) {
  const t = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  return t;
}

// Diff por palabras entre lo que dijiste y la versión corregida.
// Devuelve tramos {type: 'same' | 'del' | 'add', text}.
export function diffWords(original, corrected) {
  const a = tokens(original);
  const b = tokens(corrected);
  const ka = a.map(strip);
  const kb = b.map(strip);
  const t = lcsTable(ka, kb);
  const raw = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (ka[i] === kb[j]) { raw.push(['same', b[j]]); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) { raw.push(['del', a[i], ka[i]]); i++; }
    else { raw.push(['add', b[j], kb[j]]); j++; }
  }
  while (i < a.length) { raw.push(['del', a[i], ka[i]]); i++; }
  while (j < b.length) { raw.push(['add', b[j], kb[j]]); j++; }

  const out = [];
  for (const [type, text, key] of raw) {
    // Un signo de puntuación suelto no es un cambio que valga la pena marcar.
    if (type !== 'same' && key === '') { if (type === 'add') push(out, 'same', text); continue; }
    push(out, type, text);
  }
  return out;
}

function push(out, type, text) {
  const last = out[out.length - 1];
  if (last && last.type === type) last.text += ' ' + text;
  else out.push({ type, text });
}

export function similarity(a, b) {
  const ka = tokens(a).map(strip).filter(Boolean);
  const kb = tokens(b).map(strip).filter(Boolean);
  if (!ka.length || !kb.length) return 0;
  return (2 * lcsTable(ka, kb)[0][0]) / (ka.length + kb.length);
}

export const wordCount = (text) => tokens(text).map(strip).filter(Boolean).length;

// ---------- prompts ----------

const SYNTHETIC_START = '(The call starts now.)';

export function buildChatMessages(level, scenario, history, maxHistory = 12) {
  const system = [
    `You are ${scenario.role}. ${scenario.setting}`,
    `You are on a voice call with a Spanish-speaking software developer who is practicing spoken English at CEFR level ${level.id}.`,
    `How you speak: ${level.aiStyle}`,
    'Rules:',
    `- Stay in character. Everything you write is spoken aloud, so answer in ${level.id === 'B2' ? '2 to 4' : '1 to 3'} short sentences.`,
    '- Always finish with ONE question or request that keeps the conversation moving.',
    '- Never correct their English and never mention their mistakes. Another tool does that. Just understand them and respond naturally.',
    '- If they speak Spanish, answer in simple English and invite them to try again in English.',
    '- Plain text only: no lists, no markdown, no emojis, no stage directions.',
  ].join('\n');

  const recent = history.slice(-maxHistory).map((m) => ({ role: m.role, content: m.text }));
  if (!recent.length || recent[0].role === 'assistant') {
    recent.unshift({ role: 'user', content: SYNTHETIC_START });
  }
  return [{ role: 'system', content: system }, ...recent];
}

export const CORRECTION_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    corrected: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          wrong: { type: 'string' },
          right: { type: 'string' },
          type: { type: 'string', enum: Object.keys(ERROR_TYPES) },
          why: { type: 'string' },
        },
        required: ['wrong', 'right', 'type', 'why'],
      },
    },
    natural: { type: 'string' },
  },
  required: ['corrected', 'errors', 'natural'],
});

const shot = (message, answer) => [
  { role: 'user', content: `Message: """${message}"""` },
  { role: 'assistant', content: JSON.stringify(answer) },
];

const FEW_SHOTS = [
  ...shot('yesterday I work in the login bug and today I will to fix the tests', {
    corrected: 'Yesterday I worked on the login bug and today I will fix the tests.',
    errors: [
      { wrong: 'I work', right: 'I worked', type: 'grammar', why: 'Con "yesterday" va el pasado simple: worked.' },
      { wrong: 'in the login bug', right: 'on the login bug', type: 'vocabulary', why: 'Se dice "work on" algo, no "work in".' },
      { wrong: 'will to fix', right: 'will fix', type: 'grammar', why: 'Después de "will" va el verbo sin "to".' },
    ],
    natural: '',
  }),
  ...shot('I think we should merge it after the tests pass', {
    corrected: 'I think we should merge it after the tests pass',
    errors: [],
    natural: '',
  }),
  ...shot('I am agree with you but I have a doubt about the database', {
    corrected: 'I agree with you but I have a question about the database',
    errors: [
      { wrong: 'I am agree', right: 'I agree', type: 'grammar', why: '"Agree" ya es verbo; no lleva "am".' },
      { wrong: 'a doubt', right: 'a question', type: 'vocabulary', why: 'Para preguntar se usa "question"; "doubt" es desconfianza.' },
    ],
    natural: '',
  }),
];

export function buildCorrectionMessages(level, text, previousLine = '') {
  const system = [
    `You are a precise English teacher. You correct ONE message said by a Spanish-speaking software developer at CEFR level ${level.id}.`,
    'Answer ONLY with JSON in this shape:',
    '{"corrected": string, "errors": [{"wrong": string, "right": string, "type": "grammar" | "vocabulary" | "spelling" | "word order" | "naturalness", "why": string}], "natural": string}',
    'Rules:',
    '- "corrected": their message with every real mistake fixed. Keep their meaning and keep every word that is already correct. Do not answer the message and do not add new ideas.',
    '- If the message has no mistakes, "corrected" is identical to the message and "errors" is [].',
    '- "wrong" is copied exactly from their message. "right" is how that fragment appears in "corrected".',
    '- "why": one short sentence in Spanish that explains the rule.',
    level.natural
      ? '- "natural": a more natural way a native-speaking developer would say the same thing, or "" if "corrected" already sounds natural.'
      : '- "natural": always "".',
    '- The message comes from speech recognition: ignore capital letters and punctuation.',
    '- Technical words (deploy, endpoint, pull request, standup, backend, sprint) are correct English.',
    `- ${level.strictness}`,
  ].join('\n');

  const context = previousLine ? `They are replying to: """${previousLine}"""\n` : '';
  return [
    { role: 'system', content: system },
    ...FEW_SHOTS,
    { role: 'user', content: `${context}Message: """${text}"""` },
  ];
}

export const HINT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { suggestions: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 } },
  required: ['suggestions'],
});

export function buildHintMessages(level, scenario, lastLine) {
  return [
    {
      role: 'system',
      content: [
        `You help an English learner (CEFR ${level.id}) who does not know what to say next in a conversation.`,
        `Write exactly two different things THEY could say next, in English, using ${level.learnerStyle}.`,
        'Answer ONLY with JSON: {"suggestions": ["...", "..."]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Situation: ${scenario.setting}\nThe other person (${scenario.role}) just said: """${lastLine}"""`,
    },
  ];
}

export function buildTranslateMessages(text) {
  return [
    {
      role: 'system',
      content: 'Translate the English text into natural Latin American Spanish. Answer with the translation only.',
    },
    { role: 'user', content: text },
  ];
}

// ---------- lectura de respuestas del modelo ----------

export function extractJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw ?? '');
  try { return JSON.parse(text); } catch { /* sigue */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

const str = (value) => (typeof value === 'string' ? value.trim() : '');
// Quita comillas solo cuando envuelven toda la frase.
const clean = (value) => str(value).replace(/^"([^"]*)"$/, '$1').trim();

// Convierte la respuesta del modelo en una revisión confiable.
// status: 'ok' (sin cambios) | 'changes' | 'skip' (muy corto) | 'failed'
export function parseCorrection(raw, original, { natural: wantsNatural = false } = {}) {
  if (wordCount(original) < 2) return { status: 'skip' };

  const data = extractJson(raw);
  const corrected = clean(data?.corrected);
  if (!corrected) return { status: 'failed' };

  let natural = wantsNatural ? clean(data.natural) : '';
  if (natural && (looseEqual(natural, corrected) || looseEqual(natural, original))) natural = '';
  // Una "versión natural" que no se parece a lo dicho es otra frase, no una mejora.
  if (natural && similarity(original, natural) < 0.25) natural = '';

  if (looseEqual(corrected, original)) {
    return { status: 'ok', corrected: original, errors: [], natural, diff: [] };
  }

  // Si casi nada coincide, el modelo respondió el mensaje en vez de corregirlo.
  if (similarity(original, corrected) < 0.5) return { status: 'failed' };

  const o = ` ${strip(original)} `;
  const c = ` ${strip(corrected)} `;
  const seen = new Set();
  const errors = (Array.isArray(data.errors) ? data.errors : [])
    .map((e) => ({
      wrong: clean(e?.wrong),
      right: clean(e?.right),
      type: Object.hasOwn(ERROR_TYPES, e?.type) ? e.type : 'grammar',
      why: str(e?.why).slice(0, 220),
    }))
    .filter((e) => {
      if (!e.wrong || !e.right || looseEqual(e.wrong, e.right)) return false;
      // Descarta lo que el modelo inventó: el error debe estar en lo dicho
      // y el arreglo debe estar en la versión corregida.
      if (!o.includes(` ${strip(e.wrong)} `) || !c.includes(` ${strip(e.right)} `)) return false;
      const key = strip(e.wrong);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);

  return { status: 'changes', corrected, errors, natural, diff: diffWords(original, corrected) };
}

export function parseHints(raw) {
  const data = extractJson(raw);
  const list = Array.isArray(data?.suggestions) ? data.suggestions : [];
  return list.map(clean).filter(Boolean).slice(0, 2);
}

// ---------- puntaje ----------

export function changeCount(review) {
  if (review?.status !== 'changes') return 0;
  // Un tramo borrado seguido de uno agregado es un solo cambio.
  let groups = 0;
  let inChange = false;
  for (const d of review.diff) {
    if (d.type === 'same') inChange = false;
    else if (!inChange) { groups++; inChange = true; }
  }
  return Math.max(1, review.errors.length, Math.min(groups, 5));
}

export function messageScore(review) {
  if (!review || review.status === 'skip' || review.status === 'failed') return null;
  if (review.status === 'ok') return 1;
  const n = changeCount(review);
  return n === 1 ? 0.6 : n === 2 ? 0.3 : 0;
}

export function sessionScore(reviews) {
  const scores = reviews.map(messageScore).filter((v) => v !== null);
  const byType = {};
  for (const r of reviews) {
    if (r?.status !== 'changes') continue;
    for (const e of r.errors) byType[e.type] = (byType[e.type] || 0) + 1;
  }
  return {
    reviewed: scores.length,
    clean: scores.filter((v) => v === 1).length,
    score: scores.length ? Math.round((100 * scores.reduce((a, b) => a + b, 0)) / scores.length) : null,
    byType,
  };
}
