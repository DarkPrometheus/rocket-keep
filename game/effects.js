// =============================================================
// effects.js — Efectos visuales: partículas y sacudida de pantalla.
//
// Es puramente cosmético: usa Math.random libremente porque nada de
// esto afecta al resultado del juego (eso lo decide logic.js). Las
// coordenadas son las del mundo (las mismas que usa el render), y las
// velocidades están en unidades por segundo.
// =============================================================

const MAX_PARTICLES = 900;
const GRAVITY = 900; // para chispas y escombros (unidades/s²)

const rand = (a, b) => a + Math.random() * (b - a);

export class Effects {
  #parts = [];

  get count() {
    return this.#parts.length;
  }

  /** Añade una partícula si hay espacio (las nuevas se descartan si se llena). */
  #add(p) {
    if (this.#parts.length >= MAX_PARTICLES) return;
    p.age = 0;
    this.#parts.push(p);
  }

  /** Bocanada de humo. */
  smoke(x, y, { size = 9, grow = 26, life = 0.9, vx = 0, vy = -25, color = '120,120,120', alpha = 0.45 } = {}) {
    this.#add({ type: 'smoke', x, y, vx: vx + rand(-8, 8), vy: vy + rand(-8, 8), size, grow, life, color, alpha });
  }

  /** Llama pequeña (para castillos muy dañados). */
  fire(x, y) {
    this.#add({ type: 'fire', x, y, vx: rand(-10, 10), vy: rand(-70, -40), size: rand(6, 11), grow: -6, life: rand(0.35, 0.6) });
  }

  /** Explosión: bola de fuego, chispas, humo y escombros. `power` ~ 1..4. */
  explosion(x, y, power = 1, { debris = true } = {}) {
    this.#add({ type: 'flash', x, y, size: 22 * power, life: 0.12 });
    this.#add({ type: 'fireball', x, y, size: 14 * power, grow: 70 * power, life: 0.35 });
    const sparks = Math.round(6 + 6 * power);
    for (let i = 0; i < sparks; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(150, 380) * Math.sqrt(power);
      this.#add({ type: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 120, life: rand(0.25, 0.55) });
    }
    for (let i = 0; i < 2 + power * 2; i++) {
      this.smoke(x + rand(-10, 10), y + rand(-10, 10), { size: 10 * power, grow: 40, life: rand(0.8, 1.4), vy: rand(-50, -20), color: '70,70,70', alpha: 0.5 });
    }
    if (debris) {
      for (let i = 0; i < 3 + power * 2; i++) {
        const a = rand(-Math.PI, 0);
        const s = rand(120, 300);
        this.#add({ type: 'debris', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, rot: rand(0, 6), vr: rand(-12, 12), size: rand(4, 9), life: rand(0.7, 1.2), color: '#8a8f99' });
      }
    }
  }

  /** Polvo y terrones al chocar contra el terreno. */
  dust(x, y) {
    for (let i = 0; i < 4; i++) {
      this.smoke(x + rand(-8, 8), y - 4, { size: 8, grow: 30, life: rand(0.6, 1), vy: rand(-40, -15), color: '140,110,80', alpha: 0.55 });
    }
    for (let i = 0; i < 4; i++) {
      const a = rand(-Math.PI * 0.85, -Math.PI * 0.15);
      const s = rand(100, 220);
      this.#add({ type: 'debris', x, y: y - 3, vx: Math.cos(a) * s, vy: Math.sin(a) * s, rot: 0, vr: rand(-10, 10), size: rand(3, 6), life: 0.8, color: '#6b4a2e' });
    }
  }

  /** Anillo que se expande (al cruzar una compuerta). */
  ring(x, y, color = '255,255,255') {
    this.#add({ type: 'ring', x, y, size: 10, grow: 220, life: 0.3, color });
    for (let i = 0; i < 5; i++) {
      const a = rand(0, Math.PI * 2);
      this.#add({ type: 'spark', x, y, vx: Math.cos(a) * 200, vy: Math.sin(a) * 200, life: 0.2 });
    }
  }

  /** Fogonazo del cañón. `dirX, dirY` = dirección del disparo (unitaria). */
  muzzle(x, y, dirX, dirY) {
    this.#add({ type: 'flash', x, y, size: 30, life: 0.1 });
    for (let i = 0; i < 6; i++) {
      this.smoke(x, y, { size: 10, grow: 45, life: rand(0.5, 0.9), vx: dirX * rand(40, 120), vy: dirY * rand(40, 120) - 10, color: '200,200,200', alpha: 0.5 });
    }
  }

  update(dt) {
    for (const p of this.#parts) {
      p.age += dt;
      p.x += (p.vx ?? 0) * dt;
      p.y += (p.vy ?? 0) * dt;
      if (p.type === 'spark' || p.type === 'debris') p.vy += GRAVITY * dt;
      if (p.type === 'smoke') {
        p.vx *= 1 - 1.5 * dt;
        p.vy *= 1 - 1.2 * dt;
      }
      if (p.vr) p.rot += p.vr * dt;
    }
    this.#parts = this.#parts.filter((p) => p.age < p.life);
  }

  draw(ctx) {
    for (const p of this.#parts) {
      const u = p.age / p.life; // 0 → 1 a lo largo de su vida
      switch (p.type) {
        case 'smoke': {
          ctx.fillStyle = `rgba(${p.color},${p.alpha * (1 - u)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size + p.grow * u, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'fire': {
          ctx.fillStyle = `rgba(255,${Math.round(200 - 150 * u)},40,${1 - u})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(1, p.size + p.grow * u), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'fireball': {
          const r = p.size + p.grow * u;
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          g.addColorStop(0, `rgba(255,250,200,${1 - u})`);
          g.addColorStop(0.4, `rgba(255,170,50,${0.9 * (1 - u)})`);
          g.addColorStop(1, 'rgba(220,60,20,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'flash': {
          ctx.fillStyle = `rgba(255,255,230,${0.9 * (1 - u)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (1 + u), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'spark': {
          ctx.strokeStyle = `rgba(255,${Math.round(230 - 120 * u)},90,${1 - u})`;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
          ctx.stroke();
          break;
        }
        case 'debris': {
          ctx.save();
          ctx.globalAlpha = 1 - u * u;
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.restore();
          break;
        }
        case 'ring': {
          ctx.strokeStyle = `rgba(${p.color},${1 - u})`;
          ctx.lineWidth = 6 * (1 - u) + 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size + p.grow * u, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
      }
    }
  }
}

/** Sacudida de pantalla: se acumula con cada impacto y se amortigua sola. */
export class Shake {
  #amp = 0;

  /** Añade intensidad (en unidades del mundo). */
  add(amount) {
    this.#amp = Math.min(30, this.#amp + amount);
  }

  update(dt) {
    this.#amp *= Math.exp(-7 * dt);
    if (this.#amp < 0.05) this.#amp = 0;
  }

  /** Desplazamiento de cámara para este fotograma. */
  offset() {
    if (!this.#amp) return { x: 0, y: 0 };
    return { x: rand(-1, 1) * this.#amp, y: rand(-1, 1) * this.#amp };
  }
}
