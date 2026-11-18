// Motor de IA: un modelo de lenguaje que se descarga una vez y corre en tu
// navegador con WebGPU (WebLLM). No hay servidor ni claves de API.

export const MODELS = [
  {
    tier: 'tiny',
    name: 'Mínimo',
    f16: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    f32: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',
    download: '0,7 GB',
    memory: '1 GB',
    note: 'Para equipos con poca memoria gráfica. Conversa, pero corrige menos y se equivoca más.',
  },
  {
    tier: 'light',
    name: 'Ligero',
    f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    download: '1 GB',
    memory: '2 GB',
    note: 'El punto de partida recomendado: cabe en casi todos los equipos. Conversa bien; la corrección es más básica.',
  },
  {
    tier: 'balanced',
    name: 'Equilibrado',
    f16: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    f32: 'Llama-3.2-3B-Instruct-q4f32_1-MLC',
    download: '1,8 GB',
    memory: '3 GB',
    note: 'Mejor corrección que Ligero. Pide una tarjeta gráfica con memoria propia.',
  },
  {
    tier: 'best',
    name: 'Máxima calidad',
    f16: 'Llama-3.1-8B-Instruct-q4f16_1-MLC',
    f32: 'Llama-3.1-8B-Instruct-q4f32_1-MLC',
    download: '4,5 GB',
    memory: '6 GB',
    note: 'La mejor corrección. Necesita una tarjeta gráfica dedicada.',
  },
];

export const getModel = (tier) => MODELS.find((m) => m.tier === tier) || MODELS[1];

// El siguiente modelo más liviano (el mismo si ya es el más pequeño).
export function lighterTier(tier) {
  const i = MODELS.findIndex((m) => m.tier === tier);
  return MODELS[Math.max(0, i - 1)].tier;
}

// Un contexto de 2048 tokens sobra para estas conversaciones y gasta menos memoria gráfica.
const CHAT_OPTS = { context_window_size: 2048 };

const params = new URLSearchParams(globalThis.location?.search || '');
export const MOCK = params.has('mock');
// ?model=<id de WebLLM> permite probar cualquier otro modelo de su catálogo.
const MODEL_OVERRIDE = params.get('model');

let webllm = null;
let engine = null;
let loadedTier = null; // solo tiene valor cuando el modelo quedó cargado de verdad
let lastTier = null;   // último modelo que se pidió, para recargarlo si se pierde
let activeWorker = null;
let gpuDead = false; // la tarjeta gráfica perdió el dispositivo y el motor se descartó
let support = null;
let queue = Promise.resolve();

// El motor atiende una petición a la vez; lo demás espera en fila.
function enqueue(job) {
  const result = queue.then(job, job);
  queue = result.catch(() => {});
  return result;
}

export async function detectSupport() {
  if (support) return support;
  if (MOCK) return (support = { ok: true, f16: true });
  if (!globalThis.navigator?.gpu) {
    return (support = {
      ok: false,
      reason: 'Este navegador no tiene WebGPU. Abre la app en Chrome o Edge actualizados, en un computador.',
    });
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return (support = {
        ok: false,
        reason: 'El navegador no encontró una tarjeta gráfica compatible. Revisa que la aceleración por hardware esté activa.',
      });
    }
    return (support = { ok: true, f16: adapter.features.has('shader-f16') });
  } catch (error) {
    return (support = { ok: false, reason: `No se pudo iniciar WebGPU: ${error.message}` });
  }
}

export const isReady = () => loadedTier !== null;
export const currentTier = () => loadedTier;

const modelIdFor = (model, f16) => MODEL_OVERRIDE || (f16 ? model.f16 : model.f32);

export async function isDownloaded(tier) {
  if (MOCK) return false;
  try {
    const { ok, f16 } = await detectSupport();
    if (!ok) return false;
    webllm ??= await import('../vendor/web-llm.js');
    return await webllm.hasModelInCache(modelIdFor(getModel(tier), f16));
  } catch {
    return false;
  }
}

