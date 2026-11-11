/*
 * glyphs.js - Server tự vẽ đoạn văn thành nét cong đa hình (Polymorphic SVG Cubic Paths).
 *
 * Bảo mật chống dịch ngược (Anti-Reverse-Engineering):
 *  1. Không gửi đoạn văn dưới dạng chữ qua mạng/DOM.
 *  2. Chuyển toàn bộ các đoạn thẳng (L) và đường cong bậc hai (Q) về đường cong bậc ba (C).
 *  3. Chia nhỏ ngẫu nhiên (De Casteljau random subdivision) các đoạn cong và chèn thêm
 *     các nét vi mô vô hình (micro-decoys) để mỗi lần xuất hiện của cùng một chữ cái
 *     có số lượng lệnh M/C/Z và độ dài chuỗi khác nhau hoàn toàn -> Không thể lập bảng
 *     ánh xạ (hash/signature lookup) để dịch ngược từ SVG path ra chữ cái.
 *
 * Font: Noto Sans Mono (SIL Open Font License) - assets/fonts/NotoSansMono-Regular.ttf
 */
'use strict';

const path = require('path');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansMono-Regular.ttf');
const SIZE = 22;      // cỡ chữ (px, toạ độ ảo)
const LINE_H = 40;    // chiều cao mỗi dòng (đủ chỗ cho dấu tiếng Việt chồng trên chữ hoa)
const BASELINE = 29;  // vị trí đường chân chữ trong mỗi ô
const COLS = 48;      // số cột tối đa mỗi dòng
const SCALE = 4;      // toạ độ gửi đi được nhân 4 rồi làm tròn thành số nguyên

let font = null;
let ADV = 13.2;
const cache = new Map(); // ký tự -> danh sách lệnh vẽ gốc

function loadFont() {
  if (font) return font;
  const opentype = require('opentype.js');
  font = opentype.loadSync(FONT_PATH);
  const m = font.charToGlyph('M');
  ADV = (m.advanceWidth * SIZE) / font.unitsPerEm;
  return font;
}

function metrics() {
  loadFont();
  return { cols: COLS, adv: ADV, lineH: LINE_H, baseline: BASELINE, size: SIZE, scale: SCALE };
}

function hasGlyph(ch) {
  loadFont();
  const g = font.charToGlyph(ch);
  return !!g && g.index !== 0;
}

