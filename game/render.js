// =============================================================
// render.js — Render en canvas, vista lateral (intercambiable).
//
// El render NO decide nada: dibuja el estado que le pasan y reproduce
// los ShotResult que ya resolvió la lógica (cada cohete trae su
// parábola exacta: origen, velocidad, cuándo y cómo termina). Para
// probar otros gráficos, crea otro archivo con una clase que cumpla
// esta misma interfaz y pásala al controller desde main.js:
//
//   constructor(canvas, { onSound } = {})  callback opcional de efectos visuales/sonoros
//   setState(state, me)          estado a mostrar y qué jugador es el local
//   setAim(aim | null)           mira del jugador local: { angle, power }
//   playShot(result) → Promise   anima una ráfaga; resuelve al terminar
//   pointerToAim(clientX, clientY) → { angle, power } | null
//                                convierte la posición del puntero en mira
//   destroy()                    detiene el bucle y suelta el canvas
//
// Esta implementación: el mundo de world.js tal cual, reflejado en X
// si el jugador local es el 1 (el local siempre se ve a la izquierda).
// Capas con parallax (montañas lejanas, nubes, colinas medias) que se
// desplazan menos que el campo cuando la cámara se mueve o tiembla.
// Los efectos (humo, explosiones, sacudida) viven en effects.js.
// =============================================================

import { WORLD, LAUNCHERS, CASTLE_BOXES } from './world.js';
import { mapOf, mapGround, groundOf, terrainY, carve, GROUND_X0, GROUND_STEP } from './maps.js';
import { aimPreview, particlePos } from './logic.js';
import { Effects, Shake } from './effects.js';

const W = WORLD.width;
const H = WORLD.height;
const GROUND_Y = WORLD.groundY;
const TICKS_PER_SEC = 60;      // velocidad de reproducción de la simulación
const AIM_MIN_DIST = 40;       // distancia del puntero al cañón = potencia mínima
const AIM_MAX_DIST = 380;      // … y potencia máxima
const BARREL_LEN = 64;

// Colores del terreno y de los obstáculos por mapa.
const PALETTES = {
  hills:   { hill: '#4f3a26', edge: '#5c9e3f', rock: '#8a8f99', rockEdge: '#b8bcc4', trees: true },
  wall:    { hill: '#5a4632', edge: '#6aa84a', rock: '#8c8f96', rockEdge: '#c3c7cf', trees: true },
  islands: { hill: '#4b4a3a', edge: '#6fb04f', rock: '#6b4a2e', rockEdge: '#5c9e3f', trees: true },
  canyon:  { hill: '#9a6038', edge: '#d49a5a', rock: '#8a5a3a', rockEdge: '#d49a5a', trees: false },
  volcano: { hill: '#3b2a27', edge: '#d9542b', rock: '#4a3a38', rockEdge: '#d9542b', trees: false },
};

const COLORS = {
  skyTop: '#5fbbe8',
  skyBottom: '#d4f1fd',
  mountainFar: '#a9cad8',
  mountainMid: '#86b0a0',
  grass: '#5c9e3f',
  dirt: '#6b4a2e',
  dirtDark: '#5a3e26',
  hill: '#4f3a26',
  hillEdge: '#5c9e3f',
  tree: '#2f6b3a',
  treeDark: '#265a31',
  stone: '#b8bcc4',
  stoneDark: '#8a8f99',
  crack: '#3b3f46',
  tread: '#2b2e33',
  me: '#2f80ed',
  rival: '#e5484d',
  gate: { 2: '#3fc1c9', 4: '#2fb36b', 8: '#f2b51d', 20: '#f0742b', 30: '#c04de8' },
  gateRgb: { 2: '63,193,201', 4: '47,179,107', 8: '242,181,29', 20: '240,116,43', 30: '192,77,232' },
  text: '#ffffff',
};

// Grietas del castillo (coordenadas relativas al centro, mirando a la derecha).
const CRACKS = [
  [[-60, -140], [-48, -118], [-56, -100], [-44, -80]],                 // vida < 75 %
  [[30, -143], [18, -120], [28, -104], [14, -78], [22, -60]],          // vida < 50 %
  [[-90, -200], [-78, -176], [-88, -150], [-74, -120]],
  [[70, -140], [56, -124], [64, -98], [48, -70]],                      // vida < 25 %
  [[-20, -143], [-8, -126], [-18, -108], [-4, -92]],
];
const CRACK_LEVELS = [0.75, 0.5, 0.5, 0.25, 0.25];

const rand = (a, b) => a + Math.random() * (b - a);

export class CanvasRenderer {
  #canvas;
  #ctx;
  #raf = 0;
  #view = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  #state = null;
  #me = 0;
  #aim = null;
  #barrel = [45, 45];   // ángulo visual del cañón de cada jugador (grados)
  #recoil = [0, 0];     // retroceso del cañón (0..1)
  #hitFlash = [-1, -1]; // último impacto en cada castillo
  #hpShown = [0, 0];
  #anim = null;
  #texts = [];
  #gateFlash = new Map(); // id de compuerta → instante del último cruce
  #effects = new Effects();
  #shake = new Shake();
  #ground = null;       // alturas del suelo que se ven ahora (cambian al caer los cohetes)
  #cam = { x: 0 };      // posición horizontal de la cámara (mundo)
  #camReady = false;
  #visW = 1600;         // ancho de mundo que se ve ahora mismo
  #focus = 0;           // hacia dónde mira la cámara (x de pantalla del mundo)
  #manualX = null;      // el jugador movió la vista con el minimapa
  #mmDrag = false;
  #emit = [0, 0];       // acumuladores de humo de cada castillo
  #last = 0;
  #trees = new Map(); // árboles por mapa
  #unbindMinimap = null;
  #onResize;
  #sound;
  #timers = new Set();

