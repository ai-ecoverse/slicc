#!/usr/bin/env jsh




















const computer = require('sliccy:computer');

const WIDTH = 640;
const HEIGHT = 400;
const MARKER_R = 12;
const MARKER_R2 = MARKER_R * MARKER_R;

const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '#': ['01010', '11111', '01010', '11111', '01010', '01010', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

const THEMES = [
  { bg: [26, 31, 46], bar: [18, 21, 31] },
  { bg: [72, 24, 48], bar: [48, 16, 32] },
  { bg: [16, 48, 40], bar: [10, 32, 28] },
];
const HOME_X = 320;
const HOME_Y = 200;
const BACK_X = 48;
const BACK_Y = 352;

let seq = 0;
let last = '';
let lastX = 0;
let lastY = 0;
let hasPointer = false;
let themeIndex = 0;
let busy = false;

function rgbCss(rgb) {
  return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
}

function applySoftKey(keysym) {
  if (keysym === 'Home') {
    lastX = HOME_X;
    lastY = HOME_Y;
    hasPointer = true;
    themeIndex = 0;
    return;
  }
  if (keysym === 'Escape' || keysym === 'Back') {
    lastX = BACK_X;
    lastY = BACK_Y;
    hasPointer = true;
    return;
  }
  if (keysym === 'Menu') {
    themeIndex = (themeIndex + 1) % THEMES.length;
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n | 0));
}

function clockString() {
  return new Date().toISOString().slice(11, 19);
}

function paintCanvas(ctx) {
  const theme = THEMES[themeIndex];
  ctx.fillStyle = rgbCss(theme.bg);
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = rgbCss(theme.bar);
  ctx.fillRect(0, 0, WIDTH, 40);
  ctx.fillStyle = '#c8d0e0';
  ctx.font = '16px ui-monospace, monospace';
  ctx.fillText(clockString(), 12, 26);
  ctx.fillStyle = '#9ad17e';
  ctx.fillText('#' + seq, 12, 64);
  if (!hasPointer) return;
  ctx.strokeStyle = '#f5c518';
  ctx.fillStyle = 'rgba(245, 197, 24, 0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(lastX, lastY, MARKER_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(lastX - 18, lastY);
  ctx.lineTo(lastX + 18, lastY);
  ctx.moveTo(lastX, lastY - 18);
  ctx.lineTo(lastX, lastY + 18);
  ctx.stroke();
}

function plot(rgb, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const i = (y * WIDTH + x) * 3;
  rgb[i] = r;
  rgb[i + 1] = g;
  rgb[i + 2] = b;
}

function fillRect(rgb, x, y, w, h, r, g, b) {
  const x0 = clamp(x, 0, WIDTH);
  const y0 = clamp(y, 0, HEIGHT);
  const x1 = clamp(x + w, 0, WIDTH);
  const y1 = clamp(y + h, 0, HEIGHT);
  for (let yy = y0; yy < y1; yy++) {
    let i = (yy * WIDTH + x0) * 3;
    for (let xx = x0; xx < x1; xx++) {
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
      i += 3;
    }
  }
}

function drawGlyph(rgb, originX, originY, ch, scale, r, g, b) {
  const rows = FONT[ch];
  if (!rows) return 5 * scale + 2;
  for (let row = 0; row < rows.length; row++) {
    const bits = rows[row];
    for (let col = 0; col < bits.length; col++) {
      if (bits[col] !== '1') continue;
      fillRect(rgb, originX + col * scale, originY + row * scale, scale, scale, r, g, b);
    }
  }
  return 5 * scale + 2;
}

function drawString(rgb, x, y, text, scale, r, g, b) {
  let cx = x;
  for (const ch of text) cx += drawGlyph(rgb, cx, y, ch, scale, r, g, b);
}

