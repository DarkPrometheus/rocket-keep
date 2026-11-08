// =============================================================
// logic.js — Reglas del juego: puras y deterministas.
//
// Sin DOM, sin canvas, sin Math.random, sin fechas, sin Math.sin/cos
// (se usan dsin/dcos de world.js). Cada función recibe un estado y
// devuelve un estado NUEVO (nunca muta el de entrada).
// Misma semilla + mismos inputs = mismo resultado exacto.
//
// Modelo:
// - Apuntado libre: el jugador elige ángulo (grados) y potencia (%).
// - Cada cohete es un proyectil balístico (gravedad constante). Su
//   posición es analítica: p(t) = p0 + v·τ + ½·g·τ², con τ = t - t0.
// - Las compuertas son segmentos COMPARTIDOS en el cielo. Si un cohete
//   cruza una compuerta xM (que no haya cruzado antes), se convierte en
//   M cohetes que salen en abanico desde ese punto, con un pequeño
//   desfase (efecto de cadena).
// - Para no simular miles de objetos, cada cohete simulado tiene un
//   `weight`: cuántos cohetes reales representa.
// - Un cohete termina al tocar el castillo rival (impacto), el terreno
//   o al salir del mapa.
//
// La lógica no sabe nada de cómo se dibuja: el render recibe el
// resultado (`ShotResult`) y lo reproduce como quiera.
// =============================================================

import { createRng, hashString, mixSeeds } from './rng.js';
import { MINIGAMES, pickMinigame, validateEntry, decideMinigame } from './minigames.js';
import { DEFAULT_CONFIG } from './config.js';
import { WORLD, LAUNCHERS, CASTLE_BOXES, GATE_SLOTS, TERRAIN, terrainY, dsin, dcos, degToRad } from './world.js';

// ---------- utilidades internas ----------

/** Copia profunda de datos planos (el estado solo tiene datos JSON). */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const ok = (state, extra = {}) => ({ ok: true, state, ...extra });
const fail = (state, error) => ({ ok: false, state, error });

export const other = (p) => 1 - p;

// ---------- creación de la partida ----------

function createPlayer(cfg) {
  return {
    hp: cfg.player.hp,
    maxHp: cfg.player.hp,
    baseRockets: cfg.player.baseRockets,
    damagePerRocket: cfg.player.damagePerRocket,
    coins: 0,
    upgrades: Object.fromEntries(Object.keys(cfg.upgrades).map((id) => [id, 0])),
    perks: [],        // ids de perks comprados (ver config.perks)
    healPerRound: cfg.healPerRound,
    healedThisRound: 0, // cuánto se reparó al empezar la ronda actual (para mostrarlo)
    damageThisRound: 0,
    totalDamage: 0,
    ready: false,
    weapon: null,     // id del arma elegida al inicio (ver config.weapons)
  };
}

/**
 * Crea una partida nueva en fase 'loadout': cada jugador elige su arma
 * (chooseWeapon) y después el host llama a startRound() con la semilla
 * de la primera ronda.
 */
export function createMatch(config = DEFAULT_CONFIG) {
  const cfg = clone(config);
  return {
    config: cfg,
    round: 0,
    phase: 'loadout', // 'loadout' | 'minigame' | 'aim' | 'shop' | 'over'
    turn: 0,          // jugador que dispara ahora (0 o 1)
    firstShooter: 0,  // quién abrió la ronda actual
    shotsThisRound: 0,
    suddenDeath: false,
    roundSeed: null,
    field: null,
    minigame: null,   // minijuego de la ronda: { id, params, entries, scores, first }
    players: [createPlayer(cfg), createPlayer(cfg)],
    winner: null,     // null | 0 | 1 | 'draw'
    endReason: null,  // 'ko' | 'rounds' | 'draw'
  };
}

// ---------- generación del campo ----------

/**
 * Genera las compuertas de una ronda a partir de su semilla.
 * Se eligen pares simétricos de ranuras (mismo multiplicador en ambos
 * lados) y ranuras centrales, así el campo es igual de justo para los dos.
 * Orden de consumo del RNG: pares, centrales, relleno hasta el mínimo.
 */
