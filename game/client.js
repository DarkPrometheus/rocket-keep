// =============================================================
// client.js — Cliente de la partida (sin interfaz).
//
// Mantiene una copia del estado aplicando, con logic.js, los mismos
// inputs que difunde el host. Así puede calcular el ShotResult de cada
// disparo para animarlo sin que el host tenga que mandarlo entero.
// Tras cada cambio compara su hash con el del host; si difieren, pide
// el estado completo.
//
// Lo usan tanto el jugador humano (a través del controller) como el bot.
// No sabe nada de canvas ni del DOM: emite eventos.
//
// Eventos (client.on(nombre, cb)):
//   welcome {you}            matchStart {state}
//   weaponPicked {player}    weaponsChosen {weapons, state}
//   minigameIn {player}      minigame {result, state}   ← minijuego resuelto
//   roundStart {state}       shot {result, state}
//   roundEnd {state}         bought {player, upgrade, state}
//   playerReady {player}     gameOver {winner, reason, state}
//   rematchAsked {player}    opponentLeft {}
//   error {message}          desync {}     resynced {state}
//   peerStatus {player, online}  ← un jugador perdió / recuperó la conexión
//   change {state}  ← después de cualquier cambio de estado
// =============================================================

import * as L from './logic.js';
import { C2H, H2C, PROTOCOL_VERSION } from '../net/protocol.js';

export class GameClient {
  #transport;
  #handlers = new Map();
  #awaitingResync = false;

  /** Índice de este jugador (0 o 1), lo asigna el host en `welcome`. */
  me = null;
  /** Copia local del estado. */
  state = null;
  names = ['Jugador 1', 'Jugador 2'];
  /** Arma que eligió este jugador (se sabe antes de que el host la revele). */
  myWeapon = null;
  /** Quién ya eligió arma en esta partida: [bool, bool]. */
  picked = [false, false];
  /** ¿Ya mandé mi resultado del minijuego en esta ronda? */
  myMinigameDone = false;
  /** Quién ya jugó el minijuego de esta ronda: [bool, bool]. */
  minigameIn = [false, false];

  constructor(transport, { name } = {}) {
    this.#transport = transport;
    this.name = name;
    transport.onMessage((msg) => this.#handle(msg));
    transport.onClose(() => this.#emit('opponentLeft', {}));
  }

  /** Saluda al host; la partida empieza cuando ambos saludan. */
  connect() {
    this.#transport.send({ type: C2H.HELLO, version: PROTOCOL_VERSION, name: this.name });
  }

  // ---------- suscripción a eventos ----------

  on(event, cb) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(cb);
    return () => this.#handlers.get(event).delete(cb);
  }

  #emit(event, data) {
    this.#handlers.get(event)?.forEach((cb) => cb(data));
  }

  // ---------- consultas ----------

  get isMyTurn() {
    return this.state?.phase === 'aim' && this.state.turn === this.me;
  }

  get inShop() {
    return this.state?.phase === 'shop' && !this.state.players[this.me].ready;
  }

  /** ¿Toca elegir arma? */
  get choosingWeapon() {
    return this.state?.phase === 'loadout' && !this.myWeapon;
  }

  /** ¿Toca jugar el minijuego? */
  get inMinigame() {
    return this.state?.phase === 'minigame' && !this.myMinigameDone;
  }

  /** Manda mi resultado del minijuego (una sola vez por ronda). */
  playMinigame(entry) {
    if (!this.inMinigame) return;
    this.myMinigameDone = true;
    this.#transport.send({ type: C2H.MINIGAME, entry });
  }

  // ---------- acciones (solo intenciones; el host decide) ----------

  pickWeapon(weapon) {
    if (!this.choosingWeapon) return;
    this.myWeapon = weapon;
    this.#transport.send({ type: C2H.PICK_WEAPON, weapon });
  }

  fire(angle, power) {
    this.#transport.send({ type: C2H.FIRE, angle, power });
  }

  buy(upgrade) {
    this.#transport.send({ type: C2H.BUY, upgrade });
  }

  ready() {
    this.#transport.send({ type: C2H.READY });
  }

  rematch() {
    this.#transport.send({ type: C2H.REMATCH });
  }

  /** Pide el estado completo al host (tras una reconexión), sin tratarlo como error. */
  requestState() {
    this.#awaitingResync = true;
    this.#transport.send({ type: C2H.RESYNC });
  }

  // ---------- recepción ----------

