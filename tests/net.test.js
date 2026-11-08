// Tests del modelo de red con transportes locales (sin navegador):
// host autoritativo, clientes que reproducen y detección de desincronización.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../game/logic.js';
import { Host } from '../game/host.js';
import { GameClient } from '../game/client.js';
import { createLocalPair, BotTransport } from '../net/transport.js';
import { H2C, PROTOCOL_VERSION } from '../net/protocol.js';
import { createRng } from '../game/rng.js';
import { DEFAULT_CONFIG } from '../game/config.js';

/** Config con un solo minijuego (Machaca) para poder decidir quién gana. */
const MASH_ONLY = { ...DEFAULT_CONFIG, minigames: { ...DEFAULT_CONFIG.minigames, pool: ['mash'] } };
const WIN = { taps: 30 };
const LOSE = { taps: 5 };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Espera a que se entreguen los mensajes pendientes (con margen para máquinas lentas). */
const settle = () => wait(60);

/** Juega bot contra bot hasta el final; devuelve el host, los bots y los errores vistos. */
function botMatch(seed) {
  return new Promise((resolve, reject) => {
    const a = new BotTransport({ difficulty: 'hard', thinkMs: 0 });
    const b = new BotTransport({ difficulty: 'easy', thinkMs: 0 });
    const errors = [];
    const rng = createRng(seed);
    const host = new Host({ transports: [a, b], seedSource: () => rng.int(0, 0xffffffff), log: (...x) => errors.push(x.join(' ')) });
    for (const t of [a, b]) {
      t.bot.client.on('error', (e) => errors.push(e.message));
      t.bot.client.on('desync', (e) => errors.push('desync: ' + e.reason));
    }
    const timer = setTimeout(() => reject(new Error('la partida no terminó')), 20000);
    a.bot.client.on('gameOver', async () => {
      clearTimeout(timer);
      await settle(); // deja que el otro bot reciba los últimos mensajes
      resolve({ host, a, b, errors });
    });
  });
}

test('bot vs bot: host y ambos clientes terminan con el mismo estado (10 partidas)', async () => {
  for (let s = 1; s <= 10; s++) {
    const { host, a, b, errors } = await botMatch(s);
    assert.deepEqual(errors, []);
    const h = L.hashState(host.state);
    assert.equal(L.hashState(a.bot.client.state), h);
    assert.equal(L.hashState(b.bot.client.state), h);
  }
});

test('un invitado reconstruye la partida solo con los mensajes del host', async () => {
  // Un "espía" se conecta en el lugar del jugador 1 y graba los mensajes.
  const [hostSide0, mySide0] = createLocalPair();
  const [hostSide1, mySide1] = createLocalPair();
  const rng = createRng(77);
  const host = new Host({ transports: [hostSide0, hostSide1], config: MASH_ONLY, seedSource: () => rng.int(0, 0xffffffff) });
  const c0 = new GameClient(mySide0);
  const c1 = new GameClient(mySide1);
  const log = [];
  mySide1.onMessage((m) => log.push(m));
  c0.connect();
  c1.connect();
  await settle();
  c0.pickWeapon('mortar');
  c1.pickWeapon('cluster');
  await settle();
  // Minijuego: c0 pierde a propósito, así abre c1.
  c0.playMinigame(LOSE);
  c1.playMinigame(WIN);
  await settle();
  assert.equal(c1.state.turn, 1, 'abre quien ganó el minijuego');
  // Una ronda completa.
  for (const [c, a, p] of [[c1, 40, 70], [c0, 30, 50]]) {
    c.fire(a, p);
    await settle();
  }
  c0.ready();
  c1.ready();
  await settle();
  c0.playMinigame(LOSE);
  c1.playMinigame(WIN);
  await settle();
  c1.fire(55, 80);
  await settle();

  // Reproduce SOLO con logic.js y los mensajes grabados.
  let st = null;
  for (const m of log) {
    if (m.type === H2C.MATCH_START) st = L.createMatch(m.config);
    if (m.type === H2C.WEAPONS_CHOSEN) for (const q of [0, 1]) st = L.chooseWeapon(st, q, m.weapons[q]).state;
    if (m.type === H2C.ROUND_START) st = L.startRound(st, m.seed).state;
    if (m.type === H2C.MINIGAME_RESULT) st = L.playMinigame(st, m.entries).state;
    if (m.type === H2C.SHOT_RESULT) st = L.fire(st, m.shooter, m.angle, m.power).state;
    if (m.type === H2C.PLAYER_READY) st = L.setReady(st, m.player).state;
    if (m.type === H2C.BOUGHT) st = L.buy(st, m.player, m.upgrade).state;
    if (m.hash) assert.equal(L.hashState(st), m.hash, `tras ${m.type}`);
  }
  assert.equal(L.hashState(st), L.hashState(host.state));
  assert.equal(st.round, 2);
  assert.deepEqual(st.players.map((p) => p.weapon), ['mortar', 'cluster']);
});