export function generateField(roundSeed, cfg) {
  const rng = createRng(roundSeed);
  const gc = cfg.gates;
  const gates = [];
  const usedPairs = new Set();
  const addPair = (i, mult) => {
    usedPairs.add(i);
    const [a, b] = GATE_SLOTS.pairs[i];
    gates.push({ id: gates.length, seg: [...a], mult });
    gates.push({ id: gates.length, seg: [...b], mult });
  };
  GATE_SLOTS.pairs.forEach((_, i) => {
    if (rng.chancePct(gc.pairChancePct)) addPair(i, rng.weighted(gc.table).mult);
  });
  for (const c of GATE_SLOTS.center) {
    if (rng.chancePct(gc.centerChancePct)) gates.push({ id: gates.length, seg: [...c], mult: rng.weighted(gc.table).mult });
  }
  while (gates.length < gc.minGates && usedPairs.size < GATE_SLOTS.pairs.length) {
    const i = rng.int(0, GATE_SLOTS.pairs.length - 1);
    if (!usedPairs.has(i)) addPair(i, rng.weighted(gc.table).mult);
  }
  return { gates };
}

// ---------- rondas ----------

/** Un jugador elige su arma (solo al inicio de la partida, una vez). */
export function chooseWeapon(state, playerIndex, weaponId) {
  if (state.phase !== 'loadout') return fail(state, 'Las armas se eligen al inicio de la partida');
  if (playerIndex !== 0 && playerIndex !== 1) return fail(state, 'Jugador inválido');
  if (typeof weaponId !== 'string' || !Object.hasOwn(state.config.weapons, weaponId)) return fail(state, 'Arma desconocida');
  if (state.players[playerIndex].weapon) return fail(state, 'Ya elegiste tu arma');
  const s = clone(state);
  s.players[playerIndex].weapon = weaponId;
  return ok(s);
}

export const bothArmed = (state) => state.players.every((p) => p.weapon);

/** Inicia una ronda con la semilla que decide el host. */
export function startRound(state, roundSeed) {
  if (state.phase !== 'loadout' && state.phase !== 'shop') {
    return fail(state, `No se puede iniciar ronda en fase "${state.phase}"`);
  }
  if (state.phase === 'loadout' && !bothArmed(state)) {
    return fail(state, 'Falta que alguien elija su arma');
  }
  if (state.phase === 'shop' && !state.players.every((p) => p.ready)) {
    return fail(state, 'Algún jugador no ha terminado de comprar');
  }
  if (!Number.isInteger(roundSeed) || roundSeed < 0 || roundSeed > 0xffffffff) {
    return fail(state, 'Semilla de ronda inválida');
  }
  const s = clone(state);
  s.round += 1;
  s.roundSeed = roundSeed;
  s.field = generateField(roundSeed, s.config);
  // La ronda empieza con un minijuego (elegido por la semilla, con su propio
  // RNG para no alterar las compuertas); playMinigame() decide quién abre.
  s.phase = 'minigame';
  s.minigame = pickMinigame(createRng(mixSeeds(roundSeed, 0x6d696e69)), s, state.minigame?.id ?? null);
  s.firstShooter = (s.round - 1) % 2; // valor por defecto (se usa si hay empate)
  s.turn = s.firstShooter;
  s.shotsThisRound = 0;
  for (const p of s.players) {
    p.damageThisRound = 0;
    p.ready = false;
    // Reparación de inicio de ronda (la primera ronda ya empieza con vida llena).
    const heal = s.round > 1 ? Math.min(p.healPerRound, p.maxHp - p.hp) : 0;
    p.hp += heal;
    p.healedThisRound = heal;
  }
  return ok(s);
}

// ---------- física ----------

/** Velocidad inicial (vx, vy) de un disparo. El jugador 1 dispara hacia la izquierda. */
export function launchVelocity(shooterIndex, angle, power, cfg) {
  const ph = cfg.physics;
  const speed = ph.speedMin + ((ph.speedMax - ph.speedMin) * power) / 100;
  const rad = degToRad(angle);
  const dir = shooterIndex === 0 ? 1 : -1;
  return { vx: dir * speed * dcos(rad), vy: -speed * dsin(rad) };
}

