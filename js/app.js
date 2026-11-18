import { LEVELS, getLevel, findScenario, roleName } from './curriculum.js';
import * as tutor from './tutor.js';
import * as store from './store.js';
import * as llm from './engine.js';
import * as speech from './speech.js';

const app = document.getElementById('app');
const dialog = document.getElementById('dialog');
const state = store.load();
const persist = () => store.save(state);

// ---------- utilidades de DOM ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const svg = (path) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICON = {
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  end: svg('<path d="M3 15c0-2 4-5 9-5s9 3 9 5v2l-4 1-1-3a12 12 0 0 0-8 0l-1 3-4-1z"/>'),
};

function ctl(label, { icon, pressed, cls = '', ...rest } = {}) {
  const button = h('button', {
    class: `ctl ${cls}`, type: 'button',
    'aria-pressed': pressed === undefined ? null : String(pressed), ...rest,
  });
  if (icon) button.insertAdjacentHTML('beforeend', icon);
  button.append(h('span', {}, label));
  return button;
}

let cleanup = [];
function runCleanup() {
  for (const fn of cleanup) { try { fn(); } catch { /* sigue con los demás */ } }
  cleanup = [];
}

function showDialog(title, body, actions, onClose) {
  dialog.replaceChildren(h('h2', {}, title), h('div', { class: 'body' }, body), h('div', { class: 'actions' }, actions));
  dialog.onclose = onClose || null;
  if (!dialog.open) dialog.showModal();
}
function closeDialog() {
  dialog.onclose = null;
  if (dialog.open) dialog.close();
}

function renderDiff(original, corrected) {
  return h('p', { class: 'diff' }, tutor.diffWords(original, corrected).flatMap((part) => [
    part.type === 'del' ? h('del', {}, part.text) : part.type === 'add' ? h('ins', {}, part.text) : part.text,
    ' ',
  ]));
}

function renderWhys(errors) {
  if (!errors.length) return null;
  return h('ul', { class: 'whys' }, errors.map((e) =>
    h('li', {}, h('span', { class: 'type' }, `${tutor.ERROR_TYPES[e.type]}: `), e.why || `${e.wrong} → ${e.right}`)));
}

// ---------- modelo ----------

const model = {
  status: llm.isReady() ? 'ready' : 'idle',
  progress: 0, text: '', error: '', choosing: false,
  pick: state.tier, cached: {}, support: null,
};
const modelListeners = new Set();
function setModel(patch) {
  Object.assign(model, patch);
  for (const fn of [...modelListeners]) fn();
}

async function initModel() {
  const support = await llm.detectSupport();
  setModel({ support });
  if (!support.ok) return;
  const cached = {};
  for (const m of llm.MODELS) cached[m.tier] = await llm.isDownloaded(m.tier);
  setModel({ cached });
}

async function startLoad(tier) {
  state.tier = tier;
  persist();
  setModel({ status: 'loading', progress: 0, text: '', error: '' });
  try {
    await llm.loadModel(tier, ({ progress, text }) => setModel({ progress, text }));
    setModel({ status: 'ready', choosing: false, cached: { ...model.cached, [tier]: true } });
  } catch (error) {
    setModel({ status: llm.isReady() ? 'ready' : 'error', choosing: true, error: llm.friendlyError(error) });
  }
}

