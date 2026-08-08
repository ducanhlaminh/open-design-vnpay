Protocol: áp dụng cho MODE=branch và MODE=reduce | Nguồn: `.app-docs/`

# Luật cứng

- Đọc toàn bộ input của mode; không lấy mẫu, không bỏ trang dài.
- MODE=branch chỉ đọc một branch cấp-1; ghi đúng `_branches/<slug>.md`.
- MODE=reduce đọc `_index.md`, mọi `_branches/*.md`, và `_overview.md` cũ nếu có; ghi đúng `_overview.md`.
- Mọi fact phải có citation path thật, tương đối từ pool. [Nguồn: `.app-docs/_index.md`]
- Keywords phải VERBATIM từ trang; không dịch, bịa, viết tắt, hoặc sửa chính tả. [Nguồn: `.app-docs/1-nguoi-dung/1-ho-so.md`]
- `_overview.md` dùng đúng sáu heading cố định, đúng thứ tự; Bản đồ trang bao phủ 100% entry `_index.md`. [Nguồn: `.app-docs/_index.md`]
- Branch tối đa 120 dòng; overview tối đa 400 dòng.
- Không filler. Thiếu dữ liệu ghi `Chưa nêu` kèm citation; không suy đoán. [Nguồn: `.app-docs/_index.md`]
- Chỉ ghi output mode được giao; không sửa trang nguồn, `_index.md`, manifest, hoặc file khác.
