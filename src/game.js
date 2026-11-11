/*
 * game.js - Logic phòng thi, chấm điểm và chống gian lận phía server.
 *
 * Xếp hạng (thi trong thời gian cố định):
 *   1. Nhiều ký tự đúng hơn xếp trên.
 *   2. Bằng nhau: ai đạt được số ký tự đúng đó sớm hơn xếp trên.
 *   3. Vẫn bằng: ít lỗi chính tả hơn xếp trên.
 *
 * Bảo mật & Chống Auto-Typing / Script ngầm phía Server:
 *   1. Kiểm tra cờ `untrusted` từ client (khi phát hiện Event.isTrusted=false, paste, can thiệp .value).
 *   2. Kiểm tra tốc độ tối đa (`MAX_CPS`) & bước nhảy ký tự (`BURST_ALLOWANCE`).
 *   3. Kiểm tra số lượng phím bấm vật lý (`keyCount`) phải tương xứng với độ dài văn bản gõ.
 *   4. Phân tích sinh trắc học nhịp gõ (Keystroke Dynamics): kiểm tra độ lệch chuẩn của
 *      khoảng cách giữa các phím (flight time `dt`) và thời gian giữ phím (dwell time `dw`)
 *      để chặn các script dùng `setInterval` / `setTimeout` / auto-typer.
 */
'use strict';

const crypto = require('crypto');
const VN = require('../public/js/vn.js');

const COUNTDOWN_MS = 3000;
const GRACE_MS = 1500;
const DURATIONS = [30, 60, 90, 120, 180, 300];
const MAX_CLASS_PLAYERS = 200;

