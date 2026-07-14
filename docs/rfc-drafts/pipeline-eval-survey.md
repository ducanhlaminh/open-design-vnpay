# Khảo sát đánh giá Pipeline AI Design (Open Design VNPAY)

> **Mục đích:** thu phản hồi có cấu trúc từ người dùng thật (UX/UI designer, BA,
> dev, PM) sau khi dùng pipeline Docs → Journey → UX Spec → UI → Figma, để biết:
> pipeline nào chạy ổn / hỏng ở đâu, output có dùng được thật không, tiết kiệm
> được bao nhiêu, và còn thiếu/thừa gì.
>
> **Cách dùng đề xuất (2 tầng):**
> - **Pulse survey (mục P)** — 3 câu, hiện ngay khi một pipeline chạy xong
>   (widget cuối pipeline). Trả lời < 20 giây, gắn tự động metadata run.
> - **Deep survey (mục A–H)** — bản đầy đủ dưới đây, gửi định kỳ (sau 1–2 tuần
>   dùng thật hoặc cuối đợt pilot), làm bằng Google Form.
>
> Ký hiệu loại câu hỏi: `(1 lựa chọn)` `(nhiều lựa chọn)` `(thang 1–5)`
> `(văn bản)` — `*` = bắt buộc. Chỗ nào có rẽ nhánh ghi rõ "Nếu…".

---

## P. Pulse survey — 3 câu hiện cuối mỗi lần chạy pipeline

> Metadata gắn tự động, không hỏi: workflow id, stage, thời gian chạy, project,
> ngày giờ, user.

**P1.*** Lần chạy này ổn không? `(1 lựa chọn)`
- 😀 Ổn, dùng được ngay
- 🙂 Tạm, phải sửa một chút
- 😐 Phải sửa nhiều
- 😞 Không dùng được / lỗi

**P2.** Nếu chọn "Phải sửa nhiều" hoặc "Không dùng được": vấn đề ở đâu? `(nhiều lựa chọn)`
- Chạy lỗi / treo / không ra output
- Output sai nghiệp vụ
- Output thiếu case / thiếu màn
- Chất lượng thấp (nội dung/thẩm mỹ)
- Chạy quá lâu
- Khác: ___

**P3.** Góp ý nhanh (không bắt buộc) `(văn bản)`

---

## A. Thông tin người đánh giá

**A1.*** Vai trò của bạn `(1 lựa chọn)`
- UX Designer  ·  UI Designer  ·  BA  ·  Developer  ·  PM/PO  ·  Khác: ___

**A2.*** Bạn đã dùng pipeline cho dự án nào? `(văn bản ngắn)` — vd: VBSP, XPOS…

**A3.*** Mức độ sử dụng `(1 lựa chọn)`
- Dùng hằng ngày  ·  Vài lần/tuần  ·  Vài lần tổng cộng  ·  Mới thử 1 lần

**A4.** Bạn tự đánh giá mức quen với công cụ AI (Claude/Gemini/Figma AI…) `(thang 1–5)`
`1 = mới bắt đầu … 5 = dùng thành thạo hằng ngày`

**A5.*** Bạn đã dùng những phần nào? `(nhiều lựa chọn)` — quyết định các mục hiện sau
- ① Docs → Markdown (Confluence/JIRA ingest)
- ② Customer Journey
- ③ UX Spec
- ④ UI — HTML prototype
- ⑤ UI — React app
- ⑥ Đẩy thiết kế sang Figma (copy-to-figma / h2d)
- ⑦ Chỉ xem kết quả người khác chạy

---

## B. Đánh giá TỪNG pipeline (lặp khối này cho ①–⑥ mà người trả lời đã dùng)

> Google Form: làm mỗi pipeline 1 section, dùng logic "Nếu A5 có chọn ① thì
> hiện section B-①"… Mỗi khối 5 câu giống nhau để so sánh ngang được.