function modelPanelContent() {
  if (model.support && !model.support.ok) {
    return [h('h3', {}, 'Este equipo no puede correr el modelo'), h('p', { class: 'notice' }, model.support.reason)];
  }
  if (model.status === 'loading') {
    const percent = Math.round(model.progress * 100);
    const downloading = /fetch/i.test(model.text);
    return [
      h('h3', {}, downloading ? `Descargando el modelo: ${percent} %` : 'Cargando el modelo en la tarjeta gráfica'),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(percent), 'aria-valuemin': '0', 'aria-valuemax': '100' },
        h('div', { style: `width:${percent}%` })),
      h('p', { class: 'muted small' }, 'La descarga solo ocurre la primera vez. No cierres esta pestaña.'),
    ];
  }
  if (model.status === 'ready' && !model.choosing) {
    return [h('div', { class: 'model-head' },
      h('div', { class: 'model-ready' }, h('span', { class: 'dot' }), `Modelo activo: ${llm.getModel(llm.currentTier()).name}`),
      h('button', { class: 'btn', type: 'button', onclick: () => setModel({ choosing: true, pick: llm.currentTier() }) }, 'Cambiar modelo'))];
  }
  const picked = llm.getModel(model.pick);
  return [
    h('div', {},
      h('h3', {}, 'Elige el modelo de IA'),
      h('p', { class: 'muted small' }, 'Corre en tu equipo, sin cuentas ni pagos. Se descarga una sola vez y queda guardado en este navegador.')),
    h('div', { class: 'tiers', role: 'radiogroup', 'aria-label': 'Modelo de IA' }, llm.MODELS.map((m) =>
      h('label', { class: 'tier' },
        h('input', { type: 'radio', name: 'tier', value: m.tier, checked: m.tier === model.pick, onchange: () => setModel({ pick: m.tier }) }),
        h('span', { class: 'tier-body' },
          h('span', { class: 'tier-name' }, m.name),
          h('span', { class: 'tier-size' }, `Descarga de ${m.download}, usa ${m.memory} de memoria gráfica`),
          h('span', { class: 'tier-note' }, m.note),
          model.cached[m.tier] && h('span', { class: 'tier-cached' }, 'Ya está descargado'))))),
    model.error && h('p', { class: 'notice' }, model.error),
    h('div', { class: 'model-head' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => startLoad(model.pick) },
        model.cached[picked.tier] ? `Activar ${picked.name}` : `Descargar y activar (${picked.download})`),
      model.status === 'ready' && h('button', { class: 'btn', type: 'button', onclick: () => setModel({ choosing: false, error: '' }) }, 'Cancelar')),
  ];
}

function modelPanel() {
  const box = h('section', { class: 'model', 'aria-live': 'polite' });
  const draw = () => box.replaceChildren(...modelPanelContent().filter(Boolean));
  draw();
  modelListeners.add(draw);
  cleanup.push(() => modelListeners.delete(draw));
  return box;
}

// ---------- inicio: niveles y escenarios ----------

function viewHome() {
  const level = getLevel(state.level);
  const days = store.streak(state);
  const progress = store.levelProgress(state, level);
  const next = LEVELS[LEVELS.indexOf(level) + 1];

  const ladder = h('div', { class: 'ladder', role: 'group', 'aria-label': 'Niveles' }, LEVELS.map((l) => {
    const p = store.levelProgress(state, l);
    return h('button', {
      class: 'step', type: 'button', 'aria-pressed': String(l.id === level.id),
      onclick: () => { state.level = l.id; persist(); route(false); },
    },
      h('span', { class: 'step-fill', style: `height:${(100 * p.passed) / p.total}%` }),
      h('span', { class: 'step-id' }, l.id),
      h('span', { class: 'step-name' }, l.name),
      h('span', { class: 'step-count' }, `${p.passed} de ${p.total} superados`));
  }));

  const scenarios = h('div', { class: 'scenarios' }, level.scenarios.map((sc) => {
    const st = store.scenarioStatus(state, sc.id);
    const stateText = sc.free ? 'No cuenta para el nivel'
      : st.passed ? `Superado, mejor puntaje ${st.best}`
      : st.best !== null ? `Mejor puntaje ${st.best}`
      : st.attempts ? 'Sin puntaje todavía' : 'Sin intentar';
    return h('a', { class: 'scenario', href: `#/llamada/${sc.id}` },
      h('h3', {}, sc.title),
      h('p', { class: 'goal' }, sc.goal),
      h('p', { class: `state${st.passed ? ' passed' : ''}` }, stateText, h('span', { class: 'call-cue' }, 'Llamar')));
  }));

  app.replaceChildren(
    h('section', { class: 'intro' },
      h('h1', {}, 'Practica inglés en llamadas sobre tu trabajo'),
      h('p', {}, 'Hablas por micrófono y la IA te responde con voz. Cada frase tuya vuelve revisada como un pull request: qué cambia y por qué.'),
      days > 0 && h('p', { class: 'streak' }, days === 1 ? 'Llevas 1 día practicando.' : `Llevas ${days} días seguidos practicando.`)),
    modelPanel(),
    ladder,
    h('section', { class: 'level' },
      h('div', { class: 'level-about' },
        h('h2', {}, `Nivel ${level.id}: ${level.name}`),
        h('p', { class: 'can' }, level.can),
        progress.ready && next && h('p', { class: 'move-up' },
          `Ya superaste ${progress.passed} escenarios de ${level.id}.`,
          h('button', { type: 'button', onclick: () => { state.level = next.id; persist(); route(false); } }, `Pasa a ${next.id}`)),
        h('h3', {}, 'Lo que vas a practicar'),
        h('ul', { class: 'focus' }, level.focus.map((f) => h('li', {}, f)))),
      scenarios),
    h('footer', { class: 'foot' },
      h('p', {}, 'El modelo corre en tu equipo: tus conversaciones no se suben a ningún servidor. El dictado por voz lo hace el navegador.'),
      h('button', { class: 'btn-quiet btn', type: 'button', onclick: confirmReset }, 'Borrar mi progreso')),
  );
}