async function createEngine(modelId, initProgressCallback) {
  // Primero en un worker; si el navegador no lo permite, en el hilo principal.
  const direct = () => webllm.CreateMLCEngine(modelId, { initProgressCallback }, CHAT_OPTS);
  let worker;
  try {
    worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
  } catch {
    return direct();
  }
  const workerFailed = new Promise((_, reject) => {
    worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'El worker no pudo iniciar.');
      error.workerFailed = true;
      reject(error);
    }, { once: true });
  });
  try {
    const created = await Promise.race([
      webllm.CreateWebWorkerMLCEngine(worker, modelId, { initProgressCallback }, CHAT_OPTS),
      workerFailed,
    ]);
    activeWorker = worker;
    return created;
  } catch (error) {
    worker.terminate();
    if (error.workerFailed) return direct();
    throw error;
  }
}

// onProgress recibe {progress: 0..1, text}
export async function loadModel(tier, onProgress = () => {}) {
  if (MOCK) {
    for (let p = 0; p <= 1.001; p += 0.25) {
      onProgress({ progress: Math.min(p, 1), text: 'Simulando la descarga…' });
      await sleep(120);
    }
    loadedTier = tier;
    return;
  }
  const report = (r) => onProgress({ progress: r.progress ?? 0, text: r.text || '' });
  await enqueue(() => doLoad(tier, report));
}

// Pérdida del dispositivo gráfico: casi siempre es falta de memoria. Con el dispositivo
// perdido el motor no sirve para nada más, así que se descarta.
export const isGpuFailure = (error) =>
  /device.*lost|GPUDeviceLost|already been disposed|out of memory|\bOOM\b/i.test(String(error?.message || error));

function dropEngine() {
  try { activeWorker?.terminate(); } catch { /* ya estaba cerrado */ }
  engine = null;
  activeWorker = null;
  loadedTier = null;
}

async function doLoad(tier, report) {
  const { ok, f16, reason } = await detectSupport();
  if (!ok) throw new Error(reason);
  webllm ??= await import('../vendor/web-llm.js');
  const modelId = modelIdFor(getModel(tier), f16);
  loadedTier = null; // si algo falla de aquí en adelante, no hay modelo activo
  try {
    if (engine) {
      engine.setInitProgressCallback?.(report);
      await engine.reload(modelId, CHAT_OPTS);
    } else {
      engine = await createEngine(modelId, report);
    }
  } catch (error) {
    if (isGpuFailure(error)) { dropEngine(); gpuDead = true; }
    throw error;
  }
  loadedTier = tier;
  lastTier = tier;
  gpuDead = false;
}

