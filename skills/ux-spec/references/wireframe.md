# Wireframe files — `wireframes/<SCREEN-ID>.html`

Mỗi màn trong UX Spec có một file HTML độc lập. Tên file phải khớp chính xác
với `screens[].id`. File mở offline, nhúng được bằng `iframe srcdoc`, và không
phải artifact sinh từ định dạng khác.

## Hợp đồng HTML

- Bắt đầu bằng `<!doctype html>`, có `<html>`, `<head>`, `<body>`.
- Mọi CSS nằm trong một `<style>` nội tuyến. Copy nguyên văn
  `skills/ux-spec/assets/wireframe.css`, sau đó thêm tối đa vài rule layout.
  Không dùng `<link>`, `<script>`, font hoặc ảnh ngoài.
- Body có `data-screen="<SCREEN-ID>"` và `data-layout="mobile|web"`.
  Màn overlay thêm `data-overlay="dialog|drawer|sheet"` và
  `data-overlay-of="<SCREEN-ID cơ sở>"` nếu có.
- Block tương ứng component DS mang `data-comp="<anchor>"`, anchor lấy từ
  `criteria/components.md`. Block không tương ứng component DS bỏ attribute.
- Block điều hướng mang `data-nav="<SCREEN-ID đích>"`; giá trị khớp
  `navigates_to` trong UX Spec. Biến thể, nếu cần, dùng
  `data-variant="Hierarchy=Level 1 · Size=Large"`.
- Web chỉ có một cây DOM. Dùng `@media` thật tại `max-width: 834px` và
  `max-width: 390px`, theo `responsive_notes`.
- Không có registry slug, script validate, hay vocabulary đóng.

## Ví dụ mobile

```html
<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    /* Copy nguyên văn skills/ux-spec/assets/wireframe.css vào đây. */
    .screen-stack { display: grid; gap: 16px; }
  </style>
</head>
<body data-screen="SCR-TRANSFER" data-layout="mobile">
  <main class="wf-mobile screen-stack">
    <header class="wf-component" data-comp="app-bar">Chuyển tiền</header>
    <section class="wf-card screen-stack">
      <div class="wf-component" data-comp="input-field">Số tài khoản nhận</div>
      <div class="wf-component" data-comp="input-field">Số tiền</div>
      <button class="wf-component" data-comp="button" data-nav="SCR-OTP"
        data-variant="Hierarchy=Level 1 · Size=Large">Tiếp tục</button>
    </section>
  </main>
</body>
</html>
```

## Ví dụ web responsive

```html
<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    /* Copy nguyên văn skills/ux-spec/assets/wireframe.css vào đây. */
    .web-shell { display: grid; grid-template-columns: 240px 1fr; gap: 24px; }
    .web-main { display: grid; gap: 16px; }
    @media (max-width: 834px) {
      .web-shell { grid-template-columns: 1fr; }
    }
    @media (max-width: 390px) {
      .web-shell { display: block; }
    }
  </style>
</head>
<body data-screen="SCR-TRANSACTIONS" data-layout="web">
  <main class="wf-web web-shell">
    <aside class="wf-component" data-comp="sidebar">Danh mục</aside>
    <section class="web-main">
      <div class="wf-component" data-comp="input-field">Tìm giao dịch</div>
      <div class="wf-component" data-comp="data-table">Danh sách giao dịch</div>
    </section>
  </main>
</body>
</html>
```

## Lồng nhau và chọn component

HTML diễn đạt cấu trúc thật: `data-comp="card-base-card"` chứa
`data-comp="title-section"` chứa `data-comp="button"`. Định dạng cũ không
diễn đạt được chuỗi cha-con này; không nhét nội dung con vào `props.label`.

1. Đọc `criteria/catalog.md`: dùng mục **Screen scaffolding** cho khung màn;
   đọc “Dùng khi / Khác với / Không dùng khi” để phân biệt component gần nghĩa.
2. Đối chiếu `criteria/components.md`: chỉ dùng anchor tồn tại trong tập hợp
   hợp lệ.
3. Đọc `criteria/examples.md` để biết cấu trúc lồng nhau chuẩn của DS.
4. Dùng HTML semantic, class wireframe chung, rồi thêm layout tối thiểu.

Wireframe là khối xám: lấy vai trò và cấu trúc từ DS, không lấy màu, ảnh,
brand hoặc đổ bóng. Đây là wireframe ít fidelity, không phải bản thiết kế thị
giác.

Overlay vẫn là màn riêng. Giữ `overlay_kind` / `overlay_of` trong UX Spec; đặt
`data-overlay` / `data-overlay-of` trên body, thân file chỉ chứa nội dung lớp
phủ. Overlay toàn cục bỏ `data-overlay-of`.
