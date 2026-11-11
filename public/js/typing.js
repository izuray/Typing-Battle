/*
 * typing.js - Bảo vệ đa lớp chống F12 (kể cả khi bóp mạng), chống đọc DOM/Canvas,
 *             chống giải mã Vector Glyphs và chống Python Auto-typer (pynput/pyautogui/keyboard).
 *
 * Các lớp bảo vệ:
 *  1. Nhận kho hàm Native C++ từ Inline Head Guard (`window.__takeNativeVault()`) chạy ở mili-giây 0
 *     ngay trong thẻ <head> trước khi bất kỳ script Console nào kịp can thiệp.
 *  2. Đặt <canvas> bên trong Closed Shadow DOM (`attachShadow({ mode: 'closed' })`) và vô hiệu hoá
 *     toàn bộ `toDataURL`, `toBlob`, `getImageData` -> Không thể tìm thấy <canvas> từ DOM hay chụp ảnh để OCR.
 *  3. Streaming Vector Glyphs theo cửa sổ trượt (`appendGlyphs`): chỉ giữ một phần đoạn văn đang gõ,
 *     gõ tới đâu server mới truyền tiếp nét vẽ tới đó.
 *  4. Phát hiện mở F12 (DevTools) bằng độ lệch chuẩn hoá theo máy (Baseline Calibration) + Console Trap.
 *  5. Chặn đứng Python Auto-typer:
 *     - Chặn sự kiện `keydown` bơm ký tự Unicode tiếng Việt dựng sẵn (`KEYEVENTF_UNICODE`, `e.code === ''`).
 *     - Khóa ô gõ 3 giây khi rời cửa sổ thi (`window.blur` / `Alt+Tab` sang Python/VS Code) và bắt quả tang
 *       nếu có luồng phím tự động bắn vào ngay khi vừa chuyển cửa sổ.
 */
