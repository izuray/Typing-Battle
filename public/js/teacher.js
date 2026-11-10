/* teacher.js - Đăng nhập & Bảng điều khiển của giáo viên (Lớp học + Battle 1v1) */
(function () {
  'use strict';
  const { $, $$, escapeHtml, formatTime, toast, standingsTable, downloadCsv, SOURCE_LABEL } = TB;

  const socket = io();
  let teacherToken = sessionStorage.getItem('tb_teacher_token') || localStorage.getItem('tb_teacher_token') || '';
  let teacherUser = sessionStorage.getItem('tb_teacher_user') || localStorage.getItem('tb_teacher_user') || '';
  let host = JSON.parse(localStorage.getItem('tb_host') || 'null'); // { code, hostToken, type }
  let selectedRoomType = 'class'; // 'class' | 'duel'
  let snap = null;
  let clock = null;
  let aiAvailable = false;

  // ---------- chọn loại phòng ----------
  function updateTypePicker() {
    $$('#roomTypePicker [data-type]').forEach((btn) => {
      const active = btn.dataset.type === selectedRoomType;
      btn.style.borderColor = active ? 'var(--primary)' : 'var(--line)';
      btn.style.boxShadow = active ? '0 0 0 3px rgba(108, 123, 255, .25)' : 'none';
    });
    $('#btnCreate').textContent = selectedRoomType === 'duel'
      ? '⚔️ Tạo phòng Battle 1 vs 1'
      : '🏫 Tạo phòng thi cả lớp';
  }
  $$('#roomTypePicker [data-type]').forEach((btn) => {
    btn.onclick = () => {
      selectedRoomType = btn.dataset.type;
      updateTypePicker();
    };
  });

  // ---------- settings form ----------
  function mountSettings(container) {
    container.innerHTML = '';
    container.appendChild($('#tplSettings').content.cloneNode(true));
    const src = $('[data-k=source]', container);
    const refresh = () => {
      $$('[data-show]', container).forEach((el) => el.classList.toggle('hidden', el.dataset.show !== src.value));
    };
    src.addEventListener('change', refresh);
    const aiOpt = $('option[value=ai]', container);
    if (!aiAvailable) {
      aiOpt.textContent += ' (chưa bật)';
      aiOpt.disabled = true;
    }
    $('[data-ai-note]', container).textContent = aiAvailable
      ? 'AI sẽ viết một đoạn văn mới cho mỗi vòng.'
      : 'Server chưa cấu hình GEMINI_API_KEY nên sẽ dùng kho câu.';
    refresh();
  }
  function readSettings(container) {
    const s = {};
    $$('[data-k]', container).forEach((el) => { s[el.dataset.k] = el.value; });
    return s;
  }
  function writeSettings(container, s) {
    if (!s) return;
    $$('[data-k]', container).forEach((el) => { if (s[el.dataset.k] != null) el.value = s[el.dataset.k]; });
    $('[data-k=source]', container).dispatchEvent(new Event('change'));
  }

  // ---------- views ----------
  function showLogin() {
    $('#viewCreate').classList.add('hidden');
    $('#viewRoom').classList.add('hidden');
    $('#btnClose').classList.add('hidden');
    $('#btnLogout').classList.add('hidden');
    $('#teacherBadge').classList.add('hidden');
    $('#viewLogin').classList.remove('hidden');
    setTimeout(() => $('#loginUser').focus(), 50);
  }

  function showCreate() {
    $('#viewLogin').classList.add('hidden');
    $('#viewRoom').classList.add('hidden');
    $('#btnClose').classList.add('hidden');
    $('#btnLogout').classList.remove('hidden');
    $('#teacherBadge').textContent = '👩‍🏫 ' + (teacherUser || 'Giảng viên');
    $('#teacherBadge').classList.remove('hidden');
    $('#viewCreate').classList.remove('hidden');
    updateTypePicker();
    mountSettings($('#createSettings'));
    const saved = JSON.parse(localStorage.getItem('tb_host_settings') || 'null');
    writeSettings($('#createSettings'), saved);
  }

  function showRoom(settings) {
    $('#viewLogin').classList.add('hidden');
    $('#viewCreate').classList.add('hidden');
    $('#viewRoom').classList.remove('hidden');
    $('#btnClose').classList.remove('hidden');
    $('#btnLogout').classList.remove('hidden');
    $('#teacherBadge').textContent = '👩‍🏫 ' + (teacherUser || 'Giảng viên');
    $('#teacherBadge').classList.remove('hidden');
    $('#roomCode').textContent = host.code;
    const url = location.origin + '/?code=' + host.code;
    $('#joinUrl').textContent = url;
    mountSettings($('#roomSettings'));
    writeSettings($('#roomSettings'), settings || JSON.parse(localStorage.getItem('tb_host_settings') || 'null'));
  }

  function clearAuth() {
    teacherToken = '';
    teacherUser = '';
    sessionStorage.removeItem('tb_teacher_token');
    sessionStorage.removeItem('tb_teacher_user');
    localStorage.removeItem('tb_teacher_token');
    localStorage.removeItem('tb_teacher_user');
    showLogin();
  }

  function enterAfterAuth() {
    if (host && socket.connected) {
      socket.emit('host:join', Object.assign({}, host, { teacherToken }), (res) => {
        if (res && res.authError) return clearAuth();
        if (!res || res.error) {
          localStorage.removeItem('tb_host');
          host = null;
          showCreate();
          return;
        }
        showRoom(res.settings);
        render(res.snapshot);
      });
    } else {
      showCreate();
    }
  }

  // ---------- login form ----------
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#loginUser').value.trim();
    const password = $('#loginPass').value;
    if (!username || !password) return;
    $('#btnLogin').disabled = true;
    try {
      const r = await fetch('/api/teacher/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password })
      });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        toast('Server đang chạy phiên bản cũ! Hãy tắt terminal cũ (Ctrl+C) và chạy lại npm start.', true);
        return;
      }
      const data = await r.json();
      if (!r.ok || !data.ok) {
        toast(data.error || 'Đăng nhập thất bại', true);
        return;
      }
      teacherToken = data.teacherToken;
      teacherUser = data.username;
      sessionStorage.setItem('tb_teacher_token', teacherToken);
      sessionStorage.setItem('tb_teacher_user', teacherUser);
      localStorage.setItem('tb_teacher_token', teacherToken);
      localStorage.setItem('tb_teacher_user', teacherUser);
      $('#loginPass').value = '';
      toast('Đăng nhập thành công!');
      enterAfterAuth();
    } catch (_) {
      toast('Không kết nối được tới máy chủ. Kiểm tra xem npm start đã chạy chưa.', true);
    } finally {
      $('#btnLogin').disabled = false;
    }
  });

  $('#btnLogout').onclick = () => {
    if (confirm('Đăng xuất khỏi tài khoản giảng viên?')) clearAuth();
  };

  function render(s) {
    snap = s;
    const st = s.state;
    const isDuel = s.type === 'duel';
    $('#roomTypeLabel').textContent = isDuel ? '⚔️ Mã phòng Battle 1 vs 1' : '🏫 Mã phòng lớp học';
    $('#controlsLobby').classList.toggle('hidden', st !== 'lobby');
    $('#controlsRunning').classList.toggle('hidden', st !== 'running' && st !== 'countdown');
    $('#controlsFinished').classList.toggle('hidden', st !== 'finished');
    $('#roundNo').textContent = s.round;
    $('#lobbyCard').classList.toggle('hidden', st === 'running' || st === 'countdown');

    const modeBadge = isDuel ? ' [Battle 1 vs 1]' : ' [Cả lớp]';
    $('#roomTitle').innerHTML = st === 'finished'
      ? '🏆 Kết quả chung cuộc' + modeBadge + ' — Vòng ' + s.round
      : st === 'lobby'
        ? '📊 Danh sách phòng thi' + modeBadge + ' (' + s.standings.length + (isDuel ? '/2' : '') + ' sinh viên)'
        : '<span class="live-dot"></span>📊 Bảng xếp hạng thời gian thực' + modeBadge + ' — Vòng ' + s.round;
    $('#roomSub').textContent = 'Thời gian thi: ' + formatTime(s.durationMs) +
      ' · Cập nhật trực tiếp theo số ký tự đúng & tốc độ gõ';

    if (st === 'countdown') clock = { label: 'Chuẩn bị', until: Date.now() + s.startsInMs, next: Date.now() + s.startsInMs + s.durationMs };
    else if (st === 'running') clock = { label: 'Còn lại', until: Date.now() + s.remainingMs };
    else clock = null;
    tickClock();

    const hasPassage = !!s.passage;
    $('#passageCard').classList.toggle('hidden', !hasPassage);
    if (hasPassage) {
      $('#passageText').textContent = s.passage;
      $('#passageSource').textContent = SOURCE_LABEL[s.passageSource] || '';
    }
    renderPlayers(s.standings);
  }

  function renderPlayers(list) {
    const isDuel = snap && snap.type === 'duel';
    $('#playerCount').textContent = list.length + (isDuel ? '/2' : '');
    $('#playerChips').innerHTML = list.map((p) =>
      '<span class="chip' + (p.connected ? '' : ' off') + '">' + escapeHtml(p.name) +
      (isDuel && p.wins ? ' <span class="tag warn">🏆 ' + p.wins + '</span>' : '') +
      '<button class="x" data-kick="' + p.id + '" title="Mời ra khỏi phòng">✕</button></span>'
    ).join('') || '<span class="muted">Chưa có sinh viên nào. Hãy chia sẻ mã phòng!</span>';
    const st = snap ? snap.state : 'lobby';
    $('#board').innerHTML = standingsTable(list, {
      showProgress: true,
      final: st === 'finished',
      kick: st !== 'finished',
      showCheat: true
    });
  }

  function tickClock() {
    const box = $('#timerBox');
    if (!clock) {
      $('#timer').textContent = snap && snap.state === 'finished' ? '0:00' : formatTime(snap ? snap.durationMs : 0);
      $('#timerLabel').textContent = snap && snap.state === 'finished' ? 'Hết giờ' : 'Chờ bắt đầu';
      box.classList.remove('low');
      return;
    }
    let left = clock.until - Date.now();
    if (clock.next && left <= 0) { clock = { label: 'Còn lại', until: clock.next }; left = clock.until - Date.now(); }
    $('#timer').textContent = formatTime(left);
    $('#timerLabel').textContent = clock.label;
    box.classList.toggle('low', clock.label === 'Còn lại' && left < 10000);
  }
  setInterval(tickClock, 200);

  // ---------- actions ----------
  function call(event, extra) {
    return new Promise((resolve) => {
      socket.emit(
        event,
        Object.assign({ code: host && host.code, hostToken: host && host.hostToken, teacherToken }, extra || {}),
        (res) => {
          if (res && res.authError) {
            toast(res.error || 'Vui lòng đăng nhập lại.', true);
            clearAuth();
            return resolve(res);
          }
          if (res && res.error) toast(res.error, true);
          if (res && res.note) toast(res.note);
          resolve(res || {});
        }
      );
    });
  }

  $('#btnCreate').onclick = () => {
    const settings = readSettings($('#createSettings'));
    localStorage.setItem('tb_host_settings', JSON.stringify(settings));
    $('#btnCreate').disabled = true;
    socket.emit('class:create', { type: selectedRoomType, settings, teacherToken }, (res) => {
      $('#btnCreate').disabled = false;
      if (res && res.authError) return clearAuth();
      if (!res || res.error) return toast((res && res.error) || 'Lỗi tạo phòng', true);
      host = { code: res.code, hostToken: res.hostToken, type: res.type };
      localStorage.setItem('tb_host', JSON.stringify(host));
      showRoom(settings);
      render(res.snapshot);
    });
  };

  $('#btnStart').onclick = async () => {
    const settings = readSettings($('#roomSettings'));
    if (settings.source === 'custom' && settings.customText.trim().split(/\s+/).length < 3) {
      return toast('Đoạn văn tự nhập quá ngắn', true);
    }
    localStorage.setItem('tb_host_settings', JSON.stringify(settings));
    $('#btnStart').disabled = true;
    await call('host:start', { settings });
    $('#btnStart').disabled = false;
    $('#preparing').classList.add('hidden');
  };

  $('#btnEnd').onclick = () => { if (confirm('Kết thúc vòng thi ngay bây giờ?')) call('host:end'); };
  $('#btnNewRound').onclick = () => call('host:reset');
  $('#btnClose').onclick = async () => {
    if (!confirm('Đóng phòng? Tất cả sinh viên sẽ bị đưa ra ngoài.')) return;
    await call('host:close');
    localStorage.removeItem('tb_host');
    host = null;
    showCreate();
  };
  $('#btnCopy').onclick = () => {
    navigator.clipboard.writeText($('#joinUrl').textContent).then(() => toast('Đã sao chép link'));
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-kick]');
    if (!b) return;
    const p = snap && snap.standings.find((x) => x.id === b.dataset.kick);
    if (p && confirm('Mời "' + p.name + '" ra khỏi phòng?')) call('host:kick', { id: p.id });
  });

  $('#btnExport').onclick = () => {
    if (!snap) return;
    const rows = [['Hạng', 'Tên', 'Ký tự đúng', 'Lỗi chính tả', 'WPM', 'Chính xác (%)', 'Tiến độ (%)', 'Hoàn thành', 'Thời gian (giây)', 'Cảnh báo gian lận']];
    snap.standings.forEach((p) => rows.push([
      p.rank, p.name, p.correct, p.mistakes, p.wpm, p.accuracy, p.progress, p.finished ? 'Có' : 'Không', (p.timeMs / 1000).toFixed(1), p.cheatFlags || 0
    ]));
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
      '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
    downloadCsv('ket-qua-phong-' + host.code + '-vong-' + snap.round + '-' + stamp + '.csv', rows);
  };

  // ---------- socket ----------
  socket.on('connect', () => {
    $('#connTag').textContent = 'Đã kết nối';
    $('#connTag').className = 'tag ok';
    if (teacherToken) enterAfterAuth();
  });
  socket.on('disconnect', () => {
    $('#connTag').textContent = 'Mất kết nối...';
    $('#connTag').className = 'tag bad';
  });
  socket.on('room:update', (s) => { $('#preparing').classList.add('hidden'); render(s); });
  socket.on('room:preparing', () => $('#preparing').classList.remove('hidden'));
  socket.on('standings', (d) => { if (snap) { snap.standings = d.standings; renderPlayers(d.standings); } });

  // ---------- khởi tạo: kiểm tra config + xác thực token giảng viên ----------
  Promise.all([
    fetch('/api/config').then((r) => r.json()).catch(() => ({})),
    teacherToken
      ? fetch('/api/teacher/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teacherToken })
        }).then((r) => r.ok ? r.json() : { ok: false }).catch(() => ({ ok: false }))
      : Promise.resolve({ ok: false })
  ]).then(([cfg, auth]) => {
    aiAvailable = !!(cfg && cfg.aiAvailable);
    if (auth && auth.ok) {
      teacherUser = auth.username || teacherUser;
      enterAfterAuth();
    } else {
      clearAuth();
    }
  });
})();
