// =============================================================
// bot.js — Rival simulado.
//
// El bot es un cliente más: tiene su GameClient conectado al host por
// un transporte y solo envía inputs (fire / buy / ready / rematch).
// No hace trampa con el host: decide con la misma información que ve
// un humano (su copia del estado), usando logic.js para "imaginar"
// cuánto daño haría cada carril.
//
// Puede usar Math.random: sus decisiones no forman parte de la lógica
// determinista; lo que importa es el ángulo que envía, y ese lo
// resuelve el host.
// =============================================================

import * as L from '../game/logic.js';
import { GameClient } from '../game/client.js';
import { needlePos, mazePathLength } from '../game/minigames.js';

/**
 * Qué tan bien apunta cada dificultad: elige entre los `topN` mejores
 * tiros de una rejilla y luego "tiembla" un poco (ruido en grados y %).
 */
const DIFFICULTY = {
  easy: { topN: 12, angleNoise: 9, powerNoise: 12, mini: { needleMs: 90, countErr: 6, simon: [2, 6], taps: [13, 20], mazeStepMs: [300, 460] } },
  normal: { topN: 8, angleNoise: 6, powerNoise: 9, mini: { needleMs: 50, countErr: 4, simon: [4, 8], taps: [17, 24], mazeStepMs: [210, 320] } },
  hard: { topN: 2, angleNoise: 1.5, powerNoise: 2, mini: { needleMs: 22, countErr: 2, simon: [6, 10], taps: [21, 28], mazeStepMs: [140, 210] } },
};

/** Entero al azar en [a, b] (el bot no necesita determinismo). */
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

/** Cohetes simulados en las pruebas del bot (más barato que el disparo real). */
const BOT_SIM_PARTICLES = 30;

/** Orden en que el bot prefiere comprar mejoras. */
const SHOP_PRIORITY = ['rockets', 'damage', 'armor', 'repair', 'savings', 'hp'];

export class BotPlayer {
  #client;
  #difficulty;
  #thinkMs;
  #weapon;
  #lastActionKey = null; // evita actuar dos veces en el mismo turno/tienda
  #match = 0;            // cuenta partidas (para no confundir claves tras una revancha)
  #timer = null;

