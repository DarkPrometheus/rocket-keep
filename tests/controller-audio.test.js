import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../game/controller.js';
import * as L from '../game/logic.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(t) {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  const listeners = new Map(), sounds = [];
  const client = {
    me: 0, names: ['Tú', 'Bot'], picked: [true, true],
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },
    fire() {},
  };
  const emit = (name, data) => { for (const fn of listeners.get(name) ?? []) fn(data); };
  let finishShot;
  const renderer = { setState() {}, setAim() {},
    playShot() { return new Promise((resolve) => { finishShot = resolve; }); },
    destroy() { finishShot?.(); },
  };
  const ui = { setHandlers() {}, render() {}, toast() {}, minigame: { close() {} } };
  const controller = new Controller({ client, renderer, ui, canvas: new EventTarget(),
    audio: { play: (name) => sounds.push(name) } });
  let state = L.createMatch();
  state = L.chooseWeapon(state, 0, 'burst').state;
  state = L.chooseWeapon(state, 1, 'burst').state;
  state = L.startRound(state, 123).state;
  state.phase = 'aim'; state.turn = 0;
  t.after(() => { controller.destroy(); globalThis.window = previous; });
  return { controller, state, emit, sounds, finish: () => finishShot() };
}

test('audio del controller: avisa el turno una vez y solo confirma las compras locales aceptadas', (t) => {
  const f = fixture(t);
  f.emit('change', { state: f.state });
  f.emit('change', { state: f.state });
  f.emit('bought', { player: 1 });
  f.emit('bought', { player: 0 });
  assert.deepEqual(f.sounds, ['turn', 'buy']);
});

test('audio del controller: la victoria espera el final de la animación', async (t) => {
  const f = fixture(t);
  f.emit('change', { state: f.state });
  const over = { ...f.state, phase: 'over', winner: 0, endReason: 'ko' };
  f.emit('shot', { result: {}, state: over });
  f.emit('change', { state: over });
  assert.deepEqual(f.sounds, ['turn']);
  f.finish();
  await new Promise((resolve) => setTimeout(resolve, 380));
  assert.deepEqual(f.sounds, ['turn', 'win']);
  f.emit('change', { state: over });
  assert.deepEqual(f.sounds, ['turn', 'win']);
});

test('audio del controller: salir durante un disparo descarta sonidos pendientes', async (t) => {
  const f = fixture(t);
  f.emit('change', { state: f.state });
  const over = { ...f.state, phase: 'over', winner: 0, endReason: 'ko' };
  f.emit('shot', { result: {}, state: over });
  f.emit('bought', { player: 0 });
  f.controller.destroy();
  await settle();
  assert.deepEqual(f.sounds, ['turn']);
});
