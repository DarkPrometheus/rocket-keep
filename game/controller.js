// =============================================================
// controller.js — Conecta input, cliente de red, render e interfaz.
//
// - Escucha los eventos del GameClient y los mete en una COLA. Se
//   procesan en orden: un disparo espera a que termine su animación
//   antes de mostrar lo siguiente. Así nada "se adelanta" en pantalla
//   aunque el host ya haya avanzado.
// - Mantiene `shown`: el estado que el jugador está viendo ahora mismo
//   (puede ir por detrás del estado real del cliente mientras se anima).
// - Traduce el puntero en el ÁNGULO de la mira (preguntándole al render, que es
//   quien conoce la pantalla). La POTENCIA sale de una barra que se carga
//   MANTENIENDO EL CLIC (sobre el campo o sobre el botón Disparar): al soltar,
//   dispara. Manda intenciones al cliente.
// - Calcula un "modelo de vista" y se lo pasa a la UI (ui.js), que solo
//   dibuja DOM y devuelve clics.
//
// No conoce reglas ni dibuja: delega en logic.js (consultas), en el
// cliente (acciones), en el render (canvas) y en la UI (DOM).
// =============================================================

import * as L from './logic.js';

const PAUSE_BETWEEN_SHOTS_MS = 350;
// Mira inicial neutra: se queda corta a propósito para que haya que apuntar.
const DEFAULT_AIM = Object.freeze({ angle: 35, power: 40 });
const CHARGE_MS = 1500;   // lo que tarda en llenarse la barra de carga
const CHARGE_MIN = 0.06;  // por debajo de esto, soltar cancela (un toque suelto no gasta el turno)

export class Controller {
  #client;
  #renderer;
  #ui;
  #canvas;
  #onLeave;
  #onOpponentStatus;
  #audio;
  #destroyed = false;
  #soundView = null;
  #queue = [];
  #busy = false;
  #shown = null;      // estado mostrado
  #aim = null;        // mira actual: { angle, power }
  #dragging = false;
  #charge = null;     // carga en curso: { t0, prevPower, raf }
  #firedThisTurn = null;
  #rematch = { me: false, opp: false };
  #match = 0;         // cuenta partidas (para no confundir minijuegos tras una revancha)
  #mgKey = null;      // minijuego que ya se está jugando: `${partida}:${ronda}`
  #unsubs = [];
  #unbindInput = null;

