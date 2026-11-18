// Voz del navegador: dictado (SpeechRecognition) y lectura en voz alta (speechSynthesis).

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
export const canListen = Boolean(Recognition);
export const canSpeak = 'speechSynthesis' in globalThis;

// ---------- escuchar ----------

// Escucha hasta que haya una pausa de silenceMs y entrega la frase completa.
// onState: 'listening' | 'idle' | 'denied'
export function createListener({ onInterim, onFinal, onState, silenceMs = 1900 }) {
  if (!canListen) return null;
  let rec = null;
  let active = false;
  let finals = '';
  let interim = '';
  let timer = null;

  const heard = () => `${finals}${interim}`.replace(/\s+/g, ' ').trim();

  function begin() {
    rec = new Recognition();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finals += `${result[0].transcript} `;
        else interim += result[0].transcript;
      }
      onInterim(heard());
      clearTimeout(timer);
      timer = setTimeout(finish, silenceMs);
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        active = false;
        onState('denied');
      }
    };
    // Chrome corta el reconocimiento cada cierto tiempo; se reanuda solo.
    rec.onend = () => {
      if (!active) return;
      try { begin(); } catch { active = false; onState('idle'); }
    };
    rec.start();
  }

  function halt() {
    active = false;
    clearTimeout(timer);
    try { rec?.abort(); } catch { /* ya estaba detenido */ }
  }

  function finish() {
    const text = heard();
    if (!text) return;
    halt();
    onState('idle');
    onFinal(text);
  }

  return {
    start() {
      if (active) return;
      active = true;
      finals = '';
      interim = '';
      try { begin(); onState('listening'); } catch { active = false; onState('idle'); }
    },
    stop() { halt(); onState('idle'); },
    finishNow: finish,
    get active() { return active; },
  };
}

// ---------- hablar ----------

let voice = null;

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('en'));
  if (!voices.length) return null;
  const prefer = [/natural.*(en-US|United States)/i, /Google US English/i, /Samantha|Aria|Jenny|Guy/i];
  for (const pattern of prefer) {
    const match = voices.find((v) => pattern.test(`${v.name} ${v.lang}`));
    if (match) return match;
  }
  return voices.find((v) => v.lang === 'en-US') || voices[0];
}

if (canSpeak) {
  voice = pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', () => { voice = pickVoice(); });
}

export function stopSpeaking() {
  if (canSpeak) speechSynthesis.cancel();
}

// Lee un texto que va llegando por partes: cada oración suena apenas se completa.
// feed(trozo) mientras llega el texto, end() al terminar; `done` se resuelve cuando calla.
export function createSpeaker({ rate = 1, enabled = true, onStart = () => {} } = {}) {
  let buffer = '';
  let pending = 0;
  let ended = false;
  let started = false;
  let cancelled = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const active = enabled && canSpeak;

  const settle = () => { if (ended && pending === 0) finish(); };

  function say(sentence) {
    const text = sentence.trim();
    if (!text || !active || cancelled) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = rate;
    if (voice) utterance.voice = voice;
    pending++;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(guard);
      pending--;
      settle();
    };
    // Chrome a veces no avisa que terminó de hablar; este tope evita quedarse esperando.
    const guard = setTimeout(close, 6000 + text.length * 110);
    utterance.onend = close;
    utterance.onerror = close;
    utterance.onstart = () => { if (!started) { started = true; onStart(); } };
    speechSynthesis.speak(utterance);
  }

  return {
    done,
    feed(piece) {
      buffer += piece;
      let match;
      while ((match = buffer.match(/^[\s\S]*?[.!?]+(?=\s)/))) {
        say(match[0]);
        buffer = buffer.slice(match[0].length);
      }
    },
    end() {
      say(buffer);
      buffer = '';
      ended = true;
      settle();
    },
    cancel() {
      cancelled = true;
      ended = true;
      pending = 0;
      stopSpeaking();
      finish();
    },
  };
}

export function speakOnce(text, rate = 1) {
  stopSpeaking();
  const speaker = createSpeaker({ rate });
  speaker.feed(`${text} `);
  speaker.end();
  return speaker;
}
