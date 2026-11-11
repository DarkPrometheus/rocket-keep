// =============================================================
// maps.js — Mapas del campo de batalla (uno por partida, lo elige la semilla).
//
// Cada mapa tiene:
//   terrain   silueta del suelo (puntos clave de la MITAD izquierda; se
//             refleja sola). Entre puntos clave se suaviza con smoothstep
//             y se muestrea cada 16 unidades → polilínea de ENTEROS.
//   blocks    obstáculos sólidos en el aire o sobre el suelo (polígonos de
//             enteros): rocas, islas, muralla, aguja de roca… Un cohete que
//             cruza su borde explota ahí.
//   gates     ranuras de compuertas: `pairs` (se da la izquierda; la
//             derecha es su reflejo) y `center` (en el eje).
//
// Todo es simétrico: el campo es igual de justo para ambos jugadores y el
// render puede reflejarlo para que el jugador local siempre esté a la
// izquierda. Solo enteros y + - * / y Math.round → idéntico en cualquier
// navegador.
// =============================================================

import { WORLD } from './world.js';

const W = WORLD.width;
const GROUND = WORLD.groundY;
const T0 = 400;              // el terreno variable va de T0 a W - T0
const T1 = W - T0;
const STEP = 16;             // separación de los puntos de la polilínea
const MID = W / 2;

/** Refleja una x respecto al centro del campo. */
const mx = (x) => W - x;

/**
 * Expande los puntos clave de la mitad izquierda (x de T0 a MID, múltiplos
 * de STEP desde T0) a una polilínea simétrica completa, suavizada.
 */
function buildTerrain(keys) {
  const pts = [];
  for (let k = 0; k < keys.length - 1; k++) {
    const [xa, ya] = keys[k];
    const [xb, yb] = keys[k + 1];
    for (let x = xa; x < xb; x += STEP) {
      const t = (x - xa) / (xb - xa);
      const s = t * t * (3 - 2 * t);
      pts.push([x, Math.round(ya + (yb - ya) * s)]);
    }
  }
  pts.push([MID, keys[keys.length - 1][1]]);
  // Mitad derecha: reflejo (sin repetir el centro).
  for (let i = pts.length - 2; i >= 0; i--) pts.push([mx(pts[i][0]), pts[i][1]]);
  return pts;
}

/** Octágono de enteros (roca) centrado en (cx, cy) con radio r. */
function rock(cx, cy, r) {
  const k = Math.round(r * 0.4142);
  return [
    [cx - k, cy - r], [cx + k, cy - r], [cx + r, cy - k], [cx + r, cy + k],
    [cx + k, cy + r], [cx - k, cy + r], [cx - r, cy + k], [cx - r, cy - k],
  ];
}

const mirrorPts = (pts) => pts.map(([x, y]) => [mx(x), y]).reverse();
const mirrorSeg = ([x0, y0, x1, y1]) => [mx(x0), y0, mx(x1), y1];

/**
 * Define un mapa a partir de su mitad izquierda.
 *   left:   bloques de la izquierda (se reflejan)
 *   center: bloques en el eje (ya simétricos)
 */
function defineMap({ id, name, terrain, left = [], center = [], pairs, centerGates }) {
  const blocks = [
    ...left.map((b) => ({ kind: b.kind, pts: b.pts })),
    ...left.map((b) => ({ kind: b.kind, pts: mirrorPts(b.pts) })),
    ...center,
  ];
  return deepFreeze({
    id,
    name,
    terrain: buildTerrain(terrain),
    blocks: blocks.map((b) => ({ ...b, bbox: bbox(b.pts) })),
    gates: { pairs: pairs.map((s) => [s, mirrorSeg(s)]), center: centerGates },
  });
}

function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(obj);
}

// ---------- los mapas ----------

