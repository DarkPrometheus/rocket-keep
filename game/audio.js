// Audio local de presentación: síntesis Web Audio, sin assets ni reglas de juego.
// Se crea un único contexto tras una interacción; no se encolan sonidos bloqueados.
const STORAGE_KEY = 'rocket-keep.audio.v1';
const MAX_VOICES = 20;
const COOLDOWNS = { launch: 0.055, impact: 0.075, ground: 0.09, gate: 0.065, split: 0.08, tap: 0.04 };

export class GameAudio {
  #Context;
  #storage;
  #doc;
  #ctx = null;
  #master;
  #compressor;
  #noise;
  #voices = new Set();
  #last = new Map();
  #listeners = new Set();
  #volume = 0.65;
  #muted = false;
  #available;
  #disposed = false;
  #gesture;
  #visibility;

  constructor({ AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext,
    storage, document = globalThis.document } = {}) {
    this.#Context = AudioContext;
    this.#available = typeof AudioContext === 'function';
    this.#doc = document;
    try {
      this.#storage = storage ?? globalThis.localStorage;
      const saved = JSON.parse(this.#storage?.getItem(STORAGE_KEY) ?? 'null');
      if (typeof saved?.volume === 'number' && Number.isFinite(saved.volume))
        this.#volume = Math.max(0, Math.min(1, saved.volume));
      if (typeof saved?.muted === 'boolean') this.#muted = saved.muted;
    } catch { /* Almacenamiento bloqueado o preferencias dañadas: valores iniciales. */ }
    this.#gesture = () => { void this.unlock(); };
    this.#visibility = () => {
      if (!this.#doc.hidden) return; // Reanudar solo con el siguiente gesto.
      this.stopAll();
      try { void this.#ctx?.suspend().catch(() => {}); } catch { /* Sin audio. */ }
    };
    document?.addEventListener('pointerdown', this.#gesture, true);
    document?.addEventListener('keydown', this.#gesture, true);
    document?.addEventListener('visibilitychange', this.#visibility);
  }

  get settings() { return { volume: this.#volume, muted: this.#muted, available: this.#available }; }

  subscribe(fn) {
    this.#listeners.add(fn);
    fn(this.settings);
    return () => this.#listeners.delete(fn);
  }

  #changed() {
    try { this.#storage?.setItem(STORAGE_KEY, JSON.stringify({ volume: this.#volume, muted: this.#muted })); }
    catch { /* La partida funciona también sin almacenamiento. */ }
    if (this.#ctx) this.#master.gain.setTargetAtTime(this.#muted ? 0 : this.#volume * 0.55, this.#ctx.currentTime, 0.015);
    for (const fn of this.#listeners) fn(this.settings);
  }

  setVolume(value) {
    if (!Number.isFinite(value)) return;
    this.#volume = Math.max(0, Math.min(1, value));
    if (this.#volume === 0) this.stopAll();
    this.#changed();
  }

  setMuted(value) {
    this.#muted = Boolean(value);
    if (this.#muted) this.stopAll();
    this.#changed();
  }

  async unlock() {
    if (this.#disposed || !this.#available || this.#doc?.hidden || this.#muted || this.#volume === 0) return false;
    try {
      if (!this.#ctx) {
        this.#ctx = new this.#Context({ latencyHint: 'interactive' });
        this.#master = this.#ctx.createGain();
        this.#master.gain.value = this.#volume * 0.55;
        this.#compressor = this.#ctx.createDynamicsCompressor();
        this.#compressor.threshold.value = -10;
        this.#compressor.ratio.value = 12;
        this.#master.connect(this.#compressor);
        this.#compressor.connect(this.#ctx.destination);
        this.#noise = this.#ctx.createBuffer(1, Math.ceil(this.#ctx.sampleRate * 1.5), this.#ctx.sampleRate);
        const data = this.#noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      if (this.#ctx.state !== 'running') await this.#ctx.resume();
      // Un cambio de pestaña puede ocurrir mientras resume() está pendiente.
      if (this.#disposed || this.#doc?.hidden || this.#muted || this.#volume === 0) {
        this.stopAll();
        await this.#ctx.suspend();
        return false;
      }
      return this.#ctx.state === 'running';
    } catch {
      // Un navegador puede rechazar resume(); otro gesto permite reintentarlo.
      return false;
    }
  }

  #voice(source, duration, { frequency = 600, endFrequency = frequency, amplitude = 0.12,
    delay = 0, pan = 0, noise = false } = {}) {
    if (this.#voices.size >= MAX_VOICES) return;
    const ctx = this.#ctx, at = ctx.currentTime + delay;
    const gain = ctx.createGain();
    const stereo = ctx.createStereoPanner();
    stereo.pan.value = Math.max(-1, Math.min(1, pan));
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(amplitude, at + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    let filter;
    if (noise) {
      source.buffer = this.#noise;
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(frequency, at);
      filter.frequency.exponentialRampToValueAtTime(endFrequency, at + duration);
      source.connect(filter);
      filter.connect(gain);
    } else {
      source.frequency.setValueAtTime(frequency, at);
      source.frequency.exponentialRampToValueAtTime(endFrequency, at + duration);
      source.connect(gain);
    }
    gain.connect(stereo);
    stereo.connect(this.#master);
    const voice = { source, nodes: [source, filter, gain, stereo].filter(Boolean) };
    this.#voices.add(voice);
    source.onended = () => {
      this.#voices.delete(voice);
      voice.nodes.forEach((node) => node.disconnect());
    };
    source.start(at);
    source.stop(at + duration + 0.02);
  }

  #tone(frequency, duration = 0.13, options = {}) {
    const source = this.#ctx.createOscillator();
    source.type = options.type ?? 'sine';
    this.#voice(source, duration, { frequency, ...options });
  }

  #burst(duration, options) {
    this.#voice(this.#ctx.createBufferSource(), duration, { noise: true, ...options });
  }

  #melody(notes, step = 0.11) {
    notes.forEach((frequency, i) => this.#tone(frequency, step * 1.6, { delay: i * step, amplitude: 0.1, type: 'triangle' }));
  }

  play(name, { pan = 0, weapon = 'burst', mult = 2, index = 0 } = {}) {
    const ctx = this.#ctx;
    if (this.#disposed || !ctx || ctx.state !== 'running' || this.#doc?.hidden || this.#muted || this.#volume === 0) return false;
    const now = ctx.currentTime;
    if (now - (this.#last.get(name) ?? -Infinity) < (COOLDOWNS[name] ?? 0.025)) return false;
    this.#last.set(name, now);
    try {
      switch (name) {
        case 'launch':
          this.#tone(weapon === 'mortar' ? 120 : weapon === 'cluster' ? 340 : 240, 0.2,
            { endFrequency: 45, type: 'triangle', amplitude: 0.2, pan });
          this.#burst(0.22, { frequency: 2000, endFrequency: 250, amplitude: 0.14, pan }); break;
        case 'gate': {
          const f = 400 + Math.log2(mult) * 150;
          this.#tone(f, 0.18, { endFrequency: f * 1.5, pan }); break;
        }
        case 'split': this.#burst(0.15, { frequency: 4000, endFrequency: 800, amplitude: 0.12, pan }); break;
        case 'impact':
          this.#burst(0.4, { frequency: 1800, endFrequency: 90, amplitude: 0.28, pan });
          this.#tone(90, 0.32, { endFrequency: 28, amplitude: 0.22, pan }); break;
        case 'ground': this.#burst(0.15, { frequency: 600, endFrequency: 100, amplitude: 0.11, pan }); break;
        case 'ko':
          this.#burst(1.2, { frequency: 2200, endFrequency: 45, amplitude: 0.4, pan });
          this.#tone(65, 1, { endFrequency: 22, amplitude: 0.28, pan }); break;
        case 'click': this.#tone(700, 0.055, { endFrequency: 480, amplitude: 0.06 }); break;
        case 'buy': this.#melody([880, 1175, 1568], 0.075); break;
        case 'error': case 'failure': this.#melody([220, 165], 0.12); break;
        case 'success': this.#melody([659, 988], 0.09); break;
        case 'start': this.#melody([392, 523, 784]); break;
        case 'turn': this.#melody([523, 784], 0.075); break;
        case 'tick': this.#tone(500, 0.09); break;
        case 'tap': this.#tone(220, 0.045, { endFrequency: 100, amplitude: 0.08 }); break;
        case 'simon': this.#tone([262, 330, 392, 523][index % 4], 0.25, { type: 'triangle' }); break;
        case 'win': this.#melody([523, 659, 784, 1047], 0.17); break;
        case 'lose': this.#melody([392, 330, 262, 196], 0.2); break;
        case 'draw': this.#melody([392, 440, 392], 0.17); break;
        default: return false;
      }
      return true;
    } catch { return false; } // Un fallo de audio nunca detiene una animación.
  }

  stopAll() {
    for (const { source, nodes } of this.#voices) {
      source.onended = null;
      try { source.stop(); } catch { /* Ya terminado. */ }
      nodes.forEach((node) => node.disconnect());
    }
    this.#voices.clear();
    this.#last.clear();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stopAll();
    this.#doc?.removeEventListener('pointerdown', this.#gesture, true);
    this.#doc?.removeEventListener('keydown', this.#gesture, true);
    this.#doc?.removeEventListener('visibilitychange', this.#visibility);
    this.#listeners.clear();
    try { void this.#ctx?.close().catch(() => {}); } catch { /* Ya cerrado. */ }
  }
}
