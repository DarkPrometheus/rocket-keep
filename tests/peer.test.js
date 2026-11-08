// Tests del canal en línea (PeerLink) con conexiones simuladas: latido,
// caída y reconexión, cierre voluntario y partidas completas que se
// recuperan tras perder la conexión. No usan red ni PeerJS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../game/logic.js';
import { PeerLink, normalizeCode } from '../net/peer.js';
import { Host } from '../game/host.js';
import { GameClient } from '../game/client.js';
import { createLocalPair } from '../net/transport.js';
import { DEFAULT_CONFIG } from '../game/config.js';
import { createRng } from '../game/rng.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { heartbeatMs: 20, timeoutMs: 120, graceMs: 400 };

/**
 * Par de conexiones falsas con la forma de una DataConnection de PeerJS.
 * `cut()` simula que la red se corta sin aviso (los mensajes dejan de llegar).
 */
function fakeConnPair() {
  const make = () => {
    const handlers = new Map();
    return {
      open: true,
      peer: null,
      cutOff: false,
      on(ev, cb) {
        if (!handlers.has(ev)) handlers.set(ev, new Set());
        handlers.get(ev).add(cb);
      },
      off(ev, cb) {
        handlers.get(ev)?.delete(cb);
      },
      emit(ev, data) {
        handlers.get(ev)?.forEach((cb) => cb(data));
      },
      send(obj) {
        const data = JSON.stringify(obj);
        const peer = this.peer;
        if (this.cutOff || !this.open) return;
        setTimeout(() => peer.open && !peer.cutOff && peer.emit('data', JSON.parse(data)), 1);
      },
      close() {
        if (!this.open) return;
        this.open = false;
        this.emit('close');
        const peer = this.peer;
        if (!this.cutOff) setTimeout(() => peer.close(), 1);
      },
    };
  };
  const a = make(), b = make();
  a.peer = b;
  b.peer = a;
  return { a, b, cut: () => (a.cutOff = b.cutOff = true) };
}

/** Dos PeerLink conectados. */
function linkedPair(timing = FAST) {
  const x = new PeerLink(timing), y = new PeerLink(timing);
  const pair = fakeConnPair();
  x.attach(pair.a);
  y.attach(pair.b);
  return { x, y, pair, reconnect: () => { const p = fakeConnPair(); x.attach(p.a); y.attach(p.b); return p; } };
}

test('código de sala: se normaliza y se valida', () => {
  assert.equal(normalizeCode('abcd'), 'ABCD');
  assert.equal(normalizeCode(' a-b c d '), 'ABCD');
  assert.equal(normalizeCode('ABC'), null);
  assert.equal(normalizeCode('ABIO'), null, 'sin I ni O');
  assert.equal(normalizeCode(null), null);
});

test('PeerLink: mensajes en ambos sentidos y el latido mantiene viva la conexión', async () => {
  const { x, y } = linkedPair();
  const got = [];
  y.onMessage((m) => got.push(m));
  x.send({ type: 'hola', n: 1 });
  await wait(300); // más que el timeout: el latido debe mantenerla
  x.send({ type: 'hola', n: 2 });
  await wait(20);
  assert.deepEqual(got, [{ type: 'hola', n: 1 }, { type: 'hola', n: 2 }]);
  assert.ok(x.online && y.online);
  x.close();
  await wait(30);
});

test('PeerLink: salida voluntaria avisa al otro lado al instante', async () => {
  const { x, y } = linkedPair();
  let closedX = false, closedY = false;
  x.onClose(() => (closedX = true));
  y.onClose(() => (closedY = true));
  x.close();
  await wait(30);
  assert.equal(closedY, true);
  assert.equal(y.closeReason, 'bye');
  assert.equal(closedX, false, 'quien sale no recibe su propio aviso');
});

test('PeerLink: si la red se corta, queda fuera de línea y se recupera al reconectar', async () => {
  const { x, y, pair, reconnect } = linkedPair();
  const status = [];
  y.onStatus((on) => status.push(on));
  let closed = false;
  y.onClose(() => (closed = true));
  pair.cut();
  await wait(200); // > timeoutMs
  assert.equal(y.online, false);
  assert.deepEqual(status, [false]);
  x.send({ type: 'perdido' }); // sin conexión: se descarta
  reconnect();
  const got = [];
  y.onMessage((m) => got.push(m));
  x.send({ type: 'vuelve' });
  await wait(30);
  assert.deepEqual(status, [false, true]);
  assert.deepEqual(got, [{ type: 'vuelve' }]);
  await wait(450); // pasado el tiempo de gracia original: ya no debe cerrarse
  assert.equal(closed, false);
  x.close();
  await wait(30);
});

