# User Requirements Document (URD)
# Open Design — VNPay Edition

**Phiên bản:** 1.0  
**Ngày:** 2026-06-02  
**Trạng thái:** Bản nháp  
**Phương pháp:** Use-Case driven + User Story  

---

## 1. Giới thiệu

Tài liệu này mô tả yêu cầu từ góc độ người dùng cho hệ thống **Open Design VNPay Edition**. URD tập trung vào **ai** làm gì với hệ thống và **tại sao** — không đi vào chi tiết kỹ thuật. Đây là tài liệu nguồn cho SRS (Software Requirements Specification).

### 1.1 Mục tiêu tài liệu
- Ghi lại yêu cầu người dùng theo dạng User Story và Use Case
- Xác định các Acceptance Criteria cho từng yêu cầu
- Làm cơ sở cho team phát triển và kiểm thử

### 1.2 Các bên liên quan (Stakeholders)

| Vai trò | Trách nhiệm |
|---------|-------------|
| Product Designer | Tạo và review design artifacts |
| Frontend Engineer | Xem code artifact, lấy design spec |
| Product Manager | Review, approve design, tạo spec document |
| AI/ML Engineer | Cấu hình agents, tùy chỉnh skills |
| Platform Admin | Cài đặt, deploy, quản lý hệ thống |
| Business Analyst | Tạo báo cáo, phân tích dữ liệu |

---

## 2. User Stories

### Epic E-01: Khởi tạo và Onboarding

---

#### US-01-01: Khởi chạy lần đầu
```
GIVEN tôi là người dùng mới của Open Design
WHEN tôi chạy ứng dụng lần đầu
THEN hệ thống tự động phát hiện các AI agent CLI có trên máy tôi
  AND hiển thị dialog welcome để tôi có thể nhập API key (nếu cần)
  AND tải sẵn 132 skills và 150+ design systems
  AND tạo tự động thư mục .od/ cho dữ liệu local
```

**Acceptance Criteria:**
- [ ] Hiển thị danh sách agents được phát hiện (Claude Code, Codex, Gemini CLI, ...)
- [ ] Có thể skip dialog và dùng BYOK API sau
- [ ] Thư mục `.od/` được tạo tự động, không cần lệnh init
- [ ] Skills picker hiển thị ≥ 130 skills sau khi load

---

#### US-01-02: Cấu hình AI Agent
```
GIVEN tôi đã cài đặt Claude Code hoặc Gemini CLI trên máy
WHEN tôi mở Settings → Agent
THEN tôi thấy danh sách các agents đã phát hiện
  AND tôi có thể chọn agent mặc định
  AND tôi có thể test kết nối agent
```

**Acceptance Criteria:**
- [ ] Hiển thị badge "Available" / "Not found" cho từng agent
- [ ] Test connection trả về kết quả trong vòng 5 giây
- [ ] Sau khi chọn agent, prompt mới sẽ dùng agent đã chọn

---

#### US-01-03: Cấu hình BYOK API
```
GIVEN tôi muốn dùng OpenAI/Anthropic trực tiếp không qua CLI
WHEN tôi vào Settings → API
THEN tôi có thể nhập API Key, Base URL, và Model
  AND chọn Provider: Anthropic / OpenAI / Azure / Google / Ollama
  AND hệ thống validate và lưu cấu hình
```

**Acceptance Criteria:**
- [ ] Mask API key hiển thị (chỉ show 4 ký tự cuối)
- [ ] Test connection trả về OK/FAIL rõ ràng
- [ ] Cấu hình persist qua reload
- [ ] Hỗ trợ loopback URL cho Ollama local

---

### Epic E-02: Tạo Design Project

---

