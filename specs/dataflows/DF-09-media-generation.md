# DF-09: Media Generation Data Flow

**Feature:** Media Generation — Tạo hình ảnh (Image), Video và Audio từ prompt hoặc template  
**Actors:** User, Web UI, Daemon, AI Agent (Media generation tools), Provider API (OpenAI, ByteDance, Fal.ai)

---

## 1. Image Generation Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant A as 🤖 Agent CLI
    participant P as ☁️ AI Provider (DALL-E / GPT-4o)

    U->>W: Mở tab "Image" → Chọn template
    W->>D: POST /api/projects\n{ kind: 'image', metadata: { promptTemplate: {...} } }
    
    Note over D,A: Bắt đầu chat run
    D->>A: spawn agent với prompt = template prompt
    
    A->>P: Tool call: `generate_image` (DALL-E)
    P-->>A: Image URL / Base64
    
    A->>A: Lưu file `.png` / `.jpg` vào thư mục project
    A-->>D: Event `write_file`
    D-->>W: SSE event (cập nhật file)
    
    W->>D: Lấy ảnh qua /api/projects/:id/files/...
    W-->>U: Hiển thị hình ảnh
```

---

## 2. Video Generation Flow (Seedance / HyperFrames)

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant A as 🤖 Agent CLI
    participant P as ☁️ AI Provider (ByteDance / HeyGen)

    U->>W: Nhập prompt tạo video (e.g. Seedance 2.0)
    W->>D: Gửi message
    
    D->>A: Agent phân tích prompt
    A->>P: Tool call `generate_video`\n{ model: 'seedance-2.0', prompt, aspect: '16:9' }
    
    Note over A,P: Async Video Generation
    P-->>A: Job ID
    
    loop Polling status
        A->>P: Kiểm tra Job ID
        P-->>A: status: 'processing'
    end
    
    P-->>A: Video MP4 URL
    A->>A: Download và lưu vào project
    A-->>D: Event `write_file`
    D-->>W: SSE báo có file video
    W-->>U: Hiển thị Video Player
```

---

## 3. Image Edit / Variation Flow

```mermaid
flowchart TD
    U[User] -->|Click 'Edit Image'| W[Web UI]
    W -->|Vẽ mask / nhập prompt phụ| W2[Gửi kèm image source + mask]
    
    W2 -->|POST /messages| D[Daemon]
    D --> A[Agent CLI]
    
    A -->|Tool `edit_image`| P[AI Provider\ne.g. DALL-E Inpainting]
    P -->|Edited image| A
    
    A -->|write_file mới| FS[(Filesystem)]
    FS --> D --> W
    W --> U
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| Prompt Template | SQLite `projects.metadataJson` | Lấy từ `prompt-templates/{image|video}/` khi tạo |
| Media Files | Filesystem `.od/projects/<id>/` | Images, MP4, MP3 được lưu vật lý |
| API Keys | SQLite `config.json` | Cấu hình trong Settings → Media Providers |
