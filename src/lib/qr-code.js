// QR Code encoder (byte mode, versions 1-40, ECC L/M/Q/H), written from the
// ISO/IEC 18004 structure with the RS-block and alignment-position tables
// taken from Kazuhiko Arase's MIT-licensed qrcode-generator (v1.4.4).
// Kept dependency-free so the toolbox stays at zero new packages.

// --- GF(256), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D) ---
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly; // length degree + 1, leading coefficient 1
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const res = new Uint8Array(degree);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[degree - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < degree; j += 1) res[j] ^= gmul(gen[j + 1], factor);
    }
  }
  return res;
}

// --- Tables (RS: per version, L/M/Q/H, flat triples count/total/data) ---
const RS_TABLE = [
  [[1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9]],
  [[1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16]],
  [[1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13]],
  [[1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9]],
  [[1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12]],
  [[2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15]],
  [[2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14]],
  [[2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15]],
  [[2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13]],
  [[2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16]],
  [[4, 101, 81], [1, 80, 50, 4, 81, 51], [4, 50, 22, 4, 51, 23], [3, 36, 12, 8, 37, 13]],
  [[2, 116, 92, 2, 117, 93], [6, 58, 36, 2, 59, 37], [4, 46, 20, 6, 47, 21], [7, 42, 14, 4, 43, 15]],
  [[4, 133, 107], [8, 59, 37, 1, 60, 38], [8, 44, 20, 4, 45, 21], [12, 33, 11, 4, 34, 12]],
  [[3, 145, 115, 1, 146, 116], [4, 64, 40, 5, 65, 41], [11, 36, 16, 5, 37, 17], [11, 36, 12, 5, 37, 13]],
  [[5, 109, 87, 1, 110, 88], [5, 65, 41, 5, 66, 42], [5, 54, 24, 7, 55, 25], [11, 36, 12, 7, 37, 13]],
  [[5, 122, 98, 1, 123, 99], [7, 73, 45, 3, 74, 46], [15, 43, 19, 2, 44, 20], [3, 45, 15, 13, 46, 16]],
  [[1, 135, 107, 5, 136, 108], [10, 74, 46, 1, 75, 47], [1, 50, 22, 15, 51, 23], [2, 42, 14, 17, 43, 15]],
  [[5, 150, 120, 1, 151, 121], [9, 69, 43, 4, 70, 44], [17, 50, 22, 1, 51, 23], [2, 42, 14, 19, 43, 15]],
  [[3, 141, 113, 4, 142, 114], [3, 70, 44, 11, 71, 45], [17, 47, 21, 4, 48, 22], [9, 39, 13, 16, 40, 14]],
  [[3, 135, 107, 5, 136, 108], [3, 67, 41, 13, 68, 42], [15, 54, 24, 5, 55, 25], [15, 43, 15, 10, 44, 16]],
  [[4, 144, 116, 4, 145, 117], [17, 68, 42], [17, 50, 22, 6, 51, 23], [19, 46, 16, 6, 47, 17]],
  [[2, 139, 111, 7, 140, 112], [17, 74, 46], [7, 54, 24, 16, 55, 25], [34, 37, 13]],
  [[4, 151, 121, 5, 152, 122], [4, 75, 47, 14, 76, 48], [11, 54, 24, 14, 55, 25], [16, 45, 15, 14, 46, 16]],
  [[6, 147, 117, 4, 148, 118], [6, 73, 45, 14, 74, 46], [11, 54, 24, 16, 55, 25], [30, 46, 16, 2, 47, 17]],
  [[8, 132, 106, 4, 133, 107], [8, 75, 47, 13, 76, 48], [7, 54, 24, 22, 55, 25], [22, 45, 15, 13, 46, 16]],
  [[10, 142, 114, 2, 143, 115], [19, 74, 46, 4, 75, 47], [28, 50, 22, 6, 51, 23], [33, 46, 16, 4, 47, 17]],
  [[8, 152, 122, 4, 153, 123], [22, 73, 45, 3, 74, 46], [8, 53, 23, 26, 54, 24], [12, 45, 15, 28, 46, 16]],
  [[3, 147, 117, 10, 148, 118], [3, 73, 45, 23, 74, 46], [4, 54, 24, 31, 55, 25], [11, 45, 15, 31, 46, 16]],
  [[7, 146, 116, 7, 147, 117], [21, 73, 45, 7, 74, 46], [1, 53, 23, 37, 54, 24], [19, 45, 15, 26, 46, 16]],
  [[5, 145, 115, 10, 146, 116], [19, 75, 47, 10, 76, 48], [15, 54, 24, 25, 55, 25], [23, 45, 15, 25, 46, 16]],
  [[13, 145, 115, 3, 146, 116], [2, 74, 46, 29, 75, 47], [42, 54, 24, 1, 55, 25], [23, 45, 15, 28, 46, 16]],
  [[17, 145, 115], [10, 74, 46, 23, 75, 47], [10, 54, 24, 35, 55, 25], [19, 45, 15, 35, 46, 16]],
  [[17, 145, 115, 1, 146, 116], [14, 74, 46, 21, 75, 47], [29, 54, 24, 19, 55, 25], [11, 45, 15, 46, 46, 16]],
  [[13, 145, 115, 6, 146, 116], [14, 74, 46, 23, 75, 47], [44, 54, 24, 7, 55, 25], [59, 46, 16, 1, 47, 17]],
  [[12, 151, 121, 7, 152, 122], [12, 75, 47, 26, 76, 48], [39, 54, 24, 14, 55, 25], [22, 45, 15, 41, 46, 16]],
  [[6, 151, 121, 14, 152, 122], [6, 75, 47, 34, 76, 48], [46, 54, 24, 10, 55, 25], [2, 45, 15, 64, 46, 16]],
  [[17, 152, 122, 4, 153, 123], [29, 74, 46, 14, 75, 47], [49, 54, 24, 10, 55, 25], [24, 45, 15, 46, 46, 16]],
  [[4, 152, 122, 18, 153, 123], [13, 74, 46, 32, 75, 47], [48, 54, 24, 14, 55, 25], [42, 45, 15, 32, 46, 16]],
  [[20, 147, 117, 4, 148, 118], [40, 75, 47, 7, 76, 48], [43, 54, 24, 22, 55, 25], [10, 45, 15, 67, 46, 16]],
  [[19, 148, 118, 6, 149, 119], [18, 75, 47, 31, 76, 48], [34, 54, 24, 34, 55, 25], [20, 45, 15, 61, 46, 16]],
];

