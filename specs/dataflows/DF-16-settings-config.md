# DF-16: Settings & Configuration Data Flow

**Feature:** Quản lý cấu hình Settings toàn cục (Agents, Models, MCP, Skills, Media Providers, Telemetry)  
**Actors:** User, Web UI, Daemon, SQLite DB

---

## 1. Preferences Loading & Saving

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite

    Note over U,W: Mở màn hình Settings
    W->>D: GET /api/config
    D->>DB: Đọc `config.json` (hoặc record trong SQLite)
    D-->>W: AppConfigPrefs (các cấu hình đã lưu)
    
    W-->>U: Hiển thị form (Agent mặc định, Telemetry, v.v.)
    
    U->>W: Đổi Agent mặc định sang "cursor"
    W->>D: PUT /api/config\n{ agentId: "cursor" }
    
    D->>D: Merge deep với config hiện tại
    D->>DB: Lưu đè xuống `config.json`
    D-->>W: Ok
```

---

## 2. Telemetry / Metrics Data Flow

Theo dõi người dùng và lưu lượng, được bật qua `telemetry.metrics`.

```mermaid
flowchart TD
    U[User Tương tác\nVD: Submit Prompt] -->|Web UI Track| D[Daemon]
    
    D --> CHK{Telemetry Enabled?}
    CHK -->|False| STOP[Drop sự kiện]
    CHK -->|True| EVENT[Chuẩn hóa Event\n(Xóa PII, Mask data)]
    
    EVENT --> BATCH[Batch Event Queue]
    BATCH -->|Định kỳ| POSTHOG[PostHog API\n(Analytics Server)]
    
    POSTHOG --> METRICS[Dashboard Thống kê\n(Phía Backend System)]
```

---

## 3. Media Provider (BYOK) Setup

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite

    U->>W: Chọn "Custom/BYOK" trong Settings → Media Provider
    W-->>U: Hiển thị form nhập: Provider URL, API Key
    
    U->>W: Nhập `https://api.openai.com` và key
    W->>D: Cập nhật AppConfigPrefs (lưu API Key masked)
    D->>DB: Lưu xuống ổ cứng
    
    Note over D,W: API Key không bị phơi bày trên UI nếu đã nhập
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| `AppConfigPrefs` | `~/.od/config.json` (hoặc DB row) | Toàn bộ settings (agent cli, orbit, telemetry) |
| API Keys | Tương tự | Lưu plain text (hoặc encrypt nhẹ) ở phía Daemon |
| Default Agent | `AppConfigPrefs.agentId` | Dùng khi user tạo project không chỉ định Agent |
