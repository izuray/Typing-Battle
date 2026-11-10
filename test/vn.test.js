const assert = require('assert');
const VN = require('../public/js/vn.js');

function type(seq, method) {
  // gõ từng phím, khoảng trắng kết thúc từ
  let out = '';
  let word = '';
  for (const k of seq) {
    if (k === ' ') { out += word + ' '; word = ''; continue; }
    word = VN.applyKey(word, k, method);
  }
  return out + word;
}

const telex = [
  ['tieengs vieetj', 'tiếng việt'],
  ['dduwowngf', 'đường'],
  ['nguwowif', 'người'],
  ['hoaf', 'hoà'],
  ['thuyr', 'thuỷ'],
  ['quoocs', 'quốc'],
  ['giaf', 'già'],
  ['nhw', 'như'],
  ['tooi', 'tôi'],
  ['Vieetj Nam', 'Việt Nam'],
  ['khoer', 'khoẻ'],
  ['muaf', 'mùa'],
  ['cuar', 'của'],
  ['nawng', 'năng'],
  ['ddaay', 'đây'],
  ['huwowngs', 'hướng'],
  ['laf', 'là'],
  ['ass', 'as'],
  ['truwowcs', 'trước'],
  ['nghieeng', 'nghiêng'],
  ['khuyeens', 'khuyến'],
  ['ddaij hocj', 'đại học'],
];
for (const [k, e] of telex) assert.strictEqual(VN.canonical(type(k, 'telex')), VN.canonical(e), `telex ${k}`);

const vni = [
  ['tie61ng vie65t', 'tiếng việt'],
  ['d9u7o7ng2', 'đường'],
  ['nguoi72', 'người'],
  ['ho2a', 'hoà'],
  ['a8n', 'ăn'],
];
for (const [k, e] of vni) assert.strictEqual(VN.canonical(type(k, 'vni')), VN.canonical(e), `vni ${k}`);

// chuẩn hoá vị trí dấu
assert.strictEqual(VN.canonical('hòa thủy'), VN.canonical('hoà thuỷ'));
assert.strictEqual(VN.canonical('“Xin chào”'), '"Xin chào"');
// NFD -> NFC
assert.strictEqual(VN.canonical('tiếng'.normalize('NFD')), VN.canonical('tiếng'));

const s = VN.score('abc', 'abx');
assert.deepStrictEqual([s.correct, s.errors], [2, 1]);
console.log('vn.js: all tests passed');
