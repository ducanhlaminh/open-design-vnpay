---
name: summary-feedback
description: |
  Summarize the END-USER feedback prompts of the CURRENT project into a product
  digest — across ALL team members, not just the local user. After a pipeline
  produces an output file, users type follow-up prompts asking the agent to
  fix/adjust it ("sửa lại cho đúng ý"). Each install ships those prompts to a
  shared media-service feedback log; when this skill runs, the daemon merges
  every install's prompts into a local file `.feedback-merged.jsonl` in the
  project working directory. This skill reads that merged file, clusters the
  prompts into recurring feedback themes, breaks them down per user, and reports
  which outputs drew the most fix requests — so you can decide what to improve.
  Read-only. Activate when the user asks to "summary feedback", "tổng hợp
  feedback", "tổng hợp prompt người dùng", "phản hồi của user dự án này", "what
  are users asking to fix", or "/summary-feedback".
triggers:
  - "summary feedback"
  - "summarize feedback"
  - "feedback summary"
  - "summary-feedback"
  - "tổng hợp feedback"
  - "tổng hợp phản hồi"
  - "tổng hợp prompt người dùng"
  - "phản hồi của user"
  - "user feedback summary"
od:
  mode: utility
  category: product-feedback
---

# summary-feedback

Tổng hợp feedback prompt của **dự án hiện tại** — **gộp của TẤT CẢ thành viên**,
không chỉ user trên máy này.

## Cách dữ liệu tới tay bạn

Đây là local-first app: prompt của mỗi người nằm trong `app.sqlite` riêng của họ.
Để gom cross-user, mỗi install đẩy prompt feedback lên một file log trên
media-service chung (`feedback/<installId>.jsonl`, một file/máy → không tranh chấp).

**Khi skill này chạy, daemon đã tự động gộp mọi file đó thành một file local
`.feedback-merged.jsonl` trong thư mục làm việc của project.** Bạn CHỈ cần đọc file
local đó — không phải gọi mạng, không đụng DB nội bộ, không đụng media-service.

## Định dạng `.feedback-merged.jsonl`

Mỗi dòng là 1 JSON record (đã lọc bỏ prompt trigger pipeline/orbit/routine):

```json
{"user":"anh","project":"BIDV","prompt":"sửa lại layout...","ts":1782205091599,"conversationId":"...","outputUserSaw":["docs-to-html/screen.html"]}
```

- `user` = tên người (đặt ở Settings → feedback username; nếu trống thì là install id).
- `prompt` = nguyên văn prompt user gõ.
- `ts` = epoch **mili-giây**.
- `outputUserSaw` = file output đang tồn tại lúc user gõ → họ đang phản ứng với output nào.

## How to use

### Bước 1 — Đọc file đã merge

```bash
ls -la .feedback-merged.jsonl 2>/dev/null && wc -l .feedback-merged.jsonl
cat .feedback-merged.jsonl
```

- Nếu **file không tồn tại**: báo rõ *"Chưa pull được feedback chung (media-service
  không sẵn sàng, hoặc project chưa có feedback nào)"* — đừng bịa, đừng tự đọc
  `app.sqlite`.
- Nếu **file rỗng** (0 dòng): báo *"Project này chưa có prompt feedback nào từ bất kỳ
  ai"* rồi dừng.

### Bước 2 — Tổng hợp

Viết bản tóm tắt **bằng ngôn ngữ user dùng trong prompt** (đa phần tiếng Việt), gồm:

1. **Tổng quan** — tổng số prompt, số người (đếm distinct `user`), số conversation,
   khoảng thời gian (đổi `ts` ms → ngày).
2. **Nhóm chủ đề feedback** — gom các yêu cầu lặp lại (sai layout, đổi nội dung/text,
   thêm/bớt field, sai theme/màu, logic sai, sai dữ liệu...). Mỗi nhóm: tần suất + 1–2
   quote nguyên văn ngắn.
3. **Breakdown theo người** — mỗi `user` đóng góp bao nhiêu prompt, chủ đề nổi bật của họ.
4. **Output bị sửa nhiều nhất** — dựa trên `outputUserSaw`: file nào hứng nhiều yêu cầu
   sửa nhất.
5. **Insight cho sản phẩm** — pipeline/bước nào hay sinh output chưa đạt; gợi ý cải
   thiện cụ thể.
6. Hỏi user có muốn lưu bản tóm tắt ra `feedback-summary.md` trong cwd không; chỉ ghi
   khi đồng ý.

## Rules

- Chỉ đọc `.feedback-merged.jsonl` trong cwd. KHÔNG tự query `app.sqlite` (đó chỉ là
  dữ liệu của một máy), KHÔNG tự gọi media-service.
- Trích quote nguyên văn, không bịa prompt không có trong dữ liệu.
- Phạm vi = project hiện tại (file đã được daemon scope sẵn theo project).