#### US-02-01: Tạo project với Skill
```
GIVEN tôi là Product Designer
WHEN tôi muốn tạo một landing page mới
THEN tôi nhập mô tả ("make me a SaaS landing page for our B2B product")
  AND tôi chọn Skill: saas-landing
  AND tôi chọn Design System: Stripe
  AND tôi nhấn Send
THEN agent hiện form câu hỏi discovery:
  - Surface (desktop/mobile)
  - Target audience
  - Tone (formal/casual/playful)
  - Brand context (colors, fonts)
  - Scale (1 page / multiple)
```

**Acceptance Criteria:**
- [ ] Form câu hỏi xuất hiện trước khi agent viết code
- [ ] User có thể trả lời và submit form
- [ ] Agent nhận câu trả lời và bắt đầu tạo todo plan
- [ ] Todo plan stream real-time dưới dạng `in_progress` → `completed`

---

#### US-02-02: Chọn Visual Direction
```
GIVEN tôi chưa có brand cụ thể
WHEN agent hiện Direction Picker
THEN tôi thấy 5 options:
  1. Editorial Monocle (palette + font stack)
  2. Modern Minimal
  3. Warm Soft
  4. Tech Utility
  5. Brutalist Experimental
AND tôi chọn một option
THEN agent dùng palette OKLch và font stack tương ứng cho toàn bộ artifact
```

**Acceptance Criteria:**
- [ ] Picker hiển thị preview màu sắc cho từng direction
- [ ] Sau khi chọn, artifact không dùng màu tự phát minh bên ngoài palette
- [ ] Font stack được áp dụng nhất quán

---

#### US-02-03: Theo dõi tiến trình agent real-time
```
GIVEN agent đang tạo design artifact
WHEN agent thực thi các bước
THEN tôi thấy Todo Card stream:
  - "Reading SKILL.md..." → completed ✓
  - "Writing brand-spec.md..." → in_progress
  - "Creating index.html..." → queued
AND tôi có thể gửi thêm hướng dẫn giữa chừng (redirect)
```

**Acceptance Criteria:**
- [ ] Todo card cập nhật real-time qua SSE
- [ ] Mỗi step hiển thị icon trạng thái rõ ràng
- [ ] User có thể type tin nhắn mới mà không cần chờ turn kết thúc
- [ ] Agent nhận instruction mid-flight

---

#### US-02-04: Xem preview artifact
```
GIVEN agent đã tạo xong artifact HTML
WHEN artifact được emit dưới dạng <artifact>...</artifact>
THEN artifact render trong sandboxed iframe bên phải
  AND iframe độc lập với trang chính (srcdoc, no scripts leak)
  AND tôi có thể interact với artifact (click, scroll)
```

**Acceptance Criteria:**
- [ ] Artifact render trong vòng 2 giây sau khi agent hoàn thành
- [ ] Iframe có sandbox attributes đúng
- [ ] Scroll, hover, animation trong iframe hoạt động
- [ ] Resize artifact preview

---

### Epic E-03: Chỉnh sửa và Tinh chỉnh

---

#### US-03-01: Chat tiếp tục chỉnh sửa
```
GIVEN tôi đang xem một artifact đã tạo
WHEN tôi muốn thay đổi màu nền từ dark sang light
THEN tôi gõ "change background to light theme, keep the layout"
  AND agent hiểu context từ conversation history
  AND agent chỉnh sửa file trong project folder
  AND artifact re-render tự động
```

**Acceptance Criteria:**
- [ ] Agent có context toàn bộ conversation
- [ ] File trong project folder được cập nhật thực sự trên disk
- [ ] Artifact preview reload sau khi agent xong turn
- [ ] Không reset toàn bộ artifact nếu chỉ thay đổi nhỏ

---

#### US-03-02: Thêm comment/annotation trên preview
```
GIVEN tôi đang xem preview artifact
WHEN tôi click vào một element trên preview và thêm comment
THEN comment được lưu kèm element selector
  AND comment xuất hiện trong lần chat tiếp theo như context
  AND agent có thể thực hiện thay đổi theo comment
```