function confirmReset() {
  showDialog('¿Borrar tu progreso?',
    h('p', {}, 'Se eliminan las llamadas registradas y la lista de errores de este navegador. El modelo descargado se conserva.'),
    [
      h('button', {
        class: 'btn btn-danger', type: 'button',
        onclick: () => { Object.assign(state, store.emptyState(), { tier: state.tier }); persist(); closeDialog(); route(false); },
      }, 'Borrar progreso'),
      h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancelar'),
    ]);
}

// ---------- llamada ----------

const PHASE_LABEL = {
  lobby: 'te espera',
  thinking: 'pensando…',
  speaking: 'hablando',
  listening: 'te escucha',
  waiting: 'espera tu respuesta',
  ended: 'llamada terminada',
};
const SILENCE_MS = { A1: 2500, A2: 2300, B1: 2000, B2: 1800 };

function viewCall({ level, scenario }) {
  const name = roleName(scenario);
  const call = {
    phase: 'lobby', history: [], entries: [], lastAi: '',
    micOn: speech.canListen, speaker: null,
    alive: true, ended: false, streaming: false,
  };

  // --- escenario ---
  const root = h('div', { class: `call${state.captions ? '' : ' captions-off'}`, 'data-phase': 'lobby' });
  const youTile = h('div', { class: 'tile tile-you' },
    h('div', { class: 'avatar avatar-you', 'aria-hidden': 'true' }, 'Tú'),
    h('div', { class: 'tile-label' }, h('strong', {}, 'Tú')));
  const aiStatus = h('span', {}, PHASE_LABEL.lobby);
  const caption = h('p', { class: 'caption', 'aria-live': 'polite' });
  const controls = h('div', { class: 'controls' });
  const modelSlot = h('div', {}, modelPanel());
  const stage = h('section', { class: 'stage', 'aria-label': 'Llamada' },
    h('div', { class: 'tiles' },
      h('div', { class: 'tile tile-ai' },
        h('div', { class: 'avatar', 'aria-hidden': 'true' }, name[0]),
        h('div', { class: 'tile-label' }, h('strong', {}, name), aiStatus)),
      youTile),
    caption, modelSlot, controls);

  // --- panel lateral ---
  const feed = h('div', { class: 'feed', role: 'log', 'aria-label': 'Revisión de tus frases' });
  const meter = h('span', { class: 'meter' });
  const hints = h('div', { class: 'hints', 'aria-live': 'polite' });
  const input = h('input', {
    type: 'text', placeholder: 'Escribe si prefieres no hablar', autocomplete: 'off', spellcheck: false,
    'aria-label': 'Escribe tu respuesta en inglés', disabled: true,
  });
  const sendBtn = h('button', { class: 'btn', type: 'submit', disabled: true }, 'Enviar');
  const hintBtn = h('button', { class: 'btn btn-quiet', type: 'button', disabled: true, onclick: askHint }, 'No sé qué decir, dame una pista');

  const side = h('aside', { class: 'side' },
    h('section', { class: 'brief' },
      h('p', { class: 'level-tag' }, `Nivel ${level.id}`),
      h('h2', {}, scenario.title),
      h('dl', {},
        h('div', {}, h('dt', {}, 'Tu objetivo'), h('dd', {}, scenario.goal)),
        h('div', {}, h('dt', {}, 'Hablas con'), h('dd', { lang: 'en' }, scenario.role))),
      h('details', {},
        h('summary', {}, 'Frases útiles (tócalas para oírlas)'),
        h('div', { class: 'phrases', lang: 'en' }, scenario.phrases.map((phrase) =>
          h('button', { type: 'button', onclick: () => replay(phrase) }, phrase))))),
    h('section', { class: 'feed-wrap' },
      h('div', { class: 'feed-head' }, h('h3', {}, 'Revisión en vivo'), meter),
      feed,
      hints,
      h('form', { class: 'typebox', onsubmit: (event) => { event.preventDefault(); const text = input.value; input.value = ''; userSaid(text); } }, input, sendBtn),
      hintBtn));

  root.append(stage, side);
  app.replaceChildren(root);

  const listener = speech.createListener({
    silenceMs: SILENCE_MS[level.id],
    onInterim: (text) => setCaption('Tú', text, true),
    onFinal: (text) => userSaid(text),
    onState: (s) => {
      if (!call.alive || call.ended) return;
      if (s === 'listening') {
        setPhase('listening');
        setCaption('Tú', 'Te escucho. Habla en inglés.', true);
      } else if (s === 'denied') {
        call.micOn = false;
        setPhase('waiting');
        setCaption('', 'El navegador bloqueó el micrófono. Permítelo desde el candado de la barra de direcciones o escribe tu respuesta.');
      }
    },
  });

  function setPhase(phase) {
    call.phase = phase;
    root.dataset.phase = phase;
    aiStatus.textContent = PHASE_LABEL[phase];
    const canType = phase === 'listening' || phase === 'waiting';
    input.disabled = sendBtn.disabled = hintBtn.disabled = !canType;
    drawControls();
  }

  function setCaption(who, text, isYou = false) {
    caption.className = `caption${isYou ? ' is-you' : ''}`;
    caption.replaceChildren(...[
      who && h('span', { class: 'who' }, who),
      h('span', { class: 'words', lang: who ? 'en' : null }, text),
    ].filter(Boolean));
  }

  // --- controles ---
  function drawControls() {
    if (call.phase === 'lobby') {
      const ready = llm.isReady();
      controls.replaceChildren(ctl(ready ? 'Entrar a la llamada' : 'Activa el modelo para entrar', {
        cls: 'ctl-start', disabled: !ready, onclick: enter,
      }));
      return;
    }
    if (call.phase === 'ended') return controls.replaceChildren();
    controls.replaceChildren(...[
      ctl('Micrófono', {
        icon: ICON.mic, pressed: call.micOn, disabled: !speech.canListen, onclick: toggleMic,
        title: speech.canListen ? null : 'Este navegador no tiene dictado por voz',
      }),
      ctl('Subtítulos', { pressed: state.captions, onclick: toggleCaptions }),
      ctl('Repetir', { disabled: !call.lastAi || call.phase === 'thinking' || call.phase === 'speaking', onclick: () => replay(call.lastAi) }),
      call.phase === 'listening' && ctl('Terminé de hablar', { cls: 'ctl-send', onclick: () => listener.finishNow() }),
      ctl('Colgar', { icon: ICON.end, cls: 'ctl-end', onclick: hangUp }),
    ].filter(Boolean));
  }

  function toggleMic() {
    call.micOn = !call.micOn;
    if (!call.micOn) {
      listener.stop();
      if (call.phase === 'listening') { setPhase('waiting'); setCaption('', 'Micrófono apagado. Enciéndelo o escribe tu respuesta.'); }
    } else if (call.phase === 'waiting') {
      listen();
    }
    drawControls();
  }

  function toggleCaptions() {
    state.captions = !state.captions;
    persist();
    root.classList.toggle('captions-off', !state.captions);
    drawControls();
  }

  // --- conversación ---
  function drawMeter() {
    const n = call.entries.length;
    const done = n >= tutor.MIN_TURNS;
    meter.className = `meter${done && !scenario.free ? ' done' : ''}`;
    meter.textContent = scenario.free ? 'Tema libre: no cuenta para el nivel'
      : done ? 'Ya cuenta para tu nivel'
      : `${n} de ${tutor.MIN_TURNS} frases para que cuente`;
  }

  const scrollFeed = () => { feed.scrollTop = feed.scrollHeight; };

  function addAiLine(text) {
    const textEl = h('span', { class: 'text', lang: 'en' }, text);
    const es = h('span', { class: 'es', hidden: true });
    const translateBtn = h('button', {
      class: 'btn btn-quiet', type: 'button',
      onclick: async () => {
        translateBtn.disabled = true;
        es.hidden = false;
        es.textContent = 'Traduciendo…';
        try {
          es.textContent = await llm.complete(tutor.buildTranslateMessages(textEl.textContent), { maxTokens: 200, kind: 'translate' });
        } catch {
          es.textContent = 'No se pudo traducir.';
          translateBtn.disabled = false;
        }
      },
    }, 'En español');
    const el = h('div', { class: 'line-ai' },
      h('span', { class: 'name' }, `${name}: `), textEl, es,
      h('div', { class: 'tools' },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => replay(textEl.textContent) }, 'Escuchar'),
        translateBtn));
    feed.append(el);
    scrollFeed();
    return { setText(value) { textEl.textContent = value; scrollFeed(); }, remove() { el.remove(); } };
  }

  function addUserEntry(text) {
    const reviewEl = h('div', { class: 'review' }, 'Revisando…');
    const entry = { text, review: null, mistake: null, reviewEl, reviewing: null };
    feed.append(h('div', { class: 'line-you' }, h('p', { class: 'said', lang: 'en' }, text), reviewEl));
    call.entries.push(entry);
    drawMeter();
    scrollFeed();
    return entry;
  }

  function drawReview(entry) {
    const { review, reviewEl } = entry;
    reviewEl.hidden = false;
    if (review.status === 'ok') {
      reviewEl.className = 'review ok';
      reviewEl.replaceChildren(...['Aprobado sin cambios',
        review.natural && h('p', { class: 'natural' }, h('strong', {}, 'Más natural: '), h('span', { lang: 'en' }, review.natural)),
      ].filter(Boolean));
    } else if (review.status === 'changes') {
      const n = tutor.changeCount(review);
      reviewEl.className = 'review changes';
      reviewEl.replaceChildren(...[
        h('p', { class: 'review-title' }, n === 1 ? '1 cambio sugerido' : `${n} cambios sugeridos`),
        renderDiff(entry.text, review.corrected),
        renderWhys(review.errors),
        review.natural && h('p', { class: 'natural' }, h('strong', {}, 'Más natural: '), h('span', { lang: 'en' }, review.natural)),
        h('div', { class: 'review-actions' },
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => replay(review.corrected) }, 'Oír la corrección'),
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => discardReview(entry) }, 'No dije eso')),
      ].filter(Boolean));
    } else if (review.status === 'failed') {
      reviewEl.className = 'review';
      reviewEl.replaceChildren('No se pudo revisar esta frase.');
    } else {
      reviewEl.hidden = true;
    }
    scrollFeed();
  }

  // El dictado a veces oye mal: esto saca la frase del puntaje y de "Mis errores".
  function discardReview(entry) {
    if (entry.mistake) { store.removeMistake(state, entry.mistake.id); persist(); }
    entry.mistake = null;
    entry.review = { status: 'skip' };
    drawReview(entry);
  }

  async function reviewEntry(entry, previousLine) {
    if (tutor.wordCount(entry.text) < 2) {
      entry.review = { status: 'skip' };
    } else {
      try {
        const raw = await llm.complete(tutor.buildCorrectionMessages(level, entry.text, previousLine),
          { schema: tutor.CORRECTION_SCHEMA, kind: 'correction' });
        entry.review = tutor.parseCorrection(raw, entry.text, { natural: level.natural });
      } catch {
        entry.review = { status: 'failed' };
      }
    }
    if (entry.review.status === 'changes') {
      entry.mistake = store.addMistake(state, { level: level.id, original: entry.text, review: entry.review });
      persist();
    }
    if (call.alive) drawReview(entry);
  }

  function listen() {
    if (!call.alive || call.ended) return;
    if (call.micOn && listener) return listener.start();
    setPhase('waiting');
    setCaption('', speech.canListen
      ? 'Micrófono apagado. Enciéndelo o escribe tu respuesta.'
      : 'Este navegador no tiene dictado por voz. Escribe tu respuesta o abre DevTalk en Chrome.');
  }

  // La IA dice un texto ya conocido (el saludo inicial o una repetición).
  async function sayAloud(text, who = name) {
    listener?.stop();
    call.speaker?.cancel();
    setPhase('speaking');
    setCaption(who, text);
    const speaker = (call.speaker = speech.createSpeaker({ rate: level.rate }));
    speaker.feed(`${text} `);
    speaker.end();
    await speaker.done;
    if (call.speaker === speaker) listen();
  }

  function replay(text) {
    if (!text || call.ended || call.phase === 'thinking' || call.phase === 'speaking') return;
    if (call.phase === 'lobby') return void speech.speakOnce(text, level.rate);
    sayAloud(text, '');
  }

  async function enter() {
    modelSlot.remove();
    call.history.push({ role: 'assistant', text: scenario.opener });
    call.lastAi = scenario.opener;
    addAiLine(scenario.opener);
    await sayAloud(scenario.opener);
  }

  async function userSaid(rawText) {
    const text = rawText.trim();
    if (!text || call.ended || !(call.phase === 'listening' || call.phase === 'waiting')) return;
    listener?.stop();
    const previousLine = call.lastAi;
    call.history.push({ role: 'user', text });
    const entry = addUserEntry(text);
    hints.replaceChildren();
    setPhase('thinking');
    setCaption(name, '…');

    const speaker = (call.speaker = speech.createSpeaker({ rate: level.rate }));
    const line = addAiLine('');
    let reply = '';
    call.streaming = true;
    try {
      reply = await llm.chatStream(tutor.buildChatMessages(level, scenario, call.history), {
        onToken: (piece, full) => {
          if (!call.alive || call.ended) return;
          if (call.phase === 'thinking') setPhase('speaking');
          speaker.feed(piece);
          line.setText(full);
          setCaption(name, full);
        },
      });
    } catch (error) {
      call.streaming = false;
      speaker.cancel();
      if (!call.alive || call.ended) return;
      line.remove();
      call.history.pop();
      entry.review = { status: 'skip' };
      drawReview(entry);
      setPhase('waiting');
      setCaption('', `La IA no pudo responder. ${llm.friendlyError(error)}`);
      return;
    }
    call.streaming = false;
    if (!call.alive || call.ended) return speaker.cancel();

    reply ||= 'Sorry, could you say that again?';
    call.history.push({ role: 'assistant', text: reply });
    call.lastAi = reply;
    line.setText(reply);
    setCaption(name, reply);
    setPhase('speaking');
    speaker.end();
    // La revisión corre mientras la IA habla.
    entry.reviewing = reviewEntry(entry, previousLine);
    await speaker.done;
    if (call.speaker === speaker) listen();
  }

  async function askHint() {
    hintBtn.disabled = true;
    hints.replaceChildren(h('p', { class: 'muted small' }, 'Buscando ideas…'));
    let list = [];
    try {
      const raw = await llm.complete(tutor.buildHintMessages(level, scenario, call.lastAi),
        { schema: tutor.HINT_SCHEMA, temperature: 0.6, maxTokens: 120, kind: 'hint' });
      list = tutor.parseHints(raw);
    } catch { /* se muestra el mensaje de abajo */ }
    if (!call.alive) return;
    hints.replaceChildren(...(list.length
      ? [h('p', { class: 'muted small' }, 'Podrías decir:'), ...list.map((t) => h('p', { lang: 'en' }, t))]
      : [h('p', { class: 'muted small' }, 'No salió ninguna idea. Inténtalo otra vez.')]));
    hintBtn.disabled = !(call.phase === 'listening' || call.phase === 'waiting');
  }

  // --- colgar ---
  function shutdown() {
    listener?.stop();
    call.speaker?.cancel();
    speech.stopSpeaking();
    if (call.streaming) llm.interrupt();
  }

  async function hangUp() {
    if (call.ended) return;
    call.ended = true;
    shutdown();
    setPhase('ended');
    setCaption('', 'Terminando la revisión de tus frases…');
    await Promise.allSettled(call.entries.map((e) => e.reviewing));
    if (!call.alive) return;

    const reviews = call.entries.map((e) => e.review).filter(Boolean);
    const result = tutor.sessionScore(reviews);
    const turns = call.entries.length;
    let session = null;
    if (turns > 0) {
      session = store.recordSession(state, { level: level.id, scenarioId: scenario.id, turns, score: result.score });
      persist();
    }
    setCaption('', 'Llamada terminada.');
    showSummary({ level, scenario, result, turns, session });
  }

  cleanup.push(() => { call.alive = false; shutdown(); });
  const onModel = () => { if (call.phase === 'lobby') drawControls(); };
  modelListeners.add(onModel);
  cleanup.push(() => modelListeners.delete(onModel));

  drawMeter();
  drawControls();
  setCaption('', `${name} te espera. Entra cuando quieras: empieza saludando y tú respondes en voz alta.`);
}

