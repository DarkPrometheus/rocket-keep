// =============================================================
// transport.js — Interfaz de transporte y sus implementaciones locales.
//
// Interfaz que debe cumplir cualquier transporte (local, bot, PeerJS…):
//
//   send(msg)         envía un objeto JSON al otro extremo
//   onMessage(cb)     cb(msg) por cada mensaje recibido; devuelve "desuscribir"
//   onClose(cb)       cb() cuando el otro extremo se va; devuelve "desuscribir"
//   close()           cierra la conexión
//
// Los mensajes siempre se serializan a JSON y se entregan de forma
// asíncrona, igual que en una red real. Así, si algo funciona en
// local, funcionará igual con PeerJS.
// =============================================================

import { BotPlayer } from './bot.js';

export class LocalTransport {
  #listeners = new Set();
  #closeListeners = new Set();
  #peer = null;
  #closed = false;
  #latencyMs;

  /** @param {{latencyMs?: number}} opts  latencia simulada (0 = siguiente tick) */
  constructor({ latencyMs = 0 } = {}) {
    this.#latencyMs = latencyMs;
  }

  /** Conecta dos extremos entre sí. */
  static link(a, b) {
    a.#peer = b;
    b.#peer = a;
  }

  send(msg) {
    if (this.#closed || !this.#peer) return;
    const data = JSON.stringify(msg); // garantiza que el mensaje sea serializable
    const peer = this.#peer;
    // setTimeout conserva el orden de los mensajes (cola FIFO).
    setTimeout(() => peer.#deliver(data), this.#latencyMs);
  }

  onMessage(cb) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  onClose(cb) {
    this.#closeListeners.add(cb);
    return () => this.#closeListeners.delete(cb);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    const peer = this.#peer;
    if (peer) setTimeout(() => peer.#remoteClosed(), this.#latencyMs);
  }

  #deliver(data) {
    if (this.#closed) return;
    const msg = JSON.parse(data);
    for (const cb of this.#listeners) cb(msg);
  }

  #remoteClosed() {
    if (this.#closed) return;
    this.#closed = true;
    for (const cb of this.#closeListeners) cb();
  }
}

/** Crea dos extremos conectados: [extremoA, extremoB]. */
export function createLocalPair(opts) {
  const a = new LocalTransport(opts);
  const b = new LocalTransport(opts);
  LocalTransport.link(a, b);
  return [a, b];
}

/**
 * Transporte cuyo otro extremo es un bot. Para el host es
 * indistinguible de un jugador humano conectado por red: recibe los
 * mismos mensajes y responde con los mismos inputs.
 */
export class BotTransport extends LocalTransport {
  /** @param {{difficulty?: 'easy'|'normal'|'hard', thinkMs?: number, latencyMs?: number}} opts */
  constructor(opts = {}) {
    super(opts);
    const botSide = new LocalTransport(opts);
    LocalTransport.link(this, botSide);
    this.bot = new BotPlayer(botSide, opts);
  }
}