**Acceptance Criteria:**
- [ ] Click mode phân biệt với interact mode
- [ ] Comment lưu vào database với element_id, selector, position
- [ ] Comment context inject vào conversation khi cần
- [ ] Status comment: open / resolved

---

#### US-03-03: Manual Edit trong File Workspace
```
GIVEN tôi muốn chỉnh sửa HTML/CSS trực tiếp
WHEN tôi mở File Workspace
THEN tôi thấy danh sách files trong project
  AND tôi có thể mở và edit file trong code editor
  AND thay đổi được lưu vào project folder
  AND preview cập nhật sau khi save
```

**Acceptance Criteria:**
- [ ] Syntax highlighting cho HTML, CSS, JS
- [ ] Auto-save sau 2 giây không có thay đổi
- [ ] Preview sync với file đang edit
- [ ] Diff view khi agent đã tạo version mới

---

#### US-03-04: Switch Design System
```
GIVEN tôi đang có một project dùng design system Stripe
WHEN tôi muốn xem thử với design system Tesla
THEN tôi chọn Tesla từ dropdown
  AND agent tự động re-render artifact với Tesla tokens
  AND không cần gõ lại prompt
```

**Acceptance Criteria:**
- [ ] Dropdown hiển thị tên + preview màu của từng design system
- [ ] Switch design system không xóa project history
- [ ] Artifact mới dùng đúng color, font, spacing của system mới

---

### Epic E-04: Export và Deploy

---

#### US-04-01: Xuất artifact ra HTML
```
GIVEN tôi có một artifact web prototype đã hoàn chỉnh
WHEN tôi click "Export → HTML"
THEN hệ thống tạo file HTML với tất cả assets inlined
  AND tải file về máy tôi
  AND file có thể mở offline trong browser mà không cần server
```

**Acceptance Criteria:**
- [ ] HTML export < 5MB cho artifact thông thường
- [ ] CSS, JS, images được inline (base64 hoặc `<style>`)
- [ ] File hoạt động offline trên Chrome, Firefox, Safari

---

#### US-04-02: Xuất ra PDF
```
GIVEN tôi muốn share design với management
WHEN tôi click "Export → PDF"
THEN browser in artifact thành PDF với layout đúng
  AND Page breaks hợp lý cho nội dung dài
  AND Deck artifacts in đúng slide boundaries
```

**Acceptance Criteria:**
- [ ] PDF layout match với preview
- [ ] Deck mode: mỗi slide = một trang PDF
- [ ] Text selectable trong PDF

---

#### US-04-03: Deploy lên Vercel/Cloudflare Pages
```
GIVEN tôi muốn share artifact qua URL public
WHEN tôi click "Deploy → Vercel"
THEN tôi nhập Vercel API token
  AND hệ thống deploy artifact lên Vercel
  AND trả về URL preview để share
  AND hiển thị deployment status (pending → ready)
```

**Acceptance Criteria:**
- [ ] Deploy < 60 giây với artifact < 1MB
- [ ] URL stable (không đổi khi re-deploy)
- [ ] Status tracking: pending / ready / failed
- [ ] Cloudflare Pages deploy tương tự

---

#### US-04-04: Export PPTX (Deck mode)
```
GIVEN tôi đã tạo một deck với guizang-ppt skill
WHEN tôi click "Export → PPTX"
THEN agent tạo file .pptx trong project folder
  AND file xuất hiện như download chip trong workspace
  AND tôi tải về và mở trong PowerPoint/Keynote
```

**Acceptance Criteria:**
- [ ] PPTX có đúng số slides theo artifact
- [ ] Text, layout, màu sắc xấp xỉ web version
- [ ] File mở được trong PowerPoint 2019+

---

### Epic E-05: Media Generation

---

