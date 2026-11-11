/*
 * game.js - Logic phòng thi, chấm điểm và chống gian lận phía server.
 *
 * Xếp hạng (thi trong thời gian cố định):
 *   1. Nhiều ký tự đúng hơn xếp trên.
 *   2. Bằng nhau: ai đạt được số ký tự đúng đó sớm hơn xếp trên.
 *   3. Vẫn bằng: ít lỗi chính tả hơn xếp trên.
 *
 * Bảo mật & Chống Auto-Typing / Script ngầm phía Server:
 *   1. KHÔNG gửi đoạn văn dạng chữ (plaintext) xuống trình duyệt sinh viên.
 *      Server chuyển từng ký tự thành đường cong vector biến dạng ngẫu nhiên (SVG Path)
 *      qua `src/glyphs.js` và chỉ gửi khi vòng thi thực sự bước vào trạng thái `running`.
 *   2. Kiểm tra cờ `untrusted` từ client (khi phát hiện Event.isTrusted=false, paste, can thiệp .value).
 *   3. Kiểm tra tốc độ tối đa (`maxWpm` cấu hình theo phòng & `MAX_CPS`) + bước nhảy ký tự (`BURST_ALLOWANCE`).
 *   4. Kiểm tra số lượng phím bấm vật lý (`keyCount`) phải tương xứng với độ dài văn bản gõ.
 *   5. Phân tích sinh trắc học nhịp gõ (Keystroke Dynamics) + nhịp thời gian gói tin đến Server
 *      (Server Packet Arrival Cadence) + tỷ lệ xoá sửa lỗi (Backspace Realism) để phát hiện bot.
 */
'use strict';

const crypto = require('crypto');
const VN = require('../public/js/vn.js');
const glyphs = require('./glyphs');

const COUNTDOWN_MS = 3000;
const GRACE_MS = 1500;
const DURATIONS = [30, 60, 90, 120, 180, 300];
const MAX_CLASS_PLAYERS = 200;

