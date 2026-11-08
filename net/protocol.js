// =============================================================
// protocol.js — Mensajes entre clientes y host.
//
// Modelo: host autoritativo.
//  - El cliente SOLO envía intenciones (disparar, comprar, listo).
//  - El host valida con logic.js, decide semillas y difunde lo que pasó.
//  - Cada cliente vuelve a aplicar los mismos inputs con logic.js para
//    tener su copia del estado y compara el `hash` que manda el host;
//    si no coincide pide el estado completo (resync).
//
// Todos los mensajes son objetos JSON planos con un campo `type`.
// =============================================================

export const PROTOCOL_VERSION = 6; // 6: juego en línea (reingreso y estado de conexión)

/** Cliente → host */
export const C2H = Object.freeze({
  HELLO: 'hello',       // { version, name }
  PICK_WEAPON: 'pickWeapon', // { weapon }  al inicio de la partida
  MINIGAME: 'minigame', // { entry }  resultado de mi minijuego (ver game/minigames.js)
  FIRE: 'fire',         // { angle, power }  grados y porcentaje
  BUY: 'buy',           // { upgrade }
  READY: 'ready',       // {}  terminé de comprar
  REMATCH: 'rematch',   // {}  quiero la revancha
  RESYNC: 'resync',     // {}  mi estado no coincide, mándame el tuyo
});

/** Host → cliente */
export const H2C = Object.freeze({
  WELCOME: 'welcome',          // { you, version }
  MATCH_START: 'matchStart',   // { config, names, hash }
  WEAPON_PICKED: 'weaponPicked',   // { player }  alguien ya eligió (sin decir cuál)
  WEAPONS_CHOSEN: 'weaponsChosen', // { weapons: [a, b], hash }  se revelan juntas
  ROUND_START: 'roundStart',   // { round, seed, hash }  empieza con el minijuego
  MINIGAME_IN: 'minigameIn',   // { player }  alguien ya jugó (sin decir cómo le fue)
  MINIGAME_RESULT: 'minigameResult', // { entries: [a, b], hash }
  SHOT_RESULT: 'shotResult',   // { round, shooter, angle, power, hash }
  ROUND_RESULT: 'roundResult', // { round, seed, hp, coins, hash }
  BOUGHT: 'bought',            // { player, upgrade, hash }
  PLAYER_READY: 'playerReady', // { player, hash }
  GAME_OVER: 'gameOver',       // { winner, reason, hash }
  REMATCH_ASKED: 'rematchAsked', // { player }
  STATE: 'state',              // { state, names, pending }  respuesta a resync o al volver a entrar
  PEER_STATUS: 'peerStatus',   // { player, online }  un jugador perdió / recuperó la conexión
  OPPONENT_LEFT: 'opponentLeft', // {}
  ERROR: 'error',              // { message }
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shortStr = (v, max) => typeof v === 'string' && v.length <= max;

/**
 * Valida la FORMA de un mensaje que llega de un cliente.
 * (Las reglas del juego las valida logic.js.) En la fase 3 los
 * mensajes vendrán de otro navegador, así que no se confía en nada.
 */
export function validateClientMessage(msg) {
  if (!isObj(msg) || typeof msg.type !== 'string') return { ok: false, error: 'Mensaje mal formado' };
  switch (msg.type) {
    case C2H.HELLO:
      if (!Number.isInteger(msg.version)) return { ok: false, error: 'Falta versión' };
      if (msg.name !== undefined && !shortStr(msg.name, 20)) return { ok: false, error: 'Nombre inválido' };
      return { ok: true };
    case C2H.MINIGAME:
      if (!isObj(msg.entry) || JSON.stringify(msg.entry).length > 400) return { ok: false, error: 'Entrada inválida' };
      return { ok: true };
    case C2H.FIRE:
      if (typeof msg.angle !== 'number' || !Number.isFinite(msg.angle)) return { ok: false, error: 'Ángulo inválido' };
      if (typeof msg.power !== 'number' || !Number.isFinite(msg.power)) return { ok: false, error: 'Potencia inválida' };
      return { ok: true };
    case C2H.BUY:
      if (!shortStr(msg.upgrade, 20)) return { ok: false, error: 'Mejora inválida' };
      return { ok: true };
    case C2H.PICK_WEAPON:
      if (!shortStr(msg.weapon, 20)) return { ok: false, error: 'Arma inválida' };
      return { ok: true };
    case C2H.READY:
    case C2H.REMATCH:
    case C2H.RESYNC:
      return { ok: true };
    default:
      return { ok: false, error: `Tipo desconocido: ${msg.type}` };
  }
}
