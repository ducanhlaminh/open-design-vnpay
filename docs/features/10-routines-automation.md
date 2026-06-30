# F-14 & F-15: Routines & Orbit — Scheduled Automation

**Nhóm:** ⚙️ Automation  
**Nguồn code:**
- `apps/daemon/src/routines.ts`
- `apps/daemon/src/routine-routes.ts`
- `apps/daemon/src/orbit.ts` (28KB)  
**UI:** `RoutinesSection.tsx` (28KB), `NewAutomationModal.tsx` (38KB)

---

## 1. Routines — Cron-based Automation (F-14)

### 1.1 Tổng quan

Routines là các **cron-based hoặc time-based automation** chạy định kỳ để tạo project mới (hoặc message vào project cũ) với prompt và skill cho trước.

**Use cases:**
- Weekly design progress report
- Daily competitor analysis
- Monthly finance summary
- Auto-generate social content mỗi ngày

### 1.2 Data Model

```typescript
interface Routine {
  id: string;
  name: string;
  prompt: string;
  scheduleKind: 'daily' | 'weekly' | 'once';
  scheduleValue: string;     // '09:00' | 'monday' | '2026-06-05'
  scheduleJson?: RoutineSchedule;
  projectMode: 'new' | 'existing';
  projectId?: string;        // Target project nếu mode = 'existing'
  skillId?: string;
  agentId?: string;
  contextJson?: object;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
```

### 1.3 Schedule Types

| scheduleKind | scheduleValue | Ví dụ |
|-------------|--------------|-------|
| `daily` | HH:mm | `"09:00"` — chạy lúc 9:00 AM mỗi ngày |
| `weekly` | day name | `"monday"` — chạy mỗi thứ Hai |
| `once` | date string | `"2026-06-05"` — chạy một lần |

### 1.4 Run Tracking

```typescript
interface RoutineRun {
  id: string;
  routineId: string;
  trigger: 'scheduled' | 'manual';
  status: 'running' | 'succeeded' | 'failed';
  projectId: string;
  conversationId: string;
  agentRunId: string;
  startedAt: number;
  completedAt?: number;
  summary?: string;
  error?: string;
  errorCode?: string;
}
```

### 1.5 API

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/routines` | GET | Danh sách routines |
| `/api/routines` | POST | Tạo routine mới |
| `/api/routines/:id` | GET | Chi tiết routine |
| `/api/routines/:id` | PUT | Update routine |
| `/api/routines/:id` | DELETE | Xóa routine |
| `/api/routines/:id/run` | POST | Trigger manual run |
| `/api/routines/:id/runs` | GET | Run history |

### 1.6 Tính năng

- **Enable/Disable** routine mà không cần xóa
- **Manual trigger** để test routine
- **Run history** với status, error, summary
- **Timezone awareness**
- Tạo project mới hoặc message vào project cũ

---

## 2. Orbit — Daily Activity Digest (F-15)

### 2.1 Tổng quan

Orbit là **routine đặc biệt** chạy hàng ngày vào giờ cố định, tổng hợp activity từ memory connectors và tạo một digest project mới.

### 2.2 Config

```typescript
interface OrbitConfig {
  enabled: boolean;
  time: string;              // 'HH:mm' format, ví dụ: '08:00'
  templateSkillId?: string | null;
}
```

Config lưu trong `AppConfig.orbit` → Settings → Orbit section.

### 2.3 Cơ chế

```
08:00 AM (configured time)
  → Daemon check connector data
  → Nếu có data: tổng hợp từ memory connectors
  → Tạo digest project mới
  → User mở app thấy digest sẵn
  → Không chạy nếu không có connector data
```

### 2.4 API

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/orbit/status` | GET | Trạng thái orbit hiện tại |
| `/api/orbit/run` | POST | Manual trigger |
| `/api/orbit/config` | GET | Đọc orbit config |
| `/api/orbit/config` | PUT | Cập nhật config |

### 2.5 Đặc điểm

- **Timezone awareness**: Chạy đúng local time
- **Summary từ memory connectors**: GitHub commits, Slack messages, v.v.
- **Không chạy nếu không có data**: Tránh tạo empty projects
- **Template Skill**: Có thể chọn skill template cho digest

---

## 3. Use Cases

### UC: Weekly Design Summary
```
Routine:
  Name: "Weekly Design Summary"
  Schedule: weekly, monday, 09:00
  Prompt: "Summarize this week's design projects and highlight key decisions"
  Skill: pm-spec
  Mode: new project

Kết quả: Mỗi thứ Hai 9AM → tạo project mới với summary
```

### UC: Daily Orbit Digest
```
Orbit config:
  Time: 08:00
  Enabled: true

Kết quả: Mỗi sáng 8AM → digest từ GitHub, Slack activity
```

---

## 4. Acceptance Criteria

**Routines:**
- [x] Schedule: daily / weekly / specific time
- [x] Timezone awareness
- [x] Routine run history với status, error, summary
- [x] Manual trigger để test
- [x] Enable/disable mà không xóa
- [x] Target: new project hoặc existing project

**Orbit:**
- [x] Orbit chạy đúng giờ đã configure
- [x] Summary từ memory connectors
- [x] Không chạy nếu không có connector data
- [x] Manual trigger