#### US-05-01: Generate image trong chat
```
GIVEN tôi đang tạo landing page và cần hero image
WHEN tôi gõ "generate a hero image: abstract technology background, blue tones"
THEN agent gọi generate_image tool
  AND image được tạo và lưu vào project folder
  AND image xuất hiện như chip trong chat
  AND tôi có thể kéo image vào artifact
```

**Acceptance Criteria:**
- [ ] Image generation < 30 giây
- [ ] Image lưu vào project folder (có thể access qua API)
- [ ] Hỗ trợ GPT-Image-2 (Azure/OpenAI)
- [ ] Aspect ratio tuỳ chỉnh (1:1, 16:9, 4:3)

---

#### US-05-02: Generate video từ text
```
GIVEN tôi cần video clip ngắn cho marketing
WHEN tôi chọn surface "Video" và nhập prompt
THEN tôi thấy các tuỳ chọn: model (Seedance 2.0), duration, aspect ratio
  AND tôi submit
  AND hệ thống poll trạng thái và thông báo khi xong
  AND video file (.mp4) lưu vào project
```

**Acceptance Criteria:**
- [ ] Video < 30 giây generation time thông báo (async)
- [ ] Status polling với progress indicator
- [ ] Video preview inline trong workspace
- [ ] Download .mp4 file

---

#### US-05-03: Generate audio (TTS)
```
GIVEN tôi cần voiceover cho presentation
WHEN tôi chọn Audio surface → Speech
  AND nhập text
  AND chọn voice (ElevenLabs voices)
THEN audio file được tạo
  AND tôi nghe preview trong app
  AND tôi download .mp3 file
```

**Acceptance Criteria:**
- [ ] Voice list load từ ElevenLabs API
- [ ] ElevenLabs Fallback Voice khi API lỗi
- [ ] Audio preview inline
- [ ] Download .mp3

---

### Epic E-06: Import và Templates

---

#### US-06-01: Import từ Claude Design
```
GIVEN tôi có export ZIP từ Claude Design (Anthropic)
WHEN tôi drag & drop file ZIP vào welcome dialog
THEN hệ thống parse ZIP thành real project
  AND project xuất hiện trong Projects list với history
  AND tôi có thể tiếp tục edit với agent local
```

**Acceptance Criteria:**
- [ ] Support format export ZIP của Claude Design
- [ ] Project history được giữ nguyên
- [ ] Files accessible trong File Workspace
- [ ] Error message rõ ràng nếu ZIP invalid

---

#### US-06-02: Lưu Project làm Template
```
GIVEN tôi có một project landing page đã hoàn chỉnh
WHEN tôi click "Save as Template"
THEN tôi đặt tên cho template
  AND template lưu vào Templates library
  AND lần sau tôi có thể tạo project mới từ template này
```

**Acceptance Criteria:**
- [ ] Template giữ file structure nhưng cho phép customize
- [ ] Templates list có search/filter
- [ ] Preview template trước khi dùng
- [ ] Template portable (có thể export/import)

---

### Epic E-07: Skills và Design Systems Management

---

#### US-07-01: Browse và Preview Skills
```
GIVEN tôi muốn tìm skill phù hợp cho dự án
WHEN tôi mở Skills Catalog
THEN tôi thấy skills group theo scenario (design/marketing/product/...)
  AND mỗi skill có preview image và mô tả ngắn
  AND tôi click xem example.html trực tiếp trong browser
```

**Acceptance Criteria:**
- [ ] Grid view với thumbnail preview
- [ ] Filter theo: mode, platform, scenario
- [ ] Search theo tên skill
- [ ] example.html render trong sandboxed iframe

---

#### US-07-02: Browse Design Systems
```
GIVEN tôi muốn chọn design system phù hợp
WHEN tôi mở Design Systems Library
THEN tôi thấy 150+ systems với color swatches
  AND tôi click để xem full DESIGN.md và swatch grid
  AND tôi xem live showcase artifact của system đó
```