function paintRgb(rgb) {
  const theme = THEMES[themeIndex];
  fillRect(rgb, 0, 0, WIDTH, HEIGHT, theme.bg[0], theme.bg[1], theme.bg[2]);
  fillRect(rgb, 0, 0, WIDTH, 40, theme.bar[0], theme.bar[1], theme.bar[2]);
  drawString(rgb, 12, 12, clockString(), 2, 200, 208, 224);
  drawString(rgb, 12, 52, '#' + String(seq), 3, 154, 209, 126);
  if (!hasPointer) return;
  for (let dy = -MARKER_R; dy <= MARKER_R; dy++) {
    for (let dx = -MARKER_R; dx <= MARKER_R; dx++) {
      if (dx * dx + dy * dy <= MARKER_R2) plot(rgb, lastX + dx, lastY + dy, 245, 197, 24);
    }
  }
  fillRect(rgb, lastX - 18, lastY - 1, 37, 3, 245, 197, 24);
  fillRect(rgb, lastX - 1, lastY - 18, 3, 37, 245, 197, 24);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(data) {
  let crc = ~0 >>> 0;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  return ~crc >>> 0;
}

function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a += data[i];
    if (a >= 65521) a -= 65521;
    b += a;
    if (b >= 65521) b -= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function be32(n) {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function chunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const payload = concat([typeBytes, data]);
  return concat([be32(data.length), payload, be32(crc32(payload))]);
}

function zlibStore(raw) {
  const pieces = [Uint8Array.of(0x78, 0x01)];
  for (let i = 0; i < raw.length; i += 65535) {
    const slice = raw.subarray(i, Math.min(i + 65535, raw.length));
    const last = i + slice.length >= raw.length ? 0x01 : 0x00;
    const len = slice.length;
    const nlen = len ^ 0xffff;
    pieces.push(
      Uint8Array.of(last, len & 0xff, (len >>> 8) & 0xff, nlen & 0xff, (nlen >>> 8) & 0xff),
      slice
    );
  }
  pieces.push(be32(adler32(raw)));
  return concat(pieces);
}

function encodePngRgb(rgb) {
  const raw = new Uint8Array(HEIGHT * (1 + WIDTH * 3));
  for (let y = 0; y < HEIGHT; y++) {
    const dest = y * (1 + WIDTH * 3);
    raw[dest] = 0;
    raw.set(rgb.subarray(y * WIDTH * 3, (y + 1) * WIDTH * 3), dest + 1);
  }
  const ihdr = concat([
    be32(WIDTH),
    be32(HEIGHT),
    Uint8Array.of(8, 2, 0, 0, 0),
  ]);
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStore(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

async function encodeJpeg() {
  if (typeof OffscreenCanvas !== 'function') return null;
  try {
    const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    paintCanvas(ctx);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    if (!blob || blob.size < 32) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

async function nextFrame() {
  seq += 1;
  const jpeg = await encodeJpeg();
  if (jpeg) return { seq, mime: 'image/jpeg', width: WIDTH, height: HEIGHT, bytes: jpeg };
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  paintRgb(rgb);
  return { seq, mime: 'image/png', width: WIDTH, height: HEIGHT, bytes: encodePngRgb(rgb) };
}

function rememberPointer(event) {
  if (typeof event.x !== 'number' || typeof event.y !== 'number') return;
  lastX = clamp(event.x, 0, WIDTH - 1);
  lastY = clamp(event.y, 0, HEIGHT - 1);
  hasPointer = true;
}

computer.register({
  id: 'jsh:fake',
  title: 'fake',
  size: { width: WIDTH, height: HEIGHT },
  capabilities: {
    screenshot: true,
    text: true,
    frames: 'push',
    keyboard: true,
    mouse: 'absolute',
    scroll: false,
    exec: false,
    inputAllowed: true,
  },
  softKeys: [
    { label: 'Home', keysym: 'Home' },
    { label: 'Back', keysym: 'Escape' },
    { label: 'Menu', keysym: 'Menu' },
  ],
  async screenshot() {
    return nextFrame();
  },
  subscribe(fps, onFrame) {
    const push = () => {
      if (busy) return;
      busy = true;
      nextFrame()
        .then((frame) => onFrame(frame))
        .finally(() => {
          busy = false;
        });
    };
    push();
    const ms = Math.max(50, Math.round(1000 / Math.max(1, fps)));
    const timer = setInterval(push, ms);
    return () => clearInterval(timer);
  },
  async text() {
    const pointer = hasPointer ? `pointer ${lastX},${lastY}` : 'pointer none';
    return last ? `${last}\n${pointer}` : pointer;
  },
  async input(events) {
    for (const event of events) {
      if (event.type === 'text') last += event.text;
      if (event.type === 'key') {
        last += `[${event.keysym}]`;
        applySoftKey(event.keysym);
      }
      if (event.type === 'click') {
        rememberPointer(event);
        last += `[click ${event.x},${event.y}]`;
      }
      if (event.type === 'mousemove' || event.type === 'button') rememberPointer(event);
      if (event.type === 'drag' && event.to) rememberPointer(event.to);
    }
  },
});
