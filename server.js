/*
 * server.js - HTTP + Socket.IO server cho Typing Battle.
 * Chạy:  npm install && npm run dev  ->  http://localhost:3000
 */
'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager, sanitizeSettings } = require('./src/game');
const { generatePassage, aiAvailable } = require('./src/passages');

const PORT = Number(process.env.PORT) || 3000;
const TICK_MS = 150;
const STANDINGS_INTERVAL_MS = 200; // cập nhật bảng xếp hạng thời gian thực mỗi 200ms
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000; // xoá phòng sau 3 giờ không hoạt động

// ---------- cấu hình đăng nhập Giáo viên ----------
const TEACHER_USER = process.env.TEACHER_USER || 'teacher';
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'teacher123';
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 giờ
const loginAttempts = new Map(); // ip -> { count, resetAt }

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function signTeacherToken(username) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ u: username, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyTeacherToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || typeof data.exp !== 'number' || Date.now() > data.exp) return null;
    return data;
  } catch (_) {
    return null;
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => res.json({ aiAvailable: aiAvailable() }));

// API lấy đoạn văn ngẫu nhiên cho chế độ Sinh viên Tự luyện
app.get('/api/practice-passage', async (req, res) => {
  const duration = Math.min(300, Math.max(30, Number(req.query.duration) || 60));
  const result = await generatePassage({ source: 'bank', durationSec: duration });
  res.json({ ok: true, text: result.text });
});

// API đăng nhập Giáo viên
app.post('/api/teacher/login', (req, res) => {
  const ip = req.ip || 'local';
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (rec && now < rec.resetAt && rec.count >= 10) {
    return res.status(429).json({ error: 'Nhập sai quá nhiều lần. Vui lòng thử lại sau 5 phút.' });
  }

  const { username, password } = req.body || {};
  if (safeEqual(String(username || '').trim(), TEACHER_USER) && safeEqual(password, TEACHER_PASSWORD)) {
    loginAttempts.delete(ip);
    const teacherToken = signTeacherToken(TEACHER_USER);
    return res.json({ ok: true, teacherToken, username: TEACHER_USER });
  }

  const nextCount = rec && now < rec.resetAt ? rec.count + 1 : 1;
  loginAttempts.set(ip, { count: nextCount, resetAt: now + 5 * 60 * 1000 });
  return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu giáo viên.' });
});

app.post('/api/teacher/verify', (req, res) => {
  const data = verifyTeacherToken(req.body && req.body.teacherToken);
  if (!data) return res.status(401).json({ ok: false });
  return res.json({ ok: true, username: data.u });
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });
const rooms = new RoomManager();

// ------------------------------------------------------------------ helpers
function emitUpdate(room) {
  io.to(room.code).emit('room:update', room.snapshot());
  room.dirty = false;
  room.lastStandingsAt = Date.now();
}

function broadcastStandingsNow(room, now = Date.now()) {
  io.to(room.code).emit('standings', { standings: room.standings(now), state: room.state });
  room.dirty = false;
  room.lastStandingsAt = now;
}

function attachPlayer(socket, room, player) {
  socket.join(room.code);
  socket.data.code = room.code;
  socket.data.token = player.token;
  player.socketId = socket.id;
  player.connected = true;
}

function playerOf(socket) {
  const room = rooms.get(socket.data.code);
  if (!room) return {};
  return { room, player: room.players.get(socket.data.token) };
}

function requireTeacher(payload) {
  return verifyTeacherToken(payload && payload.teacherToken);
}

function hostRoom(payload) {
  if (!requireTeacher(payload)) return null;
  const room = rooms.get(payload && payload.code);
  if (!room || !payload.hostToken || payload.hostToken !== room.hostToken) return null;
  return room;
}

async function startRound(room) {
  if (room.generating) return { error: 'Đang chuẩn bị đoạn văn...' };
  if (room.state === 'countdown' || room.state === 'running') return { error: 'Vòng thi đang diễn ra.' };
  room.generating = true;
  io.to(room.code).emit('room:preparing');
  try {
    const result = await generatePassage({
      source: room.settings.source,
      durationSec: room.settings.duration,
      topic: room.settings.topic,
      customText: room.settings.customText
    });
    if (!rooms.get(room.code)) return { error: 'Phòng không còn tồn tại.' };
    room.begin(result.text, result.source);
    emitUpdate(room);
    return { ok: true, note: result.note };
  } catch (e) {
    console.error('startRound', e);
    return { error: 'Không tạo được đoạn văn.' };
  } finally {
    room.generating = false;
  }
}

