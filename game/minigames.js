// =============================================================
// minigames.js — Minijuegos de inicio de ronda (lógica pura).
//
// Cada ronda la semilla elige UN minijuego de `config.minigames.pool`
// (nunca el mismo que la ronda anterior) y genera sus parámetros
// (posiciones, secuencias…), así ambos jugadores ven
// exactamente lo mismo.
//
// Cada jugador juega en su pantalla y manda UNA "entrada" (`entry`) con
// su resultado. El host la guarda en secreto hasta tener las dos y
// entonces se decide quién abre la ronda. Las entradas de tiempo (ms)
// las mide el dispositivo de cada jugador: así el lag no influye.
//
// Definición de un minijuego:
//   label, icon, type, howto     textos para la interfaz
//   available(state)             ¿se puede jugar esta ronda? (opcional)
//   gen(rng, cfg, state)         → params (solo enteros y arrays planos)
//   validate(entry, params, state, p) → mensaje de error | null
//   worst(params)                → entrada de quien no jugó (tiempo agotado)
//   score(params, entry, state, p) → array; MENOR es mejor (orden lexicográfico)
//   decide(params, entries)      → 0 | 1 | null  (opcional; si no, usa score)
//   settle(s, first, entries)    efecto extra sobre el estado (opcional, muta s)
//
// Solo enteros y + - * / → mismo resultado en cualquier navegador.
// =============================================================

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const intArray = (v, len, min, max) => Array.isArray(v) && v.length === len && v.every((x) => isInt(x, min, max));

/** Tiempo máximo que se acepta en cualquier entrada (ms). */
export const MAX_MS = 120000;

// ---------- Detén la aguja ----------

/**
 * Posición de la aguja (0…1000) tras `ms` milisegundos: va y viene a
 * velocidad constante (onda triangular). La interfaz usa la misma fórmula
 * para dibujarla, así lo que ve el jugador es lo que cuenta.
 */
export function needlePos(params, ms) {
  const u = (params.phase + Math.floor((ms * 2000) / params.periodMs)) % 2000;
  return u <= 1000 ? u : 2000 - u;
}

// ---------- Piedra, papel o tijera ----------

/** 0 = piedra, 1 = papel, 2 = tijera. ¿`a` le gana a `b`? */
const rpsBeats = (a, b) => (a === 0 && b === 2) || (a === 1 && b === 0) || (a === 2 && b === 1);

// ---------- catálogo ----------

