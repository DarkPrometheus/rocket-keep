// =============================================================
// qr.js — Generador de códigos QR mínimo (sin dependencias).
//
// Solo lo necesario para el enlace de invitación: modo byte (UTF-8),
// corrección de errores nivel M y versiones 1–10 (hasta ~210 bytes).
// Sigue el estándar ISO/IEC 18004: datos + Reed-Solomon, patrones fijos,
// máscara y bits de formato/versión.
//
//   qrMatrix(text) → boolean[][]   true = módulo oscuro, [fila][columna]
//   drawQR(canvas, text, { scale, margin })
// =============================================================

// Nivel M: codewords de corrección por bloque y número de bloques (versiones 1–10).
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ECL_BITS_M = 0; // L=1, M=0, Q=3, H=2

/** Módulos disponibles para datos y corrección en una versión. */
function rawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

const dataCodewords = (ver) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

// ---------- Reed-Solomon en GF(256) ----------

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < degree) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ r.shift();
    r.push(0);
    divisor.forEach((c, i) => (r[i] ^= gfMul(c, factor)));
  }
  return r;
}

// ---------- codificación ----------

/** Bytes de datos (con relleno) para el texto en la versión dada, o null si no cabe. */
function encodeData(bytes, ver) {
  const ccBits = ver < 10 ? 8 : 16;
  const cap = dataCodewords(ver) * 8;
  const bits = [];
  const put = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4); // modo byte
  put(bytes.length, ccBits);
  bytes.forEach((b) => put(b, 8));
  if (bits.length > cap) return null;
  put(0, Math.min(4, cap - bits.length)); // terminador
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** Reparte en bloques, añade Reed-Solomon e intercala. */
function addEcc(data, ver) {
  const nBlocks = NUM_BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0); // hueco para igualar longitudes
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= nShort) out.push(b[i]);
    });
  }
  return out;
}

// ---------- matriz ----------

function buildMatrix(ver, codewords, mask) {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    m[y][x] = dark;
    fn[y][x] = true;
  };

  // Patrones de sincronización.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Buscadores (esquinas) con su separador.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  // Patrones de alineación.
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const pos = [6];
    for (let i = 0; i < n - 1; i++) pos.splice(1, 0, size - 7 - i * step);
    pos.forEach((y, i) => pos.forEach((x, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
  }
  // Bits de formato (nivel + máscara) en sus dos copias, y el módulo oscuro fijo.
  const data = (ECL_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const fmt = ((data << 10) | rem) ^ 0x5412;
  const fb = (i) => ((fmt >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, fb(i));
  set(8, 7, fb(6));
  set(8, 8, fb(7));
  set(7, 8, fb(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, fb(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, fb(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, fb(i));
  set(8, size - 8, true);
  // Información de versión (versión 7 en adelante).
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const vb = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      const bit = ((vb >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }
  // Datos en zigzag por columnas de dos, de abajo arriba y de arriba abajo.
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - v : v;
        if (!fn[y][x] && bit < codewords.length * 8) {
          m[y][x] = ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
          bit++;
        }
      }
    }
  }
  // Máscara (solo sobre datos).
  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
  return m;
}

/** Penalización simplificada (rachas, bloques 2×2 y equilibrio) para elegir máscara. */
function penalty(m) {
  const n = m.length;
  let p = 0, dark = 0;
  for (let a = 0; a < n; a++) {
    let runR = 1, runC = 1;
    for (let b = 1; b < n; b++) {
      runR = m[a][b] === m[a][b - 1] ? runR + 1 : 1;
      runC = m[b][a] === m[b - 1][a] ? runC + 1 : 1;
      if (runR === 5) p += 3; else if (runR > 5) p++;
      if (runC === 5) p += 3; else if (runC > 5) p++;
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m[y][x]) dark++;
      if (x < n - 1 && y < n - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    }
  }
  p += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  return p;
}

/** Matriz del QR para un texto (lanza error si no cabe en la versión 10). */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  for (let ver = 1; ver <= 10; ver++) {
    const data = encodeData(bytes, ver);
    if (!data) continue;
    const cw = addEcc(data, ver);
    let best = null, bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = buildMatrix(ver, cw, mask);
      const p = penalty(m);
      if (p < bestP) {
        best = m;
        bestP = p;
      }
    }
    return best;
  }
  throw new Error('Texto demasiado largo para el QR');
}

/** Dibuja el QR en un canvas (negro sobre blanco, con margen de silencio). */
export function drawQR(canvas, text, { scale = 5, margin = 4 } = {}) {
  const m = qrMatrix(text);
  const n = m.length + margin * 2;
  canvas.width = canvas.height = n * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  m.forEach((row, y) => row.forEach((dark, x) => dark && ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale)));
}
