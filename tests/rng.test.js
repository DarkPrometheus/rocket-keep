// Tests del generador con semilla y de la matemática determinista.
// Los valores "de referencia" fijan el comportamiento: si cambian, las
// partidas guardadas o entre versiones dejarían de coincidir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, createRng, mixSeeds, hashString } from '../game/rng.js';
import { dsin, dcos, degToRad, WORLD } from '../game/world.js';
import { MAPS, mapGround, terrainY } from '../game/maps.js';

test('mulberry32 da siempre la misma secuencia para una semilla', () => {
  const n = mulberry32(12345);
  assert.deepEqual([n(), n(), n()], [0.9797282677609473, 0.3067522644996643, 0.484205421525985]);
});

test('dos generadores con la misma semilla son idénticos; con otra, no', () => {
  const a = createRng(777), b = createRng(777), c = createRng(778);
  const seqA = Array.from({ length: 50 }, () => a.int(0, 1_000_000));
  const seqB = Array.from({ length: 50 }, () => b.int(0, 1_000_000));
  const seqC = Array.from({ length: 50 }, () => c.int(0, 1_000_000));
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
});

test('createRng: valores de referencia y rangos', () => {
  const r = createRng(99);
  assert.deepEqual([r.int(0, 100), r.int(0, 100), r.int(0, 100)], [26, 81, 54]);
  const q = createRng(5);
  for (let i = 0; i < 1000; i++) {
    const v = q.int(-3, 3);
    assert.ok(Number.isInteger(v) && v >= -3 && v <= 3);
  }
});

test('weighted respeta los pesos (aprox.) y es determinista', () => {
  const items = [{ k: 'a', weight: 1 }, { k: 'b', weight: 3 }];
  const r = createRng(1);
  let b = 0;
  for (let i = 0; i < 4000; i++) if (r.weighted(items).k === 'b') b++;
  assert.ok(b > 2800 && b < 3200, `b=${b}`);
});

test('hashes de referencia', () => {
  assert.equal(mixSeeds(1, 2, 3), 2034659765);
  assert.equal(hashString('rocket'), 'e67c0055');
});

test('dsin/dcos se parecen a Math.sin/cos (error < 1e-9)', () => {
  for (let d = -720; d <= 720; d += 0.5) {
    const x = degToRad(d);
    assert.ok(Math.abs(dsin(x) - Math.sin(x)) < 1e-9, `sin ${d}°`);
    assert.ok(Math.abs(dcos(x) - Math.cos(x)) < 1e-9, `cos ${d}°`);
  }
});

test('el terreno de cada mapa es simétrico y coincide con su polilínea', () => {
  for (const map of Object.values(MAPS)) {
    // Los extremos de la polilínea coinciden con el suelo; los interiores, con su punto.
    for (const [x, y] of map.terrain.slice(1, -1)) assert.equal(terrainY(mapGround(map), x), y, `${map.id} x=${x}`);
    for (let x = 0; x <= WORLD.width; x += 7) {
      assert.equal(terrainY(mapGround(map), x), terrainY(mapGround(map), WORLD.width - x), `${map.id} x=${x}`);
    }
  }
});

test('los obstáculos de cada mapa son simétricos', () => {
  for (const map of Object.values(MAPS)) {
    const key = (b) => JSON.stringify(b.pts.map(([x, y]) => [x, y]).sort((a, c) => a[0] - c[0] || a[1] - c[1]));
    const mirrored = (b) => JSON.stringify(b.pts.map(([x, y]) => [WORLD.width - x, y]).sort((a, c) => a[0] - c[0] || a[1] - c[1]));
    const all = new Set(map.blocks.map(key));
    for (const b of map.blocks) assert.ok(all.has(mirrored(b)), `${map.id}: bloque sin su reflejo`);
  }
});
