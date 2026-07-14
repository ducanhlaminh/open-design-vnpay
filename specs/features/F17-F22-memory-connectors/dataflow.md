# F-17 & F-22: Memory System & Connectors — Data Flow

## Memory Extraction Flow

```
Agent completes a conversation turn
    │
    ▼
Daemon: extractMemories(messages)
    │
    ├── Analyze assistant message content
    ├── Identify factual claims, preferences, context worth remembering
    │   e.g., "User prefers dark mode", "Project uses BEM CSS"
    ├── Score confidence (0–1)
    └── CREATE memory entries with status = 'suggested'
    │
    ▼
SSE event (or toast notification):
    "New memory suggested: 'User prefers Inter font'"
    │
    ▼
UI: MemoryToast appears
    ├── "User prefers Inter font" [Confirm] [Reject]
    │
User confirms:
    PATCH /api/memory/:id { status: 'confirmed' }
    └── Entry now injected in future prompts

User rejects:
    PATCH /api/memory/:id { status: 'rejected' }
    └── Entry excluded from future context
```

## Memory Injection into Conversation

```
User sends new message
    │
    ▼
Daemon: assemble context
    │
    ├── Load all confirmed memory entries
    ├── Format as context block:
    │   "## Remembered Context\n
    │    - User prefers dark mode\n
    │    - Project uses BEM CSS\n
    │    - Brand colors: #1E40AF, #FFFFFF"
    └── Inject at bottom of system prompt (after skill/design system)
    │
    ▼
Agent receives memory as part of context
```

## Memory CRUD Flow

```
GET /api/memory
    └── SELECT * FROM memory_entries ORDER BY createdAt DESC
        → MemoryEntry[]

POST /api/memory/extract
    Body: { message: string }
    └── Run extraction pipeline → suggest new entries
        → { suggested: MemoryEntry[] }

PATCH /api/memory/:id
    Body: { status: 'confirmed' | 'rejected' }
    └── UPDATE memory_entries SET status = … WHERE id = :id
        → { entry: MemoryEntry }

DELETE /api/memory/:id
    └── DELETE FROM memory_entries WHERE id = :id
        → { deleted: true }
```

## Connector Connection Flow

```
User: Browse ConnectorsBrowser
    │
    ▼
GET /api/connectors
    └── → ConfiguredConnector[]

User clicks "Connect GitHub"
    │
    ▼
POST /api/connectors/github/connect
    │
    ▼
Daemon → Composio OAuth flow:
    ├── GET composio.io/oauth/github/begin → authorizeUrl
    ├── Redirect user to GitHub OAuth page
    ├── User grants permissions
    ├── GitHub → callback to Composio
    └── Composio → callback to daemon: { accessToken, refreshToken }
    │
    ▼
Store credentials in SQLite (encrypted)
UPDATE connector: { connected: true }
    │
    ▼
ConnectorsBrowser: GitHub shows "Connected ✓"
```

## Connector Data Pull Flow

```
Memory-Connectors: pull data from active connectors
    │
    ├── GitHub connector:
    │   GET /api/connectors/github/data?since=24h
    │   → { commits: [], prs: [], issues: [] }
    │
    ├── Slack connector:
    │   GET /api/connectors/slack/data?since=24h
    │   → { messages: [], channels: [] }
    │
    └── Other connectors: similar
    │
    ▼
memory-connectors.ts:
    ├── Extract meaningful memories from each data source
    │   e.g., "Merged PR #123: Updated auth system" → memory entry
    ├── Deduplicate against existing entries (by content hash)
    └── INSERT new suggested memories into DB
    │
    ▼
Feed extracted data to Orbit digest system
```

## Connector Disconnect Flow

```
DELETE /api/connectors/:id
    │
    ▼
Daemon:
    ├── Revoke OAuth token via Composio
    ├── DELETE credentials from SQLite
    └── UPDATE connector: { connected: false }
    │
    ▼
→ { disconnected: true }
```

## Memory Model Inline (In-Chat)

```
During chat turn, agent suggests memory
    │
    ▼
MemoryModelInline component appears inline in chat:
    ┌─────────────────────────────────────┐
    │ 💭 New Memory Suggestion             │
    │ "User prefers Tailwind CSS"         │
    │                [✓ Confirm] [✗ Skip] │
    └─────────────────────────────────────┘
    │
User confirms → PATCH /api/memory/:id { status: 'confirmed' }
User skips → PATCH /api/memory/:id { status: 'rejected' }
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/memory` | List all memory entries |
| POST | `/api/memory/extract` | Extract memories from text |
| GET | `/api/memory/:id` | Memory entry detail |
| PATCH | `/api/memory/:id` | Confirm / reject |
| DELETE | `/api/memory/:id` | Delete entry |
| GET | `/api/connectors` | List configured connectors |
| POST | `/api/connectors/:id/connect` | Connect via OAuth (Composio) |
| DELETE | `/api/connectors/:id` | Disconnect |
| GET | `/api/connectors/:id/data` | Pull data from connector |
