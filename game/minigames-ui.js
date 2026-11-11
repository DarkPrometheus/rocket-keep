// =============================================================
// minigames-ui.js — Interfaz DOM de los minijuegos de inicio de ronda.
//
// No decide quién gana: muestra el minijuego con los parámetros que
// generó la lógica, mide lo que hace el jugador y devuelve su "entrada"
// (ver minigames.js). Al final muestra el resultado que calculó la lógica.
//
//   play(info) → Promise<entry>      juega (info: { id, params, me, coins })
//   setOpponentDone(bool)            "el rival ya terminó"
//   waiting()                        "esperando al rival…"
//   showResult(info) → Promise       resumen (info: { id, params, entries, scores, winner, first, me })
//   close()
//
// Cada minijuego tiene un tiempo máximo: si el jugador no hace nada, se
// manda lo que lleve (así una pestaña olvidada no congela la partida).
// =============================================================

import { MINIGAMES, needlePos } from './minigames.js';

const INTRO_AUTOSTART_MS = 10000; // si no pulsa "¡Listo!", empieza solo
const RESULT_MS = 4200;           // tiempo que se ve el resultado
const SIMON_COLORS = ['#2fbf71', '#e5484d', '#f5c84c', '#2f80ed'];
const RPS = ['✊', '✋', '✌️'];
const RPS_NAMES = ['Piedra', 'Papel', 'Tijera'];

const fmtS = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;

export class MinigameUI {
  #el;
  #cleanup = [];   // funciones para soltar timers / listeners del juego en curso
  #oppDone = false;
  #audio;

  constructor(panelEl, { audio } = {}) {
    this.#audio = audio;
    this.#el = panelEl;
  }

  // ---------- utilidades ----------