  /** Aplica una función de logic.js; si falla, el estado está desincronizado. */
  #apply(r) {
    if (!r.ok) {
      this.#requestResync(`La lógica local rechazó un input del host: ${r.error}`);
      return null;
    }
    this.state = r.state;
    return r;
  }

  #check(hash) {
    if (hash && L.hashState(this.state) !== hash) {
      this.#requestResync('El hash local no coincide con el del host');
      return false;
    }
    return true;
  }

  #requestResync(reason) {
    if (this.#awaitingResync) return;
    this.#awaitingResync = true;
    this.#emit('desync', { reason });
    this.#transport.send({ type: C2H.RESYNC });
  }

  #handle(msg) {
    // Mientras se espera el estado completo, se ignora lo demás.
    if (this.#awaitingResync && msg.type !== H2C.STATE && msg.type !== H2C.ERROR) return;

    switch (msg.type) {
      case H2C.WELCOME:
        this.me = msg.you;
        this.#emit('welcome', { you: msg.you });
        return;

      case H2C.MATCH_START:
        this.state = L.createMatch(msg.config);
        this.names = msg.names;
        this.myWeapon = null;
        this.picked = [false, false];
        if (!this.#check(msg.hash)) return;
        this.#emit('matchStart', { state: this.state });
        break;

      case H2C.WEAPON_PICKED:
        this.picked[msg.player] = true;
        this.#emit('weaponPicked', { player: msg.player });
        break;

      case H2C.WEAPONS_CHOSEN: {
        let s = this.state;
        for (const q of [0, 1]) {
          const r = L.chooseWeapon(s, q, msg.weapons[q]);
          if (!r.ok) return this.#requestResync(`Arma inválida del host: ${r.error}`);
          s = r.state;
        }
        this.state = s;
        if (!this.#check(msg.hash)) return;
        this.#emit('weaponsChosen', { weapons: msg.weapons, state: this.state });
        break;
      }

      case H2C.ROUND_START:
        if (!this.#apply(L.startRound(this.state, msg.seed)) || !this.#check(msg.hash)) return;
        this.myMinigameDone = false;
        this.minigameIn = [false, false];
        this.#emit('roundStart', { state: this.state });
        break;

      case H2C.MINIGAME_IN:
        this.minigameIn[msg.player] = true;
        this.#emit('minigameIn', { player: msg.player });
        break;

      case H2C.MINIGAME_RESULT: {
        const r = this.#apply(L.playMinigame(this.state, msg.entries));
        if (!r || !this.#check(msg.hash)) return;
        this.#emit('minigame', { result: r.result, state: this.state });
        break;
      }

      case H2C.SHOT_RESULT: {
        const r = this.#apply(L.fire(this.state, msg.shooter, msg.angle, msg.power));
        if (!r || !this.#check(msg.hash)) return;
        this.#emit('shot', { result: r.result, state: this.state });
        break;
      }

      case H2C.ROUND_RESULT:
        if (!this.#check(msg.hash)) return;
        this.#emit('roundEnd', { state: this.state });
        break;

      case H2C.BOUGHT:
        if (!this.#apply(L.buy(this.state, msg.player, msg.upgrade)) || !this.#check(msg.hash)) return;
        this.#emit('bought', { player: msg.player, upgrade: msg.upgrade, state: this.state });
        break;

      case H2C.PLAYER_READY:
        if (!this.#apply(L.setReady(this.state, msg.player)) || !this.#check(msg.hash)) return;
        this.#emit('playerReady', { player: msg.player });
        break;

      case H2C.GAME_OVER:
        if (!this.#check(msg.hash)) return;
        this.#emit('gameOver', { winner: msg.winner, reason: msg.reason, state: this.state });
        break;

      case H2C.REMATCH_ASKED:
        this.#emit('rematchAsked', { player: msg.player });
        return;

      case H2C.STATE: {
        this.state = msg.state;
        if (msg.names) this.names = msg.names;
        // Lo que el host guarda en secreto y nos concierne: así se retoma donde estábamos.
        const pend = msg.pending;
        if (pend && this.me !== null) {
          this.picked = [...pend.picked];
          this.myWeapon = this.state.players[this.me].weapon ?? pend.yourPick ?? null;
          this.minigameIn = [...pend.minigameIn];
          this.myMinigameDone = pend.minigameIn[this.me];
        }
        this.#awaitingResync = false;
        this.#emit('resynced', { state: this.state, rematch: pend?.rematch });
        break;
      }

      case H2C.PEER_STATUS:
        this.#emit('peerStatus', { player: msg.player, online: msg.online });
        return;

      case H2C.OPPONENT_LEFT:
        this.#emit('opponentLeft', {});
        return;

      case H2C.ERROR:
        this.#emit('error', { message: msg.message });
        return;

      default:
        return;
    }
    this.#emit('change', { state: this.state });
  }
}
