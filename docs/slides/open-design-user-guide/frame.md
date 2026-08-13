---
colors:
  background: "#F6F8FB"
  surface: "#FFFFFF"
  surface_soft: "#EAF2F8"
  ink: "#171C24"
  muted: "#5E6875"
  accent: "#0066B3"
  accent_strong: "#00568F"
  accent_soft: "#D6E7F4"
  success: "#18784A"
  success_soft: "#DDF3E7"
  warning: "#A65A00"
  warning_soft: "#FFF0D6"
  danger: "#B13A32"
  border: "#C9D4E0"
typography:
  display: "Georgia, 'Times New Roman', serif"
  body: "Inter, 'Segoe UI', Arial, sans-serif"
  mono: "'SFMono-Regular', Consolas, monospace"
spacing:
  frame_padding: 88
  section_gap: 56
  card_radius: 28
components:
  border_width: 2
  shadow: "0 20px 70px rgba(30, 62, 92, 0.10)"
---

## Overview

Deck mang ngôn ngữ sản phẩm Open Design: nền sáng hơi xanh, accent xanh cobalt,
bề mặt trắng rõ ràng và đường viền đủ mạnh khi trình chiếu. Không dùng gradient
text, neon hoặc card grid đồng đều thiếu chủ đích.

## The Frame

- Tiêu đề là câu khẳng định hoàn chỉnh, 68–92px.
- Nội dung chính tối thiểu 34px; metadata tối thiểu 24px.
- Mỗi slide có một “product visual” lớn: cây dữ liệu, stepper, modal, file diff
  hoặc sơ đồ kết nối.
- Giữ góc phải dưới thoáng cho thanh điều hướng slideshow.

## Composition Rules

- Dùng accent xanh cho hành động/đường dẫn chính; xanh lá cho hoàn tất; cam cho
  cần chú ý; đỏ chỉ dùng cho lỗi hoặc xóa.
- Card có radius 20–28px, border 2px, shadow nhẹ. Không lồng quá hai lớp card.
- Trang trí nền gồm lưới chấm, vòng cung và số slide cỡ lớn ở opacity 10–16%.
- Icon dùng SVG nét 2px, không dùng emoji làm icon giao diện.

## Motion

- Nội dung đi vào bằng slide/fade 0.35–0.55s, stagger ngắn.
- Đường kết nối được vẽ ra; trạng thái khóa vào vị trí; không có loop vô hạn.
- Mỗi timeline paused và seek-safe để Next/Prev luôn tái hiện đúng trạng thái.
