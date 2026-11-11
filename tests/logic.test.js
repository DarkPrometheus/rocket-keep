// Tests de la lógica pura: determinismo, reglas y la "huella" de referencia.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../game/logic.js';
import { runScenario, applyInput, determinismFingerprint } from './scenario.js';
import { MINIGAMES, needlePos } from '../game/minigames.js';
import { createRng } from '../game/rng.js';

/**
 * Huella de referencia: hash final de 5 partidas guionizadas. Si cambias las
 * reglas A PROPÓSITO (balance, armas, etc.), actualiza este valor con el que
 * reporte el test. Si cambia sin querer, algo rompió el determinismo.
 */
const FINGERPRINT = '685d1305-b0393e6b-6ffca588-39a05251-394b6e78'; // tras los minijuegos variados

/** Partida nueva con armas ya elegidas (por defecto, ambos con ráfaga). */
const armed = (w0 = 'burst', w1 = 'burst') => L.chooseWeapon(L.chooseWeapon(L.createMatch(), 0, w0).state, 1, w1).state;
/**
 * Resuelve el minijuego haciendo que gane `first`: lo cambia por "Machaca"
 * (fácil de controlar) y le da más toques al ganador.
 */
function winMinigame(st, first = 0) {
  const s = { ...st, minigame: { id: 'mash', params: { durationMs: 3000, maxTaps: 80 } } };
  const entries = first === 0 ? [{ taps: 30 }, { taps: 10 }] : [{ taps: 10 }, { taps: 30 }];
  return L.playMinigame(s, entries).state;
}
/** Ronda nueva ya en fase de disparo, abriendo el jugador 0. */
const freshRound = (seed = 123, w0, w1) => winMinigame(L.startRound(armed(w0, w1), seed).state, 0);
const WEAPONS = Object.keys(L.createMatch().config.weapons);

// ---------- determinismo ----------

test('misma semilla + mismos inputs = mismo resultado (20 partidas)', () => {
  for (let s = 1; s <= 20; s++) {
    const a = runScenario(s);
    const b = runScenario(s);
    assert.equal(a.finalHash, b.finalHash, `escenario ${s}`);
    assert.deepEqual(a.shotHashes, b.shotHashes);
  }
});

test('huella de referencia (detecta cambios de reglas no intencionales)', () => {
  assert.equal(determinismFingerprint(), FINGERPRINT);
});

test('semillas distintas dan partidas distintas', () => {
  assert.notEqual(runScenario(1).finalHash, runScenario(2).finalHash);
});

test('reproducir la lista de inputs desde cero llega al mismo estado', () => {
  const { inputs, finalHash } = runScenario(9);
  let st = L.createMatch();
  for (const input of inputs) st = applyInput(st, input);
  assert.equal(L.hashState(st), finalHash);
});

test('el estado sobrevive a JSON (como al viajar por la red) sin cambiar el resultado', () => {
  const { inputs } = runScenario(11);
  let a = L.createMatch();
  let b = L.createMatch();
  for (const input of inputs) {
    a = applyInput(a, input);
    b = applyInput(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(input)));
    assert.equal(L.hashState(a), L.hashState(b));
  }
});

test('el ShotResult completo es idéntico entre dos resoluciones', () => {
  const st = freshRound(555);
  const r1 = L.resolveShot(st.field, 0, st.players[0], 47.3, 71.9, st.config);
  const r2 = L.resolveShot(st.field, 0, st.players[0], 47.3, 71.9, st.config);
  assert.deepEqual(r1, r2);
});

test('las funciones no modifican el estado de entrada', () => {
  const st = freshRound();
  const before = L.hashState(st);
  L.fire(st, 0, 45, 60);
  L.previewShot(st, 0, 45, 60);
  assert.equal(L.hashState(st), before);
  const shop = { ...st, phase: 'shop' };
  const beforeShop = L.hashState(shop);
  L.buy(shop, 0, 'hp');
  L.setReady(shop, 0);
  assert.equal(L.hashState(shop), beforeShop);
});

test('ambos lados son espejo exacto con cada arma (mismo daño con el mismo tiro)', () => {
  for (const w of WEAPONS) {
    for (let seed = 1; seed <= 6; seed++) {
      const st = freshRound(seed * 31, w, w);
      for (let a = 15; a <= 75; a += 12) {
        for (let p = 30; p <= 100; p += 14) {
          const d0 = L.resolveShot(st.field, 0, st.players[0], a, p, st.config).rawDamage;
          const d1 = L.resolveShot(st.field, 1, st.players[1], a, p, st.config).rawDamage;
          assert.equal(d0, d1, `${w}, semilla ${seed}, ${a}°, ${p}%`);
        }
      }
    }
  }
});

