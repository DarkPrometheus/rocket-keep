// =============================================================
// host.js — Árbitro autoritativo de la partida.
//
// Corre en la pestaña de quien crea la partida (o en la única pestaña
// si se juega contra el bot). Recibe un transporte por jugador:
//   transports[0] → jugador 0, transports[1] → jugador 1
// Es el único que genera semillas y el único que decide qué es válido.
// Los clientes (incluido el jugador local del host) solo le mandan
// intenciones y reproducen lo que él difunde.
// =============================================================

import * as L from './logic.js';
import { DEFAULT_CONFIG } from './config.js';
import { randomSeed } from './rng.js';
import { C2H, H2C, PROTOCOL_VERSION, validateClientMessage } from '../net/protocol.js';

export class Host {
  #transports;
  #config;
  #seedSource;
  #log;
  #state = null;
  #hello = [false, false];
  #names = ['Jugador 1', 'Jugador 2'];
  #rematch = [false, false];
  #picks = [null, null]; // armas elegidas, en secreto hasta que ambos eligen
  #entries = [null, null]; // entradas del minijuego de la ronda, en secreto hasta que ambos juegan
  #unsubs = [];

  /**
   * @param {object} o
   * @param {Array} o.transports   dos transportes, uno por jugador
   * @param {object} [o.config]    configuración de balance
   * @param {() => number} [o.seedSource]  de dónde salen las semillas (inyectable para tests)
   * @param {(...a) => void} [o.log]       registro opcional
   */
  constructor({ transports, config = DEFAULT_CONFIG, seedSource = randomSeed, log = () => {} }) {
    this.#transports = transports;
    this.#config = config;
    this.#seedSource = seedSource;
    this.#log = log;
    transports.forEach((t, p) => {
      this.#unsubs.push(t.onMessage((msg) => this.#handle(p, msg)));
      this.#unsubs.push(t.onClose(() => this.#onPlayerLeft(p)));
      // Transportes en línea: avisa al otro jugador si este pierde la conexión (y si vuelve).
      const unsub = t.onStatus?.((online) => this.#broadcast({ type: H2C.PEER_STATUS, player: p, online }));
      if (unsub) this.#unsubs.push(unsub);
    });
  }

  /** Estado autoritativo actual (solo lectura, para depurar). */
  get state() {
    return this.#state;
  }

  /** Desconecta al host de los transportes. */
  dispose() {
    this.#unsubs.forEach((u) => u());
    this.#unsubs = [];
  }

  // ---------- envío ----------

  #sendTo(p, msg) {
    this.#transports[p].send(msg);
  }

