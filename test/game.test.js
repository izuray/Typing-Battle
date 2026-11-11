const assert = require('assert');
const { Room, RoomManager, COUNTDOWN_MS } = require('../src/game');
const { generatePassage } = require('../src/passages');
const { signTeacherToken, verifyTeacherToken } = require('../server');

(async () => {
  // 1. Tạo phòng, thêm người chơi, chặn trùng tên & chặn mở 2 kết nối song song cùng token
  const rm = new RoomManager();
  const room = rm.create('class', { duration: 60, source: 'bank' });
  const a = room.join(null, 'An').player;
  const b = room.join(null, 'Bình').player;
  const c = room.join(null, 'Chi').player;
  assert(a && b && c);
  assert(room.join(null, 'an').error, 'phải chặn tên trùng không phân biệt hoa thường');
  assert(room.join(a.token, 'An', true).error, 'phải chặn kết nối thứ 2 dùng cùng token khi socket cũ đang mở');
  assert.strictEqual(room.join(a.token, 'An', false).rejoined, true, 'cho phép kết nối lại bằng token khi mất mạng');

  // 2. Bắt đầu vòng thi, kiểm tra KHÔNG lộ đề dạng chữ (plaintext) cho sinh viên
  const t0 = 1_000_000;
  room.begin('Học tập là con đường ngắn nhất để thay đổi tương lai của mỗi người.', 'bank', t0);
  const start = t0 + COUNTDOWN_MS;
  assert.strictEqual(room.state, 'countdown');

  const snapCountdown = room.snapshot(t0 + 500);
  assert.strictEqual(snapCountdown.passage, '', 'sinh viên không được nhận passage dạng chữ');
  assert(snapCountdown.glyphs && snapCountdown.glyphs.paths.length > 20, 'chỉ gửi nét vẽ vector (glyphs)');
  assert(room.teacherSnapshot(t0 + 500).passage.startsWith('Học tập'), 'giảng viên vẫn xem được đoạn văn');

  assert.strictEqual(room.tick(start), true);
  assert.strictEqual(room.state, 'running');

  const snapRunning = room.snapshot(start + 100);
  assert.strictEqual(snapRunning.passage, '', 'khi đang thi vẫn tuyệt đối không gửi passage dạng chữ cho sinh viên');
  assert(snapRunning.glyphs && snapRunning.glyphs.paths.length > 20, 'khi đang thi gửi các nét vẽ vector (glyphs)');

  // An và Bình cùng gõ đúng "Học tập " (8 ký tự), nhưng Bình xong sớm hơn (t+2s vs t+4s)
  room.progress(a.token, 'Học tập ', start + 4000);
  room.progress(b.token, 'Học tập ', start + 2000);
  // Chi đang gõ dở chữ "Học" ("Ho") -> chưa qua dấu cách nên chưa tính lỗi, charStates báo '2' (khung chữ đúng)
  const rPartial = room.progress(c.token, 'Ho', start + 1000);
  assert.strictEqual(c.mistakes, 0, 'chữ đang gõ dở không bị tính lỗi');
  assert.strictEqual(rPartial.charStates, '12', 'H đúng (1), o cùng khung chữ với ọ (2)');

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

  // 7. Chống script JS chạy ngầm (Auto-typer / setInterval / bơm gói tin thiếu phím vật lý)
  const botRoom = rm.create('class', { duration: 60, source: 'bank' });
  const bot1 = botRoom.join(null, 'BotSocket').player;
  const bot2 = botRoom.join(null, 'BotInterval').player;
  const human = botRoom.join(null, 'NguoiThat').player;
  botRoom.begin('Học tập là con đường ngắn nhất để thay đổi tương lai của mỗi người.', 'bank', t0);

  // 7a. Script gửi thẳng chuỗi văn bản qua socket mà không có lịch sử nhấn phím vật lý (keys: [])
  const rSocket = botRoom.progress(bot1.token, 'Học tập là ', start + 2000, { keys: [] });
  assert.strictEqual(rSocket.rejected, true, 'phải chặn gói tin tăng văn bản nhưng không có sự kiện phím vật lý');
  assert.strictEqual(bot1.cheatFlags, 1);

  // 7b. Script giả lập phím bằng setInterval(100ms) đều tăm tắp (sd(dt) < 4ms)
  const uniformKeys = Array.from({ length: 18 }, () => ({ dt: 100, dw: 50, bs: 0 }));
  const rInterval = botRoom.progress(bot2.token, 'Học tập là ', start + 2000, { keys: uniformKeys });
  assert.strictEqual(rInterval.rejected, true, 'phải chặn bot chạy setInterval đều nhịp');
  assert.strictEqual(bot2.cheatFlags, 1);

  // 7c. Script bắn keydown + keyup cùng lúc (dwell time = 0ms)
  const zeroDwellKeys = Array.from({ length: 18 }, (_, i) => ({ dt: 80 + (i % 5) * 15, dw: 0, bs: 0 }));
  const rZeroDw = botRoom.progress(bot2.token, 'Học tập là ', start + 3000, { keys: zeroDwellKeys });
  assert.strictEqual(rZeroDw.rejected, true, 'phải chặn bot bắn phím không có thời gian nhấn giữ (dwell=0)');

  // 7d. Người thật gõ với độ biến thiên nhịp tự nhiên -> được chấp nhận bình thường
  const humanKeys = [
    { dt: 145, dw: 72 }, { dt: 98, dw: 61 }, { dt: 180, dw: 88 }, { dt: 112, dw: 54 },
    { dt: 164, dw: 79 }, { dt: 91, dw: 48 }, { dt: 210, dw: 95 }, { dt: 130, dw: 67 },
    { dt: 105, dw: 58 }, { dt: 175, dw: 82 }, { dt: 119, dw: 63 }, { dt: 156, dw: 74 },
    { dt: 88, dw: 51 }, { dt: 195, dw: 91 }, { dt: 134, dw: 69 }, { dt: 142, dw: 77 }
  ];
  const rHuman = botRoom.progress(human.token, 'Học tập là ', start + 2500, { keys: humanKeys });
  assert.strictEqual(rHuman.rejected, false, 'người thật gõ có nhịp tự nhiên phải được chấp nhận');
  assert.strictEqual(human.correct, 11);

  // 8. Kiểm tra khoá danh sách lớp (Roster) & Soi bài sinh viên (inspectPlayer)
  const rosterRoom = rm.create('class', {
    duration: 60,
    source: 'bank',
    maxWpm: 100,
    rosterText: 'B21DCCN001 - Nguyễn Văn An\nB21DCCN002 - Trần Thị Bình'
  });
  assert(rosterRoom.join(null, 'Người Lạ').error, 'phải chặn người ngoài danh sách lớp');
  const rValid = rosterRoom.join(null, 'B21DCCN001 - Nguyễn Văn An');
  assert(rValid.player, 'sinh viên có trong danh sách lớp được vào phòng');
  const detail = botRoom.inspectPlayer(human.id);
  assert(detail && detail.name === 'NguoiThat' && detail.timeline.length >= 1, 'inspectPlayer trả về biểu đồ timeline');

  console.log('game.js & passages.js: all tests passed');
})();