// ---------- armas ----------

test('elección de arma: validaciones y la partida no empieza sin ambas', () => {
  const m = L.createMatch();
  assert.equal(m.phase, 'loadout');
  assert.equal(L.chooseWeapon(m, 0, 'láser').error, 'Arma desconocida');
  assert.equal(L.chooseWeapon(m, 0, 'toString').error, 'Arma desconocida');
  const one = L.chooseWeapon(m, 0, 'mortar').state;
  assert.equal(L.chooseWeapon(one, 0, 'burst').error, 'Ya elegiste tu arma');
  assert.equal(L.startRound(one, 1).error, 'Falta que alguien elija su arma');
  const both = L.chooseWeapon(one, 1, 'cluster').state;
  const st = L.startRound(both, 1).state;
  assert.equal(st.phase, 'minigame');
  assert.equal(L.chooseWeapon(st, 0, 'burst').error, 'Las armas se eligen al inicio de la partida');
});

test('mortero: dispara un solo proyectil, más daño por cohete y compuertas al 60 %', () => {
  const st = freshRound(5, 'mortar', 'mortar');
  const w = st.config.weapons.mortar;
  const r = L.resolveShot(st.field, 0, st.players[0], 45, 60, st.config);
  assert.equal(r.baseRockets, 1);
  assert.equal(r.rocketDamage, (st.players[0].damagePerRocket * w.damagePct) / 100);
  assert.equal(L.effectiveMult(30, w), 1 + Math.floor((29 * w.gateMultPct) / 100));
  assert.equal(L.effectiveMult(2, st.config.weapons.burst), 2);
});

test('una compuerta que para el arma vale x1 se ignora (no cuenta como cruce)', () => {
  const st = freshRound(5, 'mortar', 'mortar');
  // Una x2 justo en el camino de un tiro: para el mortero vale 1 + floor(1·60 %) = x1.
  const field = { gates: [{ id: 0, seg: [430, 400, 430, 640], mult: 2 }] };
  const r = L.resolveShot(field, 0, st.players[0], 45, 60, st.config);
  assert.equal(r.splits.length, 0);
});

test('racimo: cada cohete base se divide solo en lo más alto', () => {
  const st = freshRound(5, 'cluster', 'cluster');
  const noGates = { gates: [] };
  const r = L.resolveShot(noGates, 0, st.players[0], 50, 70, st.config);
  const autoSplits = r.splits.filter((s) => s.gate === null);
  assert.equal(autoSplits.length, st.players[0].baseRockets);
  for (const s of autoSplits) assert.equal(s.mult, st.config.weapons.cluster.clusterSplit);
  // En el punto de división la velocidad vertical es ~0 (lo más alto de la parábola).
  const base = r.particles.find((p) => p.parent === -1);
  const vyAtSplit = base.vy + st.config.physics.gravity * (base.t1 - base.t0);
  assert.ok(Math.abs(vyAtSplit) < 1e-9);
});

// ---------- reglas ----------

test('validaciones de disparo', () => {
  const st = freshRound();
  assert.equal(L.fire(st, 1, 45, 60).error, 'No es tu turno');
  assert.equal(L.fire(st, 0, 999, 60).error, 'Ángulo fuera de rango');
  assert.equal(L.fire(st, 0, 45, 0).error, 'Potencia fuera de rango');
  assert.equal(L.fire(st, 0, NaN, 60).error, 'Ángulo inválido');
  assert.equal(L.fire(st, 0, 45, '60').error, 'Potencia inválida');
  assert.equal(L.buy(st, 0, 'hp').error, 'La tienda está cerrada');
});

test('la semilla de ronda debe ser un entero de 32 bits', () => {
  const st = armed();
  assert.equal(L.startRound(st, -1).ok, false);
  assert.equal(L.startRound(st, 1.5).ok, false);
  assert.equal(L.startRound(st, 2 ** 32).ok, false);
  assert.equal(L.startRound(st, 2 ** 32 - 1).ok, true);
});

