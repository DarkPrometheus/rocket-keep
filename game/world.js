// =============================================================
// world.js — Geometría fija del campo y matemática determinista.
//
// Lo usan la lógica (para simular) y el render (para dibujar lo mismo).
// Todos los puntos son ENTEROS escritos a mano/generados una vez, así
// no dependen de Math.sin/Math.cos (que pueden variar en el último
// decimal entre navegadores). Las funciones trigonométricas que necesita
// la simulación están implementadas con sumas y multiplicaciones, que en
// JavaScript dan exactamente el mismo resultado en cualquier motor.
//
// Sistema de coordenadas: x hacia la derecha, y hacia ABAJO (como canvas).
// El jugador 0 está a la izquierda y el jugador 1 a la derecha.
// =============================================================

export const WORLD = Object.freeze({
  width: 1600,
  height: 900,
  groundY: 785,
});

/** Boca del lanzador de cada jugador. */
export const LAUNCHERS = Object.freeze([
  Object.freeze({ x: 205, y: 620 }),
  Object.freeze({ x: 1395, y: 620 }),
]);

/** Caja de impacto de cada castillo: [x0, y0, x1, y1]. */
export const CASTLE_BOXES = Object.freeze([
  Object.freeze([45, 560, 255, 785]),
  Object.freeze([1345, 560, 1555, 785]),
]);

/** Silueta de las colinas (polilínea de enteros); fuera de ella el suelo es plano. */
export const TERRAIN = Object.freeze([
  [400, 785], [416, 783], [432, 777], [448, 767], [464, 754], [480, 738], [496, 720], [512, 699],
  [528, 677], [544, 654], [560, 631], [576, 609], [592, 588], [608, 569], [624, 552], [640, 539],
  [656, 529], [672, 523], [688, 520], [704, 522], [720, 531], [736, 545], [752, 564], [768, 587],
  [784, 613], [800, 640], [816, 613], [832, 587], [848, 564], [864, 545], [880, 531], [896, 522],
  [912, 520], [928, 523], [944, 529], [960, 539], [976, 552], [992, 569], [1008, 588], [1024, 609],
  [1040, 631], [1056, 654], [1072, 677], [1088, 699], [1104, 720], [1120, 738], [1136, 754], [1152, 767],
  [1168, 777], [1184, 783], [1200, 785],
]);

/**
 * Ranuras donde puede aparecer una compuerta. Cada compuerta es un
 * segmento [x0, y0, x1, y1] colocado en forma radial alrededor de las
 * colinas (como un arco). Están en pares simétricos para que el campo
 * sea igual de justo para ambos jugadores, más dos ranuras centrales.
 */
export const GATE_SLOTS = Object.freeze({
  pairs: [
    [[575, 570, 506, 530], [1025, 570, 1094, 530]],
    [[670, 475, 630, 406], [930, 475, 970, 406]],
    [[424, 563, 349, 536], [1176, 563, 1251, 536]],
    [[517, 417, 461, 361], [1083, 417, 1139, 361]],
    [[650, 329, 620, 255], [950, 329, 980, 255]],
  ],
  center: [
    [800, 440, 800, 360],
    [800, 300, 800, 220],
  ],
});

/** Altura del terreno en x (interpolación lineal de la polilínea). */
export function terrainY(x) {
  const t = TERRAIN;
  if (x <= t[0][0] || x >= t[t.length - 1][0]) return WORLD.groundY;
  // Los puntos están cada 16 unidades: índice directo.
  const i = Math.floor((x - t[0][0]) / 16);
  const [x0, y0] = t[i];
  const [x1, y1] = t[i + 1];
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

// ---------- trigonometría determinista ----------

const PI = 3.141592653589793;
const TWO_PI = 6.283185307179586;
const HALF_PI = 1.5707963267948966;

/** Seno con serie de Taylor (solo + - * /): idéntico en todos los motores. */
export function dsin(x) {
  x -= TWO_PI * Math.round(x / TWO_PI); // ahora en [-π, π]
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x; // ahora en [-π/2, π/2]
  const x2 = x * x;
  return x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - (x2 / 110) * (1 - x2 / 156))))));
}

export function dcos(x) {
  return dsin(x + HALF_PI);
}

export const degToRad = (deg) => (deg * PI) / 180;
