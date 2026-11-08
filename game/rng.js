// =============================================================
// rng.js — Generador pseudoaleatorio con semilla (mulberry32).
//
// Todo el azar del juego pasa por aquí. Con la misma semilla, dos
// clientes obtienen exactamente la misma secuencia de números.
// Solo se usan operaciones enteras de 32 bits y una división exacta
// entre 2^32, así que el resultado es idéntico en cualquier motor JS.
// =============================================================

/** Devuelve una función que genera floats en [0, 1) a partir de una semilla. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Crea un RNG con utilidades. Todas las utilidades trabajan con enteros
 * para evitar cualquier ambigüedad con decimales.
 */
export function createRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    /** Entero en [min, max], ambos incluidos. */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** true con probabilidad pct/100 (pct entero 0..100). */
    chancePct(pct) {
      return this.int(0, 99) < pct;
    },
    /** Elige un elemento según su `weight` entero. */
    weighted(items) {
      let total = 0;
      for (const it of items) total += it.weight;
      let roll = this.int(0, total - 1);
      for (const it of items) {
        if (roll < it.weight) return it;
        roll -= it.weight;
      }
      return items[items.length - 1];
    },
  };
}

/**
 * Mezcla varios enteros en una semilla de 32 bits (hash tipo FNV-1a).
 * Sirve para derivar sub-semillas o, más adelante, combinar los
 * secretos de host e invitado.
 */
export function mixSeeds(...values) {
  let h = 0x811c9dc5;
  for (const v of values) {
    let x = v >>> 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      x >>>= 8;
    }
  }
  return h >>> 0;
}

/** Hash FNV-1a de 32 bits de un texto, en hexadecimal. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Semilla aleatoria "de verdad" (solo para el host, nunca dentro de la lógica). */
export function randomSeed() {
  if (globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 4294967296) >>> 0;
}