test('PeerLink: si no vuelve dentro del tiempo de gracia, se cierra del todo', async () => {
  const { y, pair } = linkedPair();
  let closed = false;
  y.onClose(() => (closed = true));
  pair.cut();
  await wait(650); // timeout + gracia
  assert.equal(closed, true);
  assert.equal(y.closeReason, 'timeout');
});

/** Partida en línea simulada: J0 en la pestaña del host (local), J1 por un PeerLink. */
function onlineMatch() {
  const cfg = { ...DEFAULT_CONFIG, minigames: { ...DEFAULT_CONFIG.minigames, pool: ['mash'] } };
  const [hostSide, mySide] = createLocalPair();
  const hostLink = new PeerLink(FAST), guestLink = new PeerLink(FAST);
  const pair = fakeConnPair();
  hostLink.attach(pair.a);
  guestLink.attach(pair.b);
  const rng = createRng(5);
  const host = new Host({ transports: [hostSide, hostLink], config: cfg, seedSource: () => rng.int(0, 0xffffffff) });
  const c0 = new GameClient(mySide, { name: 'Ana' });
  const c1 = new GameClient(guestLink, { name: 'Beto' });
  return { host, c0, c1, hostLink, guestLink, pair };
}

test('en línea: el anfitrión ve cuando el amigo pierde la conexión y la partida se recupera', async () => {
  const { host, c0, c1, hostLink, guestLink, pair } = onlineMatch();
  const seen = [];
  c0.on('peerStatus', (e) => seen.push(e));
  guestLink.onStatus((on) => on && c1.requestState());
  c0.connect();
  c1.connect();
  await wait(40);
  c0.pickWeapon('burst');
  c1.pickWeapon('mortar');
  await wait(40);
  c0.playMinigame({ taps: 30 });
  c1.playMinigame({ taps: 5 });
  await wait(40);
  pair.cut(); // el invitado se queda sin red
  c0.fire(40, 70); // el host sigue: este disparo no le llega al invitado
  await wait(200);
  assert.deepEqual(seen, [{ player: 1, online: false }]);
  assert.notEqual(L.hashState(c1.state), L.hashState(host.state), 'el invitado se quedó atrás');
  // Vuelve la red: reconecta y pide el estado.
  const p2 = fakeConnPair();
  hostLink.attach(p2.a);
  guestLink.attach(p2.b);
  await wait(60);
  assert.deepEqual(seen.at(-1), { player: 1, online: true });
  assert.equal(L.hashState(c1.state), L.hashState(host.state));
  // Y la partida sigue con normalidad.
  c1.fire(35, 60);
  await wait(40);
  assert.equal(L.hashState(c1.state), L.hashState(host.state));
  assert.equal(host.state.phase, 'shop');
  hostLink.close();
  await wait(30);
});

test('en línea: si el invitado recarga la página, vuelve a su lugar (incluido el minijuego pendiente)', async () => {
  const { host, c0, c1, hostLink, pair } = onlineMatch();
  c0.connect();
  c1.connect();
  await wait(40);
  c0.pickWeapon('burst');
  c1.pickWeapon('cluster');
  await wait(40);
  c1.playMinigame({ taps: 12 }); // el invitado ya jugó; el anfitrión todavía no
  await wait(40);
  // "Recarga": pestaña nueva, cliente nuevo y conexión nueva con el mismo lugar.
  pair.cut(); // la pestaña vieja muere sin despedirse
  await wait(200);
  const fresh = new PeerLink(FAST);
  const p = fakeConnPair();
  hostLink.attach(p.a);
  fresh.attach(p.b);
  const again = new GameClient(fresh, { name: 'Beto' });
  again.connect();
  await wait(60);
  assert.equal(again.me, 1);
  assert.equal(L.hashState(again.state), L.hashState(host.state));
  assert.equal(again.myWeapon, 'cluster');
  assert.equal(again.myMinigameDone, true, 'sabe que ya jugó el minijuego');
  assert.deepEqual(again.names, ['Ana', 'Beto']);
  c0.playMinigame({ taps: 3 });
  await wait(40);
  assert.equal(again.state.phase, 'aim');
  assert.equal(again.state.turn, 1, 'su resultado de antes de recargar cuenta');
  hostLink.close();
  void c1;
  await wait(30);
});
