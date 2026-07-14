# F-06: Chat & Agent Streaming — Data Flow

## Full Chat Turn Flow

```
User
 │
 ├── Types message in ChatComposer
 ├── Optionally attaches files / context chips
 └── Submit
 │
 ▼
POST /api/projects/:id/conversations/:cid/messages
 Body: { content, attachments?, contextChips? }
 │
 ▼
Daemon:
 ├── INSERT user message → SQLite
 ├── Assemble prompt stack:
 │   1. DISCOVERY directives
 │   2. Identity charter
 │   3. DESIGN.md (from designSystemId)
 │   4. SKILL.md (from skillId)
 │   5. Project metadata
 │   6. Skill side files (template.html + references)
 │   7. DECK_FRAMEWORK_DIRECTIVE (if deck kind)
 ├── Create run record (status: 'queued')
 └── Spawn agent subprocess (< 1 second)
 │
 ▼
Response: HTTP 200, Content-Type: text/event-stream
 │
 ▼
SSE Stream begins
```

## SSE Event Stream

```
Agent process stdout
    │
    ├── Protocol-specific parsing (claude-stream-json | json-event-stream | acp-json-rpc | …)
    │
    ▼
Normalize to standard event format:

event: delta
data: {"text": "Here is your landing page…"}

event: tool_use
data: {"name": "Write", "input": {"file": "index.html", "content": "…"}, "output": {}}

event: todo
data: {"items": [
  {"label": "Reading SKILL.md", "status": "completed"},
  {"label": "Writing index.html", "status": "in_progress"},
  {"label": "Self-critique", "status": "queued"}
]}

event: artifact
data: {"html": "<!DOCTYPE html>…", "title": "My Landing Page", "identifier": "abc-123"}

event: file_op
data: {"path": "index.html", "operation": "write"}

event: question_form
data: {"fields": [{"id": "surface", "type": "radio", "options": ["desktop","mobile"]}]}

event: direction_picker
data: {"directions": [{"id": "editorial", "label": "Editorial Monocle", "palette": […]}]}

event: end
data: {"runId": "run-xyz", "status": "succeeded"}

event: error
data: {"message": "Agent exited unexpectedly", "code": "AGENT_CRASH"}
```

## Run Completion Flow

```
event: end received
    │
    ▼
Daemon:
    ├── UPDATE run record: status = 'succeeded' | 'failed'
    ├── INSERT assistant message into SQLite:
    │   { role: 'assistant', content, eventsJson, producedFiles, runId, runStatus }
    └── UPDATE conversation.updatedAt
    │
    ▼
SSE connection closes
    │
    ▼
UI:
    ├── Render assistant message (markdown + artifact inline)
    ├── Update TodoCard to final state
    └── Show download chips if artifact produced
```

## Cancel Flow

```
User clicks "Stop" during running turn
    │
    ▼
POST /api/projects/:id/conversations/:cid/cancel
    │
    ▼
Daemon:
    ├── Kill agent subprocess (SIGTERM → SIGKILL after 2s)
    ├── UPDATE run record: status = 'canceled'
    ├── Save partial assistant message
    └── Close SSE stream
    │
    ▼
event: end (status: 'canceled')
```

## Mid-Flight Redirect Flow

```
User types new message while agent is running
    │
    ▼
Submit new message
    │
    ▼
Daemon:
    ├── Kill current agent run
    ├── Save partial results
    └── Start new run with combined context
        (previous partial response + new message)
```

## Conversation Persistence Flow

```
Every assistant message is persisted BEFORE SSE stream closes
    │
    ├── Browser refresh → messages still present
    ├── Daemon restart → messages still present
    └── Failed run → partial content preserved for retry
```

## Multi-Conversation Architecture

```
Project A (.od/projects/<id>/)
    │
    ├── Conversation 1: "Initial design"
    │   ├── Message 1 (user): "Build a landing page"
    │   ├── Message 2 (assistant): [artifact: index.html]
    │   └── Message 3 (user): "Add dark mode"
    │
    ├── Conversation 2: "Mobile variant"
    │   ├── Message 1 (user): "Convert to mobile"
    │   └── Message 2 (assistant): [artifact: index.html updated]
    │
    └── Shared filesystem: index.html, style.css, brand-spec.md, …
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/:id/conversations` | List conversations |
| POST | `/api/projects/:id/conversations` | Create new conversation |
| GET | `/api/projects/:id/conversations/:cid` | Conversation detail |
| PUT | `/api/projects/:id/conversations/:cid` | Update title |
| DELETE | `/api/projects/:id/conversations/:cid` | Delete conversation |
| GET | `/api/projects/:id/conversations/:cid/messages` | List messages |
| POST | `/api/projects/:id/conversations/:cid/messages` | Send message (SSE stream) |
| POST | `/api/projects/:id/conversations/:cid/cancel` | Cancel running turn |
