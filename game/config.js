// =============================================================
// config.js — Todos los números de balance en un solo lugar.
//
// Valores ajustados en la subfase 1f con simulaciones bot contra bot
// (partida típica normal vs normal: ~9 rondas, ~55 % termina por
// derribo, ganadores 50/50; difícil > normal > fácil con claridad).
//
// La configuración viaja dentro del estado, así host e invitado
// juegan con las mismas reglas. Unidades de la física: unidades del
// mundo (ver world.js) y "ticks" de simulación (el render reproduce
// 60 ticks por segundo).
// =============================================================

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
}

export const DEFAULT_CONFIG = deepFreeze({
  // --- Apuntado (lo que el jugador elige) ---
  aim: {
    angleMin: 5,     // grados sobre la horizontal
    angleMax: 85,
    powerMin: 10,    // porcentaje
    powerMax: 100,
  },

  // --- Física ---
  physics: {
    gravity: 0.15,     // unidades / tick²
    // El campo mide 2400 (antes 1600): la velocidad crece ×1,29 para que el
    // alcance (∝ v²) crezca en la misma proporción que la distancia.
    speedMin: 9,       // velocidad con potencia 0 %
    speedMax: 22.5,    // velocidad con potencia 100 %
    maxTicks: 900,     // límite de seguridad de la simulación
  },

  // --- Ráfaga base ---
  burst: {
    delayTicks: 6,     // separación entre cohetes de la ráfaga inicial
    spreadDeg: 0.6,    // pequeña apertura entre ellos
    maxParticles: 8,   // cohetes base simulados por separado (el resto se agrupa)
  },

  // --- Multiplicación al cruzar una compuerta ---
  split: {
    maxChildren: 6,    // cohetes simulados que salen de cada cruce
    delayTicks: 2,     // desfase entre ellos (efecto de cadena)
    spreadDeg: 2.2,    // apertura en abanico entre hijos
  },
  maxParticles: 220,       // cohetes simulados como máximo (cada uno puede representar varios)
  maxRocketsPerShot: 180,  // tope de cohetes "reales" por disparo

  // --- Mapas (ver maps.js): la semilla elige uno al azar y vale para TODA la partida ---
  maps: ['hills', 'wall', 'islands', 'canyon', 'volcano'],

  // --- Compuertas ---
  gates: {
    pairChancePct: 60,   // probabilidad de que un par simétrico de ranuras tenga compuertas
    centerChancePct: 50, // probabilidad de cada ranura central
    minGates: 3,
    table: [             // multiplicadores y su peso relativo
      { mult: 2, weight: 40 },
      { mult: 4, weight: 28 },
      { mult: 8, weight: 18 },
      { mult: 20, weight: 9 },
      { mult: 30, weight: 5 },
    ],
  },

  // --- Armas (cada jugador elige una al inicio de la partida) ---
  // rocketsPct:  % de los cohetes base que dispara (mínimo 1)
  // damagePct:   % del daño por cohete
  // gateMultPct: qué tanto aprovecha las compuertas (xM efectivo = 1 + (M-1)·pct/100)
  // clusterSplit: si > 0, cada cohete base se divide solo en N al llegar a lo más alto
  // hitboxPad:   margen extra alrededor del castillo rival (daño de área)
  // craterR:     radio (unidades) del cráter que deja al caer en terreno elevado
  // Balanceadas con bot normal vs normal (100 partidas por pareja, con curación):
  // todas las parejas entre 46 % y 57 %.
  weapons: {
    burst: {
      label: 'Ráfaga', icon: '🚀',
      desc: 'Equilibrada: varios cohetes que aprovechan al máximo las compuertas.',
      rocketsPct: 100, damagePct: 100, gateMultPct: 100, clusterSplit: 0, clusterSpreadDeg: 0, hitboxPad: 0, craterR: 22,
    },
    mortar: {
      label: 'Mortero', icon: '💣',
      desc: 'Un proyectil pesado con mucho daño y área amplia, pero las compuertas rinden menos.',
      rocketsPct: 34, damagePct: 650, gateMultPct: 60, clusterSplit: 0, clusterSpreadDeg: 0, hitboxPad: 80, craterR: 95,
    },
    cluster: {
      label: 'Racimo', icon: '🎆',
      desc: 'Se divide solo en lo más alto: cohetes más débiles pero muy repartidos.',
      rocketsPct: 100, damagePct: 92, gateMultPct: 100, clusterSplit: 4, clusterSpreadDeg: 5, hitboxPad: 0, craterR: 16,
    },
  },

  // --- Minijuego de inicio de ronda ---
  // Cada ronda la semilla elige uno del `pool` (nunca el mismo dos veces
  // seguidas); quien gana abre la ronda. Reglas y textos en game/minigames.js.
  minigames: {
    pool: ['needle', 'count', 'simon', 'mash', 'rps', 'maze'],
    needle: { periodMinMs: 900, periodMaxMs: 1400, maxMs: 8000 },   // una ida = medio periodo
    count: { min: 18, max: 40, showMs: 1600, timeMs: 12000 },       // puntos, tiempo a la vista, tiempo para responder
    simon: { length: 10, colors: 4 },
    mash: { durationMs: 3000, maxTaps: 80 },
    rps: { picks: 3 },
    maze: { size: 9, extra: 6, timeMs: 45000 },                     // lado del cuadrado, paredes que se tiran, tiempo máximo
  },

  // --- Partida ---
  maxRounds: 0,             // 0 = sin límite: solo se gana derribando el castillo rival
  suddenDeath: true,        // (con límite) si hay empate de vida tras maxRounds, muerte súbita
  maxSuddenDeathRounds: 5,  // si aun así sigue el empate, se declara empate

  // --- Jugador inicial ---
  player: {
    hp: 2000,
    baseRockets: 3,
    damagePerRocket: 2,
  },

  // Ningún disparo quita más de este % de la vida máxima del rival.
  maxShotDamagePct: 25,

  // Al empezar cada ronda (desde la 2.ª) todos los castillos se reparan esta
  // cantidad, sin pasar de su vida máxima. Se mejora con "Reparación".
  // (Con más curación casi ninguna partida termina por derribo y se pierde tensión.)
  healPerRound: 30,

  // --- Economía ---
  roundIncome: 10,          // monedas fijas por ronda (también para quien va perdiendo)
  coinDivisor: 20,          // + daño causado en la ronda / coinDivisor
  upgrades: {
    rockets: { label: 'Más cohetes', baseCost: 30, costGrowthPct: 160, amount: 1, maxLevel: 5 },
    hp: { label: 'Más vida', baseCost: 25, costGrowthPct: 150, amount: 300, maxLevel: 5 },
    damage: { label: 'Más daño', baseCost: 30, costGrowthPct: 160, amount: 1, maxLevel: 5 },
    repair: { label: 'Reparación', baseCost: 30, costGrowthPct: 170, amount: 20, maxLevel: 3 },
  },

  // --- Perks: pasivos que se compran UNA vez en la tienda ---
  // (Los ids no deben coincidir con los de `upgrades`: comparten el mensaje `buy`.)
  // Balance (bot normal con perk vs sin perk, 100 partidas): ~55 % para quien lo compra.
  perks: {
    armor: { label: 'Blindaje', icon: '🛡️', cost: 45, value: 20, desc: 'Recibes un 20 % menos de daño.' },
    savings: { label: 'Ahorro', icon: '💰', cost: 25, value: 10, desc: '+10 monedas al terminar cada ronda.' },
    hawkeye: { label: 'Ojo de halcón', icon: '🦅', cost: 25, value: 90, desc: 'La mira muestra el doble de trayectoria.' },
  },
});
