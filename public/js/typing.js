/*
 * typing.js - Hiển thị đoạn văn trên <canvas> (chống đọc DOM) + Ô gõ chống script/auto-typer.
 *
 * Các lớp bảo vệ chống chạy JS ngầm / Extension / Auto-typer:
 *  1. Lưu giữ các hàm native C++ của trình duyệt ngay khi nạp file (Event.prototype.isTrusted,
 *     HTMLTextAreaElement.prototype.value, performance.now) để chống monkey-patching.
 *  2. Vẽ đoạn văn mẫu lên <canvas> thay vì DOM text -> document.querySelector('#passage').innerText
 *     hoặc các extension quét DOM chỉ nhận về chuỗi rỗng "".
 *  3. Toàn bộ dữ liệu nhạy cảm (target, typed, keyBuffer) nằm trong WeakMap nội bộ (private state),
 *     không gắn vào thuộc tính của instance `this` -> mở Console gõ `box.target` là undefined.
 *  4. Khoá thuộc tính `.value` trên phần tử `#typingInput`: bất kỳ đoạn JS nào chạy
 *     `document.getElementById('typingInput').value = '...'` từ bên ngoài đều bị chặn và báo cáo gian lận.
 *  5. Thu thập sinh trắc học nhịp gõ vật lý (flight time `dt` & dwell time `dw` từ keydown -> keyup)
 *     gửi lên server để server phát hiện bot `setInterval` / auto-typer.
 */