// Ngưỡng chống auto-text / script bơm ký tự phía server:
// 22 ký tự/giây ~ 264 WPM.
const MAX_CPS = 22;
// Số ký tự tối đa có thể tăng thêm trong một khoảng rất ngắn (bù độ trễ mạng).
const BURST_ALLOWANCE = 12;

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sanitizeName(name) {
  return String(name || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function sanitizeSettings(input) {
  const s = input || {};
  const duration = DURATIONS.includes(Number(s.duration)) ? Number(s.duration) : 60;
  const source = ['bank', 'ai', 'custom'].includes(s.source) ? s.source : 'bank';
  return {
    duration,
    source,
    topic: String(s.topic || '').slice(0, 100),
    customText: String(s.customText || '').slice(0, 5000)
  };
}

function stdDev(arr) {
  if (!arr || arr.length < 2) return 999;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * Phân tích mảng nhịp gõ vật lý của người chơi để phát hiện script auto-typing ngầm.
 * Trả về chuỗi lý do nếu phát hiện bot, hoặc null nếu giống người thật.
 */
function detectBotKeystrokes(keyHistory) {
  if (!keyHistory || keyHistory.length < 16) return null;
  const recent = keyHistory.slice(-24);
  const dts = recent.map((k) => k.dt);
  const dws = recent.map((k) => k.dw);

  const avgDt = dts.reduce((a, b) => a + b, 0) / dts.length;
  const sdDt = stdDev(dts);
  const sdDw = stdDev(dws);
  const zeroDwellCount = dws.filter((d) => d <= 2).length;

  // 1. Tốc độ trung bình giữa các phím quá nhanh (< 32ms/phím ~ > 31 phím/giây liên tục)
  if (avgDt < 32) {
    return 'Tốc độ phím cơ học vượt ngưỡng người thật (Auto-typer)';
  }
  // 2. Script bắn keydown + keyup trong cùng 1 tick (dwell time ~ 0ms)
  if (zeroDwellCount >= Math.ceil(recent.length * 0.8)) {
    return 'Phát hiện phím bấm nhân tạo không có thời gian nhấn giữ (Script/Bot)';
  }
  // 3. Nhịp gõ quá đều đặn do chạy vòng lặp setInterval / timer cố định
  if (sdDt < 4.0) {
    return 'Nhịp gõ đều đặn bất thường (nghi vấn chạy script setInterval tự động gõ)';
  }
  // 4. Thời gian nhấn giữ phím (dwell time) cố định nhân tạo
  if (sdDw < 1.5) {
    return 'Thời gian giữ phím cố định bất thường (nghi vấn script tự động gõ)';
  }
  return null;
}

class Room {
  constructor({ code, type, settings }) {
    this.code = code;
    this.type = type; // 'class' | 'duel'
    this.hostToken = randomHex(16);
    this.settings = sanitizeSettings(settings, type);
    this.state = 'lobby'; // lobby | countdown | running | finished
    this.round = 0;
    this.passage = '';
    this.passageSource = '';
    this.target = [];
    this.startAt = 0;
    this.endAt = 0;
    this.players = new Map(); // token -> player
    this.lastActivity = Date.now();
    this.dirty = false;
    this.timers = [];
  }

  get maxPlayers() {
    return this.type === 'duel' ? 2 : MAX_CLASS_PLAYERS;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  /** Thêm hoặc kết nối lại người chơi. Trả về { player } hoặc { error }. */
  join(token, rawName) {
    this.touch();
    if (token && this.players.has(token)) {
      const p = this.players.get(token);
      p.connected = true;
      return { player: p, rejoined: true };
    }
    const name = sanitizeName(rawName);
    if (!name) return { error: 'Vui lòng nhập tên.' };
    if (this.players.size >= this.maxPlayers) {
      return { error: this.type === 'duel' ? 'Phòng đấu đã đủ 2 người.' : 'Phòng đã đầy.' };
    }
    const lower = name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) return { error: 'Tên này đã có người dùng trong phòng, hãy chọn tên khác.' };
    }
    const p = {
      token: randomHex(16),
      id: randomHex(4),
      name,
      connected: true,
      ready: false,
      wins: 0
    };
    resetProgress(p);
    this.players.set(p.token, p);
    this.dirty = true;
    return { player: p };
  }

  remove(token) {
    this.players.delete(token);
    this.dirty = true;
  }

  removeById(id) {
    for (const [token, p] of this.players) {
      if (p.id === id) {
        this.players.delete(token);
        this.dirty = true;
        return p;
      }
    }
    return null;
  }

  /** Bắt đầu vòng mới với đoạn văn đã sinh. */
  begin(passage, source, now = Date.now()) {
    this.clearTimers();
    this.round++;
    this.passage = passage;
    this.passageSource = source;
    this.target = Array.from(VN.canonical(passage));
    this.state = 'countdown';
    this.startAt = now + COUNTDOWN_MS;
    this.endAt = this.startAt + this.settings.duration * 1000;
    for (const p of this.players.values()) {
      resetProgress(p);
      p.ready = false;
    }
    this.dirty = true;
    this.touch();
  }

  /** Cập nhật trạng thái theo thời gian. Trả về true nếu trạng thái thay đổi. */
  tick(now = Date.now()) {
    if (this.state === 'countdown' && now >= this.startAt) {
      this.state = 'running';
      return true;
    }
    return false;
  }

  acceptingInput(now = Date.now()) {
    return (this.state === 'running' || this.state === 'countdown') &&
      now >= this.startAt && now <= this.endAt + GRACE_MS;
  }

  /**
   * Nhận văn bản người chơi đã gõ, kiểm tra chống gian lận và chấm điểm phía server.
   * meta: { untrusted?: boolean, reason?: string, keys?: Array<{dt:number, dw:number, bs?:number}> }
   */
  progress(token, typedRaw, now = Date.now(), meta) {
    const p = this.players.get(token);
    if (!p || !this.acceptingInput(now) || p.finishedMs != null) return null;
    if (this.state === 'countdown') this.state = 'running';

    if (meta && meta.untrusted) {
      p.cheatFlags++;
      p.lastCheatReason = meta.reason || 'Phát hiện thao tác tự động';
      this.dirty = true;
      return { player: p, rejected: true, reason: p.lastCheatReason, revertTo: p.typed };
    }

    const elapsed = Math.max(0, Math.min(now, this.endAt) - this.startAt);
    const typed = Array.from(VN.canonical(String(typedRaw || '').slice(0, this.target.length * 2 + 50)))
      .slice(0, this.target.length);
    const target = this.target;

    // --- 1. Kiểm tra tốc độ & bước nhảy ký tự chống paste / extension auto-fill / auto-typer ---
    const deltaChars = typed.length - p.typedLen;
    const dtSec = Math.max(0.05, (elapsed - p.lastInputMs) / 1000);
    const maxAllowedStep = Math.ceil(dtSec * MAX_CPS) + BURST_ALLOWANCE;
    const totalMaxAllowed = Math.ceil((elapsed / 1000) * MAX_CPS) + BURST_ALLOWANCE;

    if (deltaChars > maxAllowedStep || typed.length > totalMaxAllowed) {
      p.cheatFlags++;
      p.lastCheatReason = 'Tốc độ nhập bất thường (nghi ngờ dán hoặc dùng công cụ tự động gõ)';
      this.dirty = true;
      return { player: p, rejected: true, reason: p.lastCheatReason, revertTo: p.typed };
    }

    // --- 2. Kiểm tra sinh trắc học nhịp gõ vật lý (khi client gửi kèm telemetry `keys`) ---
    if (meta && Array.isArray(meta.keys)) {
      const validKeys = meta.keys
        .slice(0, 120)
        .filter((k) => k && typeof k.dt === 'number' && typeof k.dw === 'number' && isFinite(k.dt) && isFinite(k.dw));

      // Nếu văn bản tăng thêm >= 6 ký tự nhưng tổng số phím vật lý gửi lên quá ít -> bơm gói tin trực tiếp qua Socket
      const nextKeyCount = p.keyCount + validKeys.length;
      if (deltaChars > 0 && typed.length >= 6 && nextKeyCount < Math.floor(typed.length * 0.6)) {
        p.cheatFlags++;
        p.lastCheatReason = 'Phát hiện gửi văn bản tự động không qua sự kiện bàn phím vật lý';
        this.dirty = true;
        return { player: p, rejected: true, reason: p.lastCheatReason, revertTo: p.typed };
      }

      const candidateHistory = p.keyHistory.concat(validKeys).slice(-60);
      const botReason = detectBotKeystrokes(candidateHistory);
      if (botReason) {
        p.cheatFlags++;
        p.lastCheatReason = botReason;
        this.dirty = true;
        return { player: p, rejected: true, reason: botReason, revertTo: p.typed };
      }

      p.keyCount = nextKeyCount;
      p.keyHistory = candidateHistory;
    }

    p.lastInputMs = elapsed;

    let correct = 0;
    for (let i = 0; i < typed.length; i++) if (typed[i] === target[i]) correct++;

    // Chỉ tính lỗi chính tả ở những từ đã gõ xong (đã có dấu cách phía sau)
    const complete = typed.length === target.length;
    const committed = complete ? typed.length : typed.lastIndexOf(' ') + 1;
    for (let i = 0; i < committed; i++) {
      if (typed[i] !== target[i] && !p.wrongMarked.has(i)) {
        p.wrongMarked.add(i);
        p.mistakes++;
      }
    }

    if (correct !== p.correct) p.lastChangeMs = elapsed;
    p.correct = correct;
    p.typedLen = typed.length;
    p.currentErrors = typed.length - correct;
    p.typed = typed.join('');
    if (complete && correct === target.length) p.finishedMs = elapsed;
    this.dirty = true;
    this.touch();
    return { player: p, rejected: false };
  }

  allFinished() {
    if (this.players.size === 0) return false;
    for (const p of this.players.values()) {
      if (p.connected && p.finishedMs == null) return false;
    }
    return true;
  }

  finish() {
    this.clearTimers();
    this.state = 'finished';
    this.dirty = true;
    const ranking = this.standings();
    if (this.type === 'duel' && ranking.length === 2 && ranking[0].correct > 0) {
      const a = ranking[0], b = ranking[1];
      const tie = a.correct === b.correct && a.timeMs === b.timeMs && a.mistakes === b.mistakes;
      if (!tie) {
        for (const p of this.players.values()) if (p.id === a.id) p.wins++;
        ranking[0].wins++;
      }
    }
    return ranking;
  }

  elapsedMs(now = Date.now()) {
    if (this.state === 'lobby' || now < this.startAt) return 0;
    return Math.min(now, this.endAt) - this.startAt;
  }

  /** Bảng xếp hạng (dữ liệu công khai, không lộ token). */
  standings(now = Date.now()) {
    const total = this.target.length || 1;
    const roomElapsed = this.state === 'finished' ? this.settings.duration * 1000 : this.elapsedMs(now);
    const list = Array.from(this.players.values()).map((p) => {
      const elapsed = p.finishedMs != null ? p.finishedMs : roomElapsed;
      const minutes = elapsed / 60000;
      return {
        id: p.id,
        name: p.name,
        connected: p.connected,
        ready: p.ready,
        wins: p.wins,
        correct: p.correct,
        typedLen: p.typedLen,
        mistakes: p.mistakes,
        currentErrors: p.currentErrors,
        cheatFlags: p.cheatFlags || 0,
        progress: Math.round((p.typedLen / total) * 1000) / 10,
        wpm: minutes > 0.02 ? Math.round(p.correct / 5 / minutes) : 0,
        accuracy: p.correct + p.mistakes > 0 ? Math.round((p.correct / (p.correct + p.mistakes)) * 1000) / 10 : 100,
        finished: p.finishedMs != null,
        timeMs: p.finishedMs != null ? p.finishedMs : p.lastChangeMs
      };
    });
    list.sort((a, b) =>
      b.correct - a.correct ||
      a.timeMs - b.timeMs ||
      a.mistakes - b.mistakes ||
      a.name.localeCompare(b.name, 'vi'));
    let rank = 0;
    list.forEach((p, i) => {
      const prev = list[i - 1];
      if (!prev || prev.correct !== p.correct || prev.timeMs !== p.timeMs || prev.mistakes !== p.mistakes) rank = i + 1;
      p.rank = rank;
    });
    return list;
  }

  /** Trạng thái phòng gửi cho client. */
  snapshot(now = Date.now()) {
    return {
      code: this.code,
      type: this.type,
      state: this.state,
      round: this.round,
      settings: {
        duration: this.settings.duration,
        source: this.settings.source,
        topic: this.settings.topic
      },
      passage: this.state === 'lobby' ? '' : this.passage,
      passageSource: this.passageSource,
      startsInMs: this.state === 'countdown' ? Math.max(0, this.startAt - now) : 0,
      remainingMs: this.state === 'running' || this.state === 'countdown'
        ? Math.max(0, this.endAt - Math.max(now, this.startAt))
        : 0,
      durationMs: this.settings.duration * 1000,
      standings: this.standings(now)
    };
  }
}

function resetProgress(p) {
  p.typed = '';
  p.correct = 0;
  p.typedLen = 0;
  p.currentErrors = 0;
  p.mistakes = 0;
  p.wrongMarked = new Set();
  p.lastChangeMs = 0;
  p.lastInputMs = 0;
  p.finishedMs = null;
  p.cheatFlags = 0;
  p.lastCheatReason = '';
  p.keyCount = 0;
  p.keyHistory = [];
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  newCode(type) {
    for (let i = 0; i < 1000; i++) {
      const code = type === 'duel'
        ? String(Math.floor(10000 + Math.random() * 90000))
        : String(Math.floor(100000 + Math.random() * 900000));
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Không tạo được mã phòng');
  }

  create(type, settings) {
    const room = new Room({ code: this.newCode(type), type, settings });
    this.rooms.set(room.code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').trim());
  }

  delete(code) {
    const r = this.rooms.get(code);
    if (r) r.clearTimers();
    this.rooms.delete(code);
  }

  sweep(maxIdleMs, now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (now - room.lastActivity > maxIdleMs) this.delete(code);
    }
  }
}

module.exports = {
  Room,
  RoomManager,
  sanitizeName,
  sanitizeSettings,
   detectBotKeystrokes,
  COUNTDOWN_MS,
  GRACE_MS,
  DURATIONS,
  MAX_CPS,
  BURST_ALLOWANCE
};
