import test from 'node:test';
import assert from 'node:assert/strict';
import { GameAudio } from '../game/audio.js';

class Param {
  value = 0;
  setValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
}
class Node {
  gain = new Param(); pan = new Param(); frequency = new Param();
  threshold = new Param(); ratio = new Param(); disconnected = false;
  connect() {}
  disconnect() { this.disconnected = true; }
}
class Source extends Node {
  stopped = false;
  start(at) { this.at = at; }
  stop(at) { if (at === undefined) this.stopped = true; }
}
class Context {
  static instances = [];
  state = 'suspended'; currentTime = 0; sampleRate = 8000; destination = new Node(); sources = [];
  constructor() { Context.instances.push(this); }
  createGain() { return new Node(); }
  createDynamicsCompressor() { return new Node(); }
  createStereoPanner() { return new Node(); }
  createBiquadFilter() { return new Node(); }
  createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
  createOscillator() { const node = new Source(); this.sources.push(node); return node; }
  createBufferSource() { return this.createOscillator(); }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.state = 'closed'; }
}
const storage = (initial = null) => ({ value: initial, getItem() { return this.value; }, setItem(k, v) { this.value = v; } });
const setup = (opts = {}) => {
  const doc = new EventTarget(); doc.hidden = false;
  const audio = new GameAudio({ AudioContext: Context, storage: storage(), document: doc, ...opts });
  return { audio, doc };
};

test('audio: espera un gesto, reutiliza contexto y no reproduce sonidos bloqueados después', async () => {
  const count = Context.instances.length;
  const { audio, doc } = setup();
  assert.equal(Context.instances.length, count);
  assert.equal(audio.play('impact'), false);
  doc.dispatchEvent(new Event('pointerdown'));
  await audio.unlock();
  const ctx = Context.instances.at(-1);
  assert.equal(Context.instances.length, count + 1);
  assert.equal(ctx.sources.length, 0);
  assert.equal(audio.play('impact'), true);
  await audio.unlock();
  assert.equal(Context.instances.length, count + 1);
  audio.dispose();
});

test('audio: todos los efectos se sintetizan; los nodos terminados se liberan', async () => {
  const { audio } = setup(); await audio.unlock();
  const ctx = Context.instances.at(-1);
  for (const name of ['launch','gate','split','impact','ground','ko','click','buy','error','failure',
    'success','start','turn','tick','tap','simon','win','lose','draw']) {
    assert.equal(audio.play(name), true, name);
    assert.ok(ctx.sources.length > 0);
    for (const source of ctx.sources) source.onended?.();
    ctx.currentTime += 1;
  }
  assert.ok(ctx.sources.every((node) => node.disconnected));
  audio.dispose();
});

test('audio: agrupa ráfagas de impactos y limita voces simultáneas', async () => {
  const { audio } = setup(); await audio.unlock();
  const ctx = Context.instances.at(-1);
  audio.play('impact');
  assert.equal(audio.play('impact'), false);
  assert.equal(ctx.sources.filter((s) => s.at !== undefined).length, 2);
  for (let i = 0; i < 200; i++) { ctx.currentTime += 0.08; audio.play('impact'); }
  assert.equal(ctx.sources.filter((s) => s.at !== undefined).length, 20);
  audio.stopAll();
  assert.ok(ctx.sources.filter((s) => s.at !== undefined).every((s) => s.stopped && s.disconnected));
  assert.equal(audio.play('impact'), true);
  audio.dispose();
});

test('audio: silencio, volumen cero y preferencias persistentes cancelan incluso melodías futuras', async () => {
  const saved = storage();
  const { audio } = setup({ storage: saved }); await audio.unlock();
  const ctx = Context.instances.at(-1);
  audio.play('win');
  assert.ok(ctx.sources.some((s) => s.at > ctx.currentTime));
  audio.setMuted(true);
  assert.ok(ctx.sources.every((s) => s.stopped));
  assert.equal(audio.play('launch'), false);
  audio.setVolume(0.32);
  const restored = setup({ storage: saved }).audio;
  assert.deepEqual(restored.settings, { muted: true, volume: 0.32, available: true });
  restored.dispose();
  audio.setMuted(false);
  audio.setVolume(0);
  assert.equal(audio.play('win'), false);
  audio.setVolume(1.5); assert.equal(audio.settings.volume, 1);
  audio.setVolume(NaN); assert.equal(audio.settings.volume, 1);
  audio.dispose();
});

test('audio: ocultar la pestaña cancela sonidos, no los repite, y espera otro gesto para reanudar', async () => {
  const { audio, doc } = setup(); await audio.unlock();
  const ctx = Context.instances.at(-1);
  audio.play('win');
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(ctx.state, 'suspended');
  assert.ok(ctx.sources.every((s) => s.stopped));
  assert.equal(audio.play('impact'), false);
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(audio.play('impact'), false);
  doc.dispatchEvent(new Event('keydown')); await audio.unlock();
  assert.equal(audio.play('impact'), true);
  audio.dispose(); audio.dispose();
  assert.equal(ctx.state, 'closed');
  assert.equal(await audio.unlock(), false);
});

test('audio: sin API, almacenamiento bloqueado o resume rechazado la partida puede continuar', async () => {
  const noApi = setup({ AudioContext: null }).audio;
  assert.equal(noApi.settings.available, false);
  assert.equal(await noApi.unlock(), false); noApi.dispose();
  const blocked = setup({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); } } }).audio;
  blocked.setMuted(true); blocked.setVolume(0.5); blocked.dispose();
  const malformed = setup({ storage: storage('{oops') }).audio;
  assert.equal(malformed.settings.volume, 0.65); malformed.dispose();
  class Rejected extends Context { async resume() { throw Error('blocked'); } }
  const rejected = setup({ AudioContext: Rejected }).audio;
  assert.equal(await rejected.unlock(), false);
  assert.equal(rejected.play('launch'), false); rejected.dispose();
});