export const MAPS = Object.freeze({
  // Dos colinas con un collado en medio y dos rocas flotando sobre ellas.
  hills: defineMap({
    id: 'hills',
    name: 'Dos colinas',
    terrain: [[400, 785], [560, 770], [720, 700], [880, 590], [1008, 520], [1104, 560], [1200, 640]],
    left: [{ kind: 'rock', pts: rock(640, 360, 46) }],
    pairs: [
      [520, 660, 560, 590],
      [800, 560, 830, 485],
      [960, 430, 980, 350],
      [700, 250, 720, 170],
      [430, 480, 470, 410],
    ],
    centerGates: [[1200, 540, 1200, 460], [1200, 320, 1200, 240]],
  }),

  // Una muralla alta en el centro: hay que pasar por encima (o rebotar en ella).
  wall: defineMap({
    id: 'wall',
    name: 'La muralla',
    terrain: [[400, 785], [640, 770], [880, 730], [1056, 690], [1200, 680]],
    left: [{ kind: 'rock', pts: rock(880, 420, 40) }],
    center: [{ kind: 'wall', pts: [[1165, 720], [1165, 380], [1235, 380], [1235, 720]] }],
    pairs: [
      [560, 640, 590, 570],
      [760, 560, 790, 490],
      [1000, 540, 1030, 465],
      [980, 330, 1010, 255],
      [640, 330, 660, 250],
    ],
    centerGates: [[1200, 300, 1200, 220], [1200, 170, 1200, 90]],
  }),

  // Islas de roca flotando: se puede pasar por arriba o por debajo.
  islands: defineMap({
    id: 'islands',
    name: 'Islas flotantes',
    terrain: [[400, 785], [560, 760], [720, 745], [880, 760], [1040, 740], [1200, 750]],
    left: [{
      kind: 'island',
      pts: [[620, 500], [660, 475], [740, 470], [820, 480], [850, 505], [800, 535], [740, 550], [680, 540]],
    }],
    center: [{
      kind: 'island',
      pts: [[1060, 330], [1110, 300], [1200, 290], [1290, 300], [1340, 330], [1300, 370], [1240, 400],
        [1200, 410], [1160, 400], [1100, 370]],
    }],
    pairs: [
      [540, 660, 570, 590],
      [960, 560, 980, 480],
      [740, 400, 760, 320],
      [950, 300, 970, 220],
      [480, 420, 510, 345],
    ],
    centerGates: [[1200, 560, 1200, 480], [1200, 220, 1200, 140]],
  }),

  // Dos mesetas más altas que los cañones y una aguja de roca en el cañón.
  canyon: defineMap({
    id: 'canyon',
    name: 'El cañón',
    terrain: [[400, 785], [560, 780], [608, 560], [640, 545], [896, 545], [944, 560], [992, 770], [1200, 775]],
    center: [{ kind: 'spire', pts: [[1170, 790], [1175, 520], [1190, 470], [1210, 470], [1225, 520], [1230, 790]] }],
    pairs: [
      [420, 560, 450, 490],
      [760, 460, 780, 380],
      [1060, 670, 1090, 600],
      [1000, 400, 1020, 320],
      [700, 260, 720, 180],
    ],
    centerGates: [[1200, 400, 1200, 320], [1200, 230, 1200, 150]],
  }),

  // Un volcán enorme en el centro, con cráter, y rocas flotando a los lados.
  volcano: defineMap({
    id: 'volcano',
    name: 'El volcán',
    terrain: [[400, 785], [640, 770], [864, 700], [992, 560], [1088, 400], [1136, 340], [1168, 345], [1200, 380]],
    left: [{ kind: 'rock', pts: rock(760, 330, 42) }],
    pairs: [
      [520, 650, 550, 580],
      [800, 560, 830, 490],
      [960, 420, 980, 345],
      [1050, 250, 1070, 170],
      [560, 420, 590, 345],
    ],
    centerGates: [[1200, 280, 1200, 200], [1200, 150, 1200, 70]],
  }),
});