  /**
   * @param {object} o
   * @param {import('./client.js').GameClient} o.client
   * @param {object} o.renderer   cualquier objeto con la interfaz de render.js
   * @param {import('./ui.js').GameUI} o.ui
   * @param {HTMLCanvasElement} o.canvas
   * @param {import('./audio.js').GameAudio} [o.audio] efectos de presentación
   * @param {() => void} o.onLeave  volver al menú
   * @param {(online: boolean) => void} [o.onOpponentStatus]  en línea: el rival perdió / recuperó la conexión
   */
  constructor({ client, renderer, ui, canvas, onLeave, audio, onOpponentStatus }) {
    this.#client = client;
    this.#audio = audio;
    this.#renderer = renderer;
    this.#ui = ui;
    this.#canvas = canvas;
    this.#onLeave = onLeave;
    this.#onOpponentStatus = onOpponentStatus;

    ui.setHandlers({
      onPickWeapon: (id) => {
        client.pickWeapon(id);
        this.#refreshUi();
      },
      onChargeStart: () => this.startCharge(),
      onChargeEnd: () => this.releaseCharge(),
      onChargeCancel: () => this.cancelCharge(),
      onBuy: (id) => client.buy(id),
      onReady: () => client.ready(),
      onRematch: () => {
        this.#rematch.me = true;
        client.rematch();
        this.#refreshUi();
      },
      onLeave: () => this.#onLeave?.(),
    });

    const c = client;
    this.#unsubs.push(
      c.on('matchStart', () => {
        this.#match++;
        this.#rematch = { me: false, opp: false };
        this.#firedThisTurn = null;
      }),
      c.on('weaponsChosen', ({ weapons, state }) => {
        const w = state.config.weapons[weapons[L.other(c.me)]];
        this.#push({ kind: 'toast', text: `El rival eligió ${w.icon} ${w.label}` });
      }),
      c.on('minigame', ({ result, state }) => this.#push({ kind: 'minigame', result, state })),
      c.on('minigameIn', ({ player }) => {
        if (player !== c.me) ui.minigame.setOpponentDone(true);
      }),
      c.on('shot', ({ result, state }) => this.#push({ kind: 'shot', result, state })),
      c.on('change', ({ state }) => this.#push({ kind: 'state', state })),
      c.on('roundStart', ({ state }) =>
        this.#push({ kind: 'toast', text: state.suddenDeath ? `Muerte súbita · ronda ${state.round}` : `Ronda ${state.round}` })),
      c.on('bought', ({ player }) => { if (player === c.me) this.#push({ kind: 'sound', name: 'buy' }); }),
      c.on('error', ({ message }) => { this.#audio?.play('error'); ui.toast(message, 'error'); }),
      c.on('desync', () => ui.toast('Resincronizando…', 'error')),
      c.on('resynced', ({ state, rematch }) => {
        // Si mi resultado del minijuego se perdió en la desconexión, se vuelve a jugar.
        if (c.inMinigame) this.#mgKey = null;
        if (rematch) this.#rematch = { me: rematch[c.me], opp: rematch[L.other(c.me)] };
        this.#push({ kind: 'state', state });
      }),
      c.on('peerStatus', ({ player, online }) => {
        if (player !== c.me) this.#onOpponentStatus?.(online);
      }),
      c.on('opponentLeft', () => ui.toast('El rival se desconectó', 'error')),
      c.on('rematchAsked', ({ player }) => {
        if (player !== c.me) {
          this.#rematch.opp = true;
          ui.toast('El rival quiere la revancha');
          this.#refreshUi();
        }
      }),
    );
    this.#bindInput();
  }

  destroy() {
    this.#destroyed = true;
    if (this.#charge) cancelAnimationFrame(this.#charge.raf);
    this.#charge = null;
    this.#queue.length = 0;
    this.#ui.minigame.close();
    this.#unsubs.forEach((u) => u());
    this.#unbindInput?.();
    this.#renderer.destroy();
  }

  // ---------- cola de eventos ----------

  #push(item) {
    if (this.#destroyed) return;
    this.#queue.push(item);
    if (!this.#busy) this.#drain();
  }

  async #drain() {
    this.#busy = true;
    this.#refreshUi();
    while (this.#queue.length) {
      const item = this.#queue.shift();
      if (item.kind === 'shot') {
        this.#renderer.setAim(null);
        await this.#renderer.playShot(item.result);
        if (this.#destroyed) return;
        this.#show(item.state);
        await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_SHOTS_MS));
      } else if (item.kind === 'minigame') {
        await this.#ui.minigame.showResult({ ...item.result, me: this.#client.me });
        if (this.#destroyed) return;
        this.#show(item.state);
      } else if (item.kind === 'state') {
        this.#show(item.state);
      } else if (item.kind === 'sound') {
        this.#audio?.play(item.name);
      } else if (item.kind === 'toast') {
        this.#ui.toast(item.text);
      }
    }
    this.#busy = false;
    this.#refreshUi();
  }

  #show(state) {
    this.#shown = state;
    this.#renderer.setState(state, this.#client.me);
    this.#maybeStartMinigame();
  }

  /** Si la ronda mostrada empieza con minijuego y aún no lo jugué, lo abre. */
  #maybeStartMinigame() {
    const s = this.#shown;
    const c = this.#client;
    if (s?.phase !== 'minigame' || !c.inMinigame) return;
    const key = `${this.#match}:${s.round}`;
    if (this.#mgKey === key) return;
    this.#mgKey = key;
    this.#renderer.setAim(null);
    const ui = this.#ui.minigame;
    ui.play({ id: s.minigame.id, params: s.minigame.params, me: c.me, coins: s.players[c.me].coins })
      .then((entry) => {
        if (this.#destroyed) return;
        c.playMinigame(entry);
        // Si el rival aún no termina, se queda esperando; el resultado reemplaza este panel.
        if (c.state?.phase === 'minigame') ui.waiting();
      });
    if (c.minigameIn[L.other(c.me)]) ui.setOpponentDone(true);
  }

  // ---------- consultas sobre lo mostrado ----------

  /** Solo se puede disparar si es mi turno Y ya no hay animaciones pendientes. */
  get #canFire() {
    const s = this.#shown;
    if (this.#busy || !s) return false;
    return s.phase === 'aim' && s.turn === this.#client.me &&
      this.#firedThisTurn !== `${s.round}:${s.shotsThisRound}`;
  }

  // ---------- input ----------

  #bindInput() {
    const cv = this.#canvas;
    // Arrastrar (o mover el ratón) solo cambia el ÁNGULO; la potencia la fija la barra.
    const aimAngle = (e) => {
      const p = this.#renderer.pointerToAim(e.clientX, e.clientY);
      if (p) this.#setAim({ angle: p.angle, power: (this.#aim ?? DEFAULT_AIM).power });
    };
    const onDown = (e) => {
      if (!this.#canFire) return;
      this.#dragging = true;
      try {
        cv.setPointerCapture?.(e.pointerId); // así el soltar llega aunque el puntero se salga del campo
      } catch {
        /* sin captura: el soltar solo llega si el puntero sigue sobre el campo */
      }
      aimAngle(e);
      this.startCharge(); // mantener el clic carga la barra
    };
    const onMove = (e) => {
      if (this.#dragging || (e.pointerType === 'mouse' && this.#canFire)) aimAngle(e);
    };
    const onUp = () => {
      if (!this.#dragging) return;
      this.#dragging = false;
      this.releaseCharge(); // soltar dispara
    };
    const onCancel = () => {
      this.#dragging = false;
      this.cancelCharge();
    };
    const onKey = (e) => {
      const t = e.target;
      if (t?.closest?.('input, select, textarea, [contenteditable]')) return;
      const onFireBtn = t?.id === 'fire';
      if (t?.closest?.('button') && !onFireBtn) return;
      if (!this.#canFire || !this.#shown) return;
      const a = this.#shown.config.aim;
      const cur = this.#aim ?? DEFAULT_AIM;
      const step = e.shiftKey ? 5 : 1;
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      // ↑/↓ cambian el ángulo (el teclado no dispara: se dispara con el clic).
      if (e.key === 'ArrowUp') this.#setAim({ ...cur, angle: clamp(cur.angle + step, a.angleMin, a.angleMax) });
      else if (e.key === 'ArrowDown') this.#setAim({ ...cur, angle: clamp(cur.angle - step, a.angleMin, a.angleMax) });
      else return;
      e.preventDefault();
    };
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    this.#unbindInput = () => {
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
  }

  /** @param {{angle:number, power:number} | null} aim */
  #setAim(aim) {
    if (!aim) return;
    this.#aim = aim;
    this.#renderer.setAim(aim);
  }

  // ---------- carga de potencia ----------

  /** Empieza a llenar la barra (se mantiene el clic en el campo o en Disparar). */
  startCharge() {
    if (!this.#canFire || this.#charge) return;
    const a = this.#shown.config.aim;
    const charge = { t0: performance.now(), prevPower: (this.#aim ?? DEFAULT_AIM).power, raf: 0 };
    this.#charge = charge;
    const loop = (now) => {
      if (this.#charge !== charge) return;
      if (!this.#canFire) return this.cancelCharge(); // cambió el turno o hay animación
      const level = Math.min(1, (now - charge.t0) / CHARGE_MS);
      this.#setAim({ ...(this.#aim ?? DEFAULT_AIM), power: a.powerMin + level * (a.powerMax - a.powerMin) });
      this.#ui.setCharge(level, 'hold');
      charge.raf = requestAnimationFrame(loop);
    };
    this.#ui.setCharge(0, 'hold');
    charge.raf = requestAnimationFrame(loop);
  }

  /** Suelta el botón: dispara con la carga que lleva (o cancela si apenas cargó). */
  releaseCharge() {
    const c = this.#charge;
    if (!c || !this.#shown) return;
    cancelAnimationFrame(c.raf);
    this.#charge = null;
    const a = this.#shown.config.aim;
    const level = Math.min(1, (performance.now() - c.t0) / CHARGE_MS);
    this.#ui.setCharge(0, 'idle');
    if (level < CHARGE_MIN || !this.#canFire) {
      this.#setAim({ ...(this.#aim ?? DEFAULT_AIM), power: c.prevPower });
      // Un clic muy corto no dispara: se avisa cómo se usa.
      if (level < CHARGE_MIN && this.#canFire) this.#ui.toast('Mantén pulsado para cargar y suelta para disparar');
      return;
    }
    this.#setAim({ ...(this.#aim ?? DEFAULT_AIM), power: a.powerMin + level * (a.powerMax - a.powerMin) });
    this.fire();
  }

  /** Cancela la carga sin disparar. */
  cancelCharge() {
    const c = this.#charge;
    if (!c) return;
    cancelAnimationFrame(c.raf);
    this.#charge = null;
    this.#ui.setCharge(0, 'idle');
    this.#setAim({ ...(this.#aim ?? DEFAULT_AIM), power: c.prevPower });
  }

  /** Dispara con la mira actual. */
  fire() {
    if (!this.#canFire) return;
    const s = this.#shown;
    const aim = this.#aim ?? DEFAULT_AIM;
    const angle = Math.round(aim.angle * 10) / 10;
    const power = Math.round(aim.power);
    this.#renderer.setAim(null);
    this.#firedThisTurn = `${s.round}:${s.shotsThisRound}`;
    this.#client.fire(angle, power);
    this.#refreshUi();
  }

  // ---------- modelo de vista para la UI ----------

  /** Resumen corto de lo que hace un arma, con los números del jugador. */
  #weaponStats(w, player) {
    const n = Math.max(1, Math.floor((player.baseRockets * w.rocketsPct) / 100));
    const parts = [n === 1 ? '1 proyectil' : `${n} cohetes`];
    if (w.damagePct !== 100) parts.push(`daño ×${(w.damagePct / 100).toFixed(w.damagePct % 100 ? 2 : 0)}`);
    if (w.gateMultPct !== 100) parts.push(`compuertas al ${w.gateMultPct} %`);
    if (w.clusterSplit) parts.push(`se divide en ${w.clusterSplit}`);
    if (w.hitboxPad) parts.push('área amplia');
    return parts.join(' · ');
  }

  #view() {
    const s = this.#shown;
    const c = this.#client;
    if (!s) return null;
    const cfg0 = s.config;
    const weaponInfo = (id) => (id ? { id, ...cfg0.weapons[id] } : null);

    // Fase de elección de arma (todavía no hay campo).
    if (s.phase === 'loadout') {
      const me = c.me;
      return {
        names: [c.names[me] ?? 'Tú', c.names[L.other(me)] ?? 'Rival'],
        weapons: [weaponInfo(c.myWeapon), null],
        coins: s.players[me].coins,
        round: 0,
        maxRounds: cfg0.maxRounds,
        suddenDeath: false,
        turn: null,
        canFire: false,
        loadout: {
          options: Object.entries(cfg0.weapons).map(([id, w]) => ({ id, ...w, stats: this.#weaponStats(w, s.players[me]) })),
          myPick: c.myWeapon,
          oppPicked: c.picked[L.other(me)],
        },
        shop: null,
        over: null,
      };
    }
    if (!s.field) return null;
    const me = c.me;
    const op = L.other(me);
    const pm = s.players[me];
    const po = s.players[op];
    const cfg = s.config;

    let turn = null;
    if (s.phase === 'aim' && !this.#busy) turn = s.turn === me ? 'me' : 'opp';

    let shop = null;
    if (s.phase === 'shop' && !this.#busy) {
      const effect = {
        rockets: (u) => `${pm.baseRockets} → ${pm.baseRockets + u.amount} cohetes por ráfaga`,
        hp: (u) => `Vida máx. ${pm.maxHp} → ${pm.maxHp + u.amount} (y cura ${u.amount})`,
        damage: (u) => `${pm.damagePerRocket} → ${pm.damagePerRocket + u.amount} de daño por cohete`,
        repair: (u) => `Repara ${pm.healPerRound} → ${pm.healPerRound + u.amount} de vida por ronda`,
      };
      shop = {
        coins: pm.coins,
        ready: pm.ready,
        oppReady: po.ready,
        summary: {
          dealt: pm.damageThisRound,
          received: po.damageThisRound,
          earned: L.coinsForRound(pm, cfg),
        },
        offers: L.shopOffers(s, me).map((o) => ({
          ...o,
          effect: o.kind === 'perk' ? o.desc : effect[o.id]?.(cfg.upgrades[o.id]) ?? '',
        })),
      };
    }

    let over = null;
    if (s.phase === 'over' && !this.#busy) {
      over = {
        result: s.winner === 'draw' ? 'draw' : s.winner === me ? 'win' : 'lose',
        reason: s.endReason,
        myDamage: pm.totalDamage,
        oppDamage: po.totalDamage,
        rounds: s.round,
        rematchMe: this.#rematch.me,
        rematchOpp: this.#rematch.opp,
      };
    }

    return {
      names: [c.names[me] ?? 'Tú', c.names[op] ?? 'Rival'],
      weapons: [weaponInfo(pm.weapon), weaponInfo(po.weapon)],
      perks: [pm, po].map((pl) => pl.perks.map((id) => cfg.perks[id]).filter(Boolean)),
      loadout: null,
      coins: pm.coins,
      round: s.round,
      maxRounds: cfg.maxRounds,
      suddenDeath: s.suddenDeath,
      turn,
      canFire: this.#canFire,
      shop,
      over,
    };
  }

  #refreshUi() {
    if (this.#destroyed) return;
    const v = this.#view();
    // Avisos al mostrarse el turno/resultado, después de animar el disparo.
    const soundView = v?.over ? `over:${this.#match}` : v?.canFire
      ? `turn:${this.#match}:${this.#shown.round}:${this.#shown.shotsThisRound}` : null;
    if (soundView && soundView !== this.#soundView) {
      this.#soundView = soundView;
      this.#audio?.play(v.over ? v.over.result : 'turn');
    }
    this.#ui.render(v);
    if (v?.canFire) this.#renderer.setAim(this.#aim ?? DEFAULT_AIM);
  }
}