/** Posición de un cohete en el instante t (analítica). */
export function particlePos(p, t, gravity) {
  const tau = t - p.t0;
  return { x: p.x0 + p.vx * tau, y: p.y0 + p.vy * tau + 0.5 * gravity * tau * tau };
}

/**
 * ¿El tramo a→b cruza el segmento de la compuerta? Devuelve la fracción
 * del tramo (0..1) donde se cruza, o null. Solo usa + - * /.
 */
function segmentHit(ax, ay, bx, by, seg) {
  const [cx, cy, dx, dy] = seg;
  const rx = bx - ax, ry = by - ay;
  const sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (den === 0) return null;
  const qx = cx - ax, qy = cy - ay;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

/** Valida ángulo y potencia. Devuelve un mensaje de error o null. */
export function validateAim(angle, power, cfg) {
  const a = cfg.aim;
  if (typeof angle !== 'number' || !Number.isFinite(angle)) return 'Ángulo inválido';
  if (typeof power !== 'number' || !Number.isFinite(power)) return 'Potencia inválida';
  if (angle < a.angleMin || angle > a.angleMax) return 'Ángulo fuera de rango';
  if (power < a.powerMin || power > a.powerMax) return 'Potencia fuera de rango';
  return null;
}

/**
 * Resuelve una ráfaga sin modificar el estado. Devuelve un ShotResult:
 *
 *  particles[] : { id, parent, t0, x0, y0, vx, vy, weight, t1, end, ex, ey }
 *                Cada cohete simulado vuela en parábola desde (x0,y0) en t0
 *                hasta (ex,ey) en t1. `end`: 'split' | 'castle' | 'hill' |
 *                'ground' | 'out'. `weight` = cohetes reales que representa.
 *  splits[]    : { gate, t, x, y, mult, weightIn, weightOut }
 *  hits        : cohetes reales que impactaron el castillo
 *  rawDamage   : hits × daño por cohete (sin limitar a la vida restante)
 *  totalRockets, capped, ticks
 *
 * @param {object} [opts] { maxParticles } para simulaciones baratas (bot)
 */
export function resolveShot(field, shooterIndex, shooter, angle, power, cfg, opts = {}) {
  const g = cfg.physics.gravity;
  const maxParticles = opts.maxParticles ?? cfg.maxParticles;
  const weapon = weaponOf(shooter, cfg);
  // Caja de impacto del castillo rival, ampliada si el arma tiene daño de área.
  const pad = weapon.hitboxPad;
  const rawBox = CASTLE_BOXES[other(shooterIndex)];
  const box = [rawBox[0] - pad, rawBox[1] - pad, rawBox[2] + pad, rawBox[3]];
  const launcher = LAUNCHERS[shooterIndex];
  const v = launchVelocity(shooterIndex, angle, power, cfg);
  // Las aperturas se reflejan para el jugador 1, así ambos lados son espejo exacto.
  const mirror = shooterIndex === 0 ? 1 : -1;
  // Cohetes que dispara esta arma (al menos 1).
  const nRockets = Math.max(1, Math.floor((shooter.baseRockets * weapon.rocketsPct) / 100));

  const particles = [];
  const splits = [];
  let totalRockets = nRockets;
  let capped = false;

  const spawn = (x, y, vx, vy, t0, weight, used, parent) => {
    particles.push({ id: particles.length, parent, t0, x0: x, y0: y, vx, vy, weight, used, t1: null, end: null, ex: 0, ey: 0 });
  };
  const finish = (p, t, x, y, end) => {
    p.t1 = t;
    p.ex = x;
    p.ey = y;
    p.end = end;
  };
  /** Gira un vector un ángulo pequeño (radianes). */
  const rotate = (vx, vy, rad) => {
    const c = dcos(rad), s = dsin(rad);
    return { vx: vx * c - vy * s, vy: vx * s + vy * c };
  };
  /** Reparte `total` en `k` partes enteras lo más iguales posible. */
  const shares = (total, k) => {
    const base = Math.floor(total / k);
    const rem = total - base * k;
    return Array.from({ length: k }, (_, j) => base + (j < rem ? 1 : 0));
  };

  /**
   * Divide un cohete en `mult` (al cruzar una compuerta o, en el racimo, al
   * llegar a lo más alto). Los hijos salen en abanico con un pequeño desfase.
   */
  const split = (p, t1, mult, gateId, spreadDeg) => {
    const at = particlePos(p, t1, g);
    finish(p, t1, at.x, at.y, 'split');
    // Velocidad en el punto de división.
    const vx = p.vx;
    const vy = p.vy + g * (t1 - p.t0);
    // Cohetes reales que salen (respetando el tope por disparo).
    const wanted = p.weight * mult - p.weight;
    const extra = Math.min(wanted, Math.max(0, cfg.maxRocketsPerShot - totalRockets));
    if (extra < wanted) capped = true;
    totalRockets += extra;
    const weightOut = p.weight + extra;
    // Cuántos cohetes se simulan (cada uno con su parte del peso).
    const free = Math.max(1, maxParticles - particles.length);
    const k = Math.max(1, Math.min(mult, cfg.split.maxChildren, weightOut, free));
    const used = gateId === null ? p.used : [...p.used, gateId];
    shares(weightOut, k).forEach((w, j) => {
      const r = rotate(vx, vy, degToRad(mirror * (j - (k - 1) / 2) * spreadDeg));
      spawn(at.x, at.y, r.vx, r.vy, t1 + j * cfg.split.delayTicks, w, used, p.id);
    });
    splits.push({ gate: gateId, t: t1, x: at.x, y: at.y, mult, weightIn: p.weight, weightOut });
  };

  // 1) Ráfaga base: varios cohetes con un pequeño desfase y apertura.
  const nBase = Math.max(1, Math.min(nRockets, cfg.burst.maxParticles));
  shares(nRockets, nBase).forEach((w, i) => {
    const off = degToRad(mirror * (i - (nBase - 1) / 2) * cfg.burst.spreadDeg);
    const r = rotate(v.vx, v.vy, off);
    spawn(launcher.x, launcher.y, r.vx, r.vy, i * cfg.burst.delayTicks, w, [], -1);
  });

  // 2) Simulación por ticks. Los hijos se añaden al final de la lista y se
  //    procesan en el mismo recorrido, así el orden es siempre el mismo.
  let tick = 0;
  for (; tick < cfg.physics.maxTicks; tick++) {
    let alive = false;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.end) continue;
      alive = true;
      if (p.t0 >= tick + 1) continue; // todavía no sale
      const ta = Math.max(p.t0, tick);
      const tb = tick + 1;
      const a = particlePos(p, ta, g);
      const b = particlePos(p, tb, g);

      // ¿Cruza alguna compuerta en este tramo? Se toma la primera.
      let hitGate = null;
      let hitS = 2;
      for (const gate of field.gates) {
        if (p.used.includes(gate.id)) continue;
        if (effectiveMult(gate.mult, weapon) <= 1) continue; // para esta arma no multiplica: se ignora
        const s = segmentHit(a.x, a.y, b.x, b.y, gate.seg);
        if (s !== null && s < hitS) {
          hitS = s;
          hitGate = gate;
        }
      }
      // Racimo: los cohetes base se dividen solos al llegar a lo más alto.
      let apexS = 2;
      if (weapon.clusterSplit > 0 && p.parent === -1 && p.vy < 0) {
        const tApex = p.t0 - p.vy / g;
        if (tApex > ta && tApex <= tb) apexS = (tApex - ta) / (tb - ta);
      }
      if (apexS < hitS) {
        split(p, ta + (tb - ta) * apexS, weapon.clusterSplit, null, weapon.clusterSpreadDeg);
        continue;
      }
      if (hitGate) {
        split(p, ta + (tb - ta) * hitS, effectiveMult(hitGate.mult, weapon), hitGate.id, cfg.split.spreadDeg);
        continue;
      }

      // Colisiones al final del tramo.
      if (b.x >= box[0] && b.x <= box[2] && b.y >= box[1] && b.y <= box[3]) {
        finish(p, tb, b.x, b.y, 'castle');
      } else if (b.y >= terrainY(b.x)) {
        const onHill = b.x > TERRAIN[0][0] && b.x < TERRAIN[TERRAIN.length - 1][0];
        finish(p, tb, b.x, Math.min(b.y, terrainY(b.x)), onHill ? 'hill' : 'ground');
      } else if (b.x < -100 || b.x > WORLD.width + 100) {
        finish(p, tb, b.x, b.y, 'out');
      }
    }
    if (!alive) break;
  }
  // Los que sigan vivos al límite se dan por perdidos.
  for (const p of particles) {
    if (!p.end) {
      const e = particlePos(p, tick, g);
      finish(p, tick, e.x, e.y, 'out');
    }
  }

  let hits = 0;
  for (const p of particles) if (p.end === 'castle') hits += p.weight;
  // `used` solo sirve durante la simulación.
  for (const p of particles) delete p.used;

  // Daño por cohete según el arma (puede ser fraccionario; el total se redondea abajo).
  const rocketDamage = (shooter.damagePerRocket * weapon.damagePct) / 100;

  return {
    shooter: shooterIndex,
    weapon: shooter.weapon ?? 'burst',
    angle,
    power,
    baseRockets: nRockets,
    damagePerRocket: shooter.damagePerRocket,
    rocketDamage,
    particles,
    splits,
    hits,
    rawDamage: Math.floor((hits * shooter.damagePerRocket * weapon.damagePct) / 100),
    totalRockets,
    capped,
    ticks: tick,
  };
}