  #broadcast(msg) {
    this.#transports.forEach((t) => t.send(msg));
  }

  #error(p, message) {
    this.#log(`Host: rechazo a J${p}: ${message}`);
    this.#sendTo(p, { type: H2C.ERROR, message });
  }

  #hash() {
    return L.hashState(this.#state);
  }

  // ---------- flujo de la partida ----------

  /** Nueva partida: empieza en la fase de elección de armas. */
  #newMatch() {
    this.#state = L.createMatch(this.#config);
    this.#rematch = [false, false];
    this.#picks = [null, null];
    this.#broadcast({ type: H2C.MATCH_START, config: this.#state.config, names: this.#names, hash: this.#hash() });
  }

  /**
   * Elección de arma. El host la guarda en secreto y solo avisa "ya eligió";
   * cuando ambos eligieron, las aplica a la vez y las revela juntas (así en
   * línea nadie puede elegir viendo la del rival).
   */
  #onPickWeapon(p, weapon) {
    if (this.#picks[p]) return this.#error(p, 'Ya elegiste tu arma');
    const check = L.chooseWeapon(this.#state, p, weapon);
    if (!check.ok) return this.#error(p, check.error);
    this.#picks[p] = weapon;
    this.#broadcast({ type: H2C.WEAPON_PICKED, player: p });
    if (this.#picks.every(Boolean)) {
      let s = this.#state;
      for (const q of [0, 1]) s = L.chooseWeapon(s, q, this.#picks[q]).state;
      this.#state = s;
      this.#broadcast({ type: H2C.WEAPONS_CHOSEN, weapons: [...this.#picks], hash: this.#hash() });
      this.#beginRound();
    }
  }

  #beginRound() {
    const seed = this.#seedSource() >>> 0;
    const r = L.startRound(this.#state, seed);
    if (!r.ok) {
      this.#log('Host: no se pudo iniciar ronda:', r.error);
      return;
    }
    this.#state = r.state;
    this.#entries = [null, null];
    this.#broadcast({ type: H2C.ROUND_START, round: this.#state.round, seed, hash: this.#hash() });
  }

  /** Entrada del minijuego: secreta hasta que ambos juegan; luego se resuelve y se revela. */
  #onMinigame(p, entry) {
    if (this.#entries[p]) return this.#error(p, 'Ya jugaste el minijuego');
    const err = L.validateMinigameEntry(this.#state, p, entry);
    if (err) return this.#error(p, err);
    this.#entries[p] = entry;
    this.#broadcast({ type: H2C.MINIGAME_IN, player: p });
    if (this.#entries.every(Boolean)) {
      const entries = this.#entries;
      const r = L.playMinigame(this.#state, entries);
      if (!r.ok) return this.#log('Host: minijuego inválido:', r.error);
      this.#state = r.state;
      this.#broadcast({ type: H2C.MINIGAME_RESULT, entries, hash: this.#hash() });
    }
  }

  #onPlayerLeft(p) {
    this.#log(`Host: J${p} se desconectó`);
    const o = L.other(p);
    this.#sendTo(o, { type: H2C.OPPONENT_LEFT });
  }

  // ---------- manejo de mensajes ----------

  #handle(p, msg) {
    const v = validateClientMessage(msg);
    if (!v.ok) return this.#error(p, v.error);

    if (msg.type === C2H.HELLO) return this.#onHello(p, msg);
    if (!this.#state) return this.#error(p, 'La partida aún no empieza');

    switch (msg.type) {
      case C2H.PICK_WEAPON:
        return this.#onPickWeapon(p, msg.weapon);
      case C2H.MINIGAME:
        return this.#onMinigame(p, msg.entry);
      case C2H.FIRE:
        return this.#onFire(p, msg.angle, msg.power);
      case C2H.BUY:
        return this.#onBuy(p, msg.upgrade);
      case C2H.READY:
        return this.#onReady(p);
      case C2H.REMATCH:
        return this.#onRematch(p);
      case C2H.RESYNC:
        return this.#sendState(p);
    }
  }

  #onHello(p, msg) {
    if (msg.version !== PROTOCOL_VERSION) {
      return this.#error(p, `Versión incompatible (host ${PROTOCOL_VERSION}, tú ${msg.version}). Recarga la página.`);
    }
    if (msg.name) this.#names[p] = msg.name;
    this.#hello[p] = true;
    this.#sendTo(p, { type: H2C.WELCOME, you: p, version: PROTOCOL_VERSION });
    if (this.#state) {
      // Vuelve a entrar a una partida en curso (por ejemplo, recargó la página): le manda todo.
      this.#sendState(p);
    } else if (this.#hello.every(Boolean)) {
      this.#newMatch();
    }
  }

  /**
   * Estado completo para un jugador, más lo que aún es secreto pero le
   * concierne (su arma elegida, si ya jugó el minijuego) para que pueda
   * retomar justo donde estaba.
   */
  #sendState(p) {
    this.#sendTo(p, {
      type: H2C.STATE,
      state: this.#state,
      names: this.#names,
      pending: {
        picked: this.#picks.map(Boolean),
        yourPick: this.#picks[p],
        minigameIn: this.#entries.map(Boolean),
        rematch: [...this.#rematch],
      },
    });
  }

  #onFire(p, angle, power) {
    const r = L.fire(this.#state, p, angle, power);
    if (!r.ok) return this.#error(p, r.error);
    this.#state = r.state;
    const s = this.#state;
    this.#broadcast({ type: H2C.SHOT_RESULT, round: s.round, shooter: p, angle, power, hash: this.#hash() });

    if (s.phase !== 'aim') {
      // La ronda terminó (dos disparos o derribo).
      this.#broadcast({
        type: H2C.ROUND_RESULT,
        round: s.round,
        seed: s.roundSeed,
        hp: s.players.map((pl) => pl.hp),
        coins: s.players.map((pl) => pl.coins),
        hash: this.#hash(),
      });
    }
    if (s.phase === 'over') {
      this.#broadcast({ type: H2C.GAME_OVER, winner: s.winner, reason: s.endReason, hash: this.#hash() });
    }
  }

  #onBuy(p, upgrade) {
    const r = L.buy(this.#state, p, upgrade);
    if (!r.ok) return this.#error(p, r.error);
    this.#state = r.state;
    this.#broadcast({ type: H2C.BOUGHT, player: p, upgrade, hash: this.#hash() });
  }

  #onReady(p) {
    const r = L.setReady(this.#state, p);
    if (!r.ok) return this.#error(p, r.error);
    this.#state = r.state;
    this.#broadcast({ type: H2C.PLAYER_READY, player: p, hash: this.#hash() });
    if (L.bothReady(this.#state)) this.#beginRound();
  }

  #onRematch(p) {
    if (this.#state.phase !== 'over') return this.#error(p, 'La partida no ha terminado');
    this.#rematch[p] = true;
    this.#broadcast({ type: H2C.REMATCH_ASKED, player: p });
    if (this.#rematch.every(Boolean)) this.#newMatch();
  }
}
