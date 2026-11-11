// =============================================================
// world.js — Geometría fija del campo y matemática determinista.
//
// Lo usan la lógica (para simular) y el render (para dibujar lo mismo).
// El campo es más ancho que la pantalla: el render lo recorre con una cámara.
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
  width: 2400,
  height: 900,
  groundY: 785,
});

/** Boca del lanzador de cada jugador. */
export const LAUNCHERS = Object.freeze([
  Object.freeze({ x: 205, y: 620 }),
  Object.freeze({ x: 2195, y: 620 }),
]);

/** Caja de impacto de cada castillo: [x0, y0, x1, y1]. */
export const CASTLE_BOXES = Object.freeze([
  Object.freeze([45, 560, 255, 785]),
  Object.freeze([2145, 560, 2355, 785]),
]);

// El terreno, los obstáculos y las ranuras de compuertas dependen del mapa
// de cada ronda: ver maps.js.

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
