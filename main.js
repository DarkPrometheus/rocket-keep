// =============================================================
// main.js — Arranque. Aquí se "enchufan" las piezas:
//   host (árbitro) + transportes + cliente local + render + UI + controller.
//
// Modos:
//   - Contra el bot: host, jugador y bot en esta pestaña.
//   - En línea, anfitrión: esta pestaña corre el host; el amigo llega por
//     PeerJS (net/peer.js). El jugador local habla con el host por un
//     transporte local, igual que contra el bot.
//   - En línea, invitado: solo cliente; el host está en la pestaña del amigo.
//     El enlace de invitación lleva el código en el hash (#ABCD) y entra solo.
//
// Para probar otros gráficos basta con cambiar la clase de render
// que se importa abajo (debe cumplir la interfaz de game/render.js).
// =============================================================

import { GameAudio } from './game/audio.js';
import { Host } from './game/host.js';
import { GameClient } from './game/client.js';
import { Controller } from './game/controller.js';
import { CanvasRenderer } from './game/render.js';
import { GameUI } from './game/ui.js';
import { createLocalPair, BotTransport } from './net/transport.js';
import { DEFAULT_CONFIG } from './game/config.js';
import { createRoom, joinRoom, normalizeCode } from './net/peer.js';

const BOT_NAMES = { easy: 'Bot fácil', normal: 'Bot normal', hard: 'Bot difícil' };

const canvas = document.getElementById('game');
const audio = new GameAudio();
const ui = new GameUI(document, { audio });
window.addEventListener('pagehide', () => audio.stopAll());
let current = null; // { host?, controller?, client?, net? }
let attempt = 0;     // cambia al salir: invalida conexiones a medio abrir

/** Cierra la partida o sala en curso (si hay). */
function stopGame() {
  attempt++;
  audio.stopAll();
  current?.host?.dispose();
  current?.controller?.destroy();
  current?.net?.destroy();
  current = null;
  ui.setNetStatus(null);
}

const MENU_HANDLERS = {
  onStartBot: (d) => startVsBot(d),
  onCreateRoom: () => startHostRoom(),
  onJoinRoom: (text) => {
    const code = normalizeCode(text);
    if (code) startJoin(code);
    else ui.toast('El código son 4 letras', 'error');
  },
  onLobbyCancel: () => toMenu(),
};

/** Vuelve al menú principal. */
function toMenu() {
  stopGame();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  ui.setHandlers(MENU_HANDLERS);
  ui.showMenu();
}

/** Crea el render y el controller para un cliente ya creado. */
function startView(client, extra = {}) {
  ui.hideLobby();
  ui.hideMenu();
  const renderer = new CanvasRenderer(canvas, { onSound: (name, data) => audio.play(name, data) });
  const controller = new Controller({ client, renderer, ui, canvas, audio, onLeave: toMenu, ...extra });
  // El controller pone sus handlers; se añaden los de la sala.
  return controller;
}

/** Partida contra el bot: el host vive en esta pestaña. */
function startVsBot(difficulty = 'normal') {
  stopGame();
  void audio.unlock();
  ui.hideMenu();
  const [hostSide, mySide] = createLocalPair();
  const bot = new BotTransport({ difficulty, thinkMs: 900, name: BOT_NAMES[difficulty] });
  const host = new Host({ transports: [hostSide, bot], config: devConfig() });
  const client = new GameClient(mySide, { name: ui.playerName });
  const controller = startView(client);
  client.connect();
  current = { host, controller, client };
  return current;
}

// ---------- en línea ----------

/** Enlace de invitación: esta misma página con el código en el hash. */
const inviteUrl = (code) => `${location.origin}${location.pathname}#${code}`;

/** Mientras se juega en línea, pide confirmación antes de cerrar o recargar. */
window.addEventListener('beforeunload', (e) => {
  if (!current?.net) return;
  e.preventDefault();
  e.returnValue = '';
});

/** Termina la partida en línea mostrando por qué. */
function endOnline(title, message) {
  stopGame();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  ui.setHandlers(MENU_HANDLERS);
  ui.showLobby({ mode: 'error', title, message });
}

