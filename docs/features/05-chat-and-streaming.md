# F-06: Chat & Agent Streaming

**Nhóm:** 💬 Core — Conversation  
**Nguồn code:** `apps/daemon/src/chat-routes.ts` (55KB), `apps/daemon/src/db.ts`  
**UI:** `ChatPane.tsx` (75KB), `ChatComposer.tsx` (100KB), `AssistantMessage.tsx` (81KB)  
**API:** `POST /api/projects/:id/conversations/:convId/messages` (SSE stream)

---

## 1. Tổng quan

Mỗi project có nhiều **conversations** (threads chat). Mỗi conversation là một thread giữa user và agent, với lịch sử messages được persist trong SQLite và streaming qua **Server-Sent Events**.

---

## 2. Data Model

```typescript
interface Conversation {
  id: string;
  projectId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  latestRun?: ConversationRunSummary;
}

interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  agentId?: string;
  agentName?: string;
  eventsJson?: string;      // Persisted agent events
  attachments?: ChatAttachment[];
  producedFiles?: string[];
  runId?: string;
  runStatus?: RunStatus;    // 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  startedAt?: number;
  endedAt?: number;
  position: number;
  createdAt: number;
}
```

---

## 3. Prompt Stack Assembly

Khi user gửi message, daemon assembly prompt theo thứ tự:

```
1. DISCOVERY directives  (Turn-1 form, Turn-2 brand branch, TodoWrite, 5-dim critique)
2. identity charter      (OFFICIAL_DESIGNER_PROMPT, anti-AI-slop, junior-pass)
3. active DESIGN.md      (150+ systems available)
4. active SKILL.md       (132+ skills available)
5. project metadata      (kind, fidelity, speakerNotes, animations, inspirationIds)
6. skill side files      (assets/template.html + references/*.md — auto-inject pre-flight)
7. (deck kind)           DECK_FRAMEWORK_DIRECTIVE — nav/counter/scroll/print
```

---

## 4. Chat Flow (SSE Streaming)

```
User → POST /api/projects/:id/conversations/:convId/messages
     ← SSE stream: delta | tool_use | todo | artifact | file_op | question_form | direction_picker | end | error
```

---

## 5. Stream Events

| Event | Payload | Mô tả |
|-------|---------|-------|
| `delta` | `{text: string}` | Text token từ agent |
| `tool_use` | `{name, input, output}` | Tool call của agent |
| `todo` | `{items: TodoItem[]}` | Live TodoWrite progress |
| `artifact` | `{html, title, identifier}` | Artifact emitted |
| `file_op` | `{path, operation}` | File write/delete |
| `question_form` | `{fields: FormField[]}` | Turn-1 discovery form |
| `direction_picker` | `{directions: Direction[]}` | Visual direction picker |
| `end` | `{runId, status}` | Turn kết thúc |
| `error` | `{message, code}` | Lỗi |

---

## 6. Todo Card Streaming

Agent dùng `TodoWrite` để track tiến trình:

```
"Reading SKILL.md..."     → in_progress
"Writing brand-spec.md..." → completed ✓
"Creating index.html..."   → queued
"Self-critique..."         → in_progress
```

- Todo card cập nhật real-time qua SSE
- Mỗi step hiển thị icon trạng thái
- User có thể type tin nhắn mới giữa chừng (redirect mid-flight)

---

## 7. Run Status

| Status | Mô tả |
|--------|-------|
| `queued` | Đang xếp hàng chờ |
| `running` | Agent đang thực thi |
| `succeeded` | Hoàn thành thành công |
| `failed` | Thất bại |
| `canceled` | User hủy |

---

## 8. Attachments

User có thể đính kèm:
- **Files từ project** (reference to existing project files)
- **Upload files** (paste/drag image, document)
- **Context chips** (reference specific artifacts)

---

## 9. Conversation Persistence

- Messages persist trong SQLite sau mỗi turn
- Conversation history không mất sau browser refresh
- Failed agent run có thể retry mà không mất conversation
- `eventsJson` lưu raw agent events cho debugging

---

## 10. Multi-Conversation per Project

```
Project A
├── Conversation 1: "Initial design"
├── Conversation 2: "Mobile variant"
└── Conversation 3: "Dark theme"
```

- Mỗi conversation có context riêng
- Files trong project được share giữa conversations

---

## 11. Continue in CLI

Feature `ContinueInCliButton.tsx`:
- Xuất conversation history thành format dùng được với CLI agent
- User có thể tiếp tục từ CLI nếu muốn

---

## 12. API

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/projects/:id/conversations` | GET | Danh sách conversations |
| `/api/projects/:id/conversations` | POST | Tạo conversation mới |
| `/api/projects/:id/conversations/:cid` | GET | Chi tiết conversation |
| `/api/projects/:id/conversations/:cid/messages` | GET | Danh sách messages |
| `/api/projects/:id/conversations/:cid/messages` | POST | Gửi message (SSE) |
| `/api/projects/:id/conversations/:cid/cancel` | POST | Hủy run đang chạy |

---

## 13. Acceptance Criteria

- [x] SSE streaming real-time, latency cảm nhận < 100ms
- [x] Todo card cập nhật real-time
- [x] User có thể type giữa chừng (redirect mid-flight)
- [x] Conversation history persist qua browser refresh
- [x] Failed run có thể retry
- [x] Agent spawn < 1s sau khi submit prompt
- [x] Messages persist ngay cả khi daemon restart