function showSummary({ scenario, result, turns, session }) {
  const passed = Boolean(session) && !scenario.free && store.sessionPassed(session);
  const types = Object.entries(result.byType).sort((a, b) => b[1] - a[1]);
  const verdict = scenario.free ? 'El tema libre no cuenta para subir de nivel.'
    : passed ? 'Escenario superado.'
    : turns < tutor.MIN_TURNS ? `Para que cuente necesitas al menos ${tutor.MIN_TURNS} frases; dijiste ${turns}.`
    : `Para superarlo necesitas ${tutor.PASS_SCORE} o más.`;

  const leave = (hash) => () => {
    closeDialog();
    if (location.hash === hash) route();
    else location.hash = hash;
  };

  showDialog('Llamada terminada',
    [
      result.score !== null
        ? h('p', { class: 'score' }, `Puntaje: ${result.score} de 100`)
        : h('p', { class: 'score' }, 'No hubo frases para revisar'),
      result.reviewed > 0 && h('p', {}, `${result.clean} de ${result.reviewed} frases revisadas quedaron sin cambios.`),
      h('p', { class: `verdict${passed ? ' pass' : ''}` }, verdict),
      types.length > 0 && h('p', { class: 'muted' },
        `Lo que más se repitió: ${types.map(([type, n]) => `${tutor.ERROR_TYPES[type].toLowerCase()} (${n})`).join(', ')}.`),
    ],
    [
      h('button', { class: 'btn btn-primary', type: 'button', onclick: leave('#/') }, 'Volver a los niveles'),
      h('button', { class: 'btn', type: 'button', onclick: leave(location.hash) }, 'Repetir la llamada'),
      result.reviewed > result.clean && h('button', { class: 'btn', type: 'button', onclick: leave('#/errores') }, 'Repasar mis errores'),
    ],
    () => { location.hash = '#/'; });
}