function finishRound(room) {
  room.finish();
  emitUpdate(room);
}

function safeAck(ack) {
  return typeof ack === 'function' ? ack : () => {};
}

// ------------------------------------------------------------------ sockets
io.on('connection', (socket) => {
  // ---------- Đăng nhập Giáo viên qua Socket ----------
  socket.on('teacher:login', (payload, ack) => {
    ack = safeAck(ack);
    const { username, password } = payload || {};
    if (safeEqual(String(username || '').trim(), TEACHER_USER) && safeEqual(password, TEACHER_PASSWORD)) {
      const teacherToken = signTeacherToken(TEACHER_USER);
      return ack({ ok: true, teacherToken, username: TEACHER_USER });
    }
    return ack({ error: 'Sai tài khoản hoặc mật khẩu giáo viên.' });
  });

  // ---------- Giáo viên (bắt buộc đã đăng nhập mới tạo được phòng Lớp học hoặc Battle 1v1) ----------
  socket.on('class:create', (payload, ack) => {
    ack = safeAck(ack);
    if (!requireTeacher(payload)) {
      return ack({ error: 'Chỉ giáo viên đã đăng nhập mới được tạo phòng thi.', authError: true });
    }
    const roomType = payload && payload.type === 'duel' ? 'duel' : 'class';
    const room = rooms.create(roomType, payload && payload.settings);
    socket.join(room.code);
    socket.data.hostOf = room.code;
    ack({ ok: true, code: room.code, type: room.type, hostToken: room.hostToken, snapshot: room.snapshot() });
  });

  socket.on('host:join', (payload, ack) => {
    ack = safeAck(ack);
    if (!requireTeacher(payload)) {
      return ack({ error: 'Phiên đăng nhập giáo viên đã hết hạn.', authError: true });
    }
    const room = hostRoom(payload);
    if (!room) return ack({ error: 'Phòng không tồn tại hoặc đã hết hạn.' });
    socket.join(room.code);
    socket.data.hostOf = room.code;
    room.touch();
    ack({ ok: true, code: room.code, type: room.type, snapshot: room.snapshot(), settings: room.settings });
  });

  socket.on('host:settings', (payload, ack) => {
    ack = safeAck(ack);
    const room = hostRoom(payload);
    if (!room) return ack({ error: 'Không có quyền hoặc phiên đăng nhập đã hết hạn.', authError: !requireTeacher(payload) });
    room.settings = sanitizeSettings(payload.settings, room.type);
    emitUpdate(room);
    ack({ ok: true, settings: room.settings });
  });

  socket.on('host:start', async (payload, ack) => {
    ack = safeAck(ack);
    const room = hostRoom(payload);
    if (!room) return ack({ error: 'Không có quyền hoặc phiên đăng nhập đã hết hạn.', authError: !requireTeacher(payload) });
    if (payload.settings) room.settings = sanitizeSettings(payload.settings, room.type);
    if (room.players.size === 0) return ack({ error: 'Chưa có sinh viên nào trong phòng.' });
    if (room.type === 'duel' && room.players.size < 2) {
      return ack({ error: 'Phòng Battle 1 vs 1 cần đủ 2 sinh viên để bắt đầu.' });
    }
    ack(await startRound(room));
  });

  socket.on('host:end', (payload, ack) => {
    ack = safeAck(ack);
    const room = hostRoom(payload);
    if (!room) return ack({ error: 'Không có quyền hoặc phiên đăng nhập đã hết hạn.', authError: !requireTeacher(payload) });
    if (room.state === 'countdown' || room.state === 'running') finishRound(room);
    ack({ ok: true });
  });

  socket.on('host:reset', (payload, ack) => {
    ack = safeAck(ack);
    const room = hostRoom(payload);
    if (!room) return ack({ error: 'Không có quyền hoặc phiên đăng nhập đã hết hạn.', authError: !requireTeacher(payload) });
    room.clearTimers();
    room.state = 'lobby';
    room.passage = '';
    emitUpdate(room);
    ack({ ok: true });
  });

  socket.on('host:kick', (payload, ack) => {
    ack = safeAck(ack);
    const room = hostRoom(payload);
    if (!room) return ack({ error: 'Không có quyền hoặc phiên đăng nhập đã hết hạn.', authError: !requireTeacher(payload) });
    const p = room.removeById(payload.id);
    if (p && p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) {
        s.emit('kicked', { message: 'Bạn đã bị giáo viên mời ra khỏi phòng.' });
        s.leave(room.code);
        s.data.code = null;
      }
    }
    emitUpdate(room);
    ack({ ok: true });
  });

  socket.on('host:close', (payload, ack) => {
    ack = safeAck(ack);
    const room = hostRoom(payload);
    if (!room) return ack({ error: 'Không có quyền hoặc phiên đăng nhập đã hết hạn.', authError: !requireTeacher(payload) });
    io.to(room.code).emit('kicked', { message: 'Giáo viên đã đóng phòng.' });
    rooms.delete(room.code);
    ack({ ok: true });
  });

  // ---------- Sinh viên vào phòng thi (không có quyền tạo phòng) ----------
  socket.on('room:join', (payload, ack) => {
    ack = safeAck(ack);
    const room = rooms.get(payload && payload.code);
    if (!room) return ack({ error: 'Không tìm thấy phòng. Kiểm tra lại mã phòng.' });
    const res = room.join(payload.token, payload.name);
    if (res.error) return ack({ error: res.error });
    attachPlayer(socket, room, res.player);
    emitUpdate(room);
    ack({
      ok: true,
      code: room.code,
      token: res.player.token,
      id: res.player.id,
      name: res.player.name,
      typed: res.player.typed,
      snapshot: room.snapshot()
    });
  });

  socket.on('progress', (payload) => {
    const { room, player } = playerOf(socket);
    if (!room || !player || !payload || typeof payload.typed !== 'string') return;
    const now = Date.now();
    const res = room.progress(player.token, payload.typed, now, {
      untrusted: !!payload.untrusted,
      reason: payload.reason
    });
    if (!res) return;
    if (res.rejected) {
      socket.emit('cheat:rejected', { reason: res.reason, revertTo: res.revertTo });
      broadcastStandingsNow(room, now);
      return;
    }
    const p = res.player;
    if (now - (room.lastStandingsAt || 0) >= STANDINGS_INTERVAL_MS) {
      broadcastStandingsNow(room, now);
    }
    if (p && p.finishedMs != null) {
      socket.emit('you:finished', { timeMs: p.finishedMs });
      broadcastStandingsNow(room, now);
      if (room.allFinished()) finishRound(room);
    }
  });

  socket.on('room:leave', () => {
    const { room, player } = playerOf(socket);
    if (room && player) {
      if (room.state === 'lobby' || room.state === 'finished') room.remove(player.token);
      else player.connected = false;
      socket.leave(room.code);
      socket.data.code = null;
      emitUpdate(room);
    }
  });

  socket.on('disconnect', () => {
    const { room, player } = playerOf(socket);
    if (room && player && player.socketId === socket.id) {
      player.connected = false;
      room.dirty = true;
    }
  });
});

// ------------------------------------------------------------------ game loop
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.rooms.values()) {
    if (room.tick(now)) emitUpdate(room);
    if ((room.state === 'running' || room.state === 'countdown') && now > room.endAt + 1500) {
      finishRound(room);
      continue;
    }
    if (room.dirty && now - (room.lastStandingsAt || 0) >= STANDINGS_INTERVAL_MS) {
      broadcastStandingsNow(room, now);
    }
  }
}, TICK_MS).unref();

setInterval(() => rooms.sweep(ROOM_IDLE_MS), 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Typing Battle đang chạy tại http://localhost:${PORT}`);
    console.log(`Tài khoản giáo viên: "${TEACHER_USER}" (đặt TEACHER_USER & TEACHER_PASSWORD để đổi)`);
    console.log(`Sinh đoạn văn bằng AI: ${aiAvailable() ? 'BẬT' : 'TẮT (đặt GEMINI_API_KEY để bật)'}`);
  });
}

module.exports = { server, rooms, signTeacherToken, verifyTeacherToken };