(function () {
  'use strict';

  // --- 1. Lấy kho hàm Native C++ đã được niêm phong từ đầu <head> (nếu có) ---
  const vault = (typeof window !== 'undefined' && typeof window.__takeNativeVault === 'function')
    ? window.__takeNativeVault()
    : {};

  const nativeValueDesc = vault.valueDesc || (function () {
    try {
      return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') ||
             Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    } catch (_) {
      return null;
    }
  })();

  const nativeAttachShadow = vault.attachShadow || (
    (typeof Element !== 'undefined' && Element.prototype.attachShadow)
      ? Element.prototype.attachShadow
      : null
  );
  const nativeFill = vault.fill || (
    (typeof CanvasRenderingContext2D !== 'undefined') ? CanvasRenderingContext2D.prototype.fill : null
  );
  const nativeFillText = vault.fillText || (
    (typeof CanvasRenderingContext2D !== 'undefined') ? CanvasRenderingContext2D.prototype.fillText : null
  );
  const nativeMeasureText = vault.measureText || (
    (typeof CanvasRenderingContext2D !== 'undefined') ? CanvasRenderingContext2D.prototype.measureText : null
  );
  const nativeFillRect = vault.fillRect || (
    (typeof CanvasRenderingContext2D !== 'undefined') ? CanvasRenderingContext2D.prototype.fillRect : null
  );
  const nativeClearRect = vault.clearRect || (
    (typeof CanvasRenderingContext2D !== 'undefined') ? CanvasRenderingContext2D.prototype.clearRect : null
  );
  const NativePath2D = vault.Path2D || ((typeof Path2D !== 'undefined') ? Path2D : null);
  const NativeWeakMap = vault.WeakMap || WeakMap;

  const nativeNow = (typeof performance !== 'undefined' && performance.now)
    ? performance.now.bind(performance)
    : Date.now.bind(Date);

  // Vô hiệu hoá hoàn toàn việc trích xuất hình ảnh từ mọi thẻ <canvas> để chống Python OCR
  (function disableCanvasExtraction() {
    try {
      if (typeof HTMLCanvasElement !== 'undefined') {
        HTMLCanvasElement.prototype.toDataURL = function () { return 'data:,'; };
        HTMLCanvasElement.prototype.toBlob = function (cb) { if (typeof cb === 'function') cb(null); };
        if (HTMLCanvasElement.prototype.captureStream) {
          HTMLCanvasElement.prototype.captureStream = function () { return null; };
        }
      }
      if (typeof CanvasRenderingContext2D !== 'undefined') {
        CanvasRenderingContext2D.prototype.getImageData = function (_x, _y, w, h) {
          return new ImageData(Math.max(1, w || 1), Math.max(1, h || 1));
        };
      }
    } catch (_) {}
  })();

  /**
   * Kiểm tra sự kiện bàn phím có phải do phần cứng/trình duyệt tạo ra thật hay không.
   */
  function isGenuineTrustedEvent(e) {
    if (!e || typeof e !== 'object') return false;
    if (typeof Event !== 'undefined' && !(e instanceof Event)) return false;
    if (e.isTrusted !== true) return false;
    try {
      const desc = Object.getOwnPropertyDescriptor(e, 'isTrusted');
      if (desc) {
        if (desc.configurable === true) return false;
        if ('value' in desc) return false;
        if (typeof desc.get === 'function') return desc.get.call(e) === true;
      }
    } catch (_) {}
    return e.isTrusted === true;
  }

  // --- 2. Chặn phím tắt F12 / DevTools & Phát hiện mở F12 theo độ lệch chuẩn hoá (Baseline) ---
  let devtoolsOpen = false;
  const devtoolsListeners = new Set();

  function setupAntiDevTools() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    window.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    }, true);

    window.addEventListener('keydown', (e) => {
      const key = (e.key || '').toUpperCase();
      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      const blocked =
        e.key === 'F12' ||
        e.keyCode === 123 ||
        (ctrlOrMeta && e.shiftKey && ['I', 'J', 'C', 'K'].includes(key)) ||
        (ctrlOrMeta && ['U', 'S'].includes(key));
      if (blocked) {
        e.preventDefault();
        e.stopPropagation();
        devtoolsListeners.forEach((fn) => fn('Bấm phím tắt mở F12/DevTools', devtoolsOpen));
        if (typeof TB !== 'undefined' && TB.toast) {
          TB.toast('🚫 Không được sử dụng công cụ F12 (DevTools) trong phòng thi!', true);
        }
        return false;
      }
    }, true);

    let banner = null;
    function ensureBanner() {
      if (banner) return banner;
      banner = document.createElement('div');
      banner.className = 'overlay hidden';
      banner.style.zIndex = '9999';
      banner.style.background = 'rgba(20, 6, 14, 0.96)';
      banner.style.padding = '24px';
      banner.style.textAlign = 'center';
      banner.innerHTML =
        '<div style="font-size:4rem">🚫</div>' +
        '<h2 style="color:#ff5c7a;font-size:1.8rem;margin:8px 0">PHÁT HIỆN ĐANG MỞ F12 (DEVTOOLS)!</h2>' +
        '<p style="max-width:520px;color:#e8eaf6">Đoạn văn và ô gõ đã bị khoá để chống gian lận. ' +
        'Vui lòng <b>đóng cửa sổ F12 (DevTools)</b> ngay lập tức để tiếp tục làm bài.<br>' +
        '<span class="small muted">Hệ thống đã ghi nhận cảnh báo về bảng điều khiển của giảng viên.</span></p>';
      document.body.appendChild(banner);
      return banner;
    }

    // Ghi nhận độ chênh lệch khung cửa sổ ban đầu làm mốc chuẩn cho máy của sinh viên
    // (nhờ đó máy Windows phóng to DPI 125%-150% hay có sẵn Sidebar không bị báo nhầm)
    let baseW = Math.max(0, window.outerWidth - window.innerWidth);
    let baseH = Math.max(0, window.outerHeight - window.innerHeight);
    let lastOuterW = window.outerWidth;
    let lastOuterH = window.outerHeight;

    function checkDevTools() {
      const curW = Math.max(0, window.outerWidth - window.innerWidth);
      const curH = Math.max(0, window.outerHeight - window.innerHeight);

      // Nếu người dùng thu phóng cả cửa sổ trình duyệt (outerWidth thay đổi), cập nhật lại mốc chuẩn
      if (Math.abs(window.outerWidth - lastOuterW) > 10 || Math.abs(window.outerHeight - lastOuterH) > 10) {
        lastOuterW = window.outerWidth;
        lastOuterH = window.outerHeight;
        if (curW < baseW) baseW = curW;
        if (curH < baseH) baseH = curH;
      }

      // Khi mở F12 dạng gắn liền (docked), outerWidth giữ nguyên nhưng innerWidth/innerHeight sụt giảm mạnh (> 165px)
      const dockedNow = (curW - baseW > 165) || (curH - baseH > 165) || (curW > 420) || (curH > 420);

      // Kiểm tra bằng console getter trap (phát hiện cả khi mở sẵn F12 hoặc tách cửa sổ rời)
      let consoleTrapped = false;
      try {
        const err = new Error();
        Object.defineProperty(err, 'stack', {
          configurable: true,
          get: function () {
            consoleTrapped = true;
            return '';
          }
        });
        console.debug(err);
      } catch (_) {}

      const isOpen = dockedNow || consoleTrapped;
      if (isOpen !== devtoolsOpen) {
        devtoolsOpen = isOpen;
        const b = ensureBanner();
        b.classList.toggle('hidden', !isOpen);
        devtoolsListeners.forEach((fn) => fn('Mở cửa sổ F12 (DevTools)', isOpen));
      }
    }

    setInterval(checkDevTools, 650);
    window.addEventListener('resize', checkDevTools);
  }

  setupAntiDevTools();

  const VN_PRECOMPOSED_RE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
  const MAX_SINGLE_INPUT_CHARS = 8;
  const PRIV = new NativeWeakMap();

  class TypingBox {
    constructor(opts) {
      const state = {
        passageEl: opts.passageEl,
        input: opts.inputEl,
        examMode: !!opts.examMode,
        getMethod: opts.getMethod || (() => 'telex'),
        onChange: opts.onChange || (() => {}),
        onCheatAttempt: opts.onCheatAttempt || (() => {}),
        mode: 'text', // 'text' | 'glyphs'
        target: [],
        totalLen: 0,
        glyphPack: null,
        pathMap: new Map(),
        spaceSet: new Set(),
        serverStates: '',
        serverCorrect: 0,
        serverMistakes: 0,
        typed: '',
        typedArr: [],
        enabled: false,
        lastKeyDownAt: 0,
        downMap: new Map(),
        telemetry: [],
        canvas: null,
        ctx: null,
        scrollY: 0,
        reportedDevtools: false,
        focusLockUntil: 0,
        blockedWhileLocked: 0,
        unicodeInjectCount: 0,
        lastUnicodeInjectAt: 0
      };
      PRIV.set(this, state);
      this._initCanvas(state);
      this._lockInputElement(state);
      this._bindEvents(state);
      this._bindFocusGuard(state);

      devtoolsListeners.add((reason, isOpen) => {
        this._render(state);
        if (state.enabled && !state.reportedDevtools) {
          state.reportedDevtools = true;
          state.onCheatAttempt(reason);
          setTimeout(() => { state.reportedDevtools = false; }, 4000);
        }
        if (!isOpen && state.enabled) this.focus();
      });
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
        Object.defineProperty(state.input, 'value', {
          configurable: false,
          enumerable: true,
          get: function () {
            return nativeValueDesc.get.call(state.input);
          },
          set: function (_externalVal) {
            state.onCheatAttempt('Phát hiện script can thiệp trực tiếp vào ô gõ (.value)');
            if (typeof TB !== 'undefined' && TB.toast) {
              TB.toast('⚠️ Phát hiện can thiệp bằng mã JavaScript!', true);
            }
            return nativeValueDesc.get.call(state.input);
          }
        });
      } catch (_) {}
    }

    /**
     * Khởi tạo Canvas bên trong Closed Shadow DOM (`mode: 'closed'`):
     * `document.querySelector('canvas')` và `passageEl.shadowRoot` đều trả về `null`,
     * ngăn chặn hoàn toàn các đoạn mã JS ngoài Console truy cập vào phần tử Canvas.
     */
    _initCanvas(state) {
      if (typeof document === 'undefined' || !state.passageEl) return;
      state.passageEl.innerHTML = '';
      state.passageEl.removeAttribute('aria-label');
      state.passageEl.style.padding = '0';

      const canvas = document.createElement('canvas');
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';

      let hostRoot = state.passageEl;
      if (nativeAttachShadow) {
        try {
          hostRoot = nativeAttachShadow.call(state.passageEl, { mode: 'closed' });
        } catch (_) {
          hostRoot = state.passageEl;
        }
      }
      hostRoot.appendChild(canvas);
      state.canvas = canvas;
      state.ctx = canvas.getContext('2d');

      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => this._render(state));
        ro.observe(state.passageEl);
      } else if (typeof window !== 'undefined') {
        window.addEventListener('resize', () => this._render(state));
      }
    }

    /**
     * Chống sinh viên chuyển cửa sổ (Alt+Tab) sang VS Code / Terminal để bấm chạy script Python:
     * Khi cửa sổ mất tiêu điểm trong lúc đang thi, tạm khóa ô gõ 3 giây khi quay lại.
     * Nếu script Python tự động bắn phím trong lúc đang khóa -> bắt quả tang ngay lập tức!
     */
    _bindFocusGuard(state) {
      if (typeof window === 'undefined' || !state.examMode) return;
      let blurredInExam = false;
      window.addEventListener('blur', () => {
        if (!state.enabled) return;
        blurredInExam = true;
        state.focusLockUntil = nativeNow() + 2800;
        state.blockedWhileLocked = 0;
        state.onCheatAttempt('Rời khỏi cửa sổ trang thi trong lúc đang làm bài (Alt+Tab / Chuyển cửa sổ)');
        this._render(state);
      });
      window.addEventListener('focus', () => {
        if (!state.enabled || !blurredInExam) return;
        blurredInExam = false;
        state.focusLockUntil = nativeNow() + 2500;
        state.blockedWhileLocked = 0;
        if (typeof TB !== 'undefined' && TB.toast) {
          TB.toast('⚠️ Bạn vừa rời khỏi cửa sổ thi! Ô gõ tạm khóa 2.5 giây để chống công cụ tự động.', true);
        }
        this._render(state);
        setTimeout(() => {
          this._render(state);
          if (state.enabled) this.focus();
        }, 2550);
      });
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
        if (!state.enabled || devtoolsOpen || nativeNow() < state.focusLockUntil) {
          e.preventDefault();
          return;
        }
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

    /** Dùng cho chế độ Tự luyện cá nhân trên trang chủ */
    setPassage(text, typed) {
      const state = PRIV.get(this);
      if (!state) return;
      state.mode = 'text';
      state.target = Array.from(VN.canonical(text));
      state.totalLen = state.target.length;
      state.glyphPack = null;
      state.pathMap.clear();
      state.spaceSet.clear();
      state.serverStates = '';
      state.scrollY = 0;
      state.telemetry = [];
      state.downMap.clear();
      state.lastKeyDownAt = 0;
      this.setTyped(typed || '', true);
    }

    /**
     * Dùng cho Phòng thi (Lớp học & Battle 1v1):
     * Nhận gói Vector Glyphs cửa sổ đầu tiên từ Server.
     */
    setGlyphs(glyphPack, typed, charStates) {
      const state = PRIV.get(this);
      if (!state) return;
      state.mode = 'glyphs';
      state.target = [];
      state.glyphPack = glyphPack || null;
      state.totalLen = glyphPack && glyphPack.total ? glyphPack.total : 0;
      state.pathMap.clear();
      state.spaceSet.clear();
      if (glyphPack && Array.isArray(glyphPack.spaces)) {
        for (let i = 0; i < glyphPack.spaces.length; i++) {
          state.spaceSet.add(glyphPack.spaces[i]);
        }
      }
      if (glyphPack && Array.isArray(glyphPack.paths) && NativePath2D) {
        for (let i = 0; i < glyphPack.paths.length; i++) {
          const pair = glyphPack.paths[i];
          if (pair && pair[1]) {
            state.pathMap.set(pair[0], new NativePath2D(pair[1]));
          }
        }
      }
      state.serverStates = String(charStates || '');
      state.scrollY = 0;
      state.telemetry = [];
      state.downMap.clear();
      state.lastKeyDownAt = 0;
      this.setTyped(typed || '', true);
    }

    /** Nối thêm các nét vẽ Vector Glyphs mới khi sinh viên gõ tiến lên (Sliding Window) */
    appendGlyphs(nextPaths) {
      const state = PRIV.get(this);
      if (!state || !Array.isArray(nextPaths) || !NativePath2D) return;
      for (let i = 0; i < nextPaths.length; i++) {
        const pair = nextPaths[i];
        if (pair && pair[1]) {
          state.pathMap.set(pair[0], new NativePath2D(pair[1]));
        }
      }
      this._render(state);
    }

    /** Cập nhật màu đúng/sai của từng ký tự từ phản hồi của Server */
    setServerState(charStates, correct, mistakes) {
      const state = PRIV.get(this);
      if (!state) return;
      if (typeof charStates === 'string') state.serverStates = charStates;
      if (typeof correct === 'number') state.serverCorrect = correct;
      if (typeof mistakes === 'number') state.serverMistakes = mistakes;
      this._render(state);
    }

    enable(on) {
      const state = PRIV.get(this);
      if (!state) return;
      state.enabled = !!on;
      state.input.disabled = !on;
      if (!on) state.focusLockUntil = 0;
      if (on) this.focus();
      else state.input.blur();
      this._render(state);
    }

    get enabled() {
      const state = PRIV.get(this);
      return !!(state && state.enabled);
    }

    get typed() {
      const state = PRIV.get(this);
      return state ? state.typed : '';
    }

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
      if (!state.enabled || devtoolsOpen || nativeNow() < state.focusLockUntil) return;
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
      if (!state.enabled || devtoolsOpen) { e.preventDefault(); return; }

      // Nếu vừa chuyển từ cửa sổ ngoài (Python/VS Code) vào trong lúc đang khóa 2.5s mà có phím bắn liên tục:
      if (nativeNow() < state.focusLockUntil) {
        e.preventDefault();
        state.blockedWhileLocked++;
        if (state.blockedWhileLocked === 5) {
          state.onCheatAttempt('Phát hiện công cụ ngoài (Python/Auto-typer) tự động bắn phím ngay sau khi chuyển cửa sổ');
        }
        return;
      }

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

      // Chặn công cụ ngoài (Python pynput/keyboard/SendInput Unicode) bắn trực tiếp ký tự tiếng Việt có sẵn dấu
      // khi đang ở chế độ bộ gõ Telex/VNI trên web (hoặc sự kiện không có mã phím phần cứng e.code):
      if (e.key && e.key.length === 1 && this._isBuiltin(state)) {
        const isPrecomposedVN = VN_PRECOMPOSED_RE.test(e.key);
        const noHardwareCode = !e.code || e.code === '';
        if (isPrecomposedVN || noHardwareCode) {
          e.preventDefault();
          const now = nativeNow();
          if (now - state.lastUnicodeInjectAt < 1200) {
            state.unicodeInjectCount++;
          } else {
            state.unicodeInjectCount = 1;
          }
          state.lastUnicodeInjectAt = now;
          if (state.unicodeInjectCount >= 4) {
            state.unicodeInjectCount = 0;
            state.onCheatAttempt('Phát hiện công cụ ngoài (Python/Auto-typer) bơm chuỗi ký tự Unicode không qua bàn phím');
            if (typeof TB !== 'undefined' && TB.toast) {
              TB.toast('🚫 Phát hiện công cụ tự động bơm ký tự Unicode!', true);
            }
          } else if (typeof TB !== 'undefined' && TB.toast) {
            TB.toast('💡 Hãy tắt Unikey/EVKey khi đang chọn bộ gõ Telex/VNI trên web (hoặc chuyển sang nút "Bộ gõ máy")!', true);
          }
          return;
        }
      }

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
      if (state.totalLen > 0 && state.typedArr.length >= state.totalLen) return;
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
      if (!state.enabled || devtoolsOpen || nativeNow() < state.focusLockUntil) {
        this._setInputValue(state, state.typed);
        return;
      }
      if (!isGenuineTrustedEvent(e)) {
        this._setInputValue(state, state.typed);
        state.onCheatAttempt('Phát hiện sự kiện input giả lập từ script/extension');
        return;
      }
      const sinceKey = nativeNow() - state.lastKeyDownAt;
      if (sinceKey > 1500 && state.lastKeyDownAt > 0) {
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
      if (state.totalLen > 0 && arr.length > state.totalLen) {
        arr = arr.slice(0, state.totalLen);
      }
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

    /** Vẽ đoạn văn mẫu bằng các hàm Canvas native C++ đã lưu */
    _render(state) {
      const canvas = state.canvas;
      const ctx = state.ctx;
      if (!canvas || !ctx || !nativeFillText || !nativeMeasureText) return;

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
      nativeClearRect.call(ctx, 0, 0, width, height);

      const fontSize = 21;
      const lineH = 36;
      const padX = 20;
      const padY = 14;
      ctx.font = '600 ' + fontSize + 'px "JetBrains Mono", "Cascadia Code", Consolas, monospace';
      ctx.textBaseline = 'top';

      if (devtoolsOpen) {
        ctx.fillStyle = '#ff5c7a';
        nativeFillText.call(ctx, '🚫 Đã ẩn đoạn văn vì phát hiện mở F12 (DevTools).', padX, padY + lineH);
        ctx.restore();
        return;
      }

      if (nativeNow() < state.focusLockUntil) {
        ctx.fillStyle = '#ffc857';
        nativeFillText.call(ctx, '⚠️ Đang tạm khóa 2.5 giây do bạn vừa chuyển ra ngoài cửa sổ thi...', padX, padY + lineH);
        ctx.restore();
        return;
      }

      if (state.mode === 'glyphs') {
        this._renderGlyphs(state, ctx, width, height, padX, padY);
        ctx.restore();
        return;
      }

      const target = state.target;
      const typed = Array.from(VN.canonical(state.typed));
      const len = typed.length;
      const complete = len >= target.length;
      const wordStart = complete ? len : typed.lastIndexOf(' ') + 1;

      const maxX = width - padX;
      const pos = new Array(target.length);
      let x = padX;
      let y = padY;
      let i = 0;
      while (i < target.length) {
        if (target[i] === ' ') {
          const w = nativeMeasureText.call(ctx, ' ').width;
          if (x + w > maxX) { x = padX; y += lineH; }
          pos[i] = { x, y, w };
          x += w;
          i++;
        } else {
          let j = i;
          let wordW = 0;
          const charWidths = [];
          while (j < target.length && target[j] !== ' ') {
            const cw = nativeMeasureText.call(ctx, target[j]).width;
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

      const caretIdx = Math.min(len, Math.max(0, target.length - 1));
      const caretPos = pos[caretIdx] || { x: padX, y: padY };
      state.scrollY = Math.max(0, caretPos.y - padY - lineH);

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
            nativeFillRect.call(ctx, p.x - 1, drawY - 2, p.w + 2, fontSize + 6);
            ctx.fillStyle = '#ffffff';
          }
        } else if (idx === len) {
          ctx.fillStyle = 'rgba(108, 123, 255, 0.28)';
          nativeFillRect.call(ctx, p.x - 1, drawY - 2, p.w + 2, fontSize + 6);
          ctx.fillStyle = '#ffc857';
          nativeFillRect.call(ctx, p.x - 1, drawY - 2, 2.5, fontSize + 6);
          ctx.fillStyle = '#ffffff';
        } else {
          ctx.fillStyle = '#7e86b8';
        }
        nativeFillText.call(ctx, ch, p.x, drawY);
      }

      ctx.restore();
    }

    /** Vẽ các đường cong Vector đa hình (Path2D) từ server theo cửa sổ trượt */
    _renderGlyphs(state, ctx, width, height, padX, padY) {
      const pack = state.glyphPack;
      if (!pack || !pack.total || !nativeFill) {
        ctx.fillStyle = '#9aa3d4';
        nativeFillText.call(ctx, '⏳ Đang chờ bắt đầu vòng thi...', padX, padY + 24);
        return;
      }

      const total = pack.total;
      const m = pack.metrics || { adv: 13.2, lineH: 40, scale: 4, size: 22 };
      const cw = m.adv;
      const lineH = m.lineH;
      const invScale = 1 / (m.scale || 4);
      const typed = Array.from(VN.canonical(state.typed));
      const len = typed.length;
      const states = state.serverStates || '';
      const hasSpacesList = state.spaceSet.size > 0;

      const isSpaceAt = (idx) => hasSpacesList ? state.spaceSet.has(idx) : !state.pathMap.has(idx);

      const maxX = width - padX;
      const pos = new Array(total);
      let x = padX;
      let y = padY;
      let i = 0;

      while (i < total) {
        if (isSpaceAt(i)) {
          if (x + cw > maxX) { x = padX; y += lineH; }
          pos[i] = { x, y, w: cw };
          x += cw;
          i++;
        } else {
          let j = i;
          while (j < total && !isSpaceAt(j)) j++;
          const wordLen = j - i;
          const wordW = wordLen * cw;
          if (x > padX && x + wordW > maxX) {
            x = padX;
            y += lineH;
          }
          for (let k = 0; k < wordLen; k++) {
            if (x + cw > maxX && x > padX) { x = padX; y += lineH; }
            pos[i + k] = { x, y, w: cw };
            x += cw;
          }
          i = j;
        }
      }

      const caretIdx = Math.min(len, Math.max(0, total - 1));
      const caretPos = pos[caretIdx] || { x: padX, y: padY };
      state.scrollY = Math.max(0, caretPos.y - padY - lineH);

      for (let idx = 0; idx < total; idx++) {
        const p = pos[idx];
        const drawY = p.y - state.scrollY;
        if (drawY + lineH < 0 || drawY > height) continue;

        const stChar = idx < states.length ? states[idx] : '';
        if (idx < len) {
          if (stChar === '1') {
            ctx.fillStyle = '#3ddc97';
          } else if (stChar === '2') {
            ctx.fillStyle = '#ffc857';
          } else if (stChar === '0') {
            ctx.fillStyle = 'rgba(255, 92, 122, 0.85)';
            nativeFillRect.call(ctx, p.x - 1, drawY + 6, p.w + 2, m.size + 8);
            ctx.fillStyle = '#ffffff';
          } else {
            ctx.fillStyle = '#c5cff8';
          }
        } else if (idx === len) {
          ctx.fillStyle = 'rgba(108, 123, 255, 0.28)';
          nativeFillRect.call(ctx, p.x - 1, drawY + 6, p.w + 2, m.size + 8);
          ctx.fillStyle = '#ffc857';
          nativeFillRect.call(ctx, p.x - 1, drawY + 6, 2.5, m.size + 8);
          ctx.fillStyle = '#ffffff';
        } else {
          ctx.fillStyle = '#8b93c6';
        }

        const path2d = state.pathMap.get(idx);
        if (path2d) {
          ctx.save();
          ctx.translate(p.x, drawY);
          ctx.scale(invScale, invScale);
          nativeFill.call(ctx, path2d);
          ctx.restore();
        } else if (!isSpaceAt(idx)) {
          // Những từ ở xa phía sau chưa được Server stream xuống chỉ hiện chấm mờ
          ctx.fillStyle = 'rgba(139, 147, 198, 0.25)';
          nativeFillRect.call(ctx, p.x + 3, drawY + 20, Math.max(3, cw - 6), 3);
        }
      }
    }

    stats() {
      const state = PRIV.get(this);
      if (!state) return { correct: 0, typedLen: 0, total: 0, mistakes: 0 };
      const typed = Array.from(VN.canonical(state.typed));
      if (state.mode === 'glyphs') {
        let correct = 0;
        const st = state.serverStates || '';
        for (let i = 0; i < typed.length && i < st.length; i++) {
          if (st[i] === '1') correct++;
        }
        return {
          correct,
          mistakes: state.serverMistakes || 0,
          typedLen: typed.length,
          total: state.totalLen
        };
      }
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