// ---------- mis errores ----------

let notebookFilter = 'pending';

function viewNotebook() {
  const pending = state.mistakes.filter((m) => !m.mastered);
  const mastered = state.mistakes.filter((m) => m.mastered);
  const list = notebookFilter === 'pending' ? pending : mastered;
  const setFilter = (value) => () => { notebookFilter = value; route(false); };

  const card = (m) => {
    const result = h('p', { class: 'drill-result', 'aria-live': 'polite' });
    const answer = h('input', { type: 'text', placeholder: 'Escribe la frase corregida', 'aria-label': 'Frase corregida', autocomplete: 'off', spellcheck: false, lang: 'en' });
    const fix = h('details', { open: m.mastered },
      h('summary', {}, 'Ver la corrección'),
      renderDiff(m.original, m.corrected),
      renderWhys(m.errors),
      m.natural && h('p', { class: 'natural' }, h('strong', {}, 'Más natural: '), h('span', { lang: 'en' }, m.natural)));
    const check = (event) => {
      event.preventDefault();
      if (tutor.looseEqual(answer.value, m.corrected) || (m.natural && tutor.looseEqual(answer.value, m.natural))) {
        store.setMastered(state, m.id);
        persist();
        result.className = 'drill-result good';
        result.textContent = 'Correcto. Pasa a dominados.';
        setTimeout(() => { if (location.hash === '#/errores') route(false); }, 900);
      } else {
        result.className = 'drill-result bad';
        result.textContent = 'Todavía no. Mira la corrección y vuelve a intentarlo.';
        fix.open = true;
      }
    };
    return h('li', { class: `mistake${m.mastered ? ' mastered' : ''}` },
      h('p', { class: 'mistake-meta' },
        h('span', {}, `Nivel ${m.level}`),
        h('span', {}, new Date(m.date).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' }))),
      h('p', {}, h('span', { class: 'muted' }, 'Dijiste: '), h('span', { lang: 'en' }, m.original)),
      fix,
      !m.mastered && h('form', { class: 'drill', onsubmit: check }, answer, h('button', { class: 'btn', type: 'submit' }, 'Comprobar'), result),
      h('div', { class: 'mistake-actions' },
        speech.canSpeak && h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => speech.speakOnce(m.corrected, 0.95) }, 'Oír la corrección'),
        m.mastered && h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { store.setMastered(state, m.id, false); persist(); route(false); } }, 'Volver a practicar'),
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { store.removeMistake(state, m.id); persist(); route(false); } }, 'Eliminar')));
  };

  app.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, 'Mis errores'),
        h('p', {}, 'Cada frase que recibió cambios queda aquí. Escríbela bien una vez y pasa a dominados.')),
      h('div', { class: 'filters', role: 'group', 'aria-label': 'Filtro' },
        h('button', { class: 'btn', type: 'button', 'aria-pressed': String(notebookFilter === 'pending'), onclick: setFilter('pending') }, `Pendientes (${pending.length})`),
        h('button', { class: 'btn', type: 'button', 'aria-pressed': String(notebookFilter === 'mastered'), onclick: setFilter('mastered') }, `Dominados (${mastered.length})`))),
    list.length
      ? h('ul', { class: 'mistakes' }, list.map(card))
      : h('div', { class: 'empty' },
        h('p', {}, notebookFilter === 'pending'
          ? 'No tienes errores pendientes. Cuando una revisión sugiera cambios, la frase queda guardada aquí.'
          : 'Todavía no has dominado ninguna frase. Practica las pendientes para moverlas aquí.'),
        notebookFilter === 'pending' && h('a', { class: 'btn btn-primary', href: '#/' }, 'Ir a los niveles')),
  );
}

// ---------- rutas ----------

function route(resetScroll = true) {
  runCleanup();
  closeDialog();
  speech.stopSpeaking();
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const target = name === 'llamada' ? findScenario(arg) : null;
  let current = 'home';
  if (target) { current = 'call'; viewCall(target); }
  else if (name === 'errores') { current = 'notebook'; viewNotebook(); }
  else viewHome();
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (resetScroll) window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => route());
route();
initModel();