**B1.*** Mức độ chạy ổn định `(1 lựa chọn)`
- 4 — Mượt, hầu như không lỗi
- 3 — Thi thoảng lỗi nhưng chạy lại là được
- 2 — Hay lỗi, phải mò cách né
- 1 — Thường xuyên không chạy được

**B2.** Nếu B1 ≤ 3: không ổn ở đâu? `(nhiều lựa chọn)`
- Cài đặt / môi trường / đăng nhập
- Kết nối nguồn (Confluence/JIRA) không lấy được docs
- Chạy lâu quá rồi treo / timeout
- Ra output nhưng sai format / thiếu file
- Output đè mất bản cũ / mất dữ liệu
- Lỗi hiển thị trên app (không xem được kết quả)
- Khác (ghi rõ): ___

**B3.*** Chất lượng output của bước này `(thang 1–5)`
`1 = không dùng được … 3 = sửa ~50% mới dùng được … 5 = dùng gần như nguyên bản`

**B4.*** Bước này có giúp ích thật cho công việc của bạn không? `(1 lựa chọn)`
- Giúp nhiều — thay được phần lớn việc tay
- Giúp vừa — làm nền để sửa tiếp
- Giúp ít — tham khảo là chính
- Không giúp — làm tay còn nhanh hơn

**B5.** Thời gian chạy của bước này với bạn là… `(1 lựa chọn)`
- Nhanh hơn kỳ vọng  ·  Chấp nhận được  ·  Hơi lâu  ·  Quá lâu (bỏ đi làm việc khác / quên luôn)

---

## C. Riêng cho đầu ra UX (Customer Journey + UX Spec) — dành cho Designer/BA

**C1.*** Journey/UX Spec có ĐÚNG nghiệp vụ không? `(thang 1–5)`
`1 = sai căn bản … 5 = đúng, phản ánh đủ luồng nghiệp vụ thật`

**C2.*** Có ĐỦ case không? `(nhiều lựa chọn — chọn những gì thường bị THIẾU)`
- Thiếu luồng phụ (alternative flow)
- Thiếu case lỗi / exception
- Thiếu màn trạng thái (loading / empty / error)
- Thiếu phân quyền / actor phụ
- Thiếu validation trên form
- Không thiếu gì đáng kể

**C3.*** Với bạn (designer), bản UX này dùng được ở mức nào? `(1 lựa chọn)`
- Làm thẳng wireframe trên nền nó được
- Làm khung để thảo luận với BA/khách
- Chỉ để tham khảo ý tưởng
- Không dùng — tự làm từ đầu

**C4.** So với tự làm tay, bước UX tiết kiệm cho bạn khoảng… `(1 lựa chọn)`
- >70% thời gian  ·  30–70%  ·  <30%  ·  Không tiết kiệm  ·  Tốn thêm thời gian (phải sửa nhiều hơn làm mới)

**C5.** Điều bạn PHẢI SỬA nhiều nhất ở output UX là gì? `(văn bản)`

**C6.** Bạn có tin kết quả AI suy luận không (pain point, đề xuất màn…)? `(1 lựa chọn)`
- Tin, ít khi phải kiểm tra lại
- Tin một phần — luôn phải đối chiếu docs gốc
- Không tin — phải kiểm tra từng ý
- (Gợi ý cải tiến: bạn muốn AI dẫn nguồn/căn cứ cho từng kết luận không? Có/Không)

---

## D. Riêng cho đầu ra Figma (copy-to-figma / h2d) — dành cho Designer

**D1.*** File đẩy sang Figma có CHUẨN cấu trúc không? `(thang 1–5)`
`1 = một cục flatten, phải dựng lại … 5 = layer/frame/component đặt tên đúng, sửa tiếp được ngay`

**D2.** Cụ thể phần nào CHƯA chuẩn? `(nhiều lựa chọn)`
- Layer không đặt tên / sai tên
- Không thành component / variant — chỉ là frame rời
- Auto-layout sai hoặc không có
- Font/màu/token lệch so với preview
- Icon/ảnh vỡ hoặc mất
- Thiếu màn / thiếu state so với bản gốc
- Không có gì đáng kể