// Si el modelo se perdió sin que fallara la GPU (otra pestaña, el worker se reinició),
// se vuelve a cargar desde la caché y se reintenta una vez.
const isNotLoaded = (error) => /not loaded|ModelNotLoaded|\.reload\(/i.test(String(error?.message || error));

async function recover() {
  if (gpuDead) throw new Error('Device was lost: la tarjeta gráfica se quedó sin memoria.');
  if (!lastTier) throw new Error('El modelo no está cargado. Actívalo desde la pantalla de niveles.');
  await doLoad(lastTier, () => {});
}

async function withRecovery(run) {
  if (!loadedTier) await recover();
  try {
    return await run();
  } catch (error) {
    if (isGpuFailure(error)) { dropEngine(); gpuDead = true; throw error; }
    if (!isNotLoaded(error)) throw error;
    await recover();
    return run();
  }
}

// Respuesta en streaming para la conversación. Devuelve el texto completo.
export function chatStream(messages, { onToken = () => {}, temperature = 0.7, maxTokens = 220 } = {}) {
  return enqueue(async () => {
    if (MOCK) return mockStream(messages, onToken);
    return withRecovery(async () => {
      const stream = await engine.chat.completions.create({
        messages, temperature, max_tokens: maxTokens, stream: true,
      });
      let text = '';
      for await (const chunk of stream) {
        const piece = chunk.choices[0]?.delta?.content || '';
        if (piece) { text += piece; onToken(piece, text); }
      }
      return text.trim();
    });
  });
}

// Respuesta completa, opcionalmente obligada a cumplir un JSON Schema.
export function complete(messages, { schema, temperature = 0, maxTokens = 500, kind = '' } = {}) {
  return enqueue(async () => {
    if (MOCK) return mockComplete(messages, kind);
    return withRecovery(async () => {
      const reply = await engine.chat.completions.create({
        messages, temperature, max_tokens: maxTokens,
        ...(schema ? { response_format: { type: 'json_object', schema } } : {}),
      });
      return reply.choices[0]?.message?.content || '';
    });
  });
}

export function interrupt() {
  try { engine?.interruptGenerate(); } catch { /* nada que interrumpir */ }
}

export function friendlyError(error) {
  const message = String(error?.message || error);
  if (isGpuFailure(error) || /allocation/i.test(message)) {
    return 'La tarjeta gráfica se quedó sin memoria con este modelo. Elige uno más liviano y cierra otras pestañas que usen la GPU.';
  }
  if (/not loaded|ModelNotLoaded/i.test(message)) {
    return 'El modelo se descargó de la memoria gráfica. Vuelve a Niveles y actívalo de nuevo.';
  }
  if (/shader-f16|ShaderF16/i.test(message)) {
    return 'Tu tarjeta gráfica no soporta este formato de modelo. Elige otro modelo.';
  }
  if (/fetch|network|Failed to load|NetworkError/i.test(message)) {
    return 'Se cortó la descarga del modelo. Revisa tu conexión y vuelve a intentarlo; continúa donde quedó.';
  }
  if (/quota|storage/i.test(message)) {
    return 'No hay espacio suficiente en el navegador para guardar el modelo. Libera espacio en disco.';
  }
  return message;
}

// ---------- motor simulado (?mock) para probar la interfaz sin tarjeta gráfica ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MOCK_REPLIES = [
  'Nice to meet you! Where are you from?',
  'That sounds great. What do you do in your team?',
  'Interesting! Which tools do you use every day?',
  'I see. What do you like most about your job?',
  'Good to know. What are you working on this week?',
  'Thanks for sharing. Do you have any questions for me?',
];
let mockTurn = 0;

async function mockStream(_messages, onToken) {
  const reply = MOCK_REPLIES[mockTurn++ % MOCK_REPLIES.length];
  let text = '';
  for (const word of reply.split(' ')) {
    await sleep(35);
    text += (text ? ' ' : '') + word;
    onToken(word + ' ', text);
  }
  return reply;
}

const MOCK_FIXES = [
  ['I am agree', 'I agree', 'grammar', '"Agree" ya es verbo; no lleva "am".'],
  ['I have 28 years', 'I am 28 years old', 'grammar', 'La edad se dice con "to be": I am 28 years old.'],
  ['I work in the backend', 'I work on the backend', 'vocabulary', 'Se dice "work on" un sistema o una tarea.'],
  ['a doubt', 'a question', 'vocabulary', 'Para preguntar se usa "question".'],
  ['Yesterday I work', 'Yesterday I worked', 'grammar', 'Con "yesterday" va el pasado simple.'],
];

async function mockComplete(messages, kind) {
  await sleep(250);
  const last = messages[messages.length - 1].content;
  if (kind === 'hint') {
    return JSON.stringify({ suggestions: ['I’m a backend developer.', 'I work with Java and Spring Boot.'] });
  }
  if (kind === 'translate') return `(traducción simulada) ${last}`;
  const text = (last.match(/Message: """([\s\S]*)"""$/) || [, last])[1];
  let corrected = text;
  const errors = [];
  for (const [wrong, right, type, why] of MOCK_FIXES) {
    const at = corrected.toLowerCase().indexOf(wrong.toLowerCase());
    if (at === -1) continue;
    corrected = corrected.slice(0, at) + right + corrected.slice(at + wrong.length);
    errors.push({ wrong, right, type, why });
  }
  return JSON.stringify({ corrected, errors, natural: '' });
}