**Acceptance Criteria:**
- [ ] Hiển thị 4 màu signature của mỗi system
- [ ] Xem DESIGN.md đầy đủ
- [ ] Swatch grid cho color palette
- [ ] Live showcase render đúng system đó

---

#### US-07-03: Tạo custom Design System
```
GIVEN tôi muốn tạo VNPay Design System riêng
WHEN tôi vào Design Systems → Create New
THEN tôi nhập tên và định nghĩa theo schema 9-section DESIGN.md
  AND tôi upload brand assets (logo, fonts)
  AND design system lưu vào user library
  AND có thể chọn trong project picker
```

**Acceptance Criteria:**
- [ ] Editor với DESIGN.md schema hướng dẫn
- [ ] Validate theo schema (9 sections bắt buộc)
- [ ] Preview màu sắc real-time khi nhập hex
- [ ] Import từ GitHub repository

---

### Epic E-08: Routines và Automation

---

#### US-08-01: Tạo Routine tự động
```
GIVEN tôi muốn generate weekly design report tự động
WHEN tôi tạo Routine:
  - Name: "Weekly design summary"
  - Schedule: Every Monday 9:00 AM
  - Prompt: "Create a design progress report based on this week's projects"
  - Skill: pm-spec
THEN routine chạy đúng lịch
  AND tạo project mới với report
  AND tôi nhận notification khi xong
```

**Acceptance Criteria:**
- [ ] Schedule: daily / weekly / specific time
- [ ] Timezone awareness
- [ ] Routine run history với status
- [ ] Notification khi routine hoàn thành hoặc lỗi

---

#### US-08-02: Orbit — Daily Activity Digest
```
GIVEN tôi đã bật Orbit với thời gian 8:00 AM
WHEN đến 8:00 AM sáng
THEN daemon chạy summary các connector activity
  AND tạo digest project mới
  AND tôi mở app và thấy digest
```

**Acceptance Criteria:**
- [ ] Orbit chạy đúng giờ configured
- [ ] Summary từ memory connectors
- [ ] Không chạy nếu không có connector data

---

### Epic E-09: Settings và Privacy

---

#### US-09-01: Quản lý Privacy và Telemetry
```
GIVEN tôi lo ngại về dữ liệu của mình
WHEN tôi vào Settings → Privacy
THEN tôi thấy rõ các loại data được thu thập:
  - Metrics (aggregate usage)
  - Content (prompts và artifacts)
  - Artifact manifest
AND tôi có thể toggle từng loại ON/OFF
  AND "Delete my data" xóa installation ID và reset consent
```

**Acceptance Criteria:**
- [ ] Default: Metrics ON, Content ON, Artifact manifest OFF
- [ ] Toggle persist sau restart
- [ ] "Delete my data" không xóa projects
- [ ] Privacy policy link rõ ràng

---

#### US-09-02: Custom Instructions
```
GIVEN tôi muốn agent luôn viết code theo convention của team
WHEN tôi vào Settings → Custom Instructions
THEN tôi nhập: "Always use BEM CSS methodology. Vietnamese comments."
  AND instruction được inject vào mỗi prompt
  AND có thể override per-project
```

**Acceptance Criteria:**
- [ ] Instructions append vào system prompt
- [ ] Per-project override
- [ ] Character limit 2000 với counter

---

#### US-09-03: Theme và Appearance
```
GIVEN tôi muốn dark mode
WHEN tôi chọn Theme: Dark trong Settings
THEN UI chuyển sang dark mode
  AND setting persist qua reload
  AND "System" option follow OS theme
```

**Acceptance Criteria:**
- [ ] Light / Dark / System
- [ ] Accent color picker
- [ ] Smooth transition khi switch

---

### Epic E-10: Desktop App

---

#### US-10-01: Sử dụng Desktop App (Electron)
```
GIVEN tôi muốn dùng Open Design không cần browser
WHEN tôi cài và mở Desktop app
THEN app hiển thị giao diện tương đương web
  AND daemon khởi động tự động trong background
  AND app phát hiện đúng URL daemon qua sidecar IPC
```

