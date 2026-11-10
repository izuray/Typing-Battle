/* common.js - tiện ích dùng chung cho các trang */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function formatSec(ms) {
    return (Math.max(0, ms) / 1000).toFixed(1) + 's';
  }

  function toast(msg, isErr) {
    let wrap = $('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    const t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' err' : '');
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => t.remove(), isErr ? 4500 : 3000);
  }

  function param(name) {
    return new URLSearchParams(location.search).get(name);
  }

  function rankCell(rank) {
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
    return '<span class="rank rank-' + rank + '">' + (medal || '#' + rank) + '</span>';
  }

  /**
   * Bảng xếp hạng thời gian thực.
   * opts: { meId, limit, showProgress, kick:boolean, final:boolean, showCheat:boolean }
   */
  function standingsTable(list, opts) {
    opts = opts || {};
    const rows = (opts.limit ? list.slice(0, opts.limit) : list).map((p) => {
      const cls = [p.id === opts.meId ? 'me' : '', p.connected ? '' : 'offline'].join(' ');
      const cheatBadge = (opts.showCheat && p.cheatFlags > 0)
        ? ' <span class="tag bad" title="Phát hiện thao tác nghi vấn gian lận (paste/auto-text)">⚠️ ' + p.cheatFlags + '</span>'
        : '';
      return '<tr class="' + cls + '">' +
        '<td>' + rankCell(p.rank) + '</td>' +
        '<td>' + escapeHtml(p.name) +
          (p.id === opts.meId ? ' <span class="tag">bạn</span>' : '') +
          (p.finished ? ' <span class="tag ok">Xong</span>' : '') +
          (p.connected ? '' : ' <span class="tag">offline</span>') +
          cheatBadge + '</td>' +
        (opts.showProgress
          ? '<td><div class="bar" title="' + p.progress + '%"><i style="width:' + Math.min(100, p.progress) + '%"></i></div></td>'
          : '') +
        '<td class="num">' + p.correct + '</td>' +
        '<td class="num">' + p.mistakes + '</td>' +
        '<td class="num">' + p.wpm + '</td>' +
        '<td class="num">' + p.accuracy + '%</td>' +
        (opts.final ? '<td class="num">' + formatSec(p.timeMs) + '</td>' : '') +
        (opts.kick ? '<td><button class="btn sm ghost" data-kick="' + p.id + '" title="Mời ra khỏi phòng">✕</button></td>' : '') +
        '</tr>';
    }).join('');
    return '<table><thead><tr>' +
      '<th>Hạng</th><th>Sinh viên</th>' +
      (opts.showProgress ? '<th>Tiến độ</th>' : '') +
      '<th class="num" title="Số ký tự gõ đúng">Đúng</th>' +
      '<th class="num" title="Số lỗi chính tả đã mắc">Lỗi</th>' +
      '<th class="num" title="Số từ mỗi phút (5 ký tự = 1 từ)">WPM</th>' +
      '<th class="num">Chính xác</th>' +
      (opts.final ? '<th class="num" title="Thời điểm đạt số ký tự đúng cuối cùng">Thời gian</th>' : '') +
      (opts.kick ? '<th></th>' : '') +
      '</tr></thead><tbody>' + (rows || '<tr><td colspan="9" class="muted center">Chưa có sinh viên nào</td></tr>') + '</tbody></table>';
  }

  function downloadCsv(filename, rows) {
    const csv = '\uFEFF' + rows.map((r) => r.map((c) => {
      const s = String(c == null ? '' : c);
      return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  const SOURCE_LABEL = { bank: 'Kho câu có sẵn', ai: 'AI (Gemini)', custom: 'Giáo viên tự nhập' };

  window.TB = { $, $$, escapeHtml, formatTime, formatSec, toast, param, standingsTable, downloadCsv, SOURCE_LABEL };
})();