test('turnos: la ronda se cierra tras dos disparos y la siguiente empieza con el minijuego', () => {
  let st = freshRound(1);
  assert.equal(st.turn, 0);
  st = L.fire(st, 0, 20, 30).state;
  assert.equal(st.turn, 1);
  st = L.fire(st, 1, 20, 30).state;
  assert.equal(st.phase, 'shop');
  st = L.setReady(L.setReady(st, 0).state, 1).state;
  st = L.startRound(st, 2).state;
  assert.equal(st.round, 2);
  assert.equal(st.phase, 'minigame');
  assert.equal(L.fire(st, 0, 45, 60).error, 'No es momento de disparar');
});

// ---------- minijuego ----------

/** Fuerza un minijuego concreto (con parámetros generados por la config) en la ronda. */
function withMinigame(id, seed = 9, coins = [50, 50]) {
  let st = L.startRound(armed(), seed).state;
  st = { ...st, players: st.players.map((p, i) => ({ ...p, coins: coins[i] })) };
  const rng = createRng(seed);
  return { ...st, minigame: { id, params: MINIGAMES[id].gen(rng, st.config.minigames[id] ?? {}, st) } };
}

/** Entrada buena y mala de cada minijuego (la buena siempre gana a la mala). */
const GOOD_BAD = {
  needle: (p) => {
    // La aguja avanza más de 1 unidad por ms: se busca el momento más cercano a la marca.
    let ms = 0;
    for (let t = 0; t < 3000; t++) if (Math.abs(needlePos(p, t) - p.target) < Math.abs(needlePos(p, ms) - p.target)) ms = t;
    return [{ ms }, { ms: p.maxMs }];
  },
  count: (p) => [{ guess: p.n, ms: 4000 }, { guess: p.n + 3, ms: 1000 }],
  simon: () => [{ reached: 7, ms: 20000 }, { reached: 6, ms: 9000 }],
  mash: () => [{ taps: 25 }, { taps: 24 }],
  maze: () => [{ ms: 9000, done: 1 }, { ms: 4000, done: 0 }], // llegar siempre gana a no llegar
  rps: () => [{ picks: [0, 1, 2] }, { picks: [0, 0, 1] }], // empate y luego papel > piedra
};

test('minijuegos: cada uno da la apertura a quien juega mejor (en ambos lados)', () => {
  for (const [id, gb] of Object.entries(GOOD_BAD)) {
    for (const first of [0, 1]) {
      const st = withMinigame(id);
      const [good, bad] = gb(st.minigame.params);
      const r = L.playMinigame(st, first === 0 ? [good, bad] : [bad, good]);
      assert.ok(r.ok, `${id}: ${r.error}`);
      assert.equal(r.state.phase, 'aim');
      assert.equal(r.state.turn, first, `${id}, gana J${first}`);
      assert.equal(r.result.winner, first);
    }
  }
});

test('minijuegos: los empates mantienen la alternancia', () => {
  for (const round of [1, 2]) {
    const t = { ...withMinigame('mash'), round, firstShooter: (round - 1) % 2 };
    const rt = L.playMinigame(t, [{ taps: 20 }, { taps: 20 }]);
    assert.equal(rt.result.winner, null);
    assert.equal(rt.state.turn, (round - 1) % 2);
    const rps = L.playMinigame({ ...withMinigame('rps'), round, firstShooter: (round - 1) % 2 }, [{ picks: [1, 2, 0] }, { picks: [1, 2, 0] }]);
    assert.equal(rps.result.winner, null);
    assert.equal(rps.state.turn, (round - 1) % 2);
  }
});

test('minijuegos: la semilla elige y nunca repite el de la ronda anterior', () => {
  const seen = new Set();
  let st = L.startRound(armed(), 1).state;
  for (let i = 0; i < 60; i++) {
    const prev = st.minigame.id;
    seen.add(prev);
    // (se salta el minijuego y los disparos: solo importa qué elige la siguiente ronda)
    st = { ...st, phase: 'shop', players: st.players.map((p) => ({ ...p, ready: true, coins: 20 })) };
    st = L.startRound(st, 1000 + i).state;
    assert.notEqual(st.minigame.id, prev);
  }
  assert.deepEqual([...seen].sort(), [...st.config.minigames.pool].sort(), 'salen todos');
  // Misma semilla → mismo minijuego y mismos parámetros.
  assert.deepEqual(L.startRound(armed(), 77).state.minigame, L.startRound(armed(), 77).state.minigame);
});