**Acceptance Criteria:**
- [ ] App khởi động < 5 giây
- [ ] Không cần config port thủ công
- [ ] Sidecar IPC: STATUS / EVAL / SCREENSHOT / SHUTDOWN
- [ ] macOS (Apple Silicon + Intel) và Windows (x64) support

---

#### US-10-02: Migrate dữ liệu từ dev-server sang Desktop app
```
GIVEN tôi đã có projects từ pnpm tools-dev
WHEN tôi cài Desktop app và muốn tiếp tục với projects cũ
THEN tôi set OD_LEGACY_DATA_DIR và mở Desktop app
  AND daemon tự động migrate .od/ vào app data dir
  AND tất cả projects, conversations, artifacts được giữ nguyên
```

**Acceptance Criteria:**
- [ ] Migration thành công, không mất data
- [ ] `.migrated-from` marker prevent re-migration
- [ ] Error message rõ nếu source không có app.sqlite
- [ ] Không merge nếu Desktop đã có data riêng

---

## 3. Use Cases (UC)

### UC-01: Tạo Mobile App Prototype

**Actor:** Product Designer  
**Precondition:** Đã cấu hình Claude Code hoặc BYOK API  

**Main Flow:**
1. Designer mở Home, nhập: "Design a mobile banking app for VNPAY users"
2. Chọn Skill: `mobile-app`, Design System: `revolut`
3. Nhấn Send → Agent emit discovery form
4. Designer điền: Surface=mobile, Audience=millennials, Tone=professional, Brand=VNPay red
5. Agent emit Direction Picker → Designer chọn "Modern Minimal"
6. Agent stream Todo: Read SKILL.md → Write brand-spec.md → Create 3 screens → Self-critique
7. Artifact render: 3 screens trong iPhone 15 Pro frame
8. Designer review, gõ "Add bottom nav bar and make the CTA button larger"
9. Agent sửa và artifact re-render
10. Designer Export → ZIP, chia sẻ với team

**Alternative Flow:**
- A1: Không có agent CLI → hỏi nhập API key, chuyển sang API mode
- A2: Discovery form bỏ qua → agent vẫn tạo nhưng có thể nhầm direction

**Postcondition:** Project folder có 3 HTML screens, brand-spec.md, preview ZIP

---

### UC-02: Tạo Báo cáo Tài chính

**Actor:** Business Analyst  

**Main Flow:**
1. Analyst mở Home, chọn Skill: `finance-report`
2. Nhập: "Q2 2026 revenue summary with YoY comparison"
3. Điền form: Data period=Q2 2026, Format=executive summary, Charts=yes
4. Agent tạo finance report artifact với charts (bar, line), KPI cards
5. Analyst Export → PDF chia sẻ với CEO

---

### UC-03: Deploy Landing Page lên Vercel

**Actor:** Marketing Designer  

**Main Flow:**
1. Designer có landing page artifact hoàn chỉnh
2. Click Deploy → Vercel
3. Nhập Vercel token, chọn team/project name
4. Hệ thống build và deploy
5. URL trả về: `https://my-landing.vercel.app`
6. Share URL với team để review

---

### UC-04: Admin cài đặt Private Instance

**Actor:** Platform Admin  

**Main Flow:**
1. Clone repository: `git clone ...open-design-vnpay`
2. `cp deploy/.env.example deploy/.env`
3. Nhập `OD_API_TOKEN=<secure-token>`
4. `docker compose up -d`
5. Truy cập `http://localhost:7456`
6. Admin phân phát token cho team members

---

## 4. Non-Functional User Requirements

### 4.1 Usability
- **UNF-01:** Thời gian học để tạo artifact đầu tiên < 10 phút với user mới
- **UNF-02:** Form discovery không quá 8 câu hỏi
- **UNF-03:** Error messages phải có actionable suggestions
- **UNF-04:** Hỗ trợ keyboard navigation cho main workflows
- **UNF-05:** Loading states rõ ràng cho mọi async operation

