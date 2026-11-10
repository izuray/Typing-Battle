/*
 * vn.js - Xử lý tiếng Việt dùng chung cho server (Node) và trình duyệt.
 *  - canonical(): chuẩn hoá văn bản (NFC, dấu câu, vị trí dấu thanh) để so sánh công bằng
 *    giữa "hoà" / "hòa", "thuý" / "thúy"...
 *  - applyKey(): bộ gõ Telex / VNI tích hợp (không cần cài Unikey).
 *  - score(): chấm số ký tự đúng / sai.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VN = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TABLE = {
    a: 'aáàảãạ', 'ă': 'ăắằẳẵặ', 'â': 'âấầẩẫậ',
    e: 'eéèẻẽẹ', 'ê': 'êếềểễệ',
    i: 'iíìỉĩị',
    o: 'oóòỏõọ', 'ô': 'ôốồổỗộ', 'ơ': 'ơớờởỡợ',
    u: 'uúùủũụ', 'ư': 'ưứừửữự',
    y: 'yýỳỷỹỵ'
  };

  const INFO = {};    // ký tự -> { base, tone, upper }
  const COMPOSE = {}; // base -> [6 dạng thanh]
  Object.keys(TABLE).forEach(function (rawBase) {
    const base = rawBase.normalize('NFC');
    const forms = Array.from(TABLE[rawBase].normalize('NFC'));
    COMPOSE[base] = forms;
    forms.forEach(function (ch, tone) {
      INFO[ch] = { base: base, tone: tone, upper: false };
      INFO[ch.toUpperCase()] = { base: base, tone: tone, upper: true };
    });
  });

  function compose(base, tone, upper) {
    const ch = COMPOSE[base][tone];
    return upper ? ch.toUpperCase() : ch;
  }
  function isUpper(ch) { return ch !== ch.toLowerCase(); }
  function isVowelChar(ch) { return !!INFO[ch]; }

  /** Tách dấu thanh khỏi một từ. */
  function splitTone(word) {
    let tone = 0;
    let count = 0;
    const plain = Array.from(word).map(function (ch) {
      const inf = INFO[ch];
      if (inf && inf.tone) {
        tone = inf.tone;
        count++;
        return compose(inf.base, 0, inf.upper);
      }
      return ch;
    });
    return { plain: plain, tone: tone, count: count };
  }

  /** Vị trí đặt dấu thanh (kiểu cũ: hòa, thủy, của) trong mảng ký tự không dấu thanh. */
  function toneIndex(chars) {
    const low = chars.map(function (c) { return c.toLowerCase(); });
    let start = -1;
    for (let i = 0; i < low.length; i++) if (INFO[low[i]]) { start = i; break; }
    if (start < 0) return -1;
    // "qu" và "gi" + nguyên âm: u / i thuộc phụ âm đầu
    if (low[start] === 'u' && start > 0 && low[start - 1] === 'q' && INFO[low[start + 1]]) start++;
    else if (low[start] === 'i' && start === 1 && low[0] === 'g' && INFO[low[start + 1]]) start++;
    let end = start;
    while (end + 1 < low.length && INFO[low[end + 1]]) end++;

    let special = -1;
    for (let i = start; i <= end; i++) if ('ăâêôơư'.indexOf(low[i]) >= 0) special = i;
    if (special >= 0) return special;

    const hasFinal = end + 1 < low.length;
    const len = end - start + 1;
    if (hasFinal || len === 1) return end;
    if (len === 2) return start;
    return start + 1;
  }

  function placeTone(plain, tone) {
    const s = plain.join('');
    if (!tone) return s;
    const idx = toneIndex(plain);
    if (idx < 0) return s;
    const inf = INFO[plain[idx]];
    const out = plain.slice();
    out[idx] = compose(inf.base, tone, inf.upper);
    return out.join('');
  }

  function canonicalWord(word) {
    const r = splitTone(word);
    if (r.count !== 1) return word;
    return placeTone(r.plain, r.tone);
  }

  /** Chuẩn hoá (giữ nguyên độ dài theo ký tự NFC). */
  function normalize(text) {
    return String(text || '')
      .normalize('NFC')
      .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
      .replace(/[\u2018\u2019\u201A]/g, "'")
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/[\u00A0\u2007\u202F\t\r\n]/g, ' ');
  }

  function canonical(text) {
    return normalize(text).replace(/\p{L}+/gu, canonicalWord);
  }

  /** Bỏ hết dấu (kể cả mũ, móc, đ) của 1 ký tự - dùng để hiển thị "đang gõ dở". */
  function skeleton(ch) {
    return ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
  }

  /** So từng ký tự: typed và target đều đã canonical. */
  function score(target, typed) {
    const t = Array.from(target);
    const u = Array.from(typed);
    const n = Math.min(t.length, u.length);
    let correct = 0;
    for (let i = 0; i < n; i++) if (t[i] === u[i]) correct++;
    return { correct: correct, typedLen: n, errors: n - correct, total: t.length };
  }

  // ------------------------------------------------------------------ Bộ gõ
  function setBase(chars, i, newBase) {
    const out = chars.slice();
    out[i] = compose(newBase, 0, isUpper(chars[i]));
    return out;
  }
  function lastIndexIn(chars, list) {
    for (let i = chars.length - 1; i >= 0; i--) if (list.indexOf(chars[i].toLowerCase()) >= 0) return i;
    return -1;
  }
  function findUO(chars) {
    const low = chars.map(function (c) { return c.toLowerCase(); });
    for (let i = 0; i < low.length - 1; i++) {
      if (i > 0 && low[i - 1] === 'q') continue;
      const a = low[i], b = low[i + 1];
      if ((a === 'u' || a === 'ư') && (b === 'o' || b === 'ơ')) return { i: i, done: a === 'ư' && b === 'ơ' };
    }
    return null;
  }
  function modD(chars) {
    if (!chars.length) return null;
    const c = chars[0];
    if (c === 'd' || c === 'D') { const o = chars.slice(); o[0] = c === 'D' ? 'Đ' : 'đ'; return { chars: o }; }
    if (c === 'đ' || c === 'Đ') { const o = chars.slice(); o[0] = c === 'Đ' ? 'D' : 'd'; return { chars: o, revert: true }; }
    return null;
  }
  function modHat(chars, letter) {
    const hat = { a: 'â', e: 'ê', o: 'ô' };
    const list = letter ? [letter, hat[letter]].concat(letter === 'a' ? ['ă'] : letter === 'o' ? ['ơ'] : [])
      : ['a', 'e', 'o', 'â', 'ê', 'ô', 'ă', 'ơ'];
    const i = lastIndexIn(chars, list);
    if (i < 0) return null;
    const c = chars[i].toLowerCase();
    if (c === 'â' || c === 'ê' || c === 'ô') {
      return { chars: setBase(chars, i, { 'â': 'a', 'ê': 'e', 'ô': 'o' }[c]), revert: true };
    }
    const b = { a: 'a', 'ă': 'a', e: 'e', o: 'o', 'ơ': 'o' }[c];
    return { chars: setBase(chars, i, hat[b]) };
  }
  function modHorn(chars, withA, key) {
    const uo = findUO(chars);
    if (uo) {
      if (uo.done) return { chars: setBase(setBase(chars, uo.i, 'u'), uo.i + 1, 'o'), revert: true };
      return { chars: setBase(setBase(chars, uo.i, 'ư'), uo.i + 1, 'ơ') };
    }
    const list = withA ? ['o', 'u', 'a', 'ơ', 'ư', 'ă'] : ['o', 'u', 'ơ', 'ư'];
    const i = lastIndexIn(chars, list);
    if (i >= 0) {
      const c = chars[i].toLowerCase();
      const map = { o: 'ơ', u: 'ư', a: 'ă' };
      const back = { 'ơ': 'o', 'ư': 'u', 'ă': 'a' };
      if (back[c]) return { chars: setBase(chars, i, back[c]), revert: true };
      return { chars: setBase(chars, i, map[c]) };
    }
    // Telex: "w" đứng riêng -> ư (vd: nhw -> như)
    if (withA && key) {
      const hasVowel = chars.some(function (c) { return isVowelChar(c); });
      if (!hasVowel) return { chars: chars.concat(isUpper(key) ? 'Ư' : 'ư') };
    }
    return null;
  }
  function modBreve(chars) {
    const i = lastIndexIn(chars, ['a', 'ă', 'â']);
    if (i < 0) return null;
    if (chars[i].toLowerCase() === 'ă') return { chars: setBase(chars, i, 'a'), revert: true };
    return { chars: setBase(chars, i, 'ă') };
  }

  const TONES = {
    telex: { s: 1, f: 2, r: 3, x: 4, j: 5, z: 0 },
    vni: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '0': 0 }
  };

  /**
   * Gõ thêm phím `key` vào từ đang gõ `word` theo kiểu `method` ('telex' | 'vni').
   * Trả về từ mới.
   */
  function applyKey(word, key, method) {
    method = method === 'vni' ? 'vni' : 'telex';
    const k = key.toLowerCase();
    const r = splitTone(word);
    const plain = r.plain;
    const hasVowel = plain.some(function (c) { return isVowelChar(c); });
    const tones = TONES[method];

    if (Object.prototype.hasOwnProperty.call(tones, k) && hasVowel) {
      const t = tones[k];
      if (t === 0) return r.tone === 0 ? word + key : plain.join('');
      if (r.tone === t) return plain.join('') + key; // gõ lặp -> bỏ dấu, giữ phím
      return placeTone(plain, t);
    }

    let res = null;
    if (method === 'telex') {
      if (k === 'd') res = modD(plain);
      else if (k === 'a' || k === 'e' || k === 'o') res = modHat(plain, k);
      else if (k === 'w') res = modHorn(plain, true, key);
    } else {
      if (k === '6') res = modHat(plain, null);
      else if (k === '7') res = modHorn(plain, false, null);
      else if (k === '8') res = modBreve(plain);
      else if (k === '9') res = modD(plain);
    }
    if (!res) return word + key;
    const out = placeTone(res.chars, r.tone);
    return res.revert ? out + key : out;
  }

  return {
    normalize: normalize,
    canonical: canonical,
    canonicalWord: canonicalWord,
    skeleton: skeleton,
    score: score,
    applyKey: applyKey
  };
});
