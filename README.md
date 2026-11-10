# ⌨️ Typing Battle — Thi đấu gõ phím tiếng Việt

Ứng dụng web thời gian thực cho sinh viên thi gõ phím tiếng Việt có dấu:
- **Phòng lớp học (Giáo viên tạo):** giáo viên mở phòng, phát mã 6 số (hoặc link), sinh viên cả lớp vào gõ **cùng một đoạn văn** trong thời gian cố định. Có bảng xếp hạng trực tiếp và xuất kết quả ra file **CSV (Excel)**.
- **Đấu 1-1:** tạo phòng 2 người gửi mã cho bạn bè, hoặc bấm **Tìm đối thủ ngẫu nhiên** để hệ thống tự ghép cặp.
- **Đoạn văn ngẫu nhiên:** kết hợp **kho câu tiếng Việt có sẵn** (chạy offline) + **AI Gemini** sinh đoạn văn mới theo chủ đề (tự động chuyển về kho câu nếu chưa đặt `GEMINI_API_KEY`) + giáo viên tự dán đoạn văn.
- **Bộ gõ tiếng Việt tích hợp:** chọn **Telex**, **VNI** ngay trên web (không cần cài Unikey), hoặc chuyển sang **Bộ gõ máy** nếu muốn dùng Unikey/EVKey/bàn phím điện thoại. Chuẩn hoá dấu thanh (`hoà` = `hòa`, `thuỷ` = `thủy`).
- **Luật xếp hạng:** trong thời gian cố định, xếp theo **Số ký tự đúng nhiều nhất → Đạt được sớm nhất → Ít lỗi chính tả nhất**.

## 1. Chạy trên máy (Local / mạng LAN lớp học)

```bash
cd C:\Users\Lenovo\.gemini\antigravity\scratch\typing-battle
npm install
npm start
```

Mở trình duyệt tại:
- Trang sinh viên / đấu 1-1: `http://localhost:3000`
- Trang giáo viên: `http://localhost:3000/teacher.html`

Nếu muốn bật sinh đoạn văn bằng AI Gemini:
```powershell
$env:GEMINI_API_KEY="AIza..."
npm start
```

## 2. Đưa lên Internet (Deploy lên Railway hoặc Render)

### Cách A: Deploy lên Railway
1. Đẩy thư mục `typing-battle` lên một GitHub repository (hoặc dùng Railway CLI).
2. Vào [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → chọn repo của bạn.
3. (Tuỳ chọn) Vào tab **Variables** thêm `GEMINI_API_KEY` để bật sinh đoạn văn bằng AI.
4. Vào **Settings → Networking → Generate Domain** để lấy địa chỉ `https://ten-app.up.railway.app` gửi cho sinh viên.

### Cách B: Deploy lên Render (có gói miễn phí)
1. Đẩy code lên GitHub.
2. Vào [render.com](https://render.com) → **New → Web Service** → chọn repo.
3. Điền:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment Variables:** thêm `GEMINI_API_KEY` (nếu dùng AI).
4. Bấm **Deploy Web Service**.