test('minijuegos: validaciones de entradas', () => {
  const bad = {
    needle: [{ ms: -1 }, { ms: 1.5 }, { ms: 999999 }],
    count: [{ guess: 'x', ms: 1 }, { guess: 3 }],
    simon: [{ reached: 99, ms: 1 }],
    mash: [{ taps: 500 }, {}],
    maze: [{ ms: -1, done: 1 }, { ms: 1000, done: 2 }, { ms: 1000 }],
    rps: [{ picks: [0, 1] }, { picks: [0, 1, 3] }],
  };
  for (const [id, entries] of Object.entries(bad)) {
    const st = withMinigame(id);
    const okEntry = GOOD_BAD[id](st.minigame.params)[0];
    for (const e of entries) {
      assert.equal(L.playMinigame(st, [e, okEntry]).ok, false, `${id}: ${JSON.stringify(e)}`);
      assert.ok(L.validateMinigameEntry(st, 0, e), `${id}: ${JSON.stringify(e)}`);
    }
    assert.equal(L.validateMinigameEntry(st, 0, okEntry), null, id);
  }
  const st = withMinigame('mash');
  assert.equal(L.playMinigame(st, [{ taps: 1 }]).error, 'Faltan entradas del minijuego');
  assert.equal(L.playMinigame(st, [null, { taps: 1 }]).error, 'Entrada inválida');
  const done = winMinigame(st, 0);
  assert.equal(L.playMinigame(done, [{ taps: 1 }, { taps: 1 }]).error, 'No es momento del minijuego');
});

test('minijuegos: la aguja va y viene entre 0 y 1000', () => {
  const p = withMinigame('needle').minigame.params;
  for (let ms = 0; ms < 5000; ms += 7) {
    const x = needlePos(p, ms);
    assert.ok(x >= 0 && x <= 1000);
  }
});

test('ningún disparo supera el tope de daño por disparo', () => {
  for (let s = 1; s <= 30; s++) {
    const { inputs } = runScenario(s);
    let st = L.createMatch();
    for (const input of inputs) {
      if (input.type === 'fire') {
        const target = st.players[1 - input.player];
        const r = L.fire(st, input.player, input.angle, input.power);
        assert.ok(r.result.damage <= L.maxShotDamage(target, st.config));
        st = r.state;
      } else st = applyInput(st, input);
    }
  }
});

test('economía: monedas = ingreso fijo + daño / divisor', () => {
  const cfg = L.createMatch().config;
  assert.equal(L.coinsForRound({ damageThisRound: 0 }, cfg), cfg.roundIncome);
  assert.equal(L.coinsForRound({ damageThisRound: 99 }, cfg), cfg.roundIncome + Math.floor(99 / cfg.coinDivisor));
});

test('tienda: costos, compra, nivel máximo y mejora de vida', () => {
  let st = { ...freshRound(), phase: 'shop' };
  st.players = st.players.map((p) => ({ ...p, coins: 10_000 }));
  const cfg = st.config;
  const hp0 = st.players[0].hp;
  st = L.buy(st, 0, 'hp').state;
  assert.equal(st.players[0].maxHp, cfg.player.hp + cfg.upgrades.hp.amount);
  assert.equal(st.players[0].hp, hp0 + cfg.upgrades.hp.amount, 'la mejora de vida también cura');
  for (let i = 0; i < cfg.upgrades.rockets.maxLevel; i++) st = L.buy(st, 0, 'rockets').state;
  assert.equal(L.buy(st, 0, 'rockets').error, 'Mejora al máximo');
  assert.equal(L.upgradeCost(cfg, 'damage', 1), Math.floor((cfg.upgrades.damage.baseCost * cfg.upgrades.damage.costGrowthPct) / 100));
  assert.equal(L.buy(st, 0, 'nada').error, 'Mejora desconocida');
});