  #reset() {
    this.#cleanup.forEach((f) => f());
    this.#cleanup = [];
  }

  #timeout(fn, ms) {
    const id = setTimeout(fn, ms);
    this.#cleanup.push(() => clearTimeout(id));
  }

  #raf(fn) {
    let id = 0;
    const loop = (t) => {
      if (fn(t) !== false) id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    this.#cleanup.push(() => cancelAnimationFrame(id));
  }

  #on(target, ev, fn) {
    target.addEventListener(ev, fn);
    this.#cleanup.push(() => target.removeEventListener(ev, fn));
  }

  #frame(def, body) {
    this.#el.hidden = false;
    this.#el.className = 'panel minigame';
    this.#el.innerHTML = `<h2>${def.icon} ${def.label}</h2><p class="mg-howto">${def.howto}</p>
      <div class="mg-body">${body}</div><p class="mg-opp"></p>`;
    this.#renderOpp();
    return this.#el.querySelector('.mg-body');
  }

  #renderOpp() {
    const o = this.#el.querySelector('.mg-opp');
    if (o) o.textContent = this.#oppDone ? 'El rival ya terminó' : '';
  }

  /** Barra de tiempo restante (se vacía en `ms`). */
  #timerBar(body, ms) {
    const bar = document.createElement('div');
    bar.className = 'mg-timer';
    bar.innerHTML = '<i></i>';
    body.append(bar);
    const t0 = performance.now();
    this.#raf((t) => {
      const k = Math.max(0, 1 - (t - t0) / ms);
      bar.firstChild.style.width = `${k * 100}%`;
      return k > 0;
    });
  }

  setOpponentDone(done) {
    this.#oppDone = done;
    this.#renderOpp();
  }

  waiting() {
    this.#reset();
    this.#el.hidden = false;
    this.#el.className = 'panel minigame';
    this.#el.innerHTML = '<h2>⏳</h2><p class="waiting">Esperando al rival…</p>';
  }

  close() {
    this.#reset();
    this.#el.hidden = true;
    this.#el.innerHTML = '';
  }

  // ---------- jugar ----------

  /** Muestra la intro y luego el minijuego. Resuelve con la entrada del jugador. */
  play(info) {
    this.#reset();
    this.#oppDone = false;
    const def = MINIGAMES[info.id];
    return new Promise((resolve) => {
      let sent = false;
      const submit = (entry) => {
        if (sent) return;
        sent = true;
        this.#reset();
        resolve(entry);
      };
      const body = this.#frame(def, '<button class="primary big" data-go>¡Listo!</button>');
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        this.#reset();
        this.#audio?.play('start');
        GAMES[info.id](this.#frame(def, ''), info, submit, {
          timeout: (fn, ms) => this.#timeout(fn, ms),
          raf: (fn) => this.#raf(fn),
          on: (t, ev, fn) => this.#on(t, ev, fn),
          timerBar: (b, ms) => this.#timerBar(b, ms),
          cleanup: (fn) => this.#cleanup.push(fn),
          sound: (name, data) => this.#audio?.play(name, data),
        });
      };
      this.#on(body.querySelector('[data-go]'), 'click', start);
      this.#timeout(start, INTRO_AUTOSTART_MS);
    });
  }

  // ---------- resultado ----------

  /** Muestra quién ganó y qué hizo cada uno. Resuelve al cerrar (o solo, tras unos segundos). */
  showResult(info) {
    this.#reset();
    const def = MINIGAMES[info.id];
    const me = info.me;
    const op = 1 - me;
    let title;
    if (info.winner === null) title = info.first === me ? 'Empate · abres tú por turno' : 'Empate · abre el rival por turno';
    else title = info.winner === me ? '🎉 ¡Abres tú la ronda!' : 'Abre el rival';
    this.#audio?.play(info.winner === null ? 'draw' : info.winner === me ? 'success' : 'failure');
    const lines = RESULTS[info.id](info, me, op);
    this.#el.hidden = false;
    this.#el.className = `panel minigame result ${info.winner === null ? 'tie' : info.winner === me ? 'win' : 'lose'}`;
    this.#el.innerHTML = `<h2>${title}</h2><p class="mg-howto">${def.icon} ${def.label}</p>
      <div class="mg-result">${lines}</div>
      <button class="primary" data-ok>Continuar</button>`;
    return new Promise((resolve) => {
      const done = () => {
        this.close();
        resolve();
      };
      this.#on(this.#el.querySelector('[data-ok]'), 'click', done);
      this.#timeout(done, RESULT_MS);
    });
  }
}

// ---------- cada minijuego ----------
// Cada función recibe (body, info, submit, h): `h` da temporizadores y
// listeners que se sueltan solos al terminar.

const GAMES = {
  needle(body, { params }, submit, h) {
    body.innerHTML = `<div class="mg-needle"><div class="zone" style="left:${params.target / 10}%"></div><div class="needle"></div></div>
      <button class="primary big" data-stop>¡Alto!</button>`;
    const needle = body.querySelector('.needle');
    const t0 = performance.now();
    h.raf((t) => {
      const ms = Math.floor(t - t0);
      needle.style.left = `${needlePos(params, Math.min(ms, params.maxMs)) / 10}%`;
      if (ms >= params.maxMs) {
        submit({ ms: params.maxMs });
        return false;
      }
    });
    const stop = () => {
      h.sound('tap');
      submit({ ms: Math.min(params.maxMs, Math.floor(performance.now() - t0)) });
    };
    h.on(body.querySelector('[data-stop]'), 'pointerdown', stop);
    h.on(body.querySelector('.mg-needle'), 'pointerdown', stop);
    h.on(window, 'keydown', (e) => {
      if (e.target?.closest?.('.sound-controls')) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        stop();
      }
    });
  },

  count(body, { params }, submit, h) {
    body.innerHTML = `<div class="mg-dots">${params.dots
      .map(([x, y]) => `<i style="left:${x / 10}%;top:${(y / 600) * 100}%"></i>`)
      .join('')}</div>`;
    h.timeout(() => {
      body.innerHTML = `<p class="mg-big">¿Cuántos había?</p>
        <div class="mg-stepper"><button data-d="-5">−5</button><button data-d="-1">−1</button>
        <input type="number" inputmode="numeric" min="0" max="999" value="25">
        <button data-d="1">+1</button><button data-d="5">+5</button></div>
        <button class="primary big" data-send>Enviar</button>`;
      const input = body.querySelector('input');
      const t0 = performance.now();
      const value = () => Math.max(0, Math.min(999, Math.floor(Number(input.value) || 0)));
      const send = () => submit({ guess: value(), ms: Math.floor(performance.now() - t0) });
      h.on(body, 'click', (e) => {
        const d = e.target.closest('[data-d]');
        if (d) input.value = Math.max(0, value() + Number(d.dataset.d));
        if (e.target.closest('[data-send]')) send();
      });
      h.on(input, 'keydown', (e) => e.key === 'Enter' && send());
      h.timerBar(body, params.timeMs);
      h.timeout(() => submit({ guess: value(), ms: params.timeMs }), params.timeMs);
    }, params.showMs);
  },

  simon(body, { params }, submit, h) {
    body.innerHTML = `<p class="mg-big" data-status>Mira…</p><div class="mg-simon">${SIMON_COLORS.slice(0, params.colors)
      .map((c, i) => `<button data-pad="${i}" style="background:${c}"></button>`)
      .join('')}</div>`;
    const status = body.querySelector('[data-status]');
    const pads = [...body.querySelectorAll('[data-pad]')];
    const t0 = performance.now();
    let level = 0;     // nivel que se está jugando (1…len)
    let pos = 0;       // posición dentro de la secuencia al repetir
    let input = false; // ¿acepta toques?
    let stepTimer = null;
    const end = (reached) => {
      clearTimeout(stepTimer);
      submit({ reached, ms: Math.floor(performance.now() - t0) });
    };
    h.cleanup(() => clearTimeout(stepTimer));
    const flash = (i, ms) => {
      h.sound('simon', { index: i });
      pads[i].classList.add('lit');
      h.timeout(() => pads[i].classList.remove('lit'), ms);
    };
    const armStepTimeout = () => {
      clearTimeout(stepTimer);
      stepTimer = setTimeout(() => end(level - 1), 5000); // 5 s sin tocar = fallo
    };
    const next = () => {
      level++;
      if (level > params.seq.length) return end(params.seq.length);
      input = false;
      pos = 0;
      status.textContent = `Nivel ${level}: mira…`;
      for (let k = 0; k < level; k++) h.timeout(() => flash(params.seq[k], 380), 500 + k * 560);
      h.timeout(() => {
        input = true;
        status.textContent = `Nivel ${level}: ¡repite!`;
        armStepTimeout();
      }, 500 + level * 560);
    };
    h.on(body, 'pointerdown', (e) => {
      const pad = e.target.closest('[data-pad]');
      if (!pad || !input) return;
      const i = Number(pad.dataset.pad);
      flash(i, 180);
      if (i !== params.seq[pos]) {
        clearTimeout(stepTimer);
        h.sound('failure');
        status.textContent = '¡Fallaste!';
        input = false;
        h.timeout(() => end(level - 1), 500);
        return;
      }
      pos++;
      armStepTimeout();
      if (pos === level) {
        clearTimeout(stepTimer);
        input = false;
        h.sound('success');
        status.textContent = '¡Bien!';
        h.timeout(next, 450);
      }
    });
    next();
  },

  mash(body, { params }, submit, h) {
    body.innerHTML = `<p class="mg-big" data-status>Prepárate…</p>
      <button class="mg-mash" data-tap disabled>3</button>`;
    const btn = body.querySelector('[data-tap]');
    const status = body.querySelector('[data-status]');
    let taps = 0;
    let live = false;
    [3, 2, 1].forEach((n, k) => h.timeout(() => {
      btn.textContent = String(n);
      h.sound('tick');
    }, k * 700));
    h.timeout(() => {
      live = true;
      h.sound('turn');
      btn.disabled = false;
      btn.textContent = '¡TOCA!';
      status.textContent = '0 toques';
      h.timerBar(body, params.durationMs);
      h.timeout(() => {
        live = false;
        submit({ taps: Math.min(taps, params.maxTaps) });
      }, params.durationMs);
    }, 2100);
    const tap = () => {
      if (!live) return;
      taps++;
      h.sound('tap');
      status.textContent = `${taps} toques`;
      btn.classList.remove('hit');
      void btn.offsetWidth; // reinicia la animación
      btn.classList.add('hit');
    };
    h.on(btn, 'pointerdown', tap);
    h.on(window, 'keydown', (e) => {
      if (e.target?.closest?.('.sound-controls')) return;
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        tap();
      }
    });
  },

  maze(body, { params }, submit, h) {
    const n = params.n;
    const goal = n * n - 1;
    const delta = [-n, 1, n, -1];
    const cells = params.open
      .map((m, i) => {
        const x = i % n, y = (i - x) / n;
        const walls = [!(m & 1) && 'wn', !(m & 8) && 'ww', x === n - 1 && 'we', y === n - 1 && 'ws'].filter(Boolean);
        return `<i class="${walls.join(' ')}"></i>`;
      })
      .join('');
    body.innerHTML = `<div class="mg-mazewrap">
        <div class="mg-maze" style="--n:${n}">${cells}
          <b class="mg-goal" style="--x:${n - 1};--y:${n - 1}">🏁</b><b class="mg-me" style="--x:0;--y:0"></b></div>
        <div class="mg-pad">${[0, 3, 1, 2].map((d) => `<button data-dir="${d}" aria-label="${['Arriba', 'Derecha', 'Abajo', 'Izquierda'][d]}">${['▲', '▶', '▼', '◀'][d]}</button>`).join('')}</div>
      </div>`;
    const cellEls = body.querySelectorAll('.mg-maze > i');
    const me = body.querySelector('.mg-me');
    const t0 = performance.now();
    let pos = 0;
    let finished = false;
    cellEls[0].classList.add('seen');
    const move = (d) => {
      if (finished || !(params.open[pos] & (1 << d))) return; // pared: no pasa nada
      pos += delta[d];
      me.style.setProperty('--x', pos % n);
      me.style.setProperty('--y', Math.floor(pos / n));
      cellEls[pos].classList.add('seen');
      h.sound('tick');
      if (pos === goal) {
        finished = true;
        const ms = Math.floor(performance.now() - t0);
        h.sound('success');
        h.timeout(() => submit({ ms, done: 1 }), 350); // se alcanza a ver que llegó
      }
    };
    // Teclado: flechas o WASD (mantener pulsado repite).
    const KEYS = { ArrowUp: 0, w: 0, W: 0, ArrowRight: 1, d: 1, D: 1, ArrowDown: 2, s: 2, S: 2, ArrowLeft: 3, a: 3, A: 3 };
    h.on(window, 'keydown', (e) => {
      if (e.target?.closest?.('.sound-controls') || !(e.key in KEYS)) return;
      e.preventDefault();
      move(KEYS[e.key]);
    });
    // Botones táctiles: mantener pulsado sigue avanzando.
    let repeat = 0;
    const stop = () => {
      clearInterval(repeat);
      repeat = 0;
    };
    h.cleanup(stop);
    h.on(body, 'pointerdown', (e) => {
      const b = e.target.closest('[data-dir]');
      if (!b) return;
      e.preventDefault();
      const d = Number(b.dataset.dir);
      stop();
      move(d);
      repeat = setInterval(() => move(d), 140);
    });
    h.on(window, 'pointerup', stop);
    h.on(window, 'pointercancel', stop);
    h.timerBar(body, params.timeMs);
    h.timeout(() => submit({ ms: params.timeMs, done: finished ? 1 : 0 }), params.timeMs);
  },

  rps(body, { params }, submit, h) {
    const picks = [];
    const render = () => {
      body.innerHTML = `<div class="mg-slots">${Array.from({ length: params.picks }, (_, i) =>
        `<span class="${i === picks.length ? 'next' : ''}">${picks[i] !== undefined ? RPS[picks[i]] : i + 1}</span>`).join('')}</div>
        <div class="mg-grid three">${RPS.map((e, k) => `<button data-rps="${k}" ${picks.length >= params.picks ? 'disabled' : ''}>${e}<small>${RPS_NAMES[k]}</small></button>`).join('')}</div>
        <div class="mg-row"><button data-undo ${picks.length ? '' : 'disabled'}>Borrar</button>
        <button class="primary" data-send ${picks.length === params.picks ? '' : 'disabled'}>Confirmar</button></div>`;
      h.timerBar(body, Math.max(0, 20000 - (performance.now() - t0)));
    };
    const t0 = performance.now();
    h.on(body, 'click', (e) => {
      const b = e.target.closest('[data-rps]');
      if (b && picks.length < params.picks) picks.push(Number(b.dataset.rps));
      if (e.target.closest('[data-undo]')) picks.pop();
      if (e.target.closest('[data-send]') && picks.length === params.picks) return submit({ picks });
      if (b || e.target.closest('[data-undo]')) render();
    });
    // Sin tiempo: completa con jugadas al azar (no "siempre piedra", que sería predecible).
    h.timeout(() => {
      while (picks.length < params.picks) picks.push(Math.floor(Math.random() * 3));
      submit({ picks });
    }, 20000);
    render();
  },

};

// ---------- textos del resultado ----------
// Cada función devuelve HTML con lo que hizo cada jugador.

const row = (who, text, win) => `<div class="mg-line ${win ? 'win' : ''}"><span>${who}</span><b>${text}</b></div>`;
const both = (info, me, op, fmt) =>
  row('Tú', fmt(info.entries[me], me), info.winner === me) + row('Rival', fmt(info.entries[op], op), info.winner === op);

const RESULTS = {
  needle: (info, me, op) => both(info, me, op, (e, p) => (info.scores[p][0] > 1000 ? 'No la detuvo' : `a ${info.scores[p][0]} de la marca`)),
  count: (info, me, op) => `<p class="mg-big">Había ${info.params.n}</p>` + both(info, me, op, (e) => `${e.guess} · ${fmtS(e.ms)}`),
  simon: (info, me, op) => both(info, me, op, (e) => `nivel ${e.reached} · ${fmtS(e.ms)}`),
  mash: (info, me, op) => both(info, me, op, (e) => `${e.taps} toques`),
  maze: (info, me, op) => both(info, me, op, (e) => (e.done ? fmtS(e.ms) : 'No llegó a la meta')),
  rps: (info, me, op) => {
    const a = info.entries[me].picks, b = info.entries[op].picks;
    const decisive = a.findIndex((x, i) => x !== b[i]);
    const line = (who, arr, p) => `<div class="mg-line ${info.winner === p ? 'win' : ''}"><span>${who}</span><b>${arr
      .map((x, i) => `<span class="${i === decisive ? 'decisive' : i > decisive && decisive >= 0 ? 'unused' : ''}">${RPS[x]}</span>`).join(' ')}</b></div>`;
    return line('Tú', a, me) + line('Rival', b, op);
  },
};
