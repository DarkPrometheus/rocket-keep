// =============================================================
// peer.js — Transporte en línea con PeerJS (WebRTC, de navegador a navegador).
//
// Quien crea la sala ES el servidor: su pestaña corre el Host y el amigo
// se conecta directo a ella. PeerJS solo se usa para "presentarlos"
// (servidor de señalización público de PeerJS) y trae servidores STUN y
// TURN propios, así que funciona también entre redes complicadas.
//
// Piezas:
//   PeerLink     canal lógico que SOBREVIVE a reconexiones: cumple la
//                interfaz de transporte (send / onMessage / onClose / close)
//                y además onStatus(cb(online)). Por debajo cambia de
//                conexión WebRTC cuando se cae y vuelve.
//   createRoom() la pestaña anfitriona abre una sala con código de 4 letras.
//   joinRoom()   la pestaña invitada se une con el código.
//
// Latido: cada lado manda "ping" cada pocos segundos y el otro responde
// "pong" al instante (eso no depende de temporizadores, que el navegador
// frena en pestañas de fondo). Si no llega nada en un rato, la conexión se
// da por caída: el invitado reintenta solo y el anfitrión le guarda el
// lugar durante un tiempo de gracia. Si no vuelve, se cierra del todo.
//
// Mensajes en el cable: { k: 'msg', m } | { k: 'ping' } | { k: 'pong' }
//                       | { k: 'bye' } (salida voluntaria) | { k: 'full' }
// Lo que se envía mientras no hay conexión se descarta: al volver, el
// cliente pide el estado completo al host (resync).
// =============================================================

const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const ID_PREFIX = 'rocketkeep-';
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin I ni O (se confunden con 1 y 0)
export const CODE_LENGTH = 4;

export const DEFAULT_TIMING = Object.freeze({
  heartbeatMs: 2000,  // cada cuánto se manda ping
  timeoutMs: 10000,   // sin noticias durante esto = conexión caída
  graceMs: 90000,     // tiempo para volver antes de cerrar del todo
  retryMs: 2500,      // cada cuánto reintenta conectar el invitado
});

// ---------- canal con reconexión ----------

export class PeerLink {
  #conn = null;
  #timing;
  #online = false;
  #final = false;
  #lastSeen = 0;
  #beat = null;
  #grace = null;
  #msgCbs = new Set();
  #closeCbs = new Set();
  #statusCbs = new Set();
  #connUnsubs = [];

  constructor(timing = {}) {
    this.#timing = { ...DEFAULT_TIMING, ...timing };
  }

  get online() {
    return this.#online;
  }

  get closed() {
    return this.#final;
  }