const ALIGN_POSITIONS = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
  [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

export const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

// Total codewords per version, from the symbol's module count minus the
// function patterns — the table above must sum to these.
export const TOTAL_CODEWORDS = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655,
  733, 815, 901, 991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921,
  2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];

export function rsBlocksFor(version, ecl) {
  const flat = RS_TABLE[version - 1][ECL_INDEX[ecl]];
  const blocks = [];
  for (let i = 0; i < flat.length; i += 3) {
    const [count, totalCount, dataCount] = flat.slice(i, i + 3);
    for (let k = 0; k < count; k += 1) blocks.push({ totalCount, dataCount });
  }
  return blocks;
}

export function dataCapacityBits(version, ecl) {
  return rsBlocksFor(version, ecl).reduce((sum, b) => sum + b.dataCount, 0) * 8;
}

// Byte-mode header: 4 mode bits + 8 count bits (v1-9) or 16 count bits (v10+).
function headerBits(version) {
  return 4 + (version < 10 ? 8 : 16);
}

function buildDataCodewords(bytes, version, ecl) {
  const totalData = dataCapacityBits(version, ecl) / 8;
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = totalData * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i += 1) bits.push(0); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let pad = 0; codewords.length < totalData; pad += 1) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
  }
  return codewords;
}

function interleave(dataCodewords, version, ecl) {
  const blocks = rsBlocksFor(version, ecl);
  const datas = [];
  const ecs = [];
  let offset = 0;
  for (const block of blocks) {
    const data = dataCodewords.slice(offset, offset + block.dataCount);
    offset += block.dataCount;
    datas.push(data);
    ecs.push(rsRemainder(data, block.totalCount - block.dataCount));
  }
  const out = [];
  const maxData = Math.max(...datas.map(d => d.length));
  const maxEc = Math.max(...ecs.map(e => e.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const d of datas) if (i < d.length) out.push(d[i]);
  }
  for (let i = 0; i < maxEc; i += 1) {
    for (const e of ecs) if (i < e.length) out.push(e[i]);
  }
  return out;
}

// --- BCH error protection for format/version information ---
function bchDigit(data) {
  let digit = 0;
  let value = data;
  while (value !== 0) { digit += 1; value >>>= 1; }
  return digit;
}
const G15 = 0x537;
const G18 = 0x1f25;
const G15_MASK = 0x5412;