// Ngưỡng chống auto-text / script bơm ký tự phía server:
// 22 ký tự/giây ~ 264 WPM (ngưỡng trần tuyệt đối cho mỗi bước nhảy ngắn).
const MAX_CPS = 22;
// Số ký tự tối đa có thể tăng thêm trong một khoảng rất ngắn (bù độ trễ mạng).
const BURST_ALLOWANCE = 12;
const DEFAULT_MAX_WPM = 130;

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sanitizeName(name) {
  return String(name || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

function parseRoster(raw) {
  const text = String(raw || '').normalize('NFC').slice(0, 8000);
  const items = text
    .split(/[\r\n,;]+/)
    .map((x) => sanitizeName(x).toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(items)).slice(0, 400);
}

function sanitizeSettings(input) {
  const s = input || {};
  const duration = DURATIONS.includes(Number(s.duration)) ? Number(s.duration) : 60;
  const source = ['bank', 'ai', 'custom'].includes(s.source) ? s.source : 'bank';
  const rawMaxWpm = Number(s.maxWpm);
  const maxWpm = Number.isFinite(rawMaxWpm) && rawMaxWpm >= 60 && rawMaxWpm <= 260
    ? Math.round(rawMaxWpm)
    : DEFAULT_MAX_WPM;
  const rosterText = String(s.rosterText || '').slice(0, 8000);
  const roster = parseRoster(rosterText);
  return {
    duration,
    source,
    topic: String(s.topic || '').slice(0, 100),
    customText: String(s.customText || '').slice(0, 5000),
    maxWpm,
    rosterText,
    roster
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

function matchesRoster(lowerName, roster) {
  if (!roster || roster.length === 0) return true;
  for (const entry of roster) {
    if (lowerName === entry) return true;
    // Cho phép khớp nếu danh sách lớp ghi MSSV hoặc "MSSV - Họ tên"
    const parts = entry.split(/\s*[-–|:]\s*/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1 && parts.some((pt) => pt.length >= 3 && (lowerName === pt || lowerName.includes(pt)))) {
      return true;
    }
  }
  return false;
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
    this.glyphPack = null;
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
  join(token, rawName, hasDuplicateActiveSocket = false) {
    this.touch();
    if (token && this.players.has(token)) {
      const p = this.players.get(token);
      if (hasDuplicateActiveSocket) {
        return { error: 'Tài khoản này đang mở ở một tab hoặc thiết bị khác. Hãy đóng tab kia trước.' };
      }
      p.connected = true;
      return { player: p, rejoined: true };
    }
    const name = sanitizeName(rawName);
    if (!name) return { error: 'Vui lòng nhập họ tên / mã sinh viên.' };
    if (this.players.size >= this.maxPlayers) {
      return { error: this.type === 'duel' ? 'Phòng đấu đã đủ 2 người.' : 'Phòng đã đầy.' };
    }
    const lower = name.toLowerCase();
    if (!matchesRoster(lower, this.settings.roster)) {
      return { error: 'Họ tên / Mã SV của bạn không nằm trong danh sách lớp được giảng viên cho phép.' };
    }
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) {
        return { error: 'Tên này đã có người dùng trong phòng, hãy chọn tên khác.' };
      }
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
    const lines = glyphs.layoutGrid(this.target, glyphs.COLS);
    this.glyphPack = {
      total: this.target.length,
      metrics: glyphs.metrics(),
      lines,
      paths: glyphs.glyphsForRows(this.target, lines, 0, lines.length - 1)
    };
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
   * Tính chuỗi trạng thái từng ký tự đã gõ ('1' = đúng, '2' = đúng khung chữ đang gõ dở, '0' = sai)
   * để client tô màu trên Canvas vector mà không cần biết nội dung chữ gốc.
   */
  computeCharStates(typedArr) {
    const target = this.target;
    const len = typedArr.length;
    const complete = len >= target.length;
    const wordStart = complete ? len : typedArr.lastIndexOf(' ') + 1;
    let states = '';
    for (let i = 0; i < len && i < target.length; i++) {
      if (typedArr[i] === target[i]) {
        states += '1';
      } else if (i >= wordStart && VN.skeleton(typedArr[i]) === VN.skeleton(target[i])) {
        states += '2';
      } else {
        states += '0';
      }
    }
    return states;
  }

  _recordCheat(p, elapsedMs, reason, weight = 25) {
    p.cheatFlags++;
    p.lastCheatReason = reason;
    p.suspicionScore = Math.min(100, (p.suspicionScore || 0) + weight);
    if (p.cheatLog.length < 40) {
      p.cheatLog.push({ tSec: Math.round(elapsedMs / 100) / 10, reason });
    }
  }

  /**
   * Nhận văn bản người chơi đã gõ, kiểm tra chống gian lận và chấm điểm phía server.
   * meta: { untrusted?: boolean, reason?: string, keys?: Array<{dt:number, dw:number, bs?:number}> }
   */
  progress(token, typedRaw, now = Date.now(), meta) {
    const p = this.players.get(token);
    if (!p || !this.acceptingInput(now) || p.finishedMs != null) return null;
    if (this.state === 'countdown') this.state = 'running';

    const elapsed = Math.max(0, Math.min(now, this.endAt) - this.startAt);

    if (meta && meta.untrusted) {
      const reason = String(meta.reason || 'Phát hiện thao tác tự động').slice(0, 140);
      this._recordCheat(p, elapsed, reason, 30);
      this.dirty = true;
      return {
        player: p,
        rejected: true,
        reason: p.lastCheatReason,
        revertTo: p.typed,
        charStates: this.computeCharStates(Array.from(p.typed))
      };
    }

    const typed = Array.from(VN.canonical(String(typedRaw || '').slice(0, this.target.length * 2 + 50)))
      .slice(0, this.target.length);
    const target = this.target;

    // --- 1. Kiểm tra tốc độ & bước nhảy ký tự chống paste / extension auto-fill / auto-typer ---
    const deltaChars = typed.length - p.typedLen;
    const dtSec = Math.max(0.05, (elapsed - p.lastInputMs) / 1000);
    const maxWpm = this.settings.maxWpm || DEFAULT_MAX_WPM;
    const roomMaxCps = (maxWpm * 5) / 60;
    const maxAllowedStep = Math.ceil(dtSec * MAX_CPS) + BURST_ALLOWANCE;
    const totalMaxAllowed = Math.ceil((elapsed / 1000) * Math.max(roomMaxCps * 1.25, MAX_CPS)) + BURST_ALLOWANCE;

    if (deltaChars > maxAllowedStep || typed.length > totalMaxAllowed) {
      this._recordCheat(
        p,
        elapsed,
        'Tốc độ nhập bất thường (nghi ngờ dán hoặc dùng công cụ tự động gõ)',
        35
      );
      this.dirty = true;
      return {
        player: p,
        rejected: true,
        reason: p.lastCheatReason,
        revertTo: p.typed,
        charStates: this.computeCharStates(Array.from(p.typed))
      };
    }

    // Kiểm tra trần WPM của phòng sau khi đã thi ít nhất 5 giây và gõ >= 30 ký tự
    if (deltaChars > 0 && elapsed >= 5000 && typed.length >= 30) {
      let tempCorrect = 0;
      for (let i = 0; i < typed.length; i++) if (typed[i] === target[i]) tempCorrect++;
      const currentWpm = Math.round(tempCorrect / 5 / (elapsed / 60000));
      if (currentWpm > maxWpm) {
        this._recordCheat(
          p,
          elapsed,
          `Tốc độ vượt trần cho phép của phòng (${currentWpm} WPM > ${maxWpm} WPM)`,
          35
        );
        this.dirty = true;
        return {
          player: p,
          rejected: true,
          reason: p.lastCheatReason,
          revertTo: p.typed,
          charStates: this.computeCharStates(Array.from(p.typed))
        };
      }
    }

    // --- 2. Phân tích nhịp gói tin đến Server (không phụ thuộc vào dữ liệu client tự khai) ---
    if (deltaChars > 0 && p.lastPacketAt > 0) {
      const pktDt = now - p.lastPacketAt;
      if (pktDt > 0 && pktDt < 5000) {
        p.packetIntervals.push(pktDt);
        if (p.packetIntervals.length > 30) p.packetIntervals.shift();
        if (p.packetIntervals.length >= 18) {
          const sdPkt = stdDev(p.packetIntervals.slice(-18));
          if (sdPkt < 4.5) {
            this._recordCheat(
              p,
              elapsed,
              'Nhịp gửi gói tin lên máy chủ đều đặn bất thường (nghi vấn chạy script tự động)',
              35
            );
            this.dirty = true;
            return {
              player: p,
              rejected: true,
              reason: p.lastCheatReason,
              revertTo: p.typed,
              charStates: this.computeCharStates(Array.from(p.typed))
            };
          }
        }
      }
    }
    if (deltaChars > 0) p.lastPacketAt = now;
    if (deltaChars < 0) p.backspaces += Math.abs(deltaChars);

    // --- 3. Kiểm tra sinh trắc học nhịp gõ vật lý (khi client gửi kèm telemetry `keys`) ---
    if (meta && Array.isArray(meta.keys)) {
      const validKeys = meta.keys
        .slice(0, 120)
        .filter((k) => k && typeof k.dt === 'number' && typeof k.dw === 'number' && isFinite(k.dt) && isFinite(k.dw));

      for (const k of validKeys) {
        if (k.bs) p.backspaces++;
      }

      // Nếu văn bản tăng thêm >= 6 ký tự nhưng tổng số phím vật lý gửi lên quá ít -> bơm gói tin trực tiếp qua Socket
      const nextKeyCount = p.keyCount + validKeys.length;
      if (deltaChars > 0 && typed.length >= 6 && nextKeyCount < Math.floor(typed.length * 0.6)) {
        this._recordCheat(
          p,
          elapsed,
          'Phát hiện gửi văn bản tự động không qua sự kiện bàn phím vật lý',
          35
        );
        this.dirty = true;
        return {
          player: p,
          rejected: true,
          reason: p.lastCheatReason,
          revertTo: p.typed,
          charStates: this.computeCharStates(Array.from(p.typed))
        };
      }

      const candidateHistory = p.keyHistory.concat(validKeys).slice(-60);
      const botReason = detectBotKeystrokes(candidateHistory);
      if (botReason) {
        this._recordCheat(p, elapsed, botReason, 35);
        this.dirty = true;
        return {
          player: p,
          rejected: true,
          reason: botReason,
          revertTo: p.typed,
          charStates: this.computeCharStates(Array.from(p.typed))
        };
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

    // Ghi nhận điểm nghi vấn nếu gõ rất dài tốc độ cao mà không hề xoá/sửa lỗi lần nào
    const minutes = Math.max(0.02, elapsed / 60000);
    const liveWpm = Math.round(p.correct / 5 / minutes);
    if (!p.zeroBsFlagged && p.typedLen >= 140 && liveWpm >= 95 && p.backspaces === 0 && p.mistakes === 0) {
      p.zeroBsFlagged = true;
      p.suspicionScore = Math.min(100, (p.suspicionScore || 0) + 25);
      p.cheatLog.push({
        tSec: Math.round(elapsed / 100) / 10,
        reason: `Gõ ${p.typedLen} ký tự ở tốc độ cao (${liveWpm} WPM) nhưng 0 lần bấm Backspace và 0 lỗi`
      });
    }

    // Lưu lịch sử tốc độ (mỗi ~2 giây hoặc khi hoàn thành) để giảng viên kiểm tra biểu đồ
    if (elapsed - p.lastTimelineMs >= 2000 || p.finishedMs != null) {
      p.lastTimelineMs = elapsed;
      const acc = p.correct + p.mistakes > 0
        ? Math.round((p.correct / (p.correct + p.mistakes)) * 1000) / 10
        : 100;
      if (p.timeline.length < 180) {
        p.timeline.push({
          tSec: Math.round(elapsed / 100) / 10,
          wpm: liveWpm,
          acc,
          correct: p.correct,
          mistakes: p.mistakes,
          typedLen: p.typedLen
        });
      }
    }

    this.dirty = true;
    this.touch();
    return {
      player: p,
      rejected: false,
      charStates: this.computeCharStates(typed),
      correct: p.correct,
      mistakes: p.mistakes
    };
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
        suspicionScore: p.suspicionScore || 0,
        lastCheatReason: p.lastCheatReason || '',
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

  /** Thông tin chi tiết của 1 sinh viên dành riêng cho giảng viên kiểm tra. */
  inspectPlayer(id) {
    for (const p of this.players.values()) {
      if (p.id === id) {
        return {
          id: p.id,
          name: p.name,
          connected: p.connected,
          typed: p.typed,
          correct: p.correct,
          mistakes: p.mistakes,
          backspaces: p.backspaces,
          keyCount: p.keyCount,
          cheatFlags: p.cheatFlags,
          suspicionScore: p.suspicionScore,
          lastCheatReason: p.lastCheatReason,
          cheatLog: p.cheatLog,
          timeline: p.timeline,
          passage: this.passage
        };
      }
    }
    return null;
  }

  /**
   * Trạng thái phòng gửi cho SINH VIÊN:
   * - Tuyệt đối KHÔNG gửi `passage` dạng chữ (plaintext).
   * - Chỉ gửi `glyphs` (vector paths) khi vòng thi đã thực sự `running` hoặc `finished` (không gửi lúc countdown).
   */
  snapshot(now = Date.now()) {
    const showGlyphs = this.state === 'running' || this.state === 'finished';
    return {
      code: this.code,
      type: this.type,
      state: this.state,
      round: this.round,
      settings: {
        duration: this.settings.duration,
        source: this.settings.source,
        topic: this.settings.topic,
        maxWpm: this.settings.maxWpm,
        hasRoster: this.settings.roster.length > 0
      },
      passage: '',
      glyphs: showGlyphs ? this.glyphPack : null,
      passageSource: this.passageSource,
      startsInMs: this.state === 'countdown' ? Math.max(0, this.startAt - now) : 0,
      remainingMs: this.state === 'running' || this.state === 'countdown'
        ? Math.max(0, this.endAt - Math.max(now, this.startAt))
        : 0,
      durationMs: this.settings.duration * 1000,
      standings: this.standings(now)
    };
  }

  /** Trạng thái phòng gửi riêng cho GIẢNG VIÊN (có đoạn văn gốc để đối chiếu). */
  teacherSnapshot(now = Date.now()) {
    const base = this.snapshot(now);
    base.passage = this.state === 'lobby' ? '' : this.passage;
    base.glyphs = null;
    return base;
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
  p.suspicionScore = 0;
  p.lastCheatReason = '';
  p.cheatLog = [];
  p.keyCount = 0;
  p.keyHistory = [];
  p.lastPacketAt = 0;
  p.packetIntervals = [];
  p.backspaces = 0;
  p.zeroBsFlagged = false;
  p.lastTimelineMs = 0;
  p.timeline = [];
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
  BURST_ALLOWANCE,
  DEFAULT_MAX_WPM
};