/** Parámetros del arma de un jugador (ráfaga si todavía no eligió). */
export function weaponOf(player, cfg) {
  return cfg.weapons[player.weapon] ?? cfg.weapons.burst;
}

/** Multiplicador efectivo de una compuerta para un arma (mortero aprovecha menos). */
export function effectiveMult(mult, weapon) {
  return 1 + Math.floor(((mult - 1) * weapon.gateMultPct) / 100);
}

// ---------- minijuego de inicio de ronda ----------

/** ¿Es válida la entrada de este jugador para el minijuego actual? (para el host) */
export function validateMinigameEntry(state, playerIndex, entry) {
  if (state.phase !== 'minigame') return 'No es momento del minijuego';
  if (playerIndex !== 0 && playerIndex !== 1) return 'Jugador inválido';
  return validateEntry(state, playerIndex, entry);
}

/**
 * Resuelve el minijuego con las entradas de ambos (el host lo llama cuando
 * los dos ya jugaron). Abre la ronda el ganador; si empatan, se mantiene la
 * alternancia por ronda.
 * @param entries [entrada J0, entrada J1]  (ver minigames.js)
 */
export function playMinigame(state, entries) {
  if (state.phase !== 'minigame') return fail(state, 'No es momento del minijuego');
  if (!Array.isArray(entries) || entries.length !== 2) return fail(state, 'Faltan entradas del minijuego');
  for (const p of [0, 1]) {
    const err = validateMinigameEntry(state, p, entries[p]);
    if (err) return fail(state, err);
  }
  const s = clone(state);
  const mg = s.minigame;
  const { first, scores } = decideMinigame(s, entries);
  mg.entries = clone(entries);
  mg.scores = scores;
  mg.first = first;
  if (first !== null) s.firstShooter = first;
  MINIGAMES[mg.id].settle?.(s, first, mg.entries);
  s.turn = s.firstShooter;
  s.phase = 'aim';
  return ok(s, { result: { id: mg.id, params: mg.params, entries: mg.entries, scores, winner: first, first: s.firstShooter } });
}