  /**
   * @param transport  extremo del transporte del lado del bot
   * @param {{difficulty?: string, thinkMs?: number, name?: string, weapon?: string}} opts
   *        weapon: arma fija; si se omite, elige una al azar en cada partida
   */
  constructor(transport, { difficulty = 'normal', thinkMs = 1200, name = 'Bot', weapon = null } = {}) {
    this.#difficulty = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
    this.#thinkMs = thinkMs;
    this.#weapon = weapon;
    this.#client = new GameClient(transport, { name });
    this.#client.on('matchStart', () => this.#match++);
    this.#client.on('change', () => this.#think());
    this.#client.on('resynced', () => this.#think());
    // Si el rival pide revancha, el bot acepta.
    this.#client.on('rematchAsked', ({ player }) => {
      if (player !== this.#client.me) this.#client.rematch();
    });
    this.#client.connect();
  }

  get client() {
    return this.#client;
  }

  /** Revisa si le toca hacer algo y lo programa tras un "tiempo de pensar". */
  #think() {
    const c = this.#client;
    const s = c.state;
    if (!s) return;
    let key = null;
    if (c.choosingWeapon) key = `weapon:${this.#match}`;
    else if (c.inMinigame) key = `mini:${this.#match}:${s.round}`;
    else if (c.isMyTurn) key = `fire:${this.#match}:${s.round}:${s.shotsThisRound}`;
    else if (c.inShop) key = `shop:${this.#match}:${s.round}`;
    if (!key || key === this.#lastActionKey) return;

    this.#lastActionKey = key;
    clearTimeout(this.#timer);
    let delay = this.#thinkMs * (0.7 + Math.random() * 0.6);
    let entry = null;
    if (key.startsWith('mini')) {
      // Decide ya su resultado (el tiempo que cuenta va DENTRO de la entrada, así que
      // su nivel no cambia) y lo entrega enseguida, para no hacer esperar al jugador.
      entry = this.chooseMinigameEntry(s, c.me);
      delay = this.#thinkMs > 0 ? 300 + Math.random() * 500 : 0;
    }
    this.#timer = setTimeout(() => {
      // Al despertar, comprueba que la situación sigue igual.
      if (key.startsWith('weapon') && c.choosingWeapon) {
        const ids = Object.keys(c.state.config.weapons);
        c.pickWeapon(this.#weapon ?? ids[Math.floor(Math.random() * ids.length)]);
      }
      if (key.startsWith('mini') && c.inMinigame) {
        c.playMinigame(entry);
      }
      if (key.startsWith('fire') && c.isMyTurn) {
        const aim = this.chooseAim(c.state, c.me);
        c.fire(aim.angle, aim.power);
      }
      if (key.startsWith('shop') && c.inShop) this.#shop();
    }, delay);
  }

  /**
   * Elige ángulo y potencia: prueba una rejilla de tiros con la lógica
   * (simulación barata), toma uno de los mejores y le añade ruido.
   */
  chooseAim(state, me) {
    const a = state.config.aim;
    const options = [];
    for (let angle = 15; angle <= 80; angle += 5) {
      for (let power = 25; power <= a.powerMax; power += 5) {
        const r = L.previewShot(state, me, angle, power, { maxParticles: BOT_SIM_PARTICLES });
        options.push({ angle, power, damage: r.rawDamage });
      }
    }
    options.sort((x, y) => y.damage - x.damage);
    const d = this.#difficulty;
    const pick = options[Math.floor(Math.random() * Math.min(d.topN, options.length))];

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const angle = clamp(pick.angle + (Math.random() * 2 - 1) * d.angleNoise, a.angleMin, a.angleMax);
    const power = clamp(pick.power + (Math.random() * 2 - 1) * d.powerNoise, a.powerMin, a.powerMax);
    return { angle: Math.round(angle * 10) / 10, power: Math.round(power) };
  }

  /**
   * Minijuego: simula cómo le iría a un jugador de su nivel. Solo usa lo que
   * vería un humano en pantalla (los parámetros del minijuego).
   */
  chooseMinigameEntry(state, me) {
    const mg = state.minigame;
    const p = mg.params;
    const d = this.#difficulty.mini;
    switch (mg.id) {
      case 'needle': {
        // Busca el momento en que la aguja pasa por la marca y "tiembla" unos ms.
        let best = 700;
        for (let ms = 700; ms < 4000; ms += 5) {
          if (Math.abs(needlePos(p, ms) - p.target) < Math.abs(needlePos(p, best) - p.target)) best = ms;
        }
        return { ms: Math.max(0, Math.min(p.maxMs - 1, best + rand(-d.needleMs, d.needleMs))) };
      }
      case 'count':
        return { guess: Math.max(0, p.n + rand(-d.countErr, d.countErr)), ms: rand(2500, 5500) };
      case 'simon': {
        const reached = Math.min(p.seq.length, rand(d.simon[0], d.simon[1]));
        return { reached, ms: reached * 1800 + rand(0, 1500) };
      }
      case 'mash':
        return { taps: Math.min(p.maxTaps, rand(d.taps[0], d.taps[1])) };
      case 'maze': {
        // Recorre el camino más corto (más unos pasos de duda) a su ritmo.
        const steps = mazePathLength(p) + rand(2, 8);
        const ms = steps * rand(d.mazeStepMs[0], d.mazeStepMs[1]) + rand(800, 2500);
        return ms >= p.timeMs ? { ms: p.timeMs, done: 0 } : { ms, done: 1 };
      }
      case 'rps':
        return { picks: Array.from({ length: p.picks }, () => rand(0, 2)) };
      default:
        return {};
    }
  }

  /** Compra lo que pueda según su prioridad y avisa que está listo. */
  #shop() {
    const c = this.#client;
    let sim = c.state; // simula las compras localmente para saber qué alcanza
    let bought = true;
    while (bought) {
      bought = false;
      // Solo lo que el bot sabe aprovechar (por ejemplo, "Ojo de halcón" no le sirve).
      const offers = L.shopOffers(sim, c.me).filter((o) => o.affordable && SHOP_PRIORITY.includes(o.id));
      offers.sort((a, b) => SHOP_PRIORITY.indexOf(a.id) - SHOP_PRIORITY.indexOf(b.id) || a.cost - b.cost);
      // Prefiere la mejora con menos nivel entre las que puede pagar.
      offers.sort((a, b) => a.level - b.level);
      if (offers.length) {
        const r = L.buy(sim, c.me, offers[0].id);
        if (r.ok) {
          sim = r.state;
          c.buy(offers[0].id);
          bought = true;
        }
      }
    }
    c.ready();
  }
}