export const MINIGAMES = Object.freeze({
  needle: {
    label: 'Detén la aguja', icon: '🎚️', type: 'Habilidad',
    howto: 'Detén la aguja lo más cerca posible de la marca.',
    gen: (rng, c) => ({
      periodMs: rng.int(c.periodMinMs, c.periodMaxMs),
      phase: rng.int(0, 1999),
      target: rng.int(150, 850),
      maxMs: c.maxMs,
    }),
    validate: (e, p) => (isInt(e.ms, 0, p.maxMs) ? null : 'Tiempo inválido'),
    worst: (p) => ({ ms: p.maxMs }),
    score: (p, e) => [e.ms >= p.maxMs ? 1001 : Math.abs(needlePos(p, e.ms) - p.target)],
  },

  count: {
    label: 'Cuenta rápida', icon: '🔢', type: 'Percepción',
    howto: '¿Cuántos puntos viste? Gana quien se acerque más (si empatan, el más rápido).',
    gen: (rng, c) => {
      const n = rng.int(c.min, c.max);
      const dots = [];
      let guard = 0;
      while (dots.length < n && guard++ < 5000) {
        const x = rng.int(40, 960), y = rng.int(40, 560);
        // Separación mínima para que se puedan distinguir (enteros: exacto).
        if (dots.every(([dx, dy]) => (dx - x) * (dx - x) + (dy - y) * (dy - y) >= 70 * 70)) dots.push([x, y]);
      }
      return { n: dots.length, dots, showMs: c.showMs, timeMs: c.timeMs };
    },
    validate: (e) => (isInt(e.guess, 0, 999) && isInt(e.ms, 0, MAX_MS) ? null : 'Respuesta inválida'),
    worst: (p) => ({ guess: 0, ms: p.timeMs }),
    score: (p, e) => [Math.abs(e.guess - p.n), e.ms],
  },

  simon: {
    label: 'Simón', icon: '🟩', type: 'Memoria',
    howto: 'Repite la secuencia de colores. Cada nivel añade uno más.',
    gen: (rng, c) => ({ seq: Array.from({ length: c.length }, () => rng.int(0, c.colors - 1)), colors: c.colors }),
    validate: (e, p) => (isInt(e.reached, 0, p.seq.length) && isInt(e.ms, 0, MAX_MS) ? null : 'Resultado inválido'),
    worst: () => ({ reached: 0, ms: MAX_MS }),
    score: (p, e) => [-e.reached, e.ms],
  },

  mash: {
    label: 'Machaca', icon: '👊', type: 'Físico',
    howto: '¡Toca el botón lo más rápido que puedas!',
    gen: (rng, c) => ({ durationMs: c.durationMs, maxTaps: c.maxTaps }),
    validate: (e, p) => (isInt(e.taps, 0, p.maxTaps) ? null : 'Toques inválidos'),
    worst: () => ({ taps: 0 }),
    score: (p, e) => [-e.taps],
  },

  rps: {
    label: 'Piedra, papel o tijera', icon: '✊', type: 'Suerte y lectura',
    howto: 'Elige 3 jugadas en orden. La primera que no empate decide.',
    gen: (rng, c) => ({ picks: c.picks }),
    validate: (e, p) => (intArray(e.picks, p.picks, 0, 2) ? null : 'Jugadas inválidas'),
    worst: (p) => ({ picks: Array.from({ length: p.picks }, () => 0) }),
    score: () => [0],
    decide: (p, entries) => {
      for (let i = 0; i < p.picks; i++) {
        const a = entries[0].picks[i], b = entries[1].picks[i];
        if (a !== b) return rpsBeats(a, b) ? 0 : 1;
      }
      return null;
    },
  },

});

// ---------- API usada por logic.js ----------

/** Elige el minijuego de la ronda y genera sus parámetros. */
export function pickMinigame(rng, state, previousId) {
  const cfg = state.config.minigames;
  const usable = (id) => Object.hasOwn(MINIGAMES, id) && (MINIGAMES[id].available?.(state) ?? true);
  let candidates = cfg.pool.filter((id) => usable(id) && id !== previousId);
  if (!candidates.length) candidates = cfg.pool.filter(usable);
  // Respaldo (un pool sin ninguno disponible): cualquiera que lo esté.
  if (!candidates.length) candidates = Object.keys(MINIGAMES).filter(usable);
  const id = candidates[rng.int(0, candidates.length - 1)];
  return { id, params: MINIGAMES[id].gen(rng, cfg[id] ?? {}, state) };
}

/** Valida la entrada de un jugador para el minijuego actual. */
export function validateEntry(state, playerIndex, entry) {
  const mg = state.minigame;
  if (!mg) return 'No hay minijuego';
  if (!isObj(entry)) return 'Entrada inválida';
  return MINIGAMES[mg.id].validate(entry, mg.params, state, playerIndex);
}

/** Compara dos puntuaciones (menor es mejor). Devuelve 0, 1 o null si empatan. */
function compareScores(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return 0;
    if (b[i] < a[i]) return 1;
  }
  return null;
}

/** Decide el ganador: { first: 0|1|null, scores }. */
export function decideMinigame(state, entries) {
  const mg = state.minigame;
  const def = MINIGAMES[mg.id];
  const scores = [0, 1].map((p) => def.score(mg.params, entries[p], state, p));
  const first = def.decide ? def.decide(mg.params, entries) : compareScores(scores[0], scores[1]);
  return { first, scores };
}

/** Entrada de quien no jugó a tiempo. */
export function worstEntry(state) {
  const mg = state.minigame;
  return MINIGAMES[mg.id].worst(mg.params);
}