**D3.*** Sau khi nhận file Figma, bạn phải sửa lại khoảng bao nhiêu % trước khi dùng tiếp? `(1 lựa chọn)`
- <10%  ·  10–30%  ·  30–60%  ·  >60% (gần như dựng lại)

**D4.*** So với tự dựng Figma từ đầu, bước này… `(1 lựa chọn)`
- Tiết kiệm nhiều thời gian
- Tiết kiệm chút ít
- Ngang nhau
- Tốn hơn (sửa file AI lâu hơn tự dựng)

**D5.** Bạn muốn đầu ra Figma bổ sung gì nhất? `(văn bản)` — vd: variants, design token, prototype link…

---

## E. Chất lượng THIẾT KẾ do AI sinh (HTML prototype / React app)

**E1.*** Nhìn tổng thể, thiết kế AI có ĐẸP không? `(thang 1–5)`
`1 = xấu, nhìn là biết AI … 3 = ổn nhưng generic … 5 = đẹp, đưa khách xem được`

**E2.*** Mức nhất quán (màu, chữ, khoảng cách, component giữa các màn) `(thang 1–5)`

**E3.*** Có bám design system / nhận diện thương hiệu được chọn không? `(thang 1–5)`

**E4.*** Độ phủ NGHIỆP VỤ của bản UI `(1 lựa chọn)`
- Đủ màn, đủ case chính lẫn phụ
- Đủ màn chính, thiếu case phụ (error/empty/loading)
- Thiếu cả màn chính
- Sai nghiệp vụ

**E5.** Nội dung chữ trên UI (UX writing, tiếng Việt, thuật ngữ ngành) `(thang 1–5)`
`1 = ngô nghê/sai thuật ngữ … 5 = tự nhiên, đúng thuật ngữ, dùng được ngay`

**E6.** Prototype có TƯƠNG TÁC được như kỳ vọng không (bấm chuyển màn, tab, form…)? `(1 lựa chọn)`
- Được, mô phỏng đủ luồng  ·  Được một phần  ·  Hầu như tĩnh  ·  Không mở được

---

## F. Trải nghiệm dùng app Open Design (studio)

**F1.*** Tốc độ tổng thể của app `(1 lựa chọn)`
- Nhanh, mượt
- Ổn, đôi lúc chậm
- Chậm, hay giật lag (ghi rõ ở đâu: ___)
- Rất chậm / hay đơ

**F2.** Chỗ nào hay giật/lag/đơ nhất? `(nhiều lựa chọn)`
- Mở project / chuyển tab
- Xem preview HTML/React
- Canvas / React Flow (journey, spec preview)
- Khung chat khi agent đang chạy
- Push/pull dữ liệu (KGS / media store)
- Đăng nhập / SSO
- Không gặp

**F3.*** Độ ổn định (crash, mất kết nối daemon, phải restart) `(thang 1–5)`
`1 = ngày nào cũng gặp … 5 = chưa từng gặp`

**F4.*** Mức dễ dùng — không cần ai chỉ vẫn tự thao tác được `(thang 1–5)`

**F5.** Điều khó chịu nhất khi dùng app là gì? `(văn bản)`

---

## G. Tốc độ & chi phí AI

**G1.*** Tốc độ AI sinh TÀI LIỆU (docs → journey/ux spec) `(1 lựa chọn)`
- < 5 phút — tốt  ·  5–15 phút — chấp nhận  ·  15–30 phút — hơi lâu  ·  > 30 phút — quá lâu

**G2.*** Tốc độ AI sinh UI (prototype/React/Figma) `(1 lựa chọn)`
- Cùng thang như G1

**G3.** Trong lúc chờ AI chạy, bạn thường… `(1 lựa chọn)`
- Theo dõi log/chat của agent
- Làm việc khác, quay lại sau
- Quên luôn, hôm sau mới xem
→ (dùng để quyết định có cần notification khi chạy xong không)

