/*
 * passages.js - Sinh đoạn văn ngẫu nhiên.
 *  - bank: ghép ngẫu nhiên từ kho câu có sẵn (chạy offline).
 *  - ai:   gọi Gemini API (cần biến môi trường GEMINI_API_KEY), lỗi thì tự quay về kho câu.
 *  - custom: giáo viên tự dán đoạn văn.
 */
'use strict';

const BANK = [
  // Học tập
  'Học tập là con đường ngắn nhất để thay đổi tương lai của mỗi người.',
  'Sinh viên cần biết tự đặt mục tiêu và lập kế hoạch học tập cho từng tuần.',
  'Đọc sách mỗi ngày giúp chúng ta mở rộng vốn từ và rèn luyện tư duy.',
  'Thư viện của trường luôn mở cửa đến chín giờ tối vào các ngày trong tuần.',
  'Làm việc nhóm hiệu quả đòi hỏi mỗi thành viên phải lắng nghe và chia sẻ.',
  'Trước kỳ thi, nhiều bạn thường thức khuya để ôn lại toàn bộ kiến thức.',
  'Thầy cô không chỉ truyền đạt kiến thức mà còn dạy chúng ta cách làm người.',
  'Một câu hỏi hay đôi khi có giá trị hơn rất nhiều câu trả lời vội vàng.',
  'Kỹ năng gõ phím nhanh và chính xác giúp tiết kiệm rất nhiều thời gian.',
  'Muốn đi nhanh hãy đi một mình, muốn đi xa hãy đi cùng nhau.',
  // Công nghệ
  'Trí tuệ nhân tạo đang thay đổi cách con người làm việc và học tập.',
  'Lập trình viên giỏi luôn viết mã nguồn rõ ràng và dễ bảo trì.',
  'Mạng internet giúp kết nối hàng tỷ người trên khắp thế giới với nhau.',
  'Điện thoại thông minh đã trở thành vật dụng không thể thiếu trong cuộc sống.',
  'Bảo mật thông tin cá nhân là trách nhiệm của mỗi người dùng mạng xã hội.',
  'Dữ liệu được ví như nguồn tài nguyên quý giá của thời đại số.',
  'Một mật khẩu mạnh nên có chữ hoa, chữ thường, chữ số và ký tự đặc biệt.',
  'Máy tính chỉ làm đúng những gì con người ra lệnh cho nó.',
  'Công nghệ chỉ thực sự có ý nghĩa khi phục vụ lợi ích của cộng đồng.',
  'Phần mềm mã nguồn mở được nhiều người cùng nhau xây dựng và chia sẻ.',
  // Quê hương, đất nước
  'Việt Nam có đường bờ biển dài hơn ba nghìn ki lô mét trải dài từ bắc vào nam.',
  'Vịnh Hạ Long nổi tiếng với hàng nghìn hòn đảo đá vôi lớn nhỏ khác nhau.',
  'Phố cổ Hội An về đêm lung linh trong ánh sáng của những chiếc đèn lồng.',
  'Ruộng bậc thang ở vùng núi phía bắc đẹp nhất vào mùa lúa chín.',
  'Đồng bằng sông Cửu Long được mệnh danh là vựa lúa lớn nhất cả nước.',
  'Hà Nội mùa thu có hương hoa sữa thoang thoảng trên những con phố nhỏ.',
  'Sài Gòn là thành phố trẻ trung, năng động và không bao giờ ngủ.',
  'Cố đô Huế lưu giữ nhiều di tích lịch sử và văn hóa của triều Nguyễn.',
  'Cao nguyên đá Đồng Văn là công viên địa chất toàn cầu đầu tiên của Việt Nam.',
  'Đà Lạt quanh năm mát mẻ với rừng thông xanh và những đồi hoa rực rỡ.',
  // Văn hóa, ẩm thực
  'Phở là món ăn truyền thống được nhiều du khách nước ngoài yêu thích.',
  'Tết Nguyên Đán là dịp để các thành viên trong gia đình sum họp bên nhau.',
  'Bánh chưng xanh gắn liền với truyền thuyết về hoàng tử Lang Liêu.',
  'Áo dài là trang phục truyền thống tôn vinh vẻ đẹp của người phụ nữ Việt.',
  'Ca dao và tục ngữ là kho tàng trí tuệ quý báu của ông cha ta.',
  'Uống nước nhớ nguồn là truyền thống tốt đẹp của dân tộc Việt Nam.',
  'Cà phê sữa đá là thức uống quen thuộc mỗi buổi sáng của nhiều người.',
  'Múa rối nước là loại hình nghệ thuật dân gian độc đáo của vùng đồng bằng.',
  'Tiếng Việt giàu thanh điệu nên nghe giống như một bản nhạc du dương.',
  'Mỗi vùng miền đều có những món ăn đặc sản mang hương vị riêng.',
  // Thiên nhiên, môi trường
  'Bảo vệ môi trường là bảo vệ chính cuộc sống của chúng ta.',
  'Mỗi người hãy trồng thêm một cây xanh để thành phố thêm trong lành.',
  'Rác thải nhựa đang đe dọa nghiêm trọng đến sự sống của các loài sinh vật biển.',
  'Tiết kiệm điện và nước là những việc nhỏ nhưng mang lại ý nghĩa lớn.',
  'Mùa xuân đến, cây cối đâm chồi nảy lộc và muôn hoa đua nhau khoe sắc.',
  'Cơn mưa rào mùa hạ đến rồi đi thật nhanh, để lại bầu trời trong xanh.',
  'Biến đổi khí hậu khiến thời tiết ngày càng trở nên khó dự đoán hơn.',
  'Những cánh rừng nguyên sinh là lá phổi xanh của trái đất.',
  // Cuộc sống, kỹ năng
  'Thành công không đến từ may mắn mà đến từ sự kiên trì mỗi ngày.',
  'Hãy luôn mỉm cười, vì nụ cười là món quà đẹp nhất bạn có thể trao đi.',
  'Thất bại là mẹ thành công, quan trọng là chúng ta biết đứng dậy.',
  'Quản lý thời gian tốt giúp cân bằng giữa việc học, việc làm và nghỉ ngơi.',
  'Tập thể dục đều đặn giúp cơ thể khỏe mạnh và tinh thần sảng khoái.',
  'Lòng tốt dù nhỏ bé cũng có thể làm ấm áp trái tim của người khác.',
  'Đừng so sánh bản thân với người khác, hãy so sánh với chính mình hôm qua.',
  'Có công mài sắt, có ngày nên kim.',
  'Ăn quả nhớ kẻ trồng cây, uống nước nhớ người đào giếng.',
  'Một cây làm chẳng nên non, ba cây chụm lại nên hòn núi cao.',
  'Lời nói chẳng mất tiền mua, lựa lời mà nói cho vừa lòng nhau.',
  'Người biết lắng nghe thường là người được nhiều người tin tưởng nhất.',
  'Đi một ngày đàng, học một sàng khôn.',
  'Sức khỏe là vốn quý nhất của mỗi con người.',
  'Giấc ngủ đủ và sâu giúp não bộ ghi nhớ kiến thức tốt hơn.',
  'Biết ơn những điều nhỏ bé giúp cuộc sống trở nên hạnh phúc hơn.'
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function countWords(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Số từ cần thiết để người gõ nhanh (~100 WPM) không gõ hết trong thời gian thi. */
function wordsForDuration(durationSec) {
  return Math.max(30, Math.ceil((durationSec / 60) * 100));
}

function fromBank(targetWords) {
  const parts = [];
  let words = 0;
  while (words < targetWords) {
    for (const s of shuffle(BANK)) {
      parts.push(s);
      words += countWords(s);
      if (words >= targetWords) break;
    }
  }
  return parts.join(' ');
}

/** Dọn đoạn văn: một dòng, bỏ ký tự lạ, gộp khoảng trắng. */
function clean(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[*_#`>|~\[\]{}<>]/g, '')
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\p{L}\p{N}\s.,;:!?'"()\-%/]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

async function fromAI(targetWords, topic) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Chưa cấu hình GEMINI_API_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const prompt =
    `Viết một đoạn văn tiếng Việt có dấu, dài khoảng ${targetWords} từ` +
    (topic ? ` về chủ đề "${String(topic).slice(0, 100)}"` : ' về một chủ đề ngẫu nhiên, gần gũi với sinh viên') +
    '. Đoạn văn dùng cho bài thi gõ phím nên: viết thành một đoạn liền mạch, câu văn tự nhiên, đúng chính tả; ' +
    'chỉ dùng chữ cái, chữ số, dấu chấm, dấu phẩy; không xuống dòng, không tiêu đề, không markdown, không emoji. ' +
    'Chỉ trả về đúng đoạn văn, không giải thích gì thêm.';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 1.0 }
        }),
        signal: ctrl.signal
      }
    );
    if (!res.ok) throw new Error(`Gemini API lỗi ${res.status}`);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(' ');
    const out = clean(text);
    if (countWords(out) < Math.min(20, targetWords / 2)) throw new Error('Đoạn văn AI quá ngắn');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{source:'bank'|'ai'|'custom', durationSec:number, topic?:string, customText?:string}} opts
 * @returns {Promise<{text:string, source:string, note?:string}>}
 */
async function generatePassage(opts) {
  const target = wordsForDuration(opts.durationSec || 60);
  if (opts.source === 'custom') {
    const t = clean(opts.customText).slice(0, 5000);
    if (countWords(t) >= 3) return { text: t, source: 'custom' };
    return { text: fromBank(target), source: 'bank', note: 'Đoạn văn tự nhập quá ngắn, đã dùng kho câu.' };
  }
  if (opts.source === 'ai') {
    try {
      let text = await fromAI(target, opts.topic);
      // Nếu AI viết hơi ngắn, nối thêm câu từ kho để không ai gõ hết quá sớm
      if (countWords(text) < target) text += ' ' + fromBank(target - countWords(text));
      return { text, source: 'ai' };
    } catch (e) {
      return { text: fromBank(target), source: 'bank', note: `Không sinh được bằng AI (${e.message}), đã dùng kho câu.` };
    }
  }
  return { text: fromBank(target), source: 'bank' };
}

module.exports = { generatePassage, clean, aiAvailable: () => !!process.env.GEMINI_API_KEY };