  /**
   * Usa esta conexión (ya abierta). Sirve para la primera vez y para cada
   * reconexión. `conn` es una DataConnection de PeerJS o algo con la misma
   * forma: on(evento, cb), send(obj), close().
   */
  attach(conn) {
    if (this.#final) {
      conn.close();
      return;
    }
    this.#dropConn();
    this.#conn = conn;
    const on = (ev, cb) => {
      conn.on(ev, cb);
      this.#connUnsubs.push(() => conn.off?.(ev, cb));
    };
    on('data', (d) => {
      if (conn !== this.#conn) return;
      this.#lastSeen = Date.now();
      this.#onWire(d);
    });
    on('close', () => conn === this.#conn && this.#lost());
    on('error', () => conn === this.#conn && this.#lost());
    this.#lastSeen = Date.now();
    clearTimeout(this.#grace);
    this.#grace = null;
    clearInterval(this.#beat);
    this.#beat = setInterval(() => this.#heartbeat(), this.#timing.heartbeatMs);
    this.#setOnline(true);
  }

  // ----- interfaz de transporte -----

  send(msg) {
    this.#wire({ k: 'msg', m: msg });
  }

  onMessage(cb) {
    this.#msgCbs.add(cb);
    return () => this.#msgCbs.delete(cb);
  }

  onClose(cb) {
    this.#closeCbs.add(cb);
    return () => this.#closeCbs.delete(cb);
  }

  /** cb(online: boolean) cuando la conexión se cae o vuelve. */
  onStatus(cb) {
    this.#statusCbs.add(cb);
    return () => this.#statusCbs.delete(cb);
  }

  /** Salida voluntaria: avisa al otro lado (para que no espere) y cierra. */
  close() {
    if (this.#final) return;
    this.#wire({ k: 'bye' });
    const conn = this.#conn;
    // Un instante para que salga el "bye" antes de cortar.
    setTimeout(() => conn?.close(), 150);
    this.#finish(false);
  }

  // ----- interno -----

  #wire(obj) {
    if (!this.#online || !this.#conn) return;
    try {
      this.#conn.send(obj);
    } catch {
      this.#lost();
    }
  }

  #onWire(d) {
    if (!d || typeof d !== 'object') return;
    if (d.k === 'ping') return this.#wire({ k: 'pong' });
    if (d.k === 'pong') return;
    if (d.k === 'bye' || d.k === 'full') return this.#finish(true, d.k);
    if (d.k === 'msg') for (const cb of this.#msgCbs) cb(d.m);
  }

  #heartbeat() {
    if (Date.now() - this.#lastSeen > this.#timing.timeoutMs) return this.#lost();
    this.#wire({ k: 'ping' });
  }

  /** La conexión actual murió: queda a la espera de otra (o del cierre definitivo). */
  #lost() {
    if (this.#final || !this.#conn) return;
    this.#dropConn();
    this.#setOnline(false);
    clearTimeout(this.#grace);
    this.#grace = setTimeout(() => this.#finish(true, 'timeout'), this.#timing.graceMs);
  }

  #dropConn() {
    clearInterval(this.#beat);
    this.#beat = null;
    this.#connUnsubs.forEach((u) => u());
    this.#connUnsubs = [];
    const c = this.#conn;
    this.#conn = null;
    try {
      c?.close();
    } catch {
      /* ya estaba cerrada */
    }
  }

  #setOnline(v) {
    if (this.#online === v) return;
    this.#online = v;
    for (const cb of this.#statusCbs) cb(v);
  }

  /** Cierre definitivo. `remote`: lo provocó el otro lado (o el tiempo). */
  #finish(remote, reason = 'bye') {
    if (this.#final) return;
    this.#final = true;
    this.closeReason = reason;
    clearTimeout(this.#grace);
    if (remote) this.#dropConn();
    else {
      clearInterval(this.#beat);
      this.#connUnsubs.forEach((u) => u());
      this.#connUnsubs = [];
    }
    this.#online = false;
    if (remote) for (const cb of this.#closeCbs) cb();
  }
}

// ---------- PeerJS ----------

let peerjsPromise = null;

/** Carga PeerJS desde el CDN (solo la primera vez que hace falta). */
export function loadPeerJS() {
  if (globalThis.Peer) return Promise.resolve(globalThis.Peer);
  peerjsPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PEERJS_URL;
    s.onload = () => resolve(globalThis.Peer);
    s.onerror = () => {
      peerjsPromise = null;
      reject(new Error('No se pudo cargar PeerJS. ¿Hay conexión a internet?'));
    };
    document.head.append(s);
  });
  return peerjsPromise;
}

/** Código de sala al azar (4 letras). */
export function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}

/** Normaliza lo que escribe el usuario: mayúsculas, sin espacios. ¿Es válido? */
export function normalizeCode(text) {
  const code = String(text ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_LETTERS.includes(c)) ? code : null;
}

/** Espera a que una DataConnection abra (o falle). */
function whenOpen(conn, ms) {
  return new Promise((resolve, reject) => {
    if (conn.open) return resolve(conn);
    const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { type: 'timeout' })), ms);
    conn.on('open', () => {
      clearTimeout(t);
      resolve(conn);
    });
    conn.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/** Crea un Peer y espera a que el servidor de señalización lo registre. */
function openPeer(Peer, id) {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
    const fail = (e) => {
      peer.destroy();
      reject(e);
    };
    peer.once('open', () => {
      peer.off('error', fail);
      resolve(peer);
    });
    peer.once('error', fail);
  });
}

/** Si se pierde el servidor de señalización, se reconecta solo (las partidas en curso siguen). */
function keepSignaling(peer) {
  peer.on('disconnected', () => {
    setTimeout(() => {
      if (!peer.destroyed && peer.disconnected) peer.reconnect();
    }, 1500);
  });
  peer.on('error', () => {}); // los errores de conexiones sueltas se manejan en cada una
}

/**
 * Abre una sala. Resuelve cuando ya se puede compartir el código.
 * @param {{ onGuest: (link: PeerLink) => void, timing?: object }} o
 *        onGuest se llama UNA vez, cuando el amigo se conecta por primera vez.
 * @returns {Promise<{ code: string, link: PeerLink, destroy: () => void }>}
 */
export async function createRoom({ onGuest, timing } = {}) {
  const Peer = await loadPeerJS();
  let peer = null;
  let code = null;
  for (let attempt = 0; attempt < 6 && !peer; attempt++) {
    code = randomCode();
    try {
      peer = await openPeer(Peer, ID_PREFIX + code);
    } catch (e) {
      if (e.type === 'unavailable-id') continue; // código ocupado: otro
      if (attempt >= 2) throw new Error('No se pudo abrir la sala. Revisa tu conexión e inténtalo de nuevo.');
      await new Promise((r) => setTimeout(r, 1000)); // fallo de red: reintento silencioso
    }
  }
  if (!peer) throw new Error('No se pudo abrir la sala. Inténtalo de nuevo.');
  keepSignaling(peer);

  const link = new PeerLink(timing);
  let guestToken = null;
  peer.on('connection', (conn) => {
    const token = conn.metadata?.token;
    whenOpen(conn, 15000)
      .then(() => {
        if (link.closed) return conn.close();
        if (guestToken === null && typeof token === 'string') {
          guestToken = token;
          link.attach(conn);
          onGuest?.(link);
        } else if (token === guestToken) {
          link.attach(conn); // el mismo amigo vuelve (reconexión o recarga)
        } else {
          conn.send({ k: 'full' }); // ya hay dos jugadores
          setTimeout(() => conn.close(), 300);
        }
      })
      .catch(() => conn.close());
  });

  return {
    code,
    link,
    destroy() {
      link.close();
      setTimeout(() => peer.destroy(), 300);
    },
  };
}

/**
 * Se une a una sala. Resuelve con el canal ya conectado.
 * Reintenta en silencio unos segundos (por si el anfitrión está
 * reconectando) y después, si se cae, sigue reintentando solo.
 * @param {string} code
 * @param {{ token: string, timing?: object, onAttempt?: (n: number) => void }} o
 *        token identifica a este jugador ante el anfitrión (para volver a su lugar)
 * @returns {Promise<{ link: PeerLink, destroy: () => void }>}
 */
export async function joinRoom(code, { token, timing, onAttempt } = {}) {
  const Peer = await loadPeerJS();
  const t = { ...DEFAULT_TIMING, ...timing };
  let peer = null;
  for (let attempt = 0; attempt < 3 && !peer; attempt++) {
    try {
      peer = await openPeer(Peer, null);
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!peer) throw new Error('No se pudo conectar al servidor. Revisa tu conexión.');
  keepSignaling(peer);
  const hostId = ID_PREFIX + code;

  // Errores de "esa sala no existe" llegan por el peer, no por la conexión.
  let unavailable = false;
  peer.on('error', (e) => {
    if (e.type === 'peer-unavailable') unavailable = true;
  });

  /** Un intento de conexión: resuelve con la conexión abierta o falla (con `type`). */
  const tryConnect = (timeoutMs = 9000) => new Promise((resolve, reject) => {
    unavailable = false;
    if (peer.disconnected && !peer.destroyed) peer.reconnect();
    const conn = peer.connect(hostId, { metadata: { token }, serialization: 'json', reliable: true });
    // "Esa sala no existe" llega como error del peer (no de la conexión): se vigila aparte.
    const poll = setInterval(() => {
      if (!unavailable) return;
      clearInterval(poll);
      conn.close();
      reject(Object.assign(new Error('peer-unavailable'), { type: 'peer-unavailable' }));
    }, 200);
    whenOpen(conn, timeoutMs).then(
      (c) => {
        clearInterval(poll);
        resolve(c);
      },
      (e) => {
        clearInterval(poll);
        reject(e);
      },
    );
  });

  // Primera conexión: reintenta en silencio (por si el anfitrión está reconectando).
  // Si la sala no existe, se rinde antes (~6 s); si es otro fallo, ~20 s.
  // (PeerJS solo avisa "no existe" en el primer intento; después los intentos se quedan
  // esperando, así que se recuerda que ya se vio.)
  let conn = null;
  let missing = false;
  const t0 = Date.now();
  for (let n = 1; !conn; n++) {
    onAttempt?.(n);
    try {
      conn = await tryConnect(missing ? 4000 : 9000);
    } catch (e) {
      if (e?.type === 'peer-unavailable') missing = true;
      if (Date.now() - t0 > (missing ? 5000 : 20000)) {
        peer.destroy();
        throw new Error(missing ? `La sala ${code} no existe o ya se cerró.` : `No se pudo conectar con la sala ${code}.`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const link = new PeerLink(t);
  link.attach(conn);

  // Si se cae, reintenta solo mientras dure el tiempo de gracia.
  let retrying = false;
  link.onStatus(async (online) => {
    if (online || retrying) return;
    retrying = true;
    while (!link.online && !link.closed) {
      try {
        const c = await tryConnect();
        if (link.closed) c.close();
        else link.attach(c);
      } catch {
        await new Promise((r) => setTimeout(r, t.retryMs));
      }
    }
    retrying = false;
  });

  return {
    link,
    destroy() {
      link.close();
      setTimeout(() => peer.destroy(), 300);
    },
  };
}