**G4.** Nếu biết chi phí token mỗi lần chạy, bạn thấy kết quả nhận được… `(1 lựa chọn)`
- Rất đáng  ·  Đáng  ·  Chưa đáng  ·  Không biết chi phí (muốn được hiển thị)

---

## H. Tổng thể & độ phủ pipeline

**H1.*** Bộ pipeline hiện tại (Docs → Journey → UX Spec → UI → Figma) đã ĐỦ cho quy trình làm việc của bạn chưa? `(1 lựa chọn)`
- Đủ  ·  Gần đủ  ·  Thiếu nhiều  ·  Sai hướng

**H2.** THIẾU bước nào? `(nhiều lựa chọn)`
- Research người dùng / crawl review, phân tích đối thủ
- Đánh giá heuristic app hiện có (as-is) trước khi thiết kế
- Persona có căn cứ dữ liệu
- Bước duyệt/chỉnh giữa chừng (human review gate) trước khi sinh UI
- Design QA tự động (chấm UI sau khi sinh)
- Xuất tài liệu bàn giao (slide/docx báo cáo)
- Quản lý phiên bản / so sánh 2 lần chạy
- Khác: ___

**H3.** THỪA / không dùng đến bước nào? `(văn bản ngắn)`

**H4.*** Bạn có sẵn sàng dùng pipeline này cho dự án THẬT tiếp theo không? `(1 lựa chọn)`
- Có, làm luồng chính
- Có, làm luồng phụ song song với cách cũ
- Chưa — cần cải thiện thêm (ghi rõ điều kiện: ___)
- Không

**H5.*** Khả năng bạn giới thiệu cho đồng nghiệp `(thang 0–10)` — NPS

**H6.** Nếu chỉ được sửa MỘT điều trong cả hệ thống, bạn sửa gì? `(văn bản)` *

**H7.** Ý kiến khác `(văn bản)`

---

## Phụ lục 1 — Cách chấm & tổng hợp (cho người phân tích, không đưa vào form)

- **Health score mỗi pipeline** = trung bình có trọng số: B1 ổn định ×0.3 +
  B3 chất lượng ×0.4 + B4 hữu ích (quy 4→1 điểm) ×0.3. Dưới 3.0 = đỏ, 3.0–4.0
  = vàng, trên 4.0 = xanh. So ngang ①–⑥ để biết mắt xích yếu nhất.
- **Value score** = C4/D4 (tiết kiệm thời gian) đối chiếu với G1/G2 (thời gian
  chờ) — pipeline "đáng" khi tiết kiệm > chờ.
- **Coverage gaps** = tần suất C2 + E4 + H2 → feed thẳng vào backlog
  (đối chiếu RFC `ux-research-pipeline-v2.md`: các mục H2 đầu tiên chính là
  các stage đã đề xuất).
- Mỗi câu văn bản gắn tag theo taxonomy: `bug / thiếu-case / chất-lượng /
  tốc-độ / dễ-dùng / đề-xuất-mới` để đếm được.
- Pulse survey (P) tổng hợp theo run: tỷ lệ 😀+🙂 ≥ 80% là đạt; P2 là nguồn
  phát hiện lỗi theo stage theo thời gian thực.

## Phụ lục 2 — Ghi chú dựng Google Form

- Section theo đúng thứ tự A → H; dùng "Go to section based on answer" ở A5
  để chỉ hiện khối B/C/D/E tương ứng phần người đó đã dùng (⑦ chỉ xem → bỏ B,
  vào thẳng C).
- Khối B lặp 6 lần (①–⑥) — copy section, đổi tiêu đề; giữ nguyên 5 câu để so
  sánh ngang.
- Các câu `*` bắt buộc; câu văn bản để không bắt buộc (trừ H6).
- Ước lượng thời gian trả lời bản đầy đủ: 8–12 phút (người dùng 2–3 pipeline).
- Nên kèm 1 câu hỏi cuối xin phép phỏng vấn sâu 15 phút (Có/Không + để lại tên).
