/* play.js - Trang thi của sinh viên (Phòng lớp học & Battle 1v1 do giảng viên tạo) */
(function () {
  'use strict';
  const { $, $$, escapeHtml, formatTime, toast, param, standingsTable, SOURCE_LABEL } = TB;

  let myName = (localStorage.getItem('tb_name') || '').trim();
  if (!myName) {
    myName = (prompt('Nhập họ tên / mã sinh viên của bạn:') || '').trim();
    if (!myName) { location.href = '/'; return; }
    localStorage.setItem('tb_name', myName);
  }

  // ---------- bộ gõ ----------
  let method = localStorage.getItem('tb_ime') || 'telex';
  function updateImeUI() {
    $$('#imeSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.m === method));
    $('#imeNote').innerHTML = method === 'system'
      ? '💡 Đang dùng <b>Bộ gõ của máy</b> (Unikey/EVKey/điện thoại). Hãy bật tiếng Việt trên máy của bạn.'
      : '💡 Đang bật bộ gõ <b>' + method.toUpperCase() + '</b> tích hợp trên web — hãy <b>tắt Unikey/EVKey</b> (hoặc chuyển sang tiếng Anh) để không bị gõ đúp dấu.';
  }
  $$('#imeSwitch button').forEach((b) => {
    b.onclick = () => {
      method = b.dataset.m;
      localStorage.setItem('tb_ime', method);
      updateImeUI();
      if (snap && snap.state === 'running') box.focus();
    };
  });
  updateImeUI();

  // ---------- state ----------
  const socket = io();
  try { delete window.io; } catch (_) {} // Ngăn script bên ngoài tự mở kết nối Socket thứ 2
  const code = param('room');
  let me = { id: null, token: null, name: myName };
  let snap = null;
  let loadedRound = 0;
  let clock = null;
  let sendTimer = null;

  // ---------- typing box (đoạn văn Vector Glyphs trên Canvas ở trên + ô gõ khoá .value ở dưới) ----------
  const box = new TypingBox({
    passageEl: $('#passage'),
    inputEl: $('#typingInput'),
    getMethod: () => method,
    onChange: () => {
      updateLocalStats();
      if (sendTimer) return;
      sendTimer = setTimeout(() => {
        sendTimer = null;
        socket.emit('progress', { typed: box.typed, keys: box.flushTelemetry() }, (ack) => {
          if (ack && ack.ok) {
            box.setServerState(ack.charStates, ack.correct, ack.mistakes);
            updateLocalStats();
          }
        });
      }, 65);
    },
    onCheatAttempt: (reason) => {
      socket.emit('progress', { typed: box.typed, untrusted: true, reason });
    }
  });
  try { delete window.TypingBox; } catch (_) {} // Xoá constructor khỏi window sau khi khởi tạo xong

  function sessionKey(c) { return 'tb_player_' + c; }
  function saveSession() {
    if (code && me.token) sessionStorage.setItem(sessionKey(code), JSON.stringify({ token: me.token, id: me.id, name: me.name }));
  }
  function loadSession(c) {
    try { return JSON.parse(sessionStorage.getItem(sessionKey(c)) || 'null'); } catch (_) { return null; }
  }

  function showOnly(id) {
    ['viewLobby', 'viewGame', 'viewResult'].forEach((v) =>
      $('#' + v).classList.toggle('hidden', v !== id));
  }

  function enterRoom() {
    if (!code) { location.href = '/'; return; }
    const saved = loadSession(code);
    socket.emit('room:join', { code, name: myName, token: saved && saved.token }, (res) => {
      if (!res || res.error) {
        toast((res && res.error) || 'Không vào được phòng', true);
        setTimeout(() => { location.href = '/'; }, 1800);
        return;
      }
      me = { id: res.id, token: res.token, name: res.name };
      saveSession();
      if (res.snapshot && res.snapshot.glyphs) {
        loadedRound = res.snapshot.round;
        box.setGlyphs(res.snapshot.glyphs, res.typed || '', res.charStates || '');
      }
      render(res.snapshot);
    });
  }

  // ---------- render ----------
  function render(s) {
    snap = s;
    const isDuel = s.type === 'duel';

    if (s.state === 'lobby') {
      $('#countdownOverlay').classList.add('hidden');
      loadedRound = 0;
      box.enable(false);
      showOnly('viewLobby');
      $('#lobbyModeLabel').textContent = isDuel ? '⚔️ Phòng thi Battle 1 vs 1' : '🏫 Phòng thi cả lớp';
      $('#lobbyCode').textContent = s.code;
      $('#lobbyWaitText').textContent = isDuel
        ? (s.standings.length < 2
            ? 'Đang chờ đủ 2 sinh viên và giảng viên bắt đầu...'
            : 'Đã đủ 2 sinh viên! Đang chờ giảng viên bấm Bắt đầu thi...')
        : 'Đang chờ giảng viên bấm Bắt đầu thi...';
      renderLobbyPlayers(s.standings, isDuel);
      return;
    }

    if (s.state === 'countdown' || s.state === 'running') {
      showOnly('viewGame');
      $('#duelRace').classList.toggle('hidden', !isDuel);
      $('#sideBoard').classList.remove('hidden');
      $('#gameLayout').className = 'layout-side';
      $('#srcLabel').textContent = SOURCE_LABEL[s.passageSource] || '';

      if (s.state === 'countdown') {
        if (loadedRound !== s.round) {
          box.setGlyphs(null, '', '');
        }
      } else if (s.glyphs && loadedRound !== s.round) {
        loadedRound = s.round;
        box.setGlyphs(s.glyphs, '', '');
      }
      const running = s.state === 'running';
      box.enable(running);

      if (s.state === 'countdown' && s.startsInMs > 0) {
        clock = { state: 'countdown', startAt: Date.now() + s.startsInMs, endAt: Date.now() + s.startsInMs + s.durationMs };
      } else {
        $('#countdownOverlay').classList.add('hidden');
        clock = { state: 'running', startAt: Date.now() - (s.durationMs - s.remainingMs), endAt: Date.now() + s.remainingMs };
        box.enable(true);
      }
      tickClock();
      renderStandings(s.standings);
      return;
    }

    if (s.state === 'finished') {
      if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
      $('#countdownOverlay').classList.add('hidden');
      box.enable(false);
      clock = null;
      showOnly('viewResult');
      renderResult(s);
    }
  }

  function renderLobbyPlayers(list, isDuel) {
    $('#lobbyCount').textContent = list.length + (isDuel ? '/2' : '');
    $('#lobbyPlayers').innerHTML = list.map((p) =>
      '<span class="chip' + (p.connected ? '' : ' off') + '">' +
      escapeHtml(p.name) +
      (p.id === me.id ? ' <span class="tag">bạn</span>' : '') +
      (p.wins ? ' <span class="tag warn">🏆 ' + p.wins + '</span>' : '') +
      '</span>'
    ).join('');
  }

  function renderStandings(list) {
    if (!snap) return;
    const meRow = list.find((p) => p.id === me.id);
    if (meRow) {
      $('#stWpm').textContent = meRow.wpm;
      $('#stAcc').textContent = meRow.accuracy + '%';
      $('#stCorrect').textContent = meRow.correct;
      $('#stErr').textContent = meRow.mistakes;
      $('#myRankTag').textContent = 'Hạng #' + meRow.rank + '/' + list.length;
    }
    if (snap.type === 'duel') {
      const opp = list.find((p) => p.id !== me.id);
      if (meRow) {
        $('#meName').textContent = meRow.name + ' (Bạn)';
        $('#meWins').textContent = '🏆 ' + meRow.wins;
        $('#meScore').textContent = meRow.correct;
        $('#meWpm').textContent = meRow.wpm;
        $('#meBar').style.width = meRow.progress + '%';
      }
      if (opp) {
        $('#oppName').textContent = opp.name;
        $('#oppWins').textContent = '🏆 ' + opp.wins;
        $('#oppScore').textContent = opp.correct;
        $('#oppWpm').textContent = opp.wpm;
        $('#oppBar').style.width = opp.progress + '%';
      } else {
        $('#oppName').textContent = 'Đang chờ đối thủ...';
      }
    }
    $('#liveBoard').innerHTML = standingsTable(list, { meId: me.id, limit: 50, showProgress: true });
  }

  function renderResult(s) {
    const list = s.standings;
    const isDuel = s.type === 'duel';
    $('#duelBanner').classList.add('hidden');
    const meRow = list.find((p) => p.id === me.id);
    if (isDuel && meRow && list.length === 2) {
      const opp = list.find((p) => p.id !== me.id);
      const tie = meRow.rank === opp.rank;
      const win = meRow.rank === 1 && !tie;
      const b = $('#duelBanner');
      b.classList.remove('hidden', 'win', 'lose');
      b.classList.add(win ? 'win' : tie ? '' : 'lose');
      b.textContent = tie ? '🤝 Hoà!' : win ? '🎉 Bạn thắng!' : '💪 Bạn về nhì!';
    }
    $('#resTitle').textContent = '🏆 Kết quả vòng ' + s.round +
      (meRow ? ' — Bạn xếp hạng #' + meRow.rank + '/' + list.length : '');

    const order = [list[1], list[0], list[2]].filter(Boolean);
    $('#podium').innerHTML = order.map((p) => {
      const cls = p.rank === 1 ? 'p1' : p.rank === 2 ? 'p2' : 'p3';
      return '<div class="p ' + cls + '">' +
        '<div class="name">' + escapeHtml(p.name) + '</div>' +
        '<div class="small muted">' + p.correct + ' ký tự · ' + p.wpm + ' WPM</div>' +
        '<div class="block">' + p.rank + '</div></div>';
    }).join('');

    $('#finalBoard').innerHTML = standingsTable(list, { meId: me.id, final: true });
  }

  function updateLocalStats() {
    if (!clock || clock.state !== 'running') return;
    const s = box.stats();
    const min = Math.max(0.02, (Date.now() - clock.startAt) / 60000);
    $('#stCorrect').textContent = s.correct;
    $('#stWpm').textContent = Math.round(s.correct / 5 / min);
  }

  function tickClock() {
    if (!clock) return;
    const now = Date.now();
    if (clock.state === 'countdown') {
      const left = clock.startAt - now;
      if (left > 0) {
        $('#countdownOverlay').classList.remove('hidden');
        const n = Math.ceil(left / 1000);
        if ($('#countdownNum').textContent !== String(n)) $('#countdownNum').textContent = n;
        $('#stTime').textContent = formatTime(clock.endAt - clock.startAt);
        return;
      }
      clock.state = 'running';
      if (snap) snap.state = 'running';
      $('#countdownOverlay').classList.add('hidden');
      box.enable(true);
    }
    $('#countdownOverlay').classList.add('hidden');
    const rem = Math.max(0, clock.endAt - now);
    $('#stTime').textContent = formatTime(rem);
    $('#timerBox').classList.toggle('low', rem < 10000);
    if (rem <= 0 && box.enabled) {
      box.enable(false);
      socket.emit('progress', { typed: box.typed, keys: box.flushTelemetry() });
    }
  }
  setInterval(tickClock, 150);

  // ---------- buttons ----------
  $('#btnLeave').onclick = () => {
    socket.emit('room:leave');
    location.href = '/';
  };

  // ---------- socket events ----------
  socket.on('connect', () => {
    $('#connTag').textContent = 'Đã kết nối';
    $('#connTag').className = 'tag ok';
    enterRoom();
  });
  socket.on('disconnect', () => {
    $('#connTag').textContent = 'Mất kết nối...';
    $('#connTag').className = 'tag bad';
  });
  socket.on('room:preparing', () => $('#preparing').classList.remove('hidden'));
  socket.on('room:update', (s) => { $('#preparing').classList.add('hidden'); render(s); });
  socket.on('progress:ack', (ack) => {
    if (ack && ack.ok) {
      box.setServerState(ack.charStates, ack.correct, ack.mistakes);
      updateLocalStats();
    }
  });
  socket.on('standings', (d) => {
    if (!snap) return;
    snap.standings = d.standings;
    if (snap.state === 'lobby') renderLobbyPlayers(d.standings, snap.type === 'duel');
    else if (snap.state === 'running' || snap.state === 'countdown') renderStandings(d.standings);
  });
  socket.on('cheat:rejected', (d) => {
    if (d && typeof d.charStates === 'string') {
      box.setServerState(d.charStates, undefined, undefined);
    }
    if (d && typeof d.revertTo === 'string') box.setTyped(d.revertTo, true);
    toast('⚠️ ' + ((d && d.reason) || 'Thao tác không hợp lệ!'), true);
  });
  socket.on('you:finished', () => {
    box.enable(false);
    toast('🎉 Bạn đã gõ xong toàn bộ đoạn văn!');
  });
  socket.on('kicked', (d) => {
    alert((d && d.message) || 'Phòng đã đóng.');
    location.href = '/';
  });
})();
