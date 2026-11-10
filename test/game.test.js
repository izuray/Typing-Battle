const assert = require('assert');
const { Room, RoomManager, COUNTDOWN_MS } = require('../src/game');
const { generatePassage } = require('../src/passages');
const { signTeacherToken, verifyTeacherToken } = require('../server');

(async () => {
  // 1. Tạo phòng, thêm người chơi, chặn trùng tên
  const rm = new RoomManager();
  const room = rm.create('class', { duration: 60, source: 'bank' });
  const a = room.join(null, 'An').player;
  const b = room.join(null, 'Bình').player;
  const c = room.join(null, 'Chi').player;
  assert(a && b && c);
  assert(room.join(null, 'an').error, 'phải chặn tên trùng không phân biệt hoa thường');
  assert.strictEqual(room.join(a.token, 'An').rejoined, true, 'cho phép kết nối lại bằng token');

  // 2. Bắt đầu vòng thi và chấm điểm
  const t0 = 1_000_000;
  room.begin('Học tập là con đường ngắn nhất để thay đổi tương lai của mỗi người.', 'bank', t0);
  const start = t0 + COUNTDOWN_MS;
  assert.strictEqual(room.state, 'countdown');
  assert.strictEqual(room.tick(start), true);
  assert.strictEqual(room.state, 'running');

  // An và Bình cùng gõ đúng "Học tập " (8 ký tự), nhưng Bình xong sớm hơn (t+2s vs t+4s)
  room.progress(a.token, 'Học tập ', start + 4000);
  room.progress(b.token, 'Học tập ', start + 2000);
  // Chi đang gõ dở chữ "Học" ("Ho") -> chưa qua dấu cách nên chưa tính lỗi
  room.progress(c.token, 'Ho', start + 1000);
  assert.strictEqual(c.mistakes, 0, 'chữ đang gõ dở không bị tính lỗi');
  // Chi gõ sai từ đã qua dấu cách ("Họx ") -> tính 1 lỗi dù sau đó sửa lại
  room.progress(c.token, 'Họx ', start + 2000);
  assert.strictEqual(c.mistakes, 1);
  room.progress(c.token, 'Học ', start + 3000);
  assert.strictEqual(c.mistakes, 1, 'sửa lại vẫn giữ số lỗi đã mắc');

  // 3. Chống gian lận phía server: Chi cố tình paste / auto-text cả câu trong 100ms
  const cheatRes = room.progress(
    c.token,
    'Học tập là con đường ngắn nhất để thay đổi tương lai của mỗi người.',
    start + 3100
  );
  assert.strictEqual(cheatRes.rejected, true, 'phải từ chối gói tin tăng vọt bất thường');
  assert.strictEqual(c.cheatFlags, 1, 'phải ghi nhận cờ cảnh báo gian lận');
  assert.strictEqual(c.typed, 'Học ', 'giữ nguyên văn bản hợp lệ trước đó');

  // Báo cáo thao tác untrusted từ client (paste / auto-typer)
  const untrustedRes = room.progress(c.token, 'Học ', start + 3200, {
    untrusted: true,
    reason: 'Cố tình dán văn bản'
  });
  assert.strictEqual(untrustedRes.rejected, true);
  assert.strictEqual(c.cheatFlags, 2);

  const st = room.standings(start + 5000);
  assert.deepStrictEqual(st.map((x) => x.name), ['Bình', 'An', 'Chi'],
    'Cùng số ký tự đúng thì ai đạt được sớm hơn xếp trên');
  assert.strictEqual(st[2].cheatFlags, 2, 'bảng xếp hạng có số lần cảnh báo gian lận');

  // 4. Phòng đấu 1-1 giới hạn 2 người và cộng điểm thắng
  const duel = rm.create('duel', { duration: 30, source: 'bank' });
  const p1 = duel.join(null, 'Một').player;
  const p2 = duel.join(null, 'Hai').player;
  assert(duel.join(null, 'Ba').error, 'duel chỉ cho 2 người');
  duel.begin('Xin chào Việt Nam.', 'bank', t0);
  // Gõ theo tốc độ hợp lệ (18 ký tự sau 2 giây)
  duel.progress(p1.token, 'Xin chào ', start + 1000);
  duel.progress(p1.token, 'Xin chào Việt Nam.', start + 2000);
  duel.progress(p2.token, 'Xin chào ', start + 2500);
  assert.strictEqual(p1.finishedMs, 2000, 'gõ hết đúng 100% thì ghi nhận hoàn thành');
  const final = duel.finish();
  assert.strictEqual(final[0].name, 'Một');
  assert.strictEqual(final[0].wins, 1);

  // 5. Sinh đoạn văn từ kho câu và fallback khi chưa có GEMINI_API_KEY
  const pBank = await generatePassage({ source: 'bank', durationSec: 60 });
  assert(pBank.text.split(/\s+/).length >= 80);
  const pAi = await generatePassage({ source: 'ai', durationSec: 30, topic: 'sinh viên' });
  assert(pAi.text.length > 50, 'AI không có key phải tự fallback về kho câu');

  // 6. Xác thực token Giáo viên
  const tk = signTeacherToken('teacher');
  const verified = verifyTeacherToken(tk);
  assert(verified && verified.u === 'teacher', 'token hợp lệ phải xác thực được');
  assert.strictEqual(verifyTeacherToken(tk + 'tampered'), null, 'token bị sửa phải bị từ chối');
  assert.strictEqual(verifyTeacherToken('invalid'), null);

  console.log('game.js & passages.js: all tests passed');
})();