/** Vista previa de un disparo (para el bot). No cambia el estado. */
export function previewShot(state, playerIndex, angle, power, opts) {
  return resolveShot(state.field, playerIndex, state.players[playerIndex], angle, power, state.config, opts);
}

/**
 * Puntos de la trayectoria inicial (sin compuertas) para la mira.
 * Devuelve [{x, y}] cada `step` ticks hasta `ticks` o hasta tocar el suelo.
 */
export function aimPreview(shooterIndex, angle, power, cfg, ticks = 40, step = 3) {
  const v = launchVelocity(shooterIndex, angle, power, cfg);
  const L = LAUNCHERS[shooterIndex];
  const p = { t0: 0, x0: L.x, y0: L.y, vx: v.vx, vy: v.vy };
  const pts = [];
  for (let t = step; t <= ticks; t += step) {
    const pos = particlePos(p, t, cfg.physics.gravity);
    if (pos.y >= terrainY(pos.x)) break;
    pts.push(pos);
  }
  return pts;
}

/**
 * El jugador activo dispara. Valida, resuelve, aplica daño y avanza
 * el turno o cierra la ronda. Devuelve { ok, state, result } donde
 * result es el ShotResult más hpBefore/hpAfter/damage reales.
 */
export function fire(state, playerIndex, angle, power) {
  if (state.phase !== 'aim') return fail(state, 'No es momento de disparar');
  if (playerIndex !== state.turn) return fail(state, 'No es tu turno');
  const err = validateAim(angle, power, state.config);
  if (err) return fail(state, err);

  const s = clone(state);
  const shooter = s.players[playerIndex];
  const target = s.players[other(playerIndex)];
  const shot = resolveShot(s.field, playerIndex, shooter, angle, power, s.config);

  // El daño real no pasa de la vida que le queda al rival ni del tope por
  // disparo (un % de su vida máxima), para que nadie gane de un solo tiro.
  const hpBefore = target.hp;
  const shotCap = maxShotDamage(target, s.config);
  // Blindaje: el rival recibe un % menos (se aplica antes de los topes).
  const armorPct = hasPerk(target, 'armor') ? s.config.perks.armor.value : 0;
  const afterArmor = Math.floor((shot.rawDamage * (100 - armorPct)) / 100);
  const damage = Math.min(afterArmor, hpBefore, shotCap);
  target.hp = hpBefore - damage;
  shooter.damageThisRound += damage;
  shooter.totalDamage += damage;
  s.shotsThisRound += 1;

  const result = { ...shot, round: s.round, damage, damageCapped: shot.rawDamage > shotCap, hpBefore, hpAfter: target.hp };

  if (target.hp <= 0) {
    // Derribo: termina la partida al instante.
    s.phase = 'over';
    s.winner = playerIndex;
    s.endReason = 'ko';
    awardCoins(s);
  } else if (s.shotsThisRound >= 2) {
    endRound(s);
  } else {
    s.turn = other(playerIndex);
  }
  return ok(s, { result });
}

