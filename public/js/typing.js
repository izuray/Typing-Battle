/*
 * typing.js - Hiển thị đoạn văn ở khung trên + ô gõ riêng ở dưới.
 *
 * Bảo mật & chống gian lận:
 *  1. Chặn copy, cut, paste, kéo-thả (drop), chuột phải, phím tắt Ctrl/Cmd + V/C/X.
 *  2. Chặn các sự kiện beforeinput kiểu dán/thay thế tự động (insertFromPaste, insertFromDrop,
 *     insertReplacementText - thường dùng bởi extension auto-text / text expander / autofill).
 *  3. Kiểm tra e.isTrusted === false để chặn script / extension bơm phím ảo bằng JS.
 *  4. Chặn chèn đột ngột một chuỗi nhiều ký tự trong 1 lần input (đặc trưng của snippet / auto-fill).
 *  5. Khoá con trỏ luôn ở cuối văn bản trong ô gõ để đồng bộ 1-1 với đoạn văn mẫu phía trên.
 */
(function () {
  'use strict';

  const MAX_SINGLE_INPUT_CHARS = 3; // tối đa số ký tự tăng thêm trong 1 sự kiện input hợp lệ (IME tiếng Việt)

  class TypingBox {
    constructor(opts) {
      this.passageEl = opts.passageEl;
      this.input = opts.inputEl;
      this.getMethod = opts.getMethod || (() => 'telex');
      this.onChange = opts.onChange || (() => {});
      this.onCheatAttempt = opts.onCheatAttempt || (() => {});
      this.target = [];
      this.typed = '';
      this.typedArr = [];
      this.spans = [];
      this.classes = [];
      this.enabled = false;
      this.prevLen = 0;
      this.lastKeyDownAt = 0;
      this.bind();
    }

    bind() {
      const input = this.input;

      // Đặt name/id ngẫu nhiên mỗi phiên để trình duyệt & extension autofill không nhận diện được
      input.setAttribute('name', 'tb_' + Math.random().toString(36).slice(2));

      const blockClip = (e, msg) => {
        e.preventDefault();
        e.stopPropagation();
        if (msg) TB.toast(msg, true);
      };

      // Chặn copy đoạn văn mẫu phía trên
      this.passageEl.addEventListener('copy', (e) => blockClip(e, 'Không được sao chép đoạn văn mẫu!'));
      this.passageEl.addEventListener('contextmenu', (e) => e.preventDefault());
      this.passageEl.addEventListener('selectstart', (e) => e.preventDefault());
      this.passageEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (this.enabled) this.focus();
      });

      // Chặn paste / drop / cut / copy trên ô gõ
      input.addEventListener('paste', (e) => {
        blockClip(e, 'Không được dán (paste) văn bản!');
        this.onCheatAttempt('Cố tình dán (paste) văn bản');
      });
      input.addEventListener('drop', (e) => {
        blockClip(e, 'Không được kéo-thả văn bản!');
        this.onCheatAttempt('Cố tình kéo-thả văn bản');
      });
      input.addEventListener('copy', (e) => blockClip(e));
      input.addEventListener('cut', (e) => blockClip(e));
      input.addEventListener('contextmenu', (e) => e.preventDefault());

      // Chặn beforeinput từ autofill / text-expander / spellcheck replacement
      input.addEventListener('beforeinput', (e) => {
        if (!this.enabled) { e.preventDefault(); return; }
        if (e.isTrusted === false) {
          e.preventDefault();
          this.onCheatAttempt('Phát hiện sự kiện nhập tự động không hợp lệ');
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
          TB.toast('Không được dùng tự động điền / dán văn bản!', true);
          this.onCheatAttempt('Sử dụng thao tác ' + t);
          return;
        }
        if (typeof e.data === 'string' && Array.from(e.data).length > MAX_SINGLE_INPUT_CHARS) {
          e.preventDefault();
          TB.toast('Phát hiện chèn cụm từ tự động (auto-text)!', true);
          this.onCheatAttempt('Chèn nhiều ký tự cùng lúc (' + e.data.length + ' ký tự)');
        }
      });

      // Giữ con trỏ luôn ở cuối ô gõ để sinh viên sửa bằng Backspace từ cuối
      const keepCaretEnd = () => {
        try {
          const end = input.value.length;
          if (input.selectionStart !== end || input.selectionEnd !== end) {
            input.setSelectionRange(end, end);
          }
        } catch (_) {}
      };
      input.addEventListener('click', keepCaretEnd);
      input.addEventListener('keyup', keepCaretEnd);
      input.addEventListener('select', keepCaretEnd);

      input.addEventListener('keydown', (e) => this.onKeyDown(e));
      input.addEventListener('input', (e) => this.onInput(e));
    }

    focus() {
      this.input.focus({ preventScroll: true });
      try {
        const end = this.input.value.length;
        this.input.setSelectionRange(end, end);
      } catch (_) {}
    }

    setPassage(text, typed) {
      this.target = Array.from(VN.canonical(text));
      this.passageEl.innerHTML = '';
      const frag = document.createDocumentFragment();
      this.spans = this.target.map((ch) => {
        const s = document.createElement('span');
        s.textContent = ch;
        frag.appendChild(s);
        return s;
      });
      this.passageEl.appendChild(frag);
      this.classes = new Array(this.target.length).fill('');
      this.passageEl.scrollTop = 0;
      this.prevLen = 0;
      this.setTyped(typed || '', true);
    }

    enable(on) {
      this.enabled = on;
      this.input.disabled = !on;
      if (on) this.focus();
      else this.input.blur();
    }

    // ---------- nhập liệu ----------
    onKeyDown(e) {
      if (!this.enabled) { e.preventDefault(); return; }
      if (e.isTrusted === false) {
        e.preventDefault();
        this.onCheatAttempt('Phát hiện phím bấm giả lập (auto-typer)');
        return;
      }
      this.lastKeyDownAt = Date.now();

      // Chặn các phím di chuyển con trỏ về giữa chuỗi
      if (['ArrowLeft', 'ArrowUp', 'Home', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'v' || k === 'x' || k === 'c' || k === 'z' || k === 'y' || k === 'a') {
          e.preventDefault();
          return;
        }
        if (k === 'backspace' && this.isBuiltin()) {
          // Ctrl+Backspace: xoá từ cuối cùng
          e.preventDefault();
          this.setTyped(this.typed.replace(/\S*\s*$/, ''));
        }
        return;
      }
      if (!this.isBuiltin() || e.isComposing || e.key === 'Process' || e.key === 'Unidentified') return;

      if (e.key === 'Backspace') {
        e.preventDefault();
        const arr = Array.from(this.typed);
        arr.pop();
        this.setTyped(arr.join(''));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return; }
      if (e.key.length !== 1) return;
      e.preventDefault();
      if (this.typedArr.length >= this.target.length) return;
      if (e.key === ' ') {
        this.setTyped(this.typed + ' ');
        return;
      }
      const cut = this.typed.lastIndexOf(' ') + 1;
      const word = this.typed.slice(cut);
      const next = VN.applyKey(word, e.key, this.getMethod());
      this.setTyped(this.typed.slice(0, cut) + next);
    }

    onInput(e) {
      if (!this.enabled) { this.input.value = this.typed; return; }
      if (e && e.isTrusted === false) {
        this.input.value = this.typed;
        this.onCheatAttempt('Phát hiện input tự động từ script/extension');
        return;
      }
      const raw = this.input.value.replace(/[\r\n\t]/g, ' ');
      const nextArr = Array.from(raw.normalize('NFC'));
      const delta = nextArr.length - this.typedArr.length;

      // Nếu tăng vọt nhiều ký tự trong 1 lần input -> chặn (extension auto-text / autofill)
      if (delta > MAX_SINGLE_INPUT_CHARS) {
        this.input.value = this.typed;
        TB.toast('Không được dùng công cụ tự động điền (auto-text)!', true);
        this.onCheatAttempt('Tự động điền ' + delta + ' ký tự cùng lúc');
        return;
      }
      this.setTyped(raw);
    }

    isBuiltin() {
      const m = this.getMethod();
      return m === 'telex' || m === 'vni';
    }

    setTyped(value, silent) {
      let arr = Array.from(String(value).normalize('NFC'));
      if (arr.length > this.target.length) arr = arr.slice(0, this.target.length);
      this.typed = arr.join('');
      this.typedArr = arr;
      if (this.input.value !== this.typed) this.input.value = this.typed;
      try {
        const end = this.input.value.length;
        this.input.setSelectionRange(end, end);
        this.input.scrollTop = this.input.scrollHeight;
      } catch (_) {}
      this.render();
      if (!silent) this.onChange(this.typed);
    }

    // ---------- hiển thị ----------
    render() {
      const typed = Array.from(VN.canonical(this.typed));
      const len = typed.length;
      const target = this.target;
      const complete = len >= target.length;
      const wordStart = complete ? len : typed.lastIndexOf(' ') + 1;
      const from = Math.max(0, Math.min(this.prevLen, len) - 60);
      const to = Math.min(target.length - 1, Math.max(this.prevLen, len) + 1);
      for (let i = from; i <= to; i++) {
        let cls = '';
        if (i < len) {
          if (typed[i] === target[i]) cls = 'ok';
          else if (i >= wordStart && VN.skeleton(typed[i]) === VN.skeleton(target[i])) cls = 'partial';
          else cls = 'bad';
        } else if (i === len) cls = 'cur';
        if (this.classes[i] !== cls) {
          this.classes[i] = cls;
          this.spans[i].className = cls;
        }
      }
      this.prevLen = len;
      this.scrollToCaret(Math.min(len, target.length - 1));
    }

    scrollToCaret(idx) {
      const span = this.spans[idx];
      if (!span) return;
      const box = this.passageEl;
      const lineH = parseFloat(getComputedStyle(box).lineHeight) || 34;
      const top = span.offsetTop - box.offsetTop;
      const desired = Math.max(0, top - lineH);
      if (Math.abs(box.scrollTop - desired) > lineH / 2) box.scrollTop = desired;
    }

    stats() {
      const typed = Array.from(VN.canonical(this.typed));
      let correct = 0;
      for (let i = 0; i < typed.length; i++) if (typed[i] === this.target[i]) correct++;
      return { correct, typedLen: typed.length, total: this.target.length };
    }
  }

  window.TypingBox = TypingBox;
})();