### 4.2 Performance (User-perceived)
- **UNF-06:** Home page load < 2 giây
- **UNF-07:** Skill picker hiển thị < 1 giây sau khi click
- **UNF-08:** Artifact preview xuất hiện < 3 giây sau khi agent xong
- **UNF-09:** File workspace list < 500ms

### 4.3 Reliability (User-facing)
- **UNF-10:** Conversation history không mất sau browser refresh
- **UNF-11:** Project files không mất sau daemon restart
- **UNF-12:** Failed agent run có thể retry mà không mất conversation

### 4.4 Accessibility
- **UNF-13:** WCAG 2.1 AA compliance cho core UI
- **UNF-14:** Dark mode giảm eye strain cho long sessions
- **UNF-15:** Font size tối thiểu 14px

### 4.5 Privacy
- **UNF-16:** Không upload project files lên server nếu không có explicit deploy action
- **UNF-17:** API keys không log vào console hay file
- **UNF-18:** User có thể xóa tất cả data local

---

## 5. Constraints từ góc nhìn User

| Constraint | Mô tả |
|-----------|-------|
| **C-01** | Cần có AI agent CLI hoặc BYOK API key để tạo artifact |
| **C-02** | Agent local (Claude Code, Codex...) yêu cầu cài đặt riêng trên máy user |
| **C-03** | Media generation (video, audio) cần API key riêng của provider |
| **C-04** | Deploy Vercel/Cloudflare cần account và token của provider tương ứng |
| **C-05** | Desktop app chỉ hỗ trợ macOS và Windows (Linux AppImage là beta) |
| **C-06** | Web browser phải support `srcdoc` iframe sandbox (Chrome 88+, Firefox 89+, Safari 14+) |

---

## 6. Acceptance Test Scenarios (High-level)

### ATS-01: First Run Onboarding
- Chạy fresh install → Welcome dialog xuất hiện
- Claude Code có trên PATH → Hiển thị "Available"
- Nhập Anthropic API key → Test connection → OK
- Close dialog → Có thể tạo project ngay

### ATS-02: End-to-End Design Workflow
- Home → "Create a simple dashboard for sales data" → saas-landing skill
- Discovery form → Submit answers
- Direction Picker → Select Modern Minimal
- Agent todo streaming → Artifact render
- Chat: "Make the header blue" → Artifact updates
- Export HTML → File downloads, opens offline

### ATS-03: Deck Workflow
- Select guizang-ppt skill → "Make a seed round pitch deck"
- Discovery → agent creates 10-slide deck
- Preview: horizontal swipe works
- Export PDF → 10-page PDF with slide boundaries

### ATS-04: Deploy Flow
- Artifact ready → Deploy → Cloudflare Pages
- Status: pending → building → ready
- URL accessible from another browser tab

---

## 7. Prioritization (MoSCoW)

### Must Have (M)
- Multi-agent detection và BYOK fallback
- Skills picker với prototype + deck modes
- Interactive question form (Turn-1)
- Sandboxed artifact preview
- HTML, PDF export
- SQLite persistence (conversations, projects, files)
- Settings: agent, API, privacy

### Should Have (S)
- Design Systems Library và switcher
- Deploy Vercel/Cloudflare
- Import Claude Design ZIP
- Comment/annotation trên preview
- Templates system
- Routines (scheduled automation)

### Could Have (C)
- Media generation (image, video, audio)
- MCP integration
- Desktop Electron app
- Orbit daily digest
- Community pets (gamification)

### Won't Have (W)
- Real-time collaborative editing (multi-user đồng thời)
- Mobile app native (iOS/Android)
- Vector design tools (line, shape drawing)
- Version control cho artifacts (Git-level)