/** Daño máximo que puede recibir un jugador de un solo disparo. */
export function maxShotDamage(target, cfg) {
  return Math.floor((target.maxHp * cfg.maxShotDamagePct) / 100);
}

/** Monedas que gana un jugador al cerrar la ronda: ingreso fijo + según su daño (+ Ahorro). */
export function coinsForRound(player, cfg) {
  const savings = hasPerk(player, 'savings') ? cfg.perks.savings.value : 0;
  return cfg.roundIncome + savings + Math.floor(player.damageThisRound / cfg.coinDivisor);
}

/** ¿El jugador tiene este perk? */
export function hasPerk(player, perkId) {
  return Array.isArray(player.perks) && player.perks.includes(perkId);
}

/** Da las monedas de la ronda (muta `s`, que ya es una copia). */
function awardCoins(s) {
  for (const p of s.players) p.coins += coinsForRound(p, s.config);
}

/** Cierra la ronda: monedas, límite de rondas (si hay) y paso a la tienda (muta `s`). */
function endRound(s) {
  awardCoins(s);
  const cfg = s.config;
  if (cfg.maxRounds > 0 && s.round >= cfg.maxRounds) {
    const [a, b] = s.players;
    if (a.hp !== b.hp) {
      s.phase = 'over';
      s.winner = a.hp > b.hp ? 0 : 1;
      s.endReason = 'rounds';
      return;
    }
    const sdLimit = cfg.maxRounds + (cfg.suddenDeath ? cfg.maxSuddenDeathRounds : 0);
    if (s.round >= sdLimit) {
      s.phase = 'over';
      s.winner = 'draw';
      s.endReason = 'draw';
      return;
    }
    s.suddenDeath = true;
  }
  s.phase = 'shop';
}

// ---------- tienda ----------

/** Costo del siguiente nivel de una mejora (entero). */
export function upgradeCost(cfg, upgradeId, level) {
  const u = cfg.upgrades[upgradeId];
  let cost = u.baseCost;
  for (let i = 0; i < level; i++) cost = Math.floor((cost * u.costGrowthPct) / 100);
  return cost;
}

/**
 * Información de la tienda para un jugador (para la interfaz y el bot).
 * Incluye mejoras (kind: 'upgrade', varios niveles) y perks (kind: 'perk',
 * una sola compra).
 */