test('las armas se mantienen en secreto hasta que ambos eligen', async () => {
  const [h0, c0s] = createLocalPair();
  const [h1, c1s] = createLocalPair();
  const host = new Host({ transports: [h0, h1], config: MASH_ONLY });
  const c0 = new GameClient(c0s);
  const c1 = new GameClient(c1s);
  const seenBy1 = [];
  c1s.onMessage((m) => seenBy1.push(m));
  c0.connect();
  c1.connect();
  await settle();
  c0.pickWeapon('mortar');
  await settle();
  // El jugador 1 solo sabe que el 0 ya eligió, no cuál.
  assert.ok(seenBy1.some((m) => m.type === H2C.WEAPON_PICKED && m.player === 0));
  // (matchStart trae la config con todas las armas; se revisa lo que llegó después)
  const afterStart = seenBy1.filter((m) => m.type !== H2C.MATCH_START);
  assert.ok(!JSON.stringify(afterStart).includes('mortar'));
  assert.equal(host.state.players[0].weapon, null, 'el estado público no la revela');
  c1.pickWeapon('burst');
  await settle();
  assert.ok(seenBy1.some((m) => m.type === H2C.WEAPONS_CHOSEN));
  assert.equal(c1.state.players[0].weapon, 'mortar');
  assert.equal(c1.state.phase, 'minigame');
  // El resultado del minijuego también es secreto hasta que ambos juegan.
  const before = seenBy1.length;
  c0.playMinigame({ taps: 37 });
  await settle();
  const mgMsgs = seenBy1.slice(before);
  assert.ok(mgMsgs.some((m) => m.type === H2C.MINIGAME_IN && m.player === 0));
  assert.ok(!JSON.stringify(mgMsgs).includes('taps'), 'no se filtra el resultado');
  c1.playMinigame(LOSE);
  await settle();
  assert.equal(c1.state.phase, 'aim');
  assert.equal(c1.state.minigame.entries[0].taps, 37);
  // No se puede cambiar después.
  const errs = [];
  c0.on('error', (e) => errs.push(e.message));
  c0s.send({ type: 'pickWeapon', weapon: 'burst' });
  await settle();
  assert.deepEqual(errs, ['Ya elegiste tu arma']);
});

test('el host rechaza mensajes inválidos y fuera de turno', async () => {
  const [hs, cs] = createLocalPair();
  const bot = new BotTransport({ thinkMs: 1000 }); // lento para que no avance solo
  new Host({ transports: [hs, bot] });
  const c = new GameClient(cs);
  const errs = [];
  c.on('error', (e) => errs.push(e.message));
  cs.send('basura');
  cs.send({ type: 'nope' });
  cs.send({ type: 'hello', version: PROTOCOL_VERSION + 1 });
  c.connect();
  await settle();
  cs.send({ type: 'fire', angle: 45 }); // sin potencia
  cs.send({ type: 'buy', upgrade: 'hp' }); // la tienda está cerrada
  await settle();
  assert.deepEqual(errs, [
    'Mensaje mal formado',
    'Tipo desconocido: nope',
    `Versión incompatible (host ${PROTOCOL_VERSION}, tú ${PROTOCOL_VERSION + 1}). Recarga la página.`,
    'Potencia inválida',
    'La tienda está cerrada',
  ]);
});

test('si el estado del cliente se corrompe, se detecta y se resincroniza', async () => {
  const [h0, c0s] = createLocalPair();
  const [h1, c1s] = createLocalPair();
  const host = new Host({ transports: [h0, h1], config: MASH_ONLY });
  const c0 = new GameClient(c0s);
  const c1 = new GameClient(c1s);
  let desync = false, resynced = false;
  c1.on('desync', () => (desync = true));
  c1.on('resynced', () => (resynced = true));
  c0.connect();
  c1.connect();
  await settle();
  c0.pickWeapon('burst');
  c1.pickWeapon('burst');
  await settle();
  c0.playMinigame(WIN);
  c1.playMinigame(LOSE); // abre c0
  await settle();
  c1.state.players[1].hp -= 1; // corrupción local
  c0.fire(30, 50);
  await settle();
  assert.ok(desync && resynced);
  assert.equal(L.hashState(c1.state), L.hashState(host.state));
});

test('si un jugador se desconecta, el otro recibe el aviso', async () => {
  const [h0, c0s] = createLocalPair();
  const [h1, c1s] = createLocalPair();
  new Host({ transports: [h0, h1] });
  const c0 = new GameClient(c0s);
  new GameClient(c1s).connect();
  let left = false;
  c0.on('opponentLeft', () => (left = true));
  c0.connect();
  await settle();
  c1s.close();
  await settle();
  assert.ok(left);
});