function baseCommands(ch) {
  if (cache.has(ch)) return cache.get(ch);
  loadFont();
  let g = font.charToGlyph(ch);
  if (!g || g.index === 0) g = font.charToGlyph('?');
  const cmds = g.getPath(0, BASELINE, SIZE).commands;
  cache.set(ch, cmds);
  return cmds;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Chia 1 đường cong Cubic Bézier thành 2 đường cong nối tiếp tại tham số t (De Casteljau) */
function splitCubic(x0, y0, x1, y1, x2, y2, x3, y3, t) {
  const x01 = lerp(x0, x1, t), y01 = lerp(y0, y1, t);
  const x12 = lerp(x1, x2, t), y12 = lerp(y1, y2, t);
  const x23 = lerp(x2, x3, t), y23 = lerp(y2, y3, t);
  const x012 = lerp(x01, x12, t), y012 = lerp(y01, y12, t);
  const x123 = lerp(x12, x23, t), y123 = lerp(y12, y23, t);
  const xm = lerp(x012, x123, t), ym = lerp(y012, y123, t);
  return [
    [x01, y01, x012, y012, xm, ym],
    [x123, y123, x23, y23, x3, y3]
  ];
}

/**
 * Nét vẽ đa hình của một ký tự:
 * - Xoay/co giãn/dịch chuyển + nhiễu toạ độ.
 * - Quy đổi tất cả L, Q về C (Cubic Bézier).
 * - Chia nhỏ ngẫu nhiên đoạn cong + chèn subpaths vi mô để phá vỡ mọi chữ ký hình học (signature).
 */
function jitteredPath(ch) {
  const cmds = baseCommands(ch);
  if (!cmds.length) return '';
  const r = Math.random;
  const ang = (r() - 0.5) * 0.055;           // xoay nhẹ
  const sc = 0.96 + r() * 0.08;              // co giãn 96% - 104%
  const tx = (r() - 0.5) * 1.1;
  const ty = (r() - 0.5) * 1.1;
  const cx = ADV / 2;
  const cy = LINE_H / 2;
  const cos = Math.cos(ang) * sc;
  const sin = Math.sin(ang) * sc;
  const NOISE = 0.35;

  const pt = (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const nx = cx + dx * cos - dy * sin + tx + (r() - 0.5) * 2 * NOISE;
    const ny = cy + dx * sin + dy * cos + ty + (r() - 0.5) * 2 * NOISE;
    return [nx, ny];
  };

  const fmt = (x, y) => Math.round(x * SCALE) + ' ' + Math.round(y * SCALE);

  const microDecoy = () => {
    const mx = 2 + r() * (ADV - 4);
    const my = 6 + r() * (LINE_H - 12);
    const p = fmt(mx, my);
    return 'M' + p + 'C' + p + ' ' + p + ' ' + p + 'Z';
  };

  let d = '';
  if (r() < 0.65) d += microDecoy();

  let curX = 0, curY = 0;
  let startX = 0, startY = 0;

  const emitCubic = (x0, y0, x1, y1, x2, y2, x3, y3) => {
    if (r() < 0.45) {
      const t = 0.35 + r() * 0.3;
      const [c1, c2] = splitCubic(x0, y0, x1, y1, x2, y2, x3, y3, t);
      d += 'C' + fmt(c1[0], c1[1]) + ' ' + fmt(c1[2], c1[3]) + ' ' + fmt(c1[4], c1[5]);
      d += 'C' + fmt(c2[0], c2[1]) + ' ' + fmt(c2[2], c2[3]) + ' ' + fmt(c2[4], c2[5]);
    } else {
      d += 'C' + fmt(x1, y1) + ' ' + fmt(x2, y2) + ' ' + fmt(x3, y3);
    }
  };

  for (const c of cmds) {
    switch (c.type) {
      case 'M': {
        const [nx, ny] = pt(c.x, c.y);
        curX = startX = nx;
        curY = startY = ny;
        d += 'M' + fmt(nx, ny);
        break;
      }
      case 'L': {
        const [nx, ny] = pt(c.x, c.y);
        const c1x = lerp(curX, nx, 0.33) + (r() - 0.5) * 0.2;
        const c1y = lerp(curY, ny, 0.33) + (r() - 0.5) * 0.2;
        const c2x = lerp(curX, nx, 0.67) + (r() - 0.5) * 0.2;
        const c2y = lerp(curY, ny, 0.67) + (r() - 0.5) * 0.2;
        emitCubic(curX, curY, c1x, c1y, c2x, c2y, nx, ny);
        curX = nx;
        curY = ny;
        break;
      }
      case 'Q': {
        const [qx, qy] = pt(c.x1, c.y1);
        const [nx, ny] = pt(c.x, c.y);
        const c1x = curX + (2 / 3) * (qx - curX);
        const c1y = curY + (2 / 3) * (qy - curY);
        const c2x = nx + (2 / 3) * (qx - nx);
        const c2y = ny + (2 / 3) * (qy - ny);
        emitCubic(curX, curY, c1x, c1y, c2x, c2y, nx, ny);
        curX = nx;
        curY = ny;
        break;
      }
      case 'C': {
        const [c1x, c1y] = pt(c.x1, c.y1);
        const [c2x, c2y] = pt(c.x2, c.y2);
        const [nx, ny] = pt(c.x, c.y);
        emitCubic(curX, curY, c1x, c1y, c2x, c2y, nx, ny);
        curX = nx;
        curY = ny;
        break;
      }
      case 'Z': {
        curX = startX;
        curY = startY;
        d += 'Z';
        if (r() < 0.35) d += microDecoy();
        break;
      }
      default:
        break;
    }
  }
  if (r() < 0.65) d += microDecoy();
  return d;
}

/** Chia đoạn văn thành các dòng (ngắt ở dấu cách). Trả về [[chỉ số bắt đầu, độ dài], ...] */
function layoutGrid(chars, cols = COLS) {
  const lines = [];
  const n = chars.length;
  let start = 0;
  while (start < n) {
    let end = Math.min(n, start + cols);
    if (end < n) {
      let br = -1;
      for (let i = end; i > start; i--) {
        if (chars[i] === ' ') { br = i; break; }
      }
      if (br > start) end = br + 1;
    }
    lines.push([start, end - start]);
    start = end;
  }
  return lines;
}

/** Nét vẽ cho các ký tự thuộc dòng r0..r1 (bỏ qua dấu cách). */
function glyphsForRows(chars, lines, r0, r1) {
  const out = [];
  for (let r = Math.max(0, r0); r <= r1 && r < lines.length; r++) {
    const [s, len] = lines[r];
    for (let i = s; i < s + len; i++) {
      if (chars[i] !== ' ') out.push([i, jitteredPath(chars[i])]);
    }
  }
  return out;
}

/**
 * Nét vẽ cho cửa sổ ký tự từ chỉ số [fromIdx, toIdx) (Sliding Window Streaming).
 * Mỗi lần gọi sinh ra bộ đường cong đa hình mới.
 */
function glyphsForRange(chars, fromIdx, toIdx) {
  const out = [];
  const start = Math.max(0, fromIdx);
  const end = Math.min(chars.length, toIdx);
  for (let i = start; i < end; i++) {
    if (chars[i] !== ' ') out.push([i, jitteredPath(chars[i])]);
  }
  return out;
}

module.exports = { metrics, layoutGrid, glyphsForRows, glyphsForRange, hasGlyph, jitteredPath, COLS };