export function shopOffers(state, playerIndex) {
  const cfg = state.config;
  const p = state.players[playerIndex];
  const upgrades = Object.keys(cfg.upgrades).map((id) => {
    const level = p.upgrades[id];
    const maxed = level >= cfg.upgrades[id].maxLevel;
    const cost = maxed ? null : upgradeCost(cfg, id, level);
    return {
      id,
      kind: 'upgrade',
      label: cfg.upgrades[id].label,
      level,
      maxLevel: cfg.upgrades[id].maxLevel,
      cost,
      affordable: !maxed && p.coins >= cost,
    };
  });
  const perks = Object.keys(cfg.perks).map((id) => {
    const owned = hasPerk(p, id);
    const perk = cfg.perks[id];
    return {
      id,
      kind: 'perk',
      label: perk.label,
      icon: perk.icon,
      desc: perk.desc,
      level: owned ? 1 : 0,
      maxLevel: 1,
      cost: owned ? null : perk.cost,
      owned,
      affordable: !owned && p.coins >= perk.cost,
    };
  });
  return [...upgrades, ...perks];
}

/** Compra una mejora o un perk (mismo mensaje `buy`; los ids no se repiten). */
export function buy(state, playerIndex, itemId) {
  if (state.phase !== 'shop') return fail(state, 'La tienda está cerrada');
  if (playerIndex !== 0 && playerIndex !== 1) return fail(state, 'Jugador inválido');
  const cfg = state.config;
  if (typeof itemId === 'string' && Object.hasOwn(cfg.perks, itemId)) return buyPerk(state, playerIndex, itemId);
  if (typeof itemId !== 'string' || !Object.hasOwn(cfg.upgrades, itemId)) return fail(state, 'Mejora desconocida');
  const upgradeId = itemId;
  const u = cfg.upgrades[upgradeId];
  const p0 = state.players[playerIndex];
  if (p0.ready) return fail(state, 'Ya terminaste de comprar');
  const level = p0.upgrades[upgradeId];
  if (level >= u.maxLevel) return fail(state, 'Mejora al máximo');
  const cost = upgradeCost(cfg, upgradeId, level);
  if (p0.coins < cost) return fail(state, 'Monedas insuficientes');

  const s = clone(state);
  const p = s.players[playerIndex];
  p.coins -= cost;
  p.upgrades[upgradeId] += 1;
  if (upgradeId === 'rockets') p.baseRockets += u.amount;
  if (upgradeId === 'damage') p.damagePerRocket += u.amount;
  if (upgradeId === 'repair') p.healPerRound += u.amount;
  if (upgradeId === 'hp') {
    // Más vida máxima, y cura esa misma cantidad.
    p.maxHp += u.amount;
    p.hp += u.amount;
  }
  return ok(s, { cost });
}

/** Compra un perk (una sola vez por partida). */
function buyPerk(state, playerIndex, perkId) {
  const perk = state.config.perks[perkId];
  const p0 = state.players[playerIndex];
  if (p0.ready) return fail(state, 'Ya terminaste de comprar');
  if (hasPerk(p0, perkId)) return fail(state, 'Ya tienes ese perk');
  if (p0.coins < perk.cost) return fail(state, 'Monedas insuficientes');
  const s = clone(state);
  const p = s.players[playerIndex];
  p.coins -= perk.cost;
  p.perks.push(perkId);
  return ok(s, { cost: perk.cost });
}

/** El jugador termina de comprar. Cuando ambos lo hacen, el host inicia la ronda. */
export function setReady(state, playerIndex) {
  if (state.phase !== 'shop') return fail(state, 'La tienda está cerrada');
  if (playerIndex !== 0 && playerIndex !== 1) return fail(state, 'Jugador inválido');
  const s = clone(state);
  s.players[playerIndex].ready = true;
  return ok(s);
}

export const bothReady = (state) => state.players.every((p) => p.ready);

// ---------- verificación ----------

/** JSON con claves ordenadas, para que el hash no dependa del orden de inserción. */
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** Hash del estado: host e invitado lo comparan para detectar desincronización. */
export function hashState(state) {
  return hashString(stableStringify(state));
}
