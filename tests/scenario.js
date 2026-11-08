// =============================================================
// scenario.js — Partida reproducible para comprobar el determinismo.
//
// Juega una partida completa SOLO con logic.js, donde todas las
// decisiones (armas, semillas, ángulos, potencias, compras) salen de un RNG
// con semilla. Lo usan los tests de Node y debug.html: si un navegador
// obtiene la misma "huella" que Node, la lógica es idéntica en ambos.
// =============================================================

import * as L from '../game/logic.js';
import { createRng } from '../game/rng.js';

/**
 * @param {number} scenarioSeed  semilla que decide todo el guion
 * @returns {{ finalState, finalHash, shotHashes: string[], inputs: object[] }}
 *   `inputs` es la lista de acciones aplicadas (sirve para reproducirlas).
 */
export function runScenario(scenarioSeed) {
  const rng = createRng(scenarioSeed);
  let st = L.createMatch();
  const shotHashes = [];
  const inputs = [];
  const apply = (input) => {
    inputs.push(input);
    st = applyInput(st, input);
  };

  const weaponIds = Object.keys(st.config.weapons);
  let guard = 0;
  while (st.phase !== 'over' && guard++ < 5000) {
    if (st.phase === 'loadout' && !L.bothArmed(st)) {
      for (const p of [0, 1]) apply({ type: 'weapon', player: p, weapon: weaponIds[rng.int(0, weaponIds.length - 1)] });
    } else if (st.phase === 'loadout' || (st.phase === 'shop' && L.bothReady(st))) {
      apply({ type: 'round', seed: rng.int(0, 0xffffffff) });
    } else if (st.phase === 'minigame') {
      apply({ type: 'minigame', entries: [randomEntry(rng, st, 0), randomEntry(rng, st, 1)] });
    } else if (st.phase === 'shop') {
      for (const p of [0, 1]) {
        if (st.players[p].ready) continue;
        // Compra una mejora al azar entre las que alcanzan (o ninguna).
        const offers = L.shopOffers(st, p).filter((o) => o.affordable);
        if (offers.length && rng.chancePct(70)) apply({ type: 'buy', player: p, upgrade: offers[rng.int(0, offers.length - 1)].id });
        else apply({ type: 'ready', player: p });
      }
    } else {
      const angle = rng.int(150, 750) / 10; // 15.0° … 75.0°
      const power = rng.int(250, 1000) / 10; // 25.0 % … 100.0 %
      apply({ type: 'fire', player: st.turn, angle, power });
      shotHashes.push(L.hashState(st));
    }
  }
  return { finalState: st, finalHash: L.hashState(st), shotHashes, inputs };
}

/** Entrada válida al azar para el minijuego actual (para los guiones). */
export function randomEntry(rng, st, p) {
  const { id, params } = st.minigame;
  const ms = () => rng.int(500, 9000);
  switch (id) {
    case 'needle': return { ms: rng.int(0, params.maxMs) };
    case 'count': return { guess: rng.int(Math.max(0, params.n - 5), params.n + 5), ms: ms() };
    case 'simon': return { reached: rng.int(0, params.seq.length), ms: ms() };
    case 'math': return { answers: params.questions.map(() => rng.int(-1, 3)), ms: ms() };
    case 'mash': return { taps: rng.int(0, params.maxTaps) };
    case 'rps': return { picks: Array.from({ length: params.picks }, () => rng.int(0, 2)) };
    case 'auction': return { bid: rng.int(0, st.players[p].coins) };
    case 'cards': return { pick: rng.int(0, params.cards[p].length - 1) };
    default: throw new Error(`Minijuego sin guion: ${id}`);
  }
}

/** Aplica una acción del guion. Lanza error si la lógica la rechaza. */
export function applyInput(st, input) {
  let r;
  if (input.type === 'weapon') r = L.chooseWeapon(st, input.player, input.weapon);
  else if (input.type === 'round') r = L.startRound(st, input.seed);
  else if (input.type === 'minigame') r = L.playMinigame(st, input.entries);
  else if (input.type === 'fire') r = L.fire(st, input.player, input.angle, input.power);
  else if (input.type === 'buy') r = L.buy(st, input.player, input.upgrade);
  else if (input.type === 'ready') r = L.setReady(st, input.player);
  else throw new Error(`Acción desconocida: ${input.type}`);
  if (!r.ok) throw new Error(`La lógica rechazó ${JSON.stringify(input)}: ${r.error}`);
  return r.state;
}

/** Huella combinada de varios escenarios (una sola cadena fácil de comparar). */
export function determinismFingerprint(seeds = [1, 2, 3, 42, 2026]) {
  return seeds.map((s) => runScenario(s).finalHash).join('-');
}