/** Anfitrión: abre la sala y espera al amigo. Al llegar, esta pestaña hace de host. */
async function startHostRoom() {
  stopGame();
  void audio.unlock();
  const my = attempt;
  ui.setHandlers(MENU_HANDLERS);
  ui.showLobby({ mode: 'creating' });
  let room;
  try {
    room = await createRoom({ onGuest: (link) => beginHostGame(room, link) });
  } catch (e) {
    if (my === attempt) endOnline('No se pudo crear la sala', e.message);
    return;
  }
  if (my !== attempt) return room.destroy(); // canceló mientras se abría
  current = { net: room };
  const url = inviteUrl(room.code);
  ui.setHandlers({
    ...MENU_HANDLERS,
    onShare: () => navigator.share?.({ title: 'Rocket Keep', text: `¡Juega conmigo a Rocket Keep! Sala ${room.code}`, url }).catch(() => {}),
    onCopyLink: () => navigator.clipboard?.writeText(url).then(() => ui.toast('Enlace copiado'), () => ui.toast('No se pudo copiar', 'error')),
  });
  ui.showLobby({ mode: 'host', code: room.code, url, canShare: typeof navigator.share === 'function' });
}

function beginHostGame(room, link) {
  const [hostSide, mySide] = createLocalPair();
  const host = new Host({ transports: [hostSide, link], config: devConfig() });
  const client = new GameClient(mySide, { name: ui.playerName });
  const controller = startView(client, {
    onOpponentStatus: (online) =>
      ui.setNetStatus(online ? null : 'Tu amigo perdió la conexión. Esperando a que vuelva…'),
  });
  client.on('opponentLeft', () => endOnline('Partida terminada', 'Tu amigo salió de la partida o no pudo volver a conectarse.'));
  ui.toast('¡Tu amigo entró!');
  current = { host, controller, client, net: room };
  client.connect();
}

/** Identificador de este jugador para una sala (así, si recarga, vuelve a su lugar). */
function roomToken(code) {
  const key = `rocket-keep.token.${code}`;
  try {
    let t = sessionStorage.getItem(key);
    if (!t) {
      t = crypto.randomUUID();
      sessionStorage.setItem(key, t);
    }
    return t;
  } catch {
    return crypto.randomUUID();
  }
}

/** Invitado: se une a la sala del amigo. */
async function startJoin(code) {
  stopGame();
  void audio.unlock();
  const my = attempt;
  history.replaceState(null, '', `${location.pathname}${location.search}#${code}`);
  ui.setHandlers(MENU_HANDLERS);
  ui.showLobby({ mode: 'joining', code });
  let session;
  try {
    session = await joinRoom(code, { token: roomToken(code) });
  } catch (e) {
    if (my === attempt) endOnline('No se pudo entrar', e.message);
    return;
  }
  if (my !== attempt) return session.destroy();
  const { link } = session;
  const client = new GameClient(link, { name: ui.playerName });
  const controller = startView(client);
  link.onStatus((online) => {
    ui.setNetStatus(online ? null : 'Conexión perdida. Reconectando…');
    if (online) client.requestState(); // lo que pasó mientras tanto
  });
  client.on('opponentLeft', () => {
    if (link.closeReason === 'full') endOnline('Sala llena', `La sala ${code} ya tiene dos jugadores.`);
    else if (link.closeReason === 'bye') endOnline('Partida terminada', 'Tu amigo cerró la sala.');
    else endOnline('Conexión perdida', 'No se pudo volver a conectar con la sala de tu amigo.');
  });
  current = { controller, client, net: session };
  client.connect();
}

// Solo para desarrollo (capturas automáticas):
//   ?play=easy|normal|hard  empieza directo sin menú
//   ?weapon=burst|mortar|cluster  elige esa arma automáticamente
//   ?autofire=<ms>          dispara solo tras ese tiempo
//   ?minigame=needle,count…  limita los minijuegos a esos ids
const params = new URLSearchParams(location.search);

/** Config de la partida (la normal, salvo los parámetros de desarrollo). */
function devConfig() {
  const only = params.get('minigame')?.split(',').filter((id) => DEFAULT_CONFIG.minigames.pool.includes(id));
  if (!only?.length) return DEFAULT_CONFIG;
  return { ...DEFAULT_CONFIG, minigames: { ...DEFAULT_CONFIG.minigames, pool: only } };
}
const hashCode = normalizeCode(location.hash.slice(1));
if (hashCode) {
  // Enlace de invitación: entra directo a la sala.
  ui.setHandlers(MENU_HANDLERS);
  startJoin(hashCode);
} else if (params.has('play') || params.has('autofire')) {
  const { controller, client } = startVsBot(params.get('play') || 'normal');
  if (params.has('weapon')) client.on('matchStart', () => setTimeout(() => client.pickWeapon(params.get('weapon')), 0));
  const autofire = Number(params.get('autofire'));
  if (autofire > 0) setTimeout(() => controller.fire(), autofire);
} else {
  toMenu();
}

// Si cambia el hash con la página abierta (pegó otro enlace), se une a esa sala.
window.addEventListener('hashchange', () => {
  const code = normalizeCode(location.hash.slice(1));
  if (code && !current?.net) startJoin(code);
});