  constructor(canvas, { onSound = () => {} } = {}) {
    this.#sound = onSound;
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d');
    this.#onResize = () => this.#resize();
    window.addEventListener('resize', this.#onResize);
    this.#resize();
    this.#bindMinimap();
    // Un solo reloj (performance.now) para el bucle y para las animaciones.
    const loop = () => {
      this.#frame(performance.now() / 1000);
      this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
  }

  destroy() {
    this.#timers.forEach(clearTimeout);
    this.#timers.clear();
    const anim = this.#anim;
    this.#anim = null;
    anim?.onDone();
    cancelAnimationFrame(this.#raf);
    window.removeEventListener('resize', this.#onResize);
    this.#unbindMinimap?.();
  }

  // ---------- interfaz pública ----------

  setState(state, me) {
    const prevRound = this.#state?.round ?? 0;
    this.#state = state;
    this.#me = me;
    if (!this.#anim && state) this.#hpShown = state.players.map((p) => p.hp);
    if (!this.#anim) this.#ground = state?.field ? [...groundOf(state.field)] : null;
    // Ronda nueva: muestra la reparación de cada castillo ("+60" en verde).
    if (state && state.field && state.round !== prevRound) {
      const now = performance.now() / 1000;
      state.players.forEach((pl, p) => {
        if (!pl.healedThisRound) return;
        const box = CASTLE_BOXES[p];
        const x = this.#sx((box[0] + box[2]) / 2);
        this.#texts.push({ x, y: box[1] - 30, text: `+${pl.healedThisRound}`, t0: now + 0.3, pop: now + 0.3, color: '#6cf28a' });
        this.#effects.ring(x, box[1] + 60, '108,242,138');
      });
    }
  }

  setAim(aim) {
    this.#aim = aim;
    if (aim) this.#barrel[this.#me] = aim.angle;
  }

  /** Dirección del cañón al puntero = ángulo; distancia = potencia. */
  pointerToAim(clientX, clientY) {
    if (!this.#state) return null;
    const r = this.#canvas.getBoundingClientRect();
    const wx = (clientX - r.left) / this.#view.scale + this.#cam.x;
    const wy = (clientY - r.top - this.#view.oy) / this.#view.scale;
    const L = this.#localLauncher();
    const dx = Math.max(1, wx - L.x);
    const dy = L.y - wy;
    const a = this.#state.config.aim;
    const angle = Math.max(a.angleMin, Math.min(a.angleMax, (Math.atan2(dy, dx) * 180) / Math.PI));
    const t = (Math.hypot(dx, dy) - AIM_MIN_DIST) / (AIM_MAX_DIST - AIM_MIN_DIST);
    const power = a.powerMin + Math.max(0, Math.min(1, t)) * (a.powerMax - a.powerMin);
    return { angle: Math.round(angle * 10) / 10, power: Math.round(power) };
  }

  playShot(result) {
    return new Promise((resolve) => {
      this.#manualX = null; // la cámara vuelve a seguir la acción
      this.#barrel[result.shooter] = result.angle;
      const last = Math.max(...result.particles.map((p) => p.t1));
      this.#hpShown[1 - result.shooter] = result.hpBefore;
      this.#anim = {
        result,
        start: performance.now() / 1000,
        endTick: last + (result.hpAfter === 0 ? 110 : 45), // más pausa si hay derribo
        done: new Set(),     // ids de cohetes ya terminados
        launched: new Set(), // ids de cohetes base que ya salieron
        dealt: 0,            // daño mostrado hasta ahora
        // Proporción daño real / daño bruto (blindaje y topes): el contador crece
        // suave hasta el daño real en vez de llegar antes y quedarse parado.
        scale: result.rawDamage > 0 ? (result.hpBefore - result.hpAfter) / result.rawDamage : 0,
        counter: null,       // número de daño acumulado
        ko: false,
        onDone: resolve,
      };
    });
  }

  // ---------- geometría ----------

  #resize() {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.#canvas.clientWidth;
    const ch = this.#canvas.clientHeight;
    this.#canvas.width = Math.round(cw * dpr);
    this.#canvas.height = Math.round(ch * dpr);
    // Se ve TODO el campo (sin zoom): la escala es la que hace caber el ancho y el
    // alto. Si sobra altura, el suelo queda abajo y el cielo se estira hacia arriba.
    const scale = Math.min(ch / H, cw / W);
    this.#view = { scale, ox: 0, oy: Math.max(0, ch - H * scale), dpr };
  }

  /** X de pantalla para una X del mundo (se refleja si el local es el jugador 1). */
  #sx(x) {
    return this.#me === 1 ? W - x : x;
  }

  /** El lanzador local en coordenadas de pantalla (siempre a la izquierda). */
  #localLauncher() {
    const L = LAUNCHERS[this.#me];
    return { x: this.#sx(L.x), y: L.y };
  }

  /** ¿El castillo del jugador p se ve a la izquierda? */
  #onLeft(p) {
    return this.#sx(LAUNCHERS[p].x) < W / 2;
  }

  /** Punta del cañón del jugador p y su dirección (pantalla). */
  #muzzle(p) {
    const L = LAUNCHERS[p];
    const facing = this.#onLeft(p) ? 1 : -1;
    const a = (this.#barrel[p] * Math.PI) / 180;
    const dx = Math.cos(a) * facing;
    const dy = -Math.sin(a);
    return { x: this.#sx(L.x) + dx * BARREL_LEN, y: L.y + dy * BARREL_LEN, dx, dy };
  }

  // ---------- animación de una ráfaga ----------

  #updateShot(now) {
    const a = this.#anim;
    if (!a) return;
    const tick = (now - a.start) * TICKS_PER_SEC;
    const r = a.result;
    const target = 1 - r.shooter;
    const fx = this.#effects;
    for (const p of r.particles) {
      // Salida de cada cohete de la ráfaga base: fogonazo y retroceso.
      if (p.parent === -1 && !a.launched.has(p.id) && tick >= p.t0) {
        a.launched.add(p.id);
        const m = this.#muzzle(r.shooter);
        fx.muzzle(m.x, m.y, m.dx, m.dy);
        this.#sound('launch', { weapon: this.#state.players[r.shooter].weapon, pan: this.#onLeft(r.shooter) ? -0.6 : 0.6 });
        this.#recoil[r.shooter] = 1;
        this.#shake.add(1.5);
      }
      if (a.done.has(p.id) || tick < p.t1) continue;
      a.done.add(p.id);
      const x = this.#sx(p.ex);
      const y = p.ey;
      const pan = (x / W) * 1.4 - 0.7;
      if (p.end === 'split') {
        const s = r.splits.find((sp) => Math.abs(sp.t - p.t1) < 1e-9 && sp.x === p.ex);
        if (s && s.gate !== null) {
          this.#sound('gate', { pan, mult: s.mult });
          this.#gateFlash.set(s.gate, now);
          fx.ring(x, y, COLORS.gateRgb[s.mult] ?? '255,255,255');
        } else if (s) {
          this.#sound('split', { pan });
          // Racimo: se abre solo en lo más alto.
          fx.ring(x, y, '255,200,90');
          fx.explosion(x, y, 0.6, { debris: false });
        }
      } else if (p.end === 'castle') {
        this.#sound('impact', { pan });
        const hitDamage = p.weight * r.rocketDamage;
        const power = 1 + Math.min(2.5, Math.log10(hitDamage + 1) * 1.1);
        fx.explosion(x, y, power);
        this.#shake.add(1.2 + power * 1.3);
        this.#hitFlash[target] = now;
        // Daño acumulado: la barra baja con cada impacto, sin pasar de hpAfter.
        a.dealt += hitDamage * a.scale;
        this.#hpShown[target] = Math.max(r.hpAfter, r.hpBefore - a.dealt);
        const shown = Math.min(a.dealt, r.hpBefore - r.hpAfter);
        if (!a.counter) {
          const box = CASTLE_BOXES[target];
          a.counter = { x: this.#sx((box[0] + box[2]) / 2), y: box[1] - 30, text: '', t0: now, sticky: true, pop: now };
          this.#texts.push(a.counter);
        }
        a.counter.text = `-${Math.round(shown)}`;
        a.counter.t0 = now;
        a.counter.pop = now;
      } else if (p.end === 'hill' || p.end === 'ground' || p.end === 'rock') {
        this.#sound('ground', { pan });
        fx.dust(x, y);
        if (p.end === 'rock') fx.explosion(x, y, 0.5, { debris: true });
        // Cráter: el suelo se hunde justo cuando cae el cohete.
        const crater = p.end === 'hill' ? r.craters?.find((c) => c.id === p.id) : null;
        if (crater && this.#ground) {
          this.#ground = carve(this.#ground, crater.x, crater.y, crater.r);
          if (crater.r >= 50) {
            fx.explosion(x, y, 1.4 + crater.r / 70, { debris: true });
            this.#shake.add(3);
          }
        }
        this.#shake.add(0.6);
      }
    }
    // Derribo: el castillo estalla en cadena cuando llega el último impacto.
    if (r.hpAfter === 0 && !a.ko && a.done.size === r.particles.length) {
      a.ko = true;
      this.#sound('ko', { pan: this.#onLeft(target) ? -0.6 : 0.6 });
      const box = CASTLE_BOXES[target];
      for (let i = 0; i < 6; i++) {
        const timer = setTimeout(() => {
          this.#timers.delete(timer);
          fx.explosion(this.#sx(rand(box[0] + 20, box[2] - 20)), rand(box[1] + 40, box[3] - 40), 3);
          this.#shake.add(8);
        }, i * 140);
        this.#timers.add(timer);
      }
    }
    if (tick >= a.endTick) {
      this.#hpShown[target] = r.hpAfter;
      if (a.counter) a.counter.sticky = false;
      this.#anim = null;
      a.onDone();
    }
  }

  /** Humo (y fuego) que sale de los castillos dañados. */
  #emitCastleSmoke(dt) {
    for (const p of [0, 1]) {
      const pl = this.#state.players[p];
      const ratio = this.#hpShown[p] / pl.maxHp;
      const rate = ratio <= 0 ? 14 : ratio < 0.25 ? 9 : ratio < 0.5 ? 4 : ratio < 0.75 ? 1.2 : 0;
      this.#emit[p] += rate * dt;
      const box = CASTLE_BOXES[p];
      const cx = this.#sx((box[0] + box[2]) / 2);
      while (this.#emit[p] >= 1) {
        this.#emit[p] -= 1;
        const x = cx + rand(-70, 70);
        const y = GROUND_Y - rand(150, 175);
        this.#effects.smoke(x, y, { size: 10, grow: 40, life: rand(1.4, 2.2), vy: rand(-55, -30), vx: rand(5, 20), color: ratio < 0.25 ? '45,45,45' : '90,90,90', alpha: 0.45 });
        if (ratio < 0.25) this.#effects.fire(x + rand(-10, 10), y + 8);
      }
    }
  }

  // ---------- dibujo ----------

  #frame(now) {
    const dt = Math.min(0.05, this.#last ? now - this.#last : 0);
    this.#last = now;
    const ctx = this.#ctx;
    const { scale, ox, oy, dpr } = this.#view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1b2a33';
    ctx.fillRect(0, 0, this.#canvas.clientWidth, this.#canvas.clientHeight);
    if (!this.#state || !this.#state.field) return;

    this.#updateShot(now);
    this.#emitCastleSmoke(dt);
    this.#effects.update(dt);
    this.#shake.update(dt);
    this.#recoil = this.#recoil.map((r) => Math.max(0, r - dt * 5));
    this.#updateCamera(dt, now);

    const shake = this.#shake.offset();
    const base = () => ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    /** Aplica la cámara con un factor de profundidad (0 = fondo fijo, 1 = campo). */
    const layer = (depth) => {
      base();
      ctx.translate((-this.#cam.x + shake.x) * depth, shake.y * depth);
    };

    base();
    ctx.save();
    const top = -this.#view.oy / scale; // y del mundo en el borde de arriba de la pantalla
    ctx.beginPath();
    ctx.rect(0, top, this.#visW, H - top);
    ctx.clip();

    const map = mapOf(this.#state.field);
    this.#drawSky(ctx, top);
    layer(0.15);
    this.#drawClouds(ctx, now);
    layer(0.3);
    this.#drawMountains(ctx, COLORS.mountainFar, 540, 60, 0.009);
    layer(0.55);
    this.#drawMountains(ctx, COLORS.mountainMid, 640, 40, 0.017);
    layer(1);
    this.#drawHills(ctx, map);
    this.#drawGround(ctx);
    this.#drawGates(ctx, now);
    for (const p of [0, 1]) this.#drawCastle(ctx, p, now);
    this.#drawAim(ctx);
    this.#drawRockets(ctx, now, dt);
    this.#effects.draw(ctx);
    this.#drawTexts(ctx, now);
    ctx.restore();
    this.#drawMinimap(ctx, map);
  }

  /**
   * Cámara: en reposo muestra el lado del jugador local (su castillo a la
   * izquierda); durante una ráfaga sigue a los cohetes; con el minimapa el
   * jugador puede mirar otra parte del campo.
   */
  #updateCamera(dt, now) {
    const visW = this.#canvas.clientWidth / this.#view.scale;
    this.#visW = visW;
    const a = this.#anim;
    if (a) {
      const tick = (now - a.start) * TICKS_PER_SEC;
      const g = this.#state.config.physics.gravity;
      let sum = 0, n = 0;
      for (const p of a.result.particles) {
        if (tick < p.t0 || tick >= p.t1) continue;
        sum += this.#sx(particlePos(p, tick, g).x);
        n++;
      }
      if (n) this.#focus = sum / n + visW * 0.08; // un poco por delante de la ráfaga
    } else {
      this.#focus = this.#manualX ?? visW / 2;
    }
    const target = visW >= W ? (W - visW) / 2 : Math.max(0, Math.min(W - visW, this.#focus - visW / 2));
    if (!this.#camReady) {
      this.#camReady = true;
      this.#cam.x = target;
    }
    this.#cam.x += (target - this.#cam.x) * Math.min(1, dt * 3);
  }

  // ---------- minimapa ----------

  /** El minimapa solo hace falta si el campo no cabe entero en pantalla. */
  #hasMinimap() {
    return this.#visW < W - 1;
  }

  /** Factor para agrandar textos, barras y cohetes cuando todo el campo se ve pequeño. */
  #k() {
    return Math.max(1, Math.min(2.2, 0.55 / this.#view.scale));
  }

  #mmRect() {
    const cw = this.#canvas.clientWidth;
    const w = Math.max(120, Math.min(240, cw * 0.24));
    const compact = window.matchMedia?.('(orientation: landscape) and (max-height: 520px)').matches;
    return { x: cw - w - 8, y: compact ? 38 : 8, w, h: w * 0.3 };
  }

  #bindMinimap() {
    const cv = this.#canvas;
    const inside = (e) => {
      const r = cv.getBoundingClientRect();
      const m = this.#mmRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      return { ok: x >= m.x && x <= m.x + m.w && y >= m.y - 4 && y <= m.y + m.h + 4, x, m };
    };
    const look = (e) => {
      const { x, m } = inside(e);
      this.#manualX = Math.max(0, Math.min(W, ((x - m.x) / m.w) * W));
    };
    const down = (e) => {
      if (!this.#state?.field || !this.#hasMinimap() || !inside(e).ok) return;
      this.#mmDrag = true;
      cv.setPointerCapture?.(e.pointerId);
      look(e);
      e.stopImmediatePropagation(); // que no cuente como apuntar
      e.preventDefault();
    };
    const move = (e) => {
      if (!this.#mmDrag) return;
      look(e);
      e.stopImmediatePropagation();
    };
    const up = (e) => {
      if (!this.#mmDrag) return;
      this.#mmDrag = false;
      e.stopImmediatePropagation();
    };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    this.#unbindMinimap = () => {
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
    };
  }

  /** Vista en miniatura de todo el campo con la zona visible marcada. */
  #drawMinimap(ctx, map) {
    if (!this.#hasMinimap()) return;
    const { dpr } = this.#view;
    const m = this.#mmRect();
    const kx = m.w / W, ky = m.h / H;
    const X = (wx) => m.x + this.#sx(wx) * kx;
    const Y = (wy) => m.y + wy * ky;
    const pal = PALETTES[map.id] ?? PALETTES.hills;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.fillStyle = 'rgba(8, 18, 26, 0.6)';
    this.#roundRect(ctx, m.x - 3, m.y - 3, m.w + 6, m.h + 6, 8);
    ctx.beginPath();
    ctx.rect(m.x, m.y, m.w, m.h);
    ctx.clip();
    ctx.fillStyle = 'rgba(111, 190, 230, 0.35)';
    ctx.fillRect(m.x, m.y, m.w, m.h);
    // Suelo y colinas (el terreno es simétrico: da igual el orden).
    ctx.fillStyle = pal.hill;
    ctx.beginPath();
    ctx.moveTo(m.x, Y(GROUND_Y));
    for (const [sxp, y] of this.#terrainPoints(map)) ctx.lineTo(m.x + sxp * kx, Y(y));
    ctx.lineTo(m.x + m.w, Y(GROUND_Y));
    ctx.fill();
    ctx.fillRect(m.x, Y(GROUND_Y), m.w, m.h);
    // Obstáculos.
    ctx.fillStyle = pal.rock;
    for (const b of map.blocks) {
      ctx.beginPath();
      b.pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.fill();
    }
    // Compuertas.
    ctx.lineWidth = 2;
    for (const g of this.#state.field.gates) {
      ctx.strokeStyle = COLORS.gate[g.mult] ?? '#888';
      ctx.beginPath();
      ctx.moveTo(X(g.seg[0]), Y(g.seg[1]));
      ctx.lineTo(X(g.seg[2]), Y(g.seg[3]));
      ctx.stroke();
    }
    // Castillos.
    for (const p of [0, 1]) {
      const b = CASTLE_BOXES[p];
      ctx.fillStyle = p === this.#me ? COLORS.me : COLORS.rival;
      const x = X((b[0] + b[2]) / 2);
      ctx.fillRect(x - 4, Y(b[1]), 8, Math.max(4, (b[3] - b[1]) * ky));
    }
    // Zona visible.
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    const vx = Math.max(m.x, m.x + this.#cam.x * kx);
    const vw = Math.min(m.w, this.#visW * kx);
    ctx.strokeRect(vx + 0.75, m.y + 0.75, Math.min(vw, m.x + m.w - vx) - 1.5, m.h - 1.5);
    ctx.restore();
  }

  #drawSky(ctx, top = 0) {
    const g = ctx.createLinearGradient(0, top, 0, GROUND_Y);
    g.addColorStop(0, COLORS.skyTop);
    g.addColorStop(1, COLORS.skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, top, this.#visW, H - top);
    // Sol
    ctx.fillStyle = 'rgba(255,248,214,0.9)';
    ctx.beginPath();
    ctx.arc(this.#visW * 0.78, 150, 46, 0, Math.PI * 2);
    ctx.fill();
  }

  #drawClouds(ctx, now) {
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    const span = W + 600;
    for (const [x0, y, s, speed] of [[260, 140, 1, 8], [1180, 100, 1.3, 5], [700, 200, 0.8, 11], [1450, 300, 0.9, 7], [-100, 250, 0.7, 9], [1900, 160, 1.1, 6], [2250, 260, 0.8, 10], [1600, 60, 0.9, 7]]) {
      const x = ((x0 + now * speed) % span + span) % span - 300; // deriva lenta y continua
      for (const [dx, dy, rx, ry] of [[0, 0, 60, 22], [40, -14, 40, 22], [-40, -6, 34, 18]]) {
        ctx.beginPath();
        ctx.ellipse(x + dx * s, y + dy * s, rx * s, ry * s, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Cordillera decorativa (más ancha que el mundo para que el paneo no deje huecos). */
  #drawMountains(ctx, color, baseY, amp, freq) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-100, GROUND_Y);
    for (let x = -100; x <= W + 100; x += 40) {
      ctx.lineTo(x, baseY + Math.sin(x * freq) * amp + Math.sin(x * freq * 2.7 + 1) * amp * 0.45);
    }
    ctx.lineTo(W + 100, GROUND_Y);
    ctx.fill();
  }

  /** Árboles del mapa (posiciones fijas; solo donde el mapa los admite, y simétricos). */
  #treesFor(map) {
    let trees = this.#trees.get(map.id);
    if (trees) return trees;
    trees = [];
    if (PALETTES[map.id]?.trees) {
      for (let i = 0; i < 34; i++) {
        const x = 420 + ((i * 137) % 760);
        const y = terrainY(mapGround(map), x);
        if (y > GROUND_Y - 25) continue;
        const sc = 0.7 + ((i * 31) % 50) / 100;
        trees.push({ x, y, s: sc }, { x: W - x, y, s: sc });
      }
    }
    this.#trees.set(map.id, trees);
    return trees;
  }

  /** Puntos del suelo en coordenadas de pantalla, de izquierda a derecha. */
  #terrainPoints(map) {
    const g = this.#ground ?? mapGround(map);
    const pts = g.map((y, i) => [this.#sx(GROUND_X0 + i * GROUND_STEP), y]);
    return this.#me === 1 ? pts.reverse() : pts;
  }

  #drawHills(ctx, map) {
    // El suelo ya no es simétrico (los cráteres): se dibuja reflejado si el local
    // es el jugador 1. Los obstáculos sí: su conjunto es simétrico.
    const pal = PALETTES[map.id] ?? PALETTES.hills;
    const T = this.#terrainPoints(map);
    ctx.fillStyle = pal.hill;
    ctx.beginPath();
    ctx.moveTo(T[0][0], GROUND_Y);
    for (const [x, y] of T) ctx.lineTo(x, y);
    ctx.lineTo(T[T.length - 1][0], GROUND_Y);
    ctx.fill();
    ctx.strokeStyle = pal.edge;
    ctx.lineWidth = 10;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    T.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    const ground = this.#ground ?? mapGround(map);
    for (const base of this.#treesFor(map)) {
      const y = terrainY(ground, base.x);
      if (y > base.y + 6) continue; // el suelo se hundió: el árbol cayó con él
      const t = { x: this.#sx(base.x), y, s: base.s };
      ctx.fillStyle = COLORS.treeDark;
      ctx.fillRect(t.x - 3 * t.s, t.y - 8 * t.s, 6 * t.s, 12 * t.s);
      ctx.fillStyle = COLORS.tree;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y - 50 * t.s);
      ctx.lineTo(t.x - 17 * t.s, t.y - 4 * t.s);
      ctx.lineTo(t.x + 17 * t.s, t.y - 4 * t.s);
      ctx.fill();
    }
    // Obstáculos: rocas, muralla, islas, agujas…
    for (const b of map.blocks) {
      const path = () => {
        ctx.beginPath();
        b.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
      };
      ctx.save();
      path();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = pal.rock;
      ctx.fill();
      ctx.restore();
      // Luz arriba y sombra abajo, y el borde.
      const [bx0, by0, bx1, by1] = b.bbox;
      const grad = ctx.createLinearGradient(0, by0, 0, by1);
      grad.addColorStop(0, 'rgba(255,255,255,0.22)');
      grad.addColorStop(1, 'rgba(0,0,0,0.28)');
      path();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = pal.rockEdge;
      ctx.lineWidth = b.kind === 'island' ? 8 : 5;
      ctx.lineJoin = 'round';
      ctx.stroke();
      if (b.kind === 'wall' || b.kind === 'spire') {
        // Sillares: líneas horizontales.
        ctx.save();
        path();
        ctx.clip();
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 3;
        for (let y = by0 + 36; y < by1; y += 36) {
          ctx.beginPath();
          ctx.moveTo(bx0, y);
          ctx.lineTo(bx1, y);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  #drawGround(ctx) {
    ctx.fillStyle = COLORS.grass;
    ctx.fillRect(-600, GROUND_Y, W + 1200, 18);
    ctx.fillStyle = COLORS.dirt;
    ctx.fillRect(-600, GROUND_Y + 18, W + 1200, H - GROUND_Y);
    ctx.fillStyle = COLORS.dirtDark;
    for (let x = -580; x < W + 600; x += 70) ctx.fillRect(x + ((x * 13) % 30), GROUND_Y + 45 + ((x * 7) % 40), 22, 8);
  }

  #drawGates(ctx, now) {
    for (const gate of this.#state.field.gates) {
      const [x0, y0, x1, y1] = gate.seg;
      const ax = this.#sx(x0), bx = this.#sx(x1);
      const cx = (ax + bx) / 2, cy = (y0 + y1) / 2;
      const len = Math.hypot(bx - ax, y1 - y0);
      const rot = Math.atan2(y1 - y0, bx - ax);
      const flashAt = this.#gateFlash.get(gate.id);
      const flash = flashAt !== undefined && now - flashAt < 0.15;
      const color = COLORS.gate[gate.mult] ?? '#888';
      const pulse = 1 + Math.sin(now * 3 + gate.id) * 0.03; // leve "respiración"
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.scale(pulse * (flash ? 1.1 : 1), pulse * (flash ? 1.25 : 1));
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      this.#roundRect(ctx, -len / 2 - 4, -15, len + 8, 34, 8);
      ctx.fillStyle = flash ? '#ffffff' : color;
      this.#roundRect(ctx, -len / 2 - 6, -17, len + 12, 34, 8);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      this.#roundRect(ctx, -len / 2, -13, len, 8, 4);
      ctx.restore();
      ctx.font = `bold ${Math.round(26 * this.#k())}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.strokeText(`x${gate.mult}`, cx, cy + 1);
      ctx.fillStyle = flash ? '#222' : COLORS.text;
      ctx.fillText(`x${gate.mult}`, cx, cy + 1);
    }
  }

  #drawAim(ctx) {
    if (!this.#aim || !this.#state) return;
    const { angle, power } = this.#aim;
    // Con "Ojo de halcón" la mira muestra más trayectoria.
    const cfg = this.#state.config;
    const me = this.#state.players[this.#me];
    const ticks = me.perks?.includes('hawkeye') ? cfg.perks.hawkeye.value : 48;
    const pts = aimPreview(this.#me, angle, power, cfg, ticks, 3, this.#state.field);
    pts.forEach((p, i) => {
      ctx.fillStyle = `rgba(255,255,255,${0.95 - (i / pts.length) * 0.75})`;
      ctx.beginPath();
      ctx.arc(this.#sx(p.x), p.y, (6 - (i / pts.length) * 3) * this.#k(), 0, Math.PI * 2);
      ctx.fill();
    });
    const L = this.#localLauncher();
    const bx = L.x - 150, by = L.y - 300; // encima de la barra de vida
    const k = this.#k();
    ctx.save();
    ctx.translate(bx, by + 56); // se agranda desde su esquina de abajo a la izquierda
    ctx.scale(k, k);
    ctx.translate(-bx, -(by + 56));
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    this.#roundRect(ctx, bx, by, 200, 56, 12);
    ctx.fillStyle = '#ffd34d';
    this.#roundRect(ctx, bx + 10, by + 34, 180 * (power / 100), 12, 6);
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${angle.toFixed(1)}°   ${Math.round(power)}%`, bx + 12, by + 25);
    ctx.restore();
  }

  #drawCastle(ctx, p, now) {
    const box = CASTLE_BOXES[p];
    const L = LAUNCHERS[p];
    const team = p === this.#me ? COLORS.me : COLORS.rival;
    const pl = this.#state.players[p];
    const ratio = Math.max(0, this.#hpShown[p] / pl.maxHp);
    const cx = (box[0] + box[2]) / 2;
    const lx = Math.abs(L.x - cx); // lanzador relativo al centro (hacia el frente)
    ctx.save();
    ctx.translate(this.#sx(cx), 0);
    if (!this.#onLeft(p)) ctx.scale(-1, 1); // se dibuja mirando a la derecha
    // Orugas
    ctx.fillStyle = COLORS.tread;
    this.#roundRect(ctx, -115, GROUND_Y - 42, 230, 42, 21);
    ctx.fillStyle = '#555b64';
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.arc(-90 + i * 36, GROUND_Y - 21, 12, 0, Math.PI * 2);
      ctx.fill();
    }
    // Cuerpo
    ctx.fillStyle = COLORS.stoneDark;
    ctx.fillRect(-95, GROUND_Y - 150, 190, 110);
    ctx.fillStyle = COLORS.stone;
    ctx.fillRect(-88, GROUND_Y - 143, 176, 96);
    // Torre trasera con almenas y bandera (ondea)
    ctx.fillStyle = COLORS.stoneDark;
    ctx.fillRect(-100, GROUND_Y - 230, 60, 190);
    for (let i = 0; i < 3; i++) ctx.fillRect(-100 + i * 22, GROUND_Y - 246, 15, 18);
    ctx.fillStyle = '#4a4f57';
    ctx.fillRect(-76, GROUND_Y - 200, 12, 22);
    if (ratio > 0) {
      ctx.fillStyle = team;
      ctx.fillRect(-72, GROUND_Y - 300, 4, 56);
      const wave = Math.sin(now * 6 + p) * 4;
      ctx.beginPath();
      ctx.moveTo(-68, GROUND_Y - 300);
      ctx.quadraticCurveTo(-52, GROUND_Y - 300 + wave, -34, GROUND_Y - 296);
      ctx.lineTo(-34, GROUND_Y - 280);
      ctx.quadraticCurveTo(-52, GROUND_Y - 284 + wave, -68, GROUND_Y - 280);
      ctx.fill();
    }
    // Almenas del frente
    ctx.fillStyle = COLORS.stoneDark;
    for (let i = 0; i < 4; i++) ctx.fillRect(-30 + i * 32, GROUND_Y - 166, 20, 18);
    // Hollín y grietas según la vida que queda
    /** Rellena solo la silueta de piedra (cuerpo + torre), no el cielo de alrededor. */
    const fillStone = (style) => {
      ctx.fillStyle = style;
      ctx.fillRect(-95, GROUND_Y - 150, 190, 110);
      ctx.fillRect(-100, GROUND_Y - 230, 60, 80);
    };
    if (ratio < 0.5) fillStone(`rgba(30,25,20,${0.35 * (1 - ratio / 0.5)})`);
    ctx.strokeStyle = COLORS.crack;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    CRACKS.forEach((pts, i) => {
      if (ratio >= CRACK_LEVELS[i]) return;
      ctx.beginPath();
      pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, GROUND_Y + y) : ctx.moveTo(x, GROUND_Y + y)));
      ctx.stroke();
    });
    // Destello blanco al recibir un impacto
    const since = now - this.#hitFlash[p];
    if (since >= 0 && since < 0.12) fillStone(`rgba(255,255,255,${0.45 * (1 - since / 0.12)})`);
    // Cañón (con retroceso)
    ctx.save();
    ctx.translate(lx, L.y);
    ctx.rotate((-this.#barrel[p] * Math.PI) / 180);
    ctx.translate(-this.#recoil[p] * 12, 0);
    ctx.fillStyle = '#3a3f47';
    this.#roundRect(ctx, -10, -13, 74, 26, 8);
    ctx.fillStyle = team;
    ctx.fillRect(48, -15, 10, 30);
    ctx.restore();
    ctx.fillStyle = team;
    ctx.beginPath();
    ctx.arc(lx, L.y, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Barra de vida
    const hp = Math.max(0, Math.round(this.#hpShown[p]));
    const k = this.#k();
    // La barra agrandada no debe salirse del campo por los lados.
    const x = Math.max(110 * k, Math.min(W - 110 * k, this.#sx(cx)));
    const by = GROUND_Y - 345;
    ctx.save();
    ctx.translate(x, by + 26); // la barra crece hacia arriba, lejos del castillo
    ctx.scale(k, k);
    ctx.translate(-x, -(by + 26));
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    this.#roundRect(ctx, x - 110, by, 220, 26, 13);
    ctx.fillStyle = team;
    this.#roundRect(ctx, x - 107, by + 3, 214 * ratio, 20, 10);
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${hp} / ${pl.maxHp}`, x, by + 14);
    ctx.restore();
  }

  #drawRockets(ctx, now, dt) {
    const a = this.#anim;
    if (!a) return;
    const r = a.result;
    const g = this.#state.config.physics.gravity;
    const tick = (now - a.start) * TICKS_PER_SEC;
    const color = r.shooter === this.#me ? COLORS.me : COLORS.rival;
    const active = r.particles.filter((p) => tick >= p.t0 && tick < p.t1);
    // Estela de humo: menos bocanadas por cohete cuando hay muchos.
    const puffRate = 16 * Math.min(1, 80 / Math.max(1, active.length));
    for (const p of active) {
      const pos = particlePos(p, tick, g);
      const vx = this.#me === 1 ? -p.vx : p.vx;
      const vy = p.vy + g * (tick - p.t0);
      const ang = Math.atan2(vy, vx);
      const x = this.#sx(pos.x);
      if (Math.random() < puffRate * dt) {
        this.#effects.smoke(x - Math.cos(ang) * 20, pos.y - Math.sin(ang) * 20, { size: 5, grow: 16, life: 0.6, vx: 0, vy: -10, color: '210,210,210', alpha: 0.5 });
      }
      if (r.weapon === 'mortar') {
        this.#drawShell(ctx, x, pos.y, ang, color, now);
        continue;
      }
      // Racimo: el cohete base es más grande hasta que se abre.
      const clusterBase = r.weapon === 'cluster' && p.parent === -1;
      const size = this.#k() * (clusterBase ? 1.5 : 1) * (1 + Math.min(0.6, Math.log10(p.weight) * 0.35));
      ctx.save();
      ctx.translate(x, pos.y);
      ctx.rotate(ang);
      ctx.scale(size, size);
      ctx.fillStyle = clusterBase ? '#ffb347' : color; // cuerpo
      this.#roundRect(ctx, -12, -5, 22, 10, 5);
      ctx.fillStyle = '#ffffff'; // punta
      ctx.beginPath();
      ctx.moveTo(10, -5);
      ctx.lineTo(18, 0);
      ctx.lineTo(10, 5);
      ctx.fill();
      ctx.fillStyle = '#ffb02e'; // llama
      ctx.beginPath();
      ctx.moveTo(-12, -4);
      ctx.lineTo(-20 - Math.random() * 8, 0);
      ctx.lineTo(-12, 4);
      ctx.fill();
      ctx.restore();
    }
  }

  /** Proyectil de mortero: una bomba redonda con banda del color del equipo y mecha. */
  #drawShell(ctx, x, y, ang, color, now) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.scale(this.#k(), this.#k());
    ctx.fillStyle = '#2f343b';
    ctx.beginPath();
    ctx.ellipse(0, 0, 17, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(-4, -13, 7, 26);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(5, -5, 5, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = Math.sin(now * 40) > 0 ? '#ffe14d' : '#ff7a1a'; // chispa de la mecha
    ctx.beginPath();
    ctx.arc(-19, 0, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  #drawTexts(ctx, now) {
    this.#texts = this.#texts.filter((t) => t.sticky || now - t.t0 < 1.2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const t of this.#texts) {
      if (now < t.t0 && !t.sticky) continue; // todavía no aparece
      const u = t.sticky ? 0 : (now - t.t0) / 1.2;
      const pop = 1 + 0.35 * Math.max(0, 1 - (now - t.pop) / 0.18); // "late" con cada impacto
      ctx.save();
      ctx.translate(t.x, t.y - 50 * u);
      ctx.scale(pop, pop);
      ctx.globalAlpha = 1 - u;
      ctx.font = 'bold 48px system-ui, sans-serif';
      ctx.fillStyle = t.color ?? '#ffe14d';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 6;
      ctx.strokeText(t.text, 0, 0);
      ctx.fillText(t.text, 0, 0);
      ctx.restore();
    }
  }

  #roundRect(ctx, x, y, w, h, r) {
    if (w <= 0) return;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
    ctx.fill();
  }
}
