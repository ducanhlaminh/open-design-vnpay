---
name: app-context-distill
description: |
  Distill an imported App documentation pool into branch context and a global
  overview. MODE=branch reads every page in ONE first-level branch and writes
  `_branches/<slug>.md`; MODE=reduce reads the existing overview, all branch
  files, and `_index.md`, then writes `_overview.md` with a complete page map.
  Activate only when kickoff explicitly selects `MODE=branch` or `MODE=reduce`.
triggers:
  - "app context distill"
  - "chưng cất tài liệu App"
  - "distill app docs"
  - "MODE=branch"
  - "MODE=reduce"
od:
  mode: utility
  category: documentation
---

# app-context-distill — chưng cất context tài liệu App

Skill này chạy trong App docs pool. Kickoff phải chọn đúng một mode:
`MODE=branch` hoặc `MODE=reduce`. Không tự đổi mode, không chạy cả hai trong
một lượt.

## Protocol header — đọc trước

- **Nguồn pool:** `.app-docs/` hoặc cwd được kickoff chỉ rõ.
- **Output:** chỉ ghi `_branches/<slug>.md` ở `branch`; chỉ ghi `_overview.md` ở
  `reduce`.
- **Phạm vi:** `branch` đúng một branch cấp-1; `reduce` toàn bộ pool.
- **Bằng chứng:** mọi fact phải cite path thật trong pool.
- **Nguyên văn:** keywords phải copy VERBATIM từ trang; không dịch, không bịa.
- **Trần:** overview ≤400 dòng; branch ≤120 dòng.
- **Đọc trước:** đọc toàn bộ input được mode yêu cầu, không lấy mẫu.
- **File-only:** không sửa trang nguồn, `_index.md`, manifest, hoặc file khác.

## Mode selection

Kickoff nêu `MODE=branch` hoặc `MODE=reduce`, cùng đường dẫn input/output nếu
không dùng mặc định. Nếu thiếu mode, dừng; không đoán.

## MODE=branch

Mục tiêu: đọc **mọi trang của đúng một branch** rồi ghi
`_branches/<slug>.md`.

1. Xác định `<slug>` từ kickoff hoặc từ branch cấp-1 trong `_index.md`.
2. Đọc `_index.md`, lập danh sách đầy đủ path thuộc branch.
3. Đọc từng path trong danh sách, từ đầu đến cuối. Không bỏ qua trang dài,
   bảng, phụ lục, hoặc trang có vẻ trùng.
4. Trích xuất chỉ điều trang nói: phạm vi, mục tiêu, đối tượng, luồng nội bộ,
   quy tắc, phụ thuộc, thuật ngữ và các trang con.
5. Mỗi fact ghi citation dạng `[Nguồn: <path>]`; path phải tồn tại và đúng
   tương đối từ pool.
6. Keywords lấy nguyên văn từ nội dung trang. Không dịch, viết tắt, chuẩn hoá
   hoa/thường, sửa dấu, hoặc ghép keyword mới. Có thể ghi nhiều keyword bằng
   `; `, nhưng từng keyword phải xuất hiện nguyên văn trong trang.
7. Ghi đúng headings của template branch. Giữ ≤120 dòng.
8. Không thêm kết luận không có nguồn. Nếu thiếu thông tin, ghi `Chưa nêu`
   kèm citation nếu đang mô tả sự thiếu vắng; không điền theo suy đoán.

Output phải là `_branches/<slug>.md`, với `<slug>` đúng tên branch, không đổi
sang tên tiếng Việt hay tên dễ đọc hơn.

## MODE=reduce

Mục tiêu: tạo `_overview.md` toàn cục từ context đã chưng cất.

1. Đọc `_index.md` trước để có page map chuẩn.
2. Đọc `_overview.md` cũ nếu có; dùng để bảo toàn thông tin còn đúng, không
   coi là nguồn thay thế cho trang hoặc branch.
3. Đọc **mọi** file `_branches/*.md`.
4. Tổng hợp dự án, các phân hệ, luồng xuyên trang và thuật ngữ chỉ từ nguồn
   đã đọc. Mỗi fact phải cite path trang hoặc path branch.
5. Dùng đúng, đủ, đúng thứ tự sáu heading cố định:
   `## Cách dùng file này`
   `## Dự án`
   `## Phân hệ`
   `## Luồng nghiệp vụ xuyên trang`
   `## Thuật ngữ`
   `## Bản đồ trang`
6. `## Phân hệ` phải có bảng đúng cột `Slug|Phân hệ|Phạm vi|Branch` và tham
   chiếu mọi `_branches/<slug>.md`.
7. `## Bản đồ trang` phải có bảng đúng cột
   `Path|Nội dung|Keywords`, bao phủ **100% entry trong `_index.md`**, giữ path
   thật. Không bỏ trang vì đã có branch summary.
8. Keywords trong page map phải VERBATIM từ trang; không dịch hoặc phát minh.
9. Giữ ≤400 dòng. Không thêm heading cấp `##`, không chèn filler, không lặp
   nguyên văn dài.
10. Nếu nguồn chưa đủ để xác nhận một fact, ghi `Chưa nêu` thay vì đoán.

## Output templates

Các template có ví dụ tiếng Việt đã điền tại `templates/`:

- `templates/branch.md`: ví dụ `_branches/<slug>.md`.
- `templates/overview.md`: ví dụ `_overview.md`.

Đọc template tương ứng trước khi ghi output. Template minh hoạ cấu trúc; thay
toàn bộ nội dung ví dụ bằng dữ liệu pool thật trong mỗi run.

## Hard rules

- Protocol header phải là phần đầu tiên của output; không đặt front matter,
  lời dẫn, hoặc heading khác trước nó.
- `MODE=branch`: một branch, mọi trang trong branch, một output.
- `MODE=reduce`: mọi branch, `_index.md`, page map 100% entry.
- Mọi fact cite path. Citation không được trỏ tới file không tồn tại.
- Keywords phải VERBATIM từ pages; cấm dịch, diễn giải, bịa, hoặc đổi chính tả.
- Không suy ra nội dung từ title, slug, thứ tự trang, hay convention sản phẩm.
- Không sửa bất kỳ file nguồn nào; không tạo file ngoài output được chỉ định.
- Không tạo section rỗng để đủ hình thức; dùng `Chưa nêu` khi nguồn thực sự
  không nêu, không dùng filler.
- Branch tối đa 120 dòng; overview tối đa 400 dòng. Nếu vượt, nén câu chữ,
  không xoá facts, citations, keywords, hoặc page-map rows.
- Ghi markdown hợp lệ, bảng có header, path tương đối, không dùng placeholder.