export function bchTypeInfo(data) {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}

export function bchTypeNumber(data) {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  r => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];

function buildMatrix(version, codewords, ecl, maskIndex) {
  const size = 21 + 4 * (version - 1);
  const m = Array.from({ length: size }, () => new Array(size).fill(null));

  const placeFinder = (row, col) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        m[rr][cc] = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6))
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4) ? 1 : 0;
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(size - 7, 0);
  placeFinder(0, size - 7);

  for (const r of ALIGN_POSITIONS[version - 1]) {
    for (const c of ALIGN_POSITIONS[version - 1]) {
      if (m[r][c] !== null) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i += 1) {
    if (m[6][i] === null) m[6][i] = i % 2 === 0 ? 1 : 0;
    if (m[i][6] === null) m[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // Format information (15 bits, two copies) + the always-dark module.
  const formatBits = bchTypeInfo((ECL_BITS[ecl] << 3) | maskIndex);
  for (let i = 0; i < 15; i += 1) {
    const bit = (formatBits >> i) & 1;
    if (i < 6) m[i][8] = bit;
    else if (i < 8) m[i + 1][8] = bit;
    else m[size - 15 + i][8] = bit;
    if (i < 8) m[8][size - i - 1] = bit;
    else if (i < 9) m[8][7] = bit;
    else m[8][15 - i - 1] = bit;
  }
  m[size - 8][8] = 1;

  if (version >= 7) {
    const versionBits = bchTypeNumber(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = (versionBits >> i) & 1;
      m[Math.floor(i / 3)][(i % 3) + size - 11] = bit;
      m[(i % 3) + size - 11][Math.floor(i / 3)] = bit;
    }
  }

  // Zig-zag data placement, two columns at a time, skipping the timing column.
  const maskFn = MASKS[maskIndex];
  let bitIndex = 7;
  let byteIndex = 0;
  let direction = -1;
  let row = size - 1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        if (m[row][col - c] === null) {
          let dark = 0;
          if (byteIndex < codewords.length) dark = (codewords[byteIndex] >>> bitIndex) & 1;
          if (maskFn(row, col - c)) dark ^= 1;
          m[row][col - c] = dark;
          bitIndex -= 1;
          if (bitIndex === -1) { byteIndex += 1; bitIndex = 7; }
        }
      }
      row += direction;
      if (row < 0 || row >= size) { row -= direction; direction = -direction; break; }
    }
  }
  return m;
}

// ISO 18004 penalty rules N1-N4; lower is better.
function penalty(m) {
  const size = m.length;
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i += 1) {
    lines.push(m[i]);
    lines.push(m.map(row => row[i]));
  }
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) { run += 1; continue; }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    for (let i = 0; i + 10 < size; i += 1) {
      const window = line.slice(i, i + 11).join('');
      if (window === '10111010000' || window === '00001011101') score += 40;
    }
  }
  for (let r = 0; r + 1 < size; r += 1) {
    for (let c = 0; c + 1 < size; c += 1) {
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const cell of row) dark += cell;
  score += (Math.abs((100 * dark) / (size * size) - 50) / 5) * 10;
  return score;
}

export function encodeQr(text, { ecl = 'M' } = {}) {
  if (!ECL_INDEX.hasOwnProperty(ecl)) throw new Error(`纠错级别无效：${ecl}`);
  const bytes = [...new TextEncoder().encode(String(text))];
  let version = 0;
  for (let v = 1; v <= 40; v += 1) {
    if (headerBits(v) + bytes.length * 8 <= dataCapacityBits(v, ecl)) { version = v; break; }
  }
  if (version === 0) {
    const maxBytes = Math.floor((dataCapacityBits(40, ecl) - headerBits(40)) / 8);
    throw new Error(`内容过长：${bytes.length} 字节超出二维码容量（${ecl} 级最多 ${maxBytes} 字节）`);
  }
  const codewords = interleave(buildDataCodewords(bytes, version, ecl), version, ecl);
  let best = null;
  for (let maskIndex = 0; maskIndex < 8; maskIndex += 1) {
    const matrix = buildMatrix(version, codewords, ecl, maskIndex);
    const score = penalty(matrix);
    if (best === null || score < best.score) best = { matrix, score, maskIndex };
  }
  const size = best.matrix.length;
  const modules = new Uint8Array(size * size);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) modules[r * size + c] = best.matrix[r][c];
  }
  return { size, version, ecl, mask: best.maskIndex, modules };
}
