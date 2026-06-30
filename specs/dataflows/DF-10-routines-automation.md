# DF-10: Routines & Automation Data Flow

**Feature:** Routines (Lịch chạy định kỳ) & Automations (Pipeline tự động)  
**Actors:** Daemon (Scheduler), SQLite DB, Agent CLI, Connector API

---

## 1. Routine Execution Flow (Scheduled)

```mermaid
sequenceDiagram
    participant S as ⏱️ Cron Scheduler (Daemon)
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant A as 🤖 Agent CLI
    participant FS as 📁 Filesystem

    S->>D: Tick (đến giờ chạy Routine X)
    D->>DB: Lấy cấu hình Routine X (prompt, target, skillId)
    
    alt Target = 'create_each_run'
        D->>D: POST /api/projects (nội bộ)\nCreate project mới
    else Target = 'reuse'
        D->>D: Lấy projectId đã lưu
        D->>DB: Tạo Conversation mới trong project đó
    end
    
    D->>DB: Tạo RoutineRun (status: running)
    
    D->>A: spawn agent với prompt của Routine
    Note over A,FS: Agent gọi connector, đọc tool, viết file
    A-->>D: Agent exit (thành công)
    
    D->>DB: Cập nhật RoutineRun (status: succeeded, completedAt)
    D->>DB: Tính toán `nextRunAt` dựa trên `schedule`
```

---

## 2. Orbit Flow (Daily Digest Automation)

```mermaid
flowchart TD
    S[Cron tick (daily at HH:mm)] --> CHK{Orbit enabled?}
    CHK -->|No| STOP[Bỏ qua]
    CHK -->|Yes| PULL[Kích hoạt Connector Sync]
    
    PULL --> C_CAL[Lấy Calendar events]
    PULL --> C_MAIL[Lấy Unread Emails]
    PULL --> C_GH[Lấy GitHub Notifications]
    
    C_CAL --> AG[Aggregate data]
    C_MAIL --> AG
    C_GH --> AG
    
    AG --> PROJ[Tạo Project mới\n(Skill: Daily Orbit)]
    PROJ --> AGENT[Chạy Agent tóm tắt thông tin]
    AGENT --> ART[Tạo Dashboard Live Artifact]
```

---

## 3. Automation Data Ingestion (Memory/Evolution)

Khi Routine (hoặc thao tác thủ công) "crystallize" một packet data để đưa vào Automation Pipeline:

```mermaid
sequenceDiagram
    participant A as 🤖 Agent / Routine
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant EV as 🧠 Evolution Pipeline

    A->>D: POST /api/automations/ingest\n{ sourceKind, title, bodyMarkdown, ... }
    
    D->>D: Tính toán token (Compress tokens nếu bật)
    D->>DB: Lưu AutomationContentPacket
    
    D->>EV: Đẩy Packet vào AutomationTemplate pipeline
    EV->>EV: Chạy các Stage (classify, propose)
    EV->>DB: Tạo AutomationEvolutionProposal (Draft)
    
    Note over D,EV: User review proposal (hoặc auto-apply)
    
    alt Apply Proposal (vd: memory-node)
        EV->>DB: Update Memory TreeNode / Entry
        EV->>DB: Update Proposal (status=applied)
    end
```

---

## Data Store Map

| Data | Location | Notes |
|------|----------|-------|
| `Routine` | SQLite `routines` | Cấu hình lịch (hourly, daily, weekly), target project |
| `RoutineRun` | SQLite `routine_runs` | Tracking lịch sử mỗi lần chạy |
| `AppConfig.orbit` | SQLite `config.json` | Cấu hình Orbit (time, enabled) |
| `AutomationTemplate` | SQLite `automation_templates` | Blueprint pipeline |
| `AutomationContentPacket` | SQLite | Raw data ingest vào hệ thống |
| `EvolutionProposal` | SQLite `automation_proposals` | Đề xuất chỉnh sửa từ AI chờ user duyệt |