(function () {
  'use strict';

  // --- 1. Lưu tham chiếu Native C++ ngay từ đầu (trước khi user kịp chạy script trong Console) ---
  const nativeIsTrustedGetter = (function () {
    try {
      const desc = Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted');
      return desc && desc.get ? desc.get : null;
    } catch (_) {
      return null;
    }
  })();

  const nativeValueDesc = (function () {
    try {
      return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') ||
             Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    } catch (_) {
      return null;
    }
  })();

  const nativeNow = (typeof performance !== 'undefined' && performance.now)
    ? performance.now.bind(performance)
    : Date.now.bind(Date);

  const hasOwn = Object.prototype.hasOwnProperty;

  function isGenuineTrustedEvent(e) {
    if (!e || typeof e !== 'object') return false;
    // Nếu script cố tình Object.defineProperty(e, 'isTrusted', { value: true }) trên chính instance e:
    if (hasOwn.call(e, 'isTrusted')) return false;
    if (nativeIsTrustedGetter) {
      try {
        return nativeIsTrustedGetter.call(e) === true;
      } catch (_) {
        return false;
      }
    }
    return e.isTrusted === true;
  }

  const MAX_SINGLE_INPUT_CHARS = 3;
  const PRIV = new WeakMap(); // lưu trạng thái kín hoàn toàn khỏi Console

  class TypingBox {
    constructor(opts) {
      const state = {
        passageEl: opts.passageEl,
        input: opts.inputEl,
        getMethod: opts.getMethod || (() => 'telex'),
        onChange: opts.onChange || (() => {}),
        onCheatAttempt: opts.onCheatAttempt || (() => {}),
        target: [],
        typed: '',
        typedArr: [],
        enabled: false,
        lastKeyDownAt: 0,
        downMap: new Map(), // code -> timestamp
        telemetry: [],      // [{ dt, dw, k }] gửi kèm gói tin progress lên server
        canvas: null,
        ctx: null,
        scrollY: 0
      };
      PRIV.set(this, state);
      this._initCanvas(state);
      this._lockInputElement(state);
      this._bindEvents(state);
    }

    _getInputValue(state) {
      if (nativeValueDesc && nativeValueDesc.get && state.input instanceof HTMLTextAreaElement) {
        return nativeValueDesc.get.call(state.input);
      }
      return state.input.value;
    }

    _setInputValue(state, val) {
      if (nativeValueDesc && nativeValueDesc.set && state.input instanceof HTMLTextAreaElement) {
        nativeValueDesc.set.call(state.input, val);
      } else {
        state.input.value = val;
      }
    }

    /** Khoá setter .value trên phần tử textarea để chặn script bên ngoài gán input.value = '...' */
    _lockInputElement(state) {
      if (!nativeValueDesc || typeof document === 'undefined') return;
      try {
        const self = this;
        Object.defineProperty(state.input, 'value', {
          configurable: false,
          enumerable: true,
          get: function () {
            return nativeValueDesc.get.call(state.input);
          },
          set: function (_externalVal) {
            // Bất kỳ đoạn JS nào gọi element.value = ... từ bên ngoài đều đi vào đây!
            state.onCheatAttempt('Phát hiện script can thiệp trực tiếp vào ô gõ (.value)');
            if (typeof TB !== 'undefined' && TB.toast) {
              TB.toast('⚠️ Phát hiện can thiệp bằng mã JavaScript!', true);
            }
            return nativeValueDesc.get.call(state.input);
          }
        });
        void self;
      } catch (_) {}
    }

    /** Khởi tạo Canvas hiển thị đoạn văn mẫu (chống đọc text từ DOM) */
    _initCanvas(state) {
      if (typeof document === 'undefined' || !state.passageEl) return;
      state.passageEl.innerHTML = '';
      const canvas = document.createElement('canvas');
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      state.passageEl.style.padding = '0';
      state.passageEl.appendChild(canvas);
      state.canvas = canvas;
      state.ctx = canvas.getContext('2d');
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => this._render(state));
        ro.observe(state.passageEl);
      } else if (typeof window !== 'undefined') {
        window.addEventListener('resize', () => this._render(state));
      }
    }

    _bindEvents(state) {
      const input = state.input;
      input.setAttribute('name', 'tb_' + Math.random().toString(36).slice(2));

      const blockClip = (e, msg) => {
        e.preventDefault();
        e.stopPropagation();
        if (msg && typeof TB !== 'undefined') TB.toast(msg, true);
      };

      state.passageEl.addEventListener('copy', (e) => blockClip(e, 'Không được sao chép đoạn văn mẫu!'));
      state.passageEl.addEventListener('contextmenu', (e) => e.preventDefault());
      state.passageEl.addEventListener('selectstart', (e) => e.preventDefault());
      state.passageEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (state.enabled) this.focus();
      });

      input.addEventListener('paste', (e) => {
        blockClip(e, 'Không được dán (paste) văn bản!');
        state.onCheatAttempt('Cố tình dán (paste) văn bản');
      });
      input.addEventListener('drop', (e) => {
        blockClip(e, 'Không được kéo-thả văn bản!');
        state.onCheatAttempt('Cố tình kéo-thả văn bản');
      });
      input.addEventListener('copy', (e) => blockClip(e));
      input.addEventListener('cut', (e) => blockClip(e));
      input.addEventListener('contextmenu', (e) => e.preventDefault());

      input.addEventListener('beforeinput', (e) => {
        if (!state.enabled) { e.preventDefault(); return; }
        if (!isGenuineTrustedEvent(e)) {
          e.preventDefault();
          state.onCheatAttempt('Phát hiện sự kiện beforeinput giả lập (JS/Extension)');
          return;
        }
        const t = e.inputType || '';
        if (
          t === 'insertFromPaste' ||
          t === 'insertFromPasteAsQuotation' ||
          t === 'insertFromDrop' ||
          t === 'insertFromYank' ||
          t === 'insertReplacementText' ||
          t === 'historyUndo' ||
          t === 'historyRedo'
        ) {
          e.preventDefault();
          if (typeof TB !== 'undefined') TB.toast('Không được dùng tự động điền / dán văn bản!', true);
          state.onCheatAttempt('Sử dụng thao tác ' + t);
          return;
        }
        if (typeof e.data === 'string' && Array.from(e.data).length > MAX_SINGLE_INPUT_CHARS) {
          e.preventDefault();
          if (typeof TB !== 'undefined') TB.toast('Phát hiện chèn cụm từ tự động (auto-text)!', true);
          state.onCheatAttempt('Chèn nhiều ký tự cùng lúc (' + e.data.length + ' ký tự)');
        }
      });

      const keepCaretEnd = () => {
        try {
          const end = this._getInputValue(state).length;
          if (input.selectionStart !== end || input.selectionEnd !== end) {
            input.setSelectionRange(end, end);
          }
        } catch (_) {}
      };
      input.addEventListener('click', keepCaretEnd);
      input.addEventListener('select', keepCaretEnd);

      input.addEventListener('keydown', (e) => this._onKeyDown(state, e));
      input.addEventListener('keyup', (e) => this._onKeyUp(state, e));
      input.addEventListener('input', (e) => this._onInput(state, e));
    }

    focus() {
      const state = PRIV.get(this);
      if (!state) return;
      state.input.focus({ preventScroll: true });
      try {
        const end = this._getInputValue(state).length;
        state.input.setSelectionRange(end, end);
      } catch (_) {}
    }

    setPassage(text, typed) {
      const state = PRIV.get(this);
      if (!state) return;
      state.target = Array.from(VN.canonical(text));
      state.scrollY = 0;
      state.telemetry = [];
      state.downMap.clear();
      state.lastKeyDownAt = 0;
      this.setTyped(typed || '', true);
    }

    enable(on) {
      const state = PRIV.get(this);
      if (!state) return;
      state.enabled = !!on;
      state.input.disabled = !on;
      if (on) this.focus();
      else state.input.blur();
    }

    get enabled() {
      const state = PRIV.get(this);
      return !!(state && state.enabled);
    }

    get typed() {
      const state = PRIV.get(this);
      return state ? state.typed : '';
    }

    /** Lấy và xoá hàng đợi telemetry nhịp gõ vật lý để gửi kèm gói tin progress */
    flushTelemetry() {
      const state = PRIV.get(this);
      if (!state) return [];
      const out = state.telemetry.slice(0, 120);
      state.telemetry.length = 0;
      return out;
    }

    _recordKeyDown(state, e) {
      const now = nativeNow();
      const dt = state.lastKeyDownAt > 0 ? Math.round(now - state.lastKeyDownAt) : 120;
      state.lastKeyDownAt = now;
      const code = e.code || e.key || 'Key';
      state.downMap.set(code, { downAt: now, dt: Math.min(5000, Math.max(0, dt)), bs: e.key === 'Backspace' ? 1 : 0 });
    }

    _onKeyUp(state, e) {
      if (!state.enabled) return;
      if (!isGenuineTrustedEvent(e)) {
        state.onCheatAttempt('Phát hiện sự kiện keyup giả lập (auto-typer)');
        return;
      }
      const now = nativeNow();
      const code = e.code || e.key || 'Key';
      const rec = state.downMap.get(code);
      if (rec) {
        state.downMap.delete(code);
        const dw = Math.min(2000, Math.max(0, Math.round(now - rec.downAt)));
        state.telemetry.push({ dt: rec.dt, dw, bs: rec.bs });
      }
      try {
        const end = this._getInputValue(state).length;
        if (state.input.selectionStart !== end || state.input.selectionEnd !== end) {
          state.input.setSelectionRange(end, end);
        }
      } catch (_) {}
    }

    _onKeyDown(state, e) {
      if (!state.enabled) { e.preventDefault(); return; }
      if (!isGenuineTrustedEvent(e)) {
        e.preventDefault();
        state.onCheatAttempt('Phát hiện phím bấm giả lập bằng JavaScript (isTrusted=false)');
        return;
      }

      if (['ArrowLeft', 'ArrowUp', 'Home', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) {
        const k = (e.key || '').toLowerCase();
        if (k === 'v' || k === 'x' || k === 'c' || k === 'z' || k === 'y' || k === 'a') {
          e.preventDefault();
          return;
        }
        if (k === 'backspace' && this._isBuiltin(state)) {
          e.preventDefault();
          this._recordKeyDown(state, e);
          this.setTyped(state.typed.replace(/\S*\s*$/, ''));
        }
        return;
      }

      // Ghi nhận nhịp gõ cho mọi phím ký tự hoặc Backspace
      if (e.key === 'Backspace' || (e.key && e.key.length === 1) || e.isComposing || e.key === 'Process') {
        this._recordKeyDown(state, e);
      }

      if (!this._isBuiltin(state) || e.isComposing || e.key === 'Process' || e.key === 'Unidentified') return;

      if (e.key === 'Backspace') {
        e.preventDefault();
        const arr = Array.from(state.typed);
        arr.pop();
        this.setTyped(arr.join(''));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return; }
      if (!e.key || e.key.length !== 1) return;
      e.preventDefault();
      if (state.typedArr.length >= state.target.length) return;
      if (e.key === ' ') {
        this.setTyped(state.typed + ' ');
        return;
      }
      const cut = state.typed.lastIndexOf(' ') + 1;
      const word = state.typed.slice(cut);
      const next = VN.applyKey(word, e.key, state.getMethod());
      this.setTyped(state.typed.slice(0, cut) + next);
    }

    _onInput(state, e) {
      if (!state.enabled) { this._setInputValue(state, state.typed); return; }
      if (!isGenuineTrustedEvent(e)) {
        this._setInputValue(state, state.typed);
        state.onCheatAttempt('Phát hiện sự kiện input giả lập từ script/extension');
        return;
      }
      // Ở chế độ Telex/VNI trên máy tính, mọi phím hợp lệ đã được xử lý trong _onKeyDown.
      // Nếu không có phím vật lý nào vừa nhấn trong 500ms qua mà lại phát sinh input -> script can thiệp!
      const sinceKey = nativeNow() - state.lastKeyDownAt;
      if (sinceKey > 800 && state.lastKeyDownAt > 0) {
        this._setInputValue(state, state.typed);
        state.onCheatAttempt('Phát hiện thay đổi văn bản không qua bàn phím');
        return;
      }

      const raw = this._getInputValue(state).replace(/[\r\n\t]/g, ' ');
      const nextArr = Array.from(raw.normalize('NFC'));
      const delta = nextArr.length - state.typedArr.length;

      if (delta > MAX_SINGLE_INPUT_CHARS) {
        this._setInputValue(state, state.typed);
        if (typeof TB !== 'undefined') TB.toast('Không được dùng công cụ tự động điền (auto-text)!', true);
        state.onCheatAttempt('Tự động điền ' + delta + ' ký tự cùng lúc');
        return;
      }
      if (delta > 0 && state.telemetry.length === 0 && state.downMap.size === 0) {
        // Trường hợp gõ trên bàn phím ảo điện thoại không gửi keyup chuẩn: ghi nhận nhịp từ input
        state.telemetry.push({ dt: Math.min(2000, Math.max(20, Math.round(sinceKey || 95))), dw: 65, bs: 0 });
      }
      this.setTyped(raw);
    }

    _isBuiltin(state) {
      const m = state.getMethod();
      return m === 'telex' || m === 'vni';
    }

    setTyped(value, silent) {
      const state = PRIV.get(this);
      if (!state) return;
      let arr = Array.from(String(value).normalize('NFC'));
      if (arr.length > state.target.length) arr = arr.slice(0, state.target.length);
      state.typed = arr.join('');
      state.typedArr = arr;
      if (this._getInputValue(state) !== state.typed) {
        this._setInputValue(state, state.typed);
      }
      try {
        const end = state.typed.length;
        state.input.setSelectionRange(end, end);
        state.input.scrollTop = state.input.scrollHeight;
      } catch (_) {}
      this._render(state);
      if (!silent) state.onChange(state.typed);
    }

    /** Vẽ đoạn văn mẫu lên <canvas> với màu sắc đúng/sai từng ký tự và tự động cuộn dòng */
    _render(state) {
      const canvas = state.canvas;
      const ctx = state.ctx;
      if (!canvas || !ctx) return;

      const rect = state.passageEl.getBoundingClientRect();
      const width = Math.max(300, Math.floor(rect.width || 680));
      const height = Math.max(120, Math.floor(rect.height || 170));
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const fontSize = 21;
      const lineH = 34;
      const padX = 20;
      const padY = 16;
      ctx.font = '600 ' + fontSize + 'px "JetBrains Mono", "Cascadia Code", Consolas, monospace';
      ctx.textBaseline = 'top';

      const target = state.target;
      const typed = Array.from(VN.canonical(state.typed));
      const len = typed.length;
      const complete = len >= target.length;
      const wordStart = complete ? len : typed.lastIndexOf(' ') + 1;

      // Tính toạ độ (x, y) của từng ký tự có ngắt dòng theo từ (word-wrap)
      const maxX = width - padX;
      const pos = new Array(target.length);
      let x = padX;
      let y = padY;
      let i = 0;
      while (i < target.length) {
        if (target[i] === ' ') {
          const w = ctx.measureText(' ').width;
          if (x + w > maxX) { x = padX; y += lineH; }
          pos[i] = { x, y, w };
          x += w;
          i++;
        } else {
          let j = i;
          let wordW = 0;
          const charWidths = [];
          while (j < target.length && target[j] !== ' ') {
            const cw = ctx.measureText(target[j]).width;
            charWidths.push(cw);
            wordW += cw;
            j++;
          }
          if (x > padX && x + wordW > maxX) {
            x = padX;
            y += lineH;
          }
          for (let k = 0; k < charWidths.length; k++) {
            const cw = charWidths[k];
            if (x + cw > maxX && x > padX) { x = padX; y += lineH; }
            pos[i + k] = { x, y, w: cw };
            x += cw;
          }
          i = j;
        }
      }

      // Tự động cuộn theo dòng của con trỏ hiện tại
      const caretIdx = Math.min(len, Math.max(0, target.length - 1));
      const caretPos = pos[caretIdx] || { x: padX, y: padY };
      const desiredScroll = Math.max(0, caretPos.y - padY - lineH);
      state.scrollY = desiredScroll;

      // Vẽ từng ký tự trong vùng nhìn thấy
      for (let idx = 0; idx < target.length; idx++) {
        const p = pos[idx];
        const drawY = p.y - state.scrollY;
        if (drawY + lineH < 0 || drawY > height) continue;

        const ch = target[idx];
        if (idx < len) {
          if (typed[idx] === ch) {
            ctx.fillStyle = '#3ddc97';
          } else if (idx >= wordStart && VN.skeleton(typed[idx]) === VN.skeleton(ch)) {
            ctx.fillStyle = '#ffc857';
          } else {
            ctx.fillStyle = 'rgba(255, 92, 122, 0.85)';
            ctx.fillRect(p.x - 1, drawY - 2, p.w + 2, fontSize + 6);
            ctx.fillStyle = '#ffffff';
          }
        } else if (idx === len) {
          ctx.fillStyle = 'rgba(108, 123, 255, 0.28)';
          ctx.fillRect(p.x - 1, drawY - 2, p.w + 2, fontSize + 6);
          ctx.fillStyle = '#ffc857';
          ctx.fillRect(p.x - 1, drawY - 2, 2.5, fontSize + 6);
          ctx.fillStyle = '#ffffff';
        } else {
          ctx.fillStyle = '#7e86b8';
        }
        ctx.fillText(ch, p.x, drawY);
      }

      ctx.restore();
    }

    stats() {
      const state = PRIV.get(this);
      if (!state) return { correct: 0, typedLen: 0, total: 0 };
      const typed = Array.from(VN.canonical(state.typed));
      let correct = 0;
      let mistakes = 0;
      const complete = typed.length === state.target.length;
      const committed = complete ? typed.length : typed.lastIndexOf(' ') + 1;
      for (let i = 0; i < typed.length; i++) {
        if (typed[i] === state.target[i]) correct++;
        else if (i < committed) mistakes++;
      }
      return { correct, mistakes, typedLen: typed.length, total: state.target.length };
    }
  }

  Object.freeze(TypingBox.prototype);
  Object.freeze(TypingBox);
  window.TypingBox = TypingBox;
})();
