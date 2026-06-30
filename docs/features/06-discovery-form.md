# F-07: Interactive Discovery Form (Turn-1)

**Nhóm:** 🔍 Core — Discovery  
**Nguồn code:** `apps/daemon/src/prompts/discovery.ts` (30KB)  
**UI:** `QuestionForm.tsx` (14KB)  
**Trigger:** Đầu mỗi turn mới, trước khi agent viết code

---

## 1. Tổng quan

Trước khi agent viết bất kỳ pixel nào, hệ thống emit một **interactive discovery form** để "lock brief" từ user. Đây là cơ chế đảm bảo agent luôn có đủ context trước khi bắt đầu.

---

## 2. Discovery Form (Turn-1)

Form được emit dưới dạng SSE event `question_form`:

```xml
<question-form id="discovery">
  <field id="surface" type="radio" options="desktop|mobile|tablet"/>
  <field id="audience" type="text" placeholder="Who is this for?"/>
  <field id="tone" type="radio" options="formal|casual|playful|professional"/>
  <field id="brand_context" type="text" placeholder="Brand colors, fonts, existing assets"/>
  <field id="scale" type="radio" options="1-page|multi-page|full-app"/>
  <field id="constraints" type="text" placeholder="Any technical constraints?"/>
</question-form>
```

**Các trường thu thập:**
| Field | Type | Mô tả |
|-------|------|-------|
| `surface` | radio | Desktop / Mobile / Tablet |
| `audience` | text | Đối tượng mục tiêu |
| `tone` | radio | Formal / Casual / Playful / Professional |
| `brand_context` | text | Màu brand, fonts, assets hiện có |
| `scale` | radio | 1-page / Multi-page / Full-app |
| `constraints` | text | Ràng buộc kỹ thuật |

**Giới hạn:** Không quá 8 câu hỏi.

---

## 3. Visual Direction Picker (Turn-2)

Khi user chưa có brand cụ thể, agent emit **Direction Picker** với 5 trường phái thị giác:

| Direction | OKLch Palette | Font Stack |
|-----------|-------------|-----------|
| **Editorial Monocle** | Charcoal + cream + gold | Playfair Display + Inter |
| **Modern Minimal** | White + near-black + electric | Inter + Roboto Mono |
| **Warm Soft** | Blush + ivory + terracotta | Lora + DM Sans |
| **Tech Utility** | Deep navy + cyan + slate | JetBrains Mono + Inter |
| **Brutalist Experimental** | Black + neon lime + raw white | Space Grotesk |

**Sau khi chọn:**
- Agent dùng palette OKLch xác định, không freestyle màu
- Font stack được áp dụng nhất quán
- Palette được reference trong artifact CSS

---

## 4. Junior-Designer Mode

Từ triết lý `huashu-design`:

1. **Batch câu hỏi lên trước** — Không tự suy đoán thiếu thông tin, hỏi hết một lần
2. **Show something visible sớm** — Kể cả wireframe với grey blocks
3. **Cho user redirect rẻ** — Chi phí một redirect là một chat round

---

## 5. 5-Dimensional Self-Critique

Sau khi tạo artifact, agent thực hiện **self-critique** theo 5 chiều:

| Chiều | Câu hỏi kiểm tra |
|-------|----------------|
| **Philosophy** | Thiết kế có đúng triết lý và brief không? |
| **Hierarchy** | Visual hierarchy rõ ràng, người dùng biết nhìn đâu? |
| **Detail** | Màu sắc, spacing, typography nhất quán? |
| **Function** | Artifact thực sự dùng được không? Interaction hoạt động? |
| **Innovation** | Có điểm gì mới, đáng nhớ, vượt khỏi template? |

---

## 6. Anti-AI-Slop Identity Charter

Prompt identity charter được inject để đảm bảo:
- Không dùng stock photo placeholder images
- Không dùng generic "Lorem ipsum" content
- Không dùng màu generic (red, blue, green) — phải từ palette
- Không viết code "minimum viable" — phải premium
- Không comment kiểu "//TODO: implement this"

---

## 7. OFFICIAL_DESIGNER_PROMPT

Hệ thống inject designer persona:
- Agent đóng vai **senior product designer**
- Ưu tiên thẩm mỹ và trải nghiệm người dùng
- Chú ý micro-interactions và animation
- Dùng design tokens chính xác từ DESIGN.md

---

## 8. Acceptance Criteria

- [x] Form câu hỏi xuất hiện trước khi agent viết code (Turn-1)
- [x] User trả lời và submit form
- [x] Agent nhận câu trả lời và bắt đầu tạo todo plan
- [x] Direction Picker hiển thị preview màu sắc cho từng direction
- [x] Sau khi chọn direction, artifact dùng đúng palette không freestyle
- [x] Self-critique theo 5 chiều sau khi tạo artifact
- [x] Form không quá 8 câu hỏi