export const MAP_IDS = Object.freeze(Object.keys(MAPS));

/** Mapa de un campo (los estados viejos sin mapa usan el primero). */
export const mapOf = (field) => MAPS[field?.map] ?? MAPS.hills;

// ---------- el suelo (destructible) ----------
//
// El suelo de una partida es un array de alturas `ground` (una y por cada
// punto de la polilínea, cada STEP unidades desde GROUND_X0). Empieza igual
// que el terreno del mapa y los cráteres lo van bajando; vive en
// `state.field.ground`, así que viaja con el estado y entra en el hash.

export const GROUND_X0 = T0;
export const GROUND_STEP = STEP;

const baseCache = new Map();
/** Alturas originales del terreno de un mapa (array congelado, solo lectura). */
export function mapGround(map) {
  let g = baseCache.get(map.id);
  if (!g) {
    g = Object.freeze(map.terrain.map(([, y]) => y));
    baseCache.set(map.id, g);
  }
  return g;
}

/** Alturas del suelo de un campo (las del mapa si el campo aún no las trae). */
export const groundOf = (field) => field?.ground ?? mapGround(mapOf(field));

/** Altura del suelo en x (interpolación lineal entre los puntos de `ground`). */
export function terrainY(ground, x) {
  if (x <= T0 || x >= T1) return GROUND;
  const i = Math.floor((x - T0) / STEP); // puntos cada STEP: índice directo
  const x0 = T0 + i * STEP;
  const y0 = ground[i];
  return y0 + ((ground[i + 1] - y0) * (x - x0)) / STEP;
}

/** ¿x cae sobre terreno elevado (no el llano de los castillos)? */
export const onRaisedTerrain = (ground, x) => x > T0 && x < T1 && terrainY(ground, x) < GROUND;

/**
 * Cráter: quita tierra en un cuenco de radio `r` centrado en el impacto
 * (cx, cy). El fondo del cuenco baja ~70 % del radio; nunca se baja del nivel
 * del suelo llano (donde están los castillos). Devuelve un array nuevo.
 * Solo enteros y + - * / → idéntico en cualquier navegador.
 */
export function carve(ground, cx, cy, r) {
  const out = ground.slice();
  const depth = Math.floor((r * 7) / 10);
  const r2 = r * r;
  const i0 = Math.max(0, Math.ceil((cx - r - T0) / STEP));
  const i1 = Math.min(out.length - 1, Math.floor((cx + r - T0) / STEP));
  for (let i = i0; i <= i1; i++) {
    const dx = T0 + i * STEP - cx;
    const bowl = cy + Math.floor((depth * (r2 - dx * dx)) / r2);
    if (bowl > out[i]) out[i] = Math.min(bowl, GROUND);
  }
  return out;
}

/**
 * Primer obstáculo que corta el tramo a→b. Devuelve la fracción del tramo
 * (0..1) o null. Solo + - * / (igual que las compuertas).
 */
export function blockHit(map, ax, ay, bx, by) {
  let best = null;
  const lx = Math.min(ax, bx), hx = Math.max(ax, bx);
  const ly = Math.min(ay, by), hy = Math.max(ay, by);
  for (const b of map.blocks) {
    const [x0, y0, x1, y1] = b.bbox;
    if (hx < x0 || lx > x1 || hy < y0 || ly > y1) continue; // descarte rápido
    const p = b.pts;
    for (let i = 0; i < p.length; i++) {
      const [cx, cy] = p[i];
      const [dx, dy] = p[(i + 1) % p.length];
      const s = crossAt(ax, ay, bx, by, cx, cy, dx, dy);
      if (s !== null && (best === null || s < best)) best = s;
    }
  }
  return best;
}

/** Fracción de a→b donde cruza el segmento c→d, o null. */
export function crossAt(ax, ay, bx, by, cx, cy, dx, dy) {
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