test('curación: desde la ronda 2, sin pasar de la vida máxima, y la mejora la aumenta', () => {
  const cfg = L.createMatch().config;
  let st = freshRound(1);
  assert.deepEqual(st.players.map((p) => p.healedThisRound), [0, 0], 'la ronda 1 no cura');
  // Daño simulado: J0 pierde 100, J1 solo 10.
  st = { ...st, phase: 'shop' };
  st.players = [{ ...st.players[0], hp: st.players[0].maxHp - 100, ready: true }, { ...st.players[1], hp: st.players[1].maxHp - 10, ready: true }];
  st = L.startRound(st, 2).state;
  assert.equal(st.players[0].healedThisRound, cfg.healPerRound);
  assert.equal(st.players[0].hp, st.players[0].maxHp - 100 + cfg.healPerRound);
  assert.equal(st.players[1].healedThisRound, 10, 'no pasa de la vida máxima');
  assert.equal(st.players[1].hp, st.players[1].maxHp);
  // Mejora "Reparación".
  let shop = { ...st, phase: 'shop' };
  shop.players = shop.players.map((p) => ({ ...p, coins: 1000, ready: false }));
  shop = L.buy(shop, 0, 'repair').state;
  assert.equal(shop.players[0].healPerRound, cfg.healPerRound + cfg.upgrades.repair.amount);
});

test('perks: se compran una vez y tienen efecto', () => {
  const cfg = L.createMatch().config;
  let st = { ...freshRound(3), phase: 'shop' };
  st.players = st.players.map((p) => ({ ...p, coins: 1000 }));
  // Compra única.
  st = L.buy(st, 1, 'armor').state;
  assert.equal(st.players[1].coins, 1000 - cfg.perks.armor.cost);
  assert.equal(L.buy(st, 1, 'armor').error, 'Ya tienes ese perk');
  assert.equal(L.buy(st, 1, 'toString').error, 'Mejora desconocida');
  assert.ok(L.shopOffers(st, 1).find((o) => o.id === 'armor').owned);
  // Ahorro: monedas extra por ronda.
  st = L.buy(st, 0, 'savings').state;
  const base = L.coinsForRound({ damageThisRound: 100, perks: [] }, cfg);
  assert.equal(L.coinsForRound({ damageThisRound: 100, perks: ['savings'] }, cfg), base + cfg.perks.savings.value);
  // Blindaje: el mismo disparo hace menos daño a quien lo tiene.
  let a = freshRound(21);
  let b = freshRound(21);
  b.players = b.players.map((p, i) => (i === 1 ? { ...p, perks: ['armor'] } : p));
  // Busca un tiro que haga daño.
  let shot = null;
  for (let ang = 20; ang <= 75 && !shot; ang += 5) {
    for (let pw = 30; pw <= 100 && !shot; pw += 5) {
      if (L.resolveShot(a.field, 0, a.players[0], ang, pw, a.config).rawDamage > 50) shot = [ang, pw];
    }
  }
  assert.ok(shot, 'hay algún tiro con daño');
  const ra = L.fire(a, 0, ...shot).result;
  const rb = L.fire(b, 0, ...shot).result;
  assert.equal(rb.rawDamage, ra.rawDamage);
  assert.ok(rb.damage < ra.damage);
  assert.equal(rb.damage, Math.min(Math.floor((ra.rawDamage * (100 - cfg.perks.armor.value)) / 100), L.maxShotDamage(b.players[1], cfg)));
});

test('sin límite de rondas por defecto: la partida sigue hasta un KO', () => {
  let st = { ...freshRound(), round: 50 };
  st.players = [{ ...st.players[0], hp: 500 }, { ...st.players[1], hp: 400 }];
  st = L.fire(L.fire(st, st.turn, 20, 30).state, 1 - st.turn, 20, 30).state;
  assert.equal(st.config.maxRounds, 0);
  assert.equal(st.phase, 'shop');
});

test('con límite configurado: victoria por rondas y muerte súbita', () => {
  const base = L.createMatch();
  const limited = (s) => ({ ...s, config: { ...s.config, maxRounds: 10 } });
  base.config.maxRounds = 10;
  // Llega a la última ronda con vidas distintas: gana quien tenga más.
  let st = limited({ ...freshRound(), round: base.config.maxRounds });
  st.players = [{ ...st.players[0], hp: 500 }, { ...st.players[1], hp: 400 }];
  st = L.fire(L.fire(st, st.turn, 20, 30).state, 1 - st.turn, 20, 30).state;
  assert.equal(st.phase, 'over');
  assert.equal(st.winner, 0);
  assert.equal(st.endReason, 'rounds');
  // Con la misma vida, hay muerte súbita.
  let tie = limited({ ...freshRound(), round: base.config.maxRounds });
  tie.players = tie.players.map((p) => ({ ...p, hp: 700 }));
  tie = L.fire(L.fire(tie, tie.turn, 20, 30).state, 1 - tie.turn, 20, 30).state;
  assert.equal(tie.phase, 'shop');
  assert.equal(tie.suddenDeath, true);
});
