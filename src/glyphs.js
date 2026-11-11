/*
 * glyphs.js - Server tự vẽ đoạn văn thành nét (SVG path), mỗi ký tự được làm méo ngẫu nhiên.
 *
 * Mục đích: không gửi đoạn văn dưới dạng chữ qua mạng/DOM. Client chỉ nhận các nét vẽ
 * (path) đã được biến dạng ngẫu nhiên theo từng lần gửi, nên không thể đọc chữ trực tiếp
 * từ tab Network của DevTools hoặc từ một script tự kết nối socket.
 * Muốn lấy chữ thì phải OCR, khó hơn nhiều so với đọc chuỗi JSON.
 *
 * Font: Noto Sans Mono (SIL Open Font License) - assets/fonts/NotoSansMono-Regular.ttf
 */
'use strict';

const path = require('path');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansMono-Regular.ttf');
const SIZE = 22;      // cỡ chữ (px, toạ độ ảo)
const LINE_H = 40;    // chiều cao mỗi dòng (đủ chỗ cho dấu tiếng Việt chồng trên chữ hoa)
const BASELINE = 29;  // vị trí đường chân chữ trong mỗi ô
const COLS = 48;      // số cột tối đa mỗi dòng (font đơn cách nên mỗi ký tự rộng bằng nhau)
const SCALE = 4;      // toạ độ gửi đi được nhân 4 rồi làm tròn thành số nguyên cho gọn

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

/** Nét vẽ của một ký tự, có xoay/co giãn/dịch chuyển và nhiễu điểm ngẫu nhiên. */
function jitteredPath(ch) {
  const cmds = baseCommands(ch);
  if (!cmds.length) return '';
  const r = Math.random;
  const ang = (r() - 0.5) * 0.05;            // xoay khoảng ±1.4°
  const sc = 0.97 + r() * 0.06;              // co giãn 97% - 103%
  const tx = (r() - 0.5) * 1.0;
  const ty = (r() - 0.5) * 1.0;
  const cx = ADV / 2;
  const cy = LINE_H / 2;
  const cos = Math.cos(ang) * sc;
  const sin = Math.sin(ang) * sc;
  const NOISE = 0.35;
  const tf = (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const nx = cx + dx * cos - dy * sin + tx + (r() - 0.5) * 2 * NOISE;
    const ny = cy + dx * sin + dy * cos + ty + (r() - 0.5) * 2 * NOISE;
    return Math.round(nx * SCALE) + ' ' + Math.round(ny * SCALE);
  };
  let d = '';
  for (const c of cmds) {
    switch (c.type) {
      case 'M': d += 'M' + tf(c.x, c.y); break;
      case 'L': d += 'L' + tf(c.x, c.y); break;
      case 'Q': d += 'Q' + tf(c.x1, c.y1) + ' ' + tf(c.x, c.y); break;
      case 'C': d += 'C' + tf(c.x1, c.y1) + ' ' + tf(c.x2, c.y2) + ' ' + tf(c.x, c.y); break;
      case 'Z': d += 'Z'; break;
      default: break;
    }
  }
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
      if (br > start) end = br + 1; // giữ dấu cách ở cuối dòng
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

module.exports = { metrics, layoutGrid, glyphsForRows, hasGlyph, jitteredPath, COLS };
