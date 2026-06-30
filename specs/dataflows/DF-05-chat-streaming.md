# DF-05: Chat & SSE Streaming Data Flow

**Feature:** Chat Conversation, Agent Streaming, Prompt Stack  
**Actors:** User, Web UI, Daemon, Agent CLI, AI Provider, SQLite DB, Filesystem

---

## 1. Luồng tổng quan: Gửi Message → Nhận Stream

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant DB as 🗄️ SQLite
    participant A as 🤖 Agent CLI
    participant P as ☁️ AI Provider
    participant FS as 📁 Filesystem

    U->>W: Nhập prompt → Submit
    W->>D: POST /api/projects/:id/conversations/:cid/messages\n{ agentId, message, skillId, ... }

    rect rgb(235, 245, 255)
        Note over D,DB: Persist user message
        D->>DB: INSERT ChatMessage (role=user)
        D->>DB: INSERT ChatRun (status=queued)
    end

    rect rgb(235, 255, 235)
        Note over D,D: Assemble Prompt Stack
        D->>D: 1. DISCOVERY directives
        D->>D: 2. Identity charter (anti-AI-slop)
        D->>D: 3. Active DESIGN.md (design system)
        D->>D: 4. Active SKILL.md
        D->>D: 5. Project metadata
        D->>D: 6. Skill side files (template.html, references/)
        D->>D: 7. Memory entries (if enabled)
        D->>D: 8. Custom instructions
    end

    D->>DB: UPDATE ChatRun (status=running)
    D->>A: spawn agent process\n(claude --prompt <assembled>)
    D-->>W: SSE event: {type:'start', runId, agentId, model}

    loop Agent streaming
        A->>P: API call (stream)
        P-->>A: token delta
        A-->>D: stdout line (JSON event)
        D-->>W: SSE event: {type:'agent', ...DaemonAgentPayload}
        W-->>U: Render token delta
    end

    A->>FS: Write files (tool: file_write)
    A-->>D: tool_use + tool_result events
    D-->>W: SSE: {type:'agent', type:'tool_use'/'tool_result'}

    A-->>D: Exit 0
    D-->>W: SSE event: {type:'end', code:0, status:'succeeded'}

    rect rgb(255, 248, 235)
        Note over D,DB: Finalize
        D->>DB: UPDATE ChatMessage (role=assistant, content, eventsJson)
        D->>DB: UPDATE ChatRun (status=succeeded)
        D->>D: Memory extraction (background)
    end
```

---

## 2. SSE Event Flow Chi tiết

```mermaid
flowchart TD
    A[Agent stdout line] --> B{Parse JSON}
    B -->|status| C[DaemonAgentPayload\ntype: status]
    B -->|text_delta| D[DaemonAgentPayload\ntype: text_delta]
    B -->|thinking_delta| E[DaemonAgentPayload\ntype: thinking_delta]
    B -->|tool_use| F[DaemonAgentPayload\ntype: tool_use]
    B -->|tool_result| G[DaemonAgentPayload\ntype: tool_result]
    B -->|live_artifact| H[LiveArtifactSsePayload\naction: created/updated/deleted]
    B -->|usage| I[DaemonAgentPayload\ntype: usage]

    C --> SSE[SSE stream\ntype: agent]
    D --> SSE
    E --> SSE
    F --> SSE
    G --> SSE
    H --> SSE
    I --> SSE

    SSE --> W[🌐 Web UI]
    W --> |text_delta| RENDER[Render streaming text]
    W --> |tool_use| TOOL[Show tool card]
    W --> |live_artifact| LA[Update Live Artifact badge]
    W --> |usage| USAGE[Show token count]
```

---

## 3. Prompt Stack Assembly

```mermaid
flowchart TD
    subgraph PROMPT_STACK["Prompt Stack (thứ tự inject)"]
        P1[① DISCOVERY directives\nquestion-form, direction-picker]
        P2[② Identity charter\nanti-AI-slop, OFFICIAL_DESIGNER_PROMPT]
        P3[③ Active DESIGN.md\n150+ design systems]
        P4[④ Active SKILL.md\nbody + frontmatter]
        P5[⑤ Project metadata\nkind, platform, fidelity, animations]
        P6[⑥ Skill side files\ntemplate.html + references/*.md]
        P7[⑦ DECK framework\nnav/counter/scroll/print — deck only]
        P8[⑧ Memory entries\nuser/feedback/project/reference]
        P9[⑨ Custom instructions\nuser + project level]

        P1 --> P2 --> P3 --> P4 --> P5 --> P6 --> P7 --> P8 --> P9
    end
```

---

## 4. Redirect Mid-Flight Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon
    participant A as 🤖 Agent CLI

    Note over A,D: Agent đang chạy (status=running)
    U->>W: Gửi message mới giữa chừng
    W->>D: POST /api/runs/:runId/cancel
    D->>A: SIGTERM
    A-->>D: Exit (signal=SIGTERM)
    D-->>W: SSE end (status=canceled)
    D->>DB: UPDATE ChatRun (status=canceled)

    Note over W,D: Start new run với message mới
    W->>D: POST /api/projects/:id/conversations/:cid/messages\n{ message: <new prompt> }
    D->>A: spawn new agent
```

---

## 5. Conversation Multi-Turn Memory

```mermaid
flowchart LR
    MSG1[Turn 1\nUser + Assistant] --> DB[(SQLite\nChatMessage)]
    MSG2[Turn 2] --> DB
    MSG3[Turn N] --> DB

    DB -->|Reconstruct history| HIST[Message History]
    HIST -->|Include in context| AGENT[Agent next turn]

    subgraph PERSIST["Persisted per message"]
        CONTENT[content: string]
        EVENTS[eventsJson: PersistedAgentEvent]
        FILES[producedFiles: ProjectFile[]]
        TIMING[startedAt/endedAt]
    end
```

---

## 6. Feedback Submission Flow

```mermaid
sequenceDiagram
    actor U as 👤 User
    participant W as 🌐 Web UI
    participant D as ⚙️ Daemon

    U->>W: Click 👍 / 👎 trên assistant message
    W->>D: POST /api/runs/:runId/feedback\n{ rating, reasonCodes, customReason }
    D->>D: Check telemetry.metrics consent
    D->>D: Send to Langfuse (nếu consent=true)
    D-->>W: { status: 'accepted' | 'skipped_consent' }
    W-->>U: Feedback recorded
```

---

## Data Store Map

| Data | Location | Lifecycle |
|------|----------|-----------|
| `ChatMessage` | SQLite `messages` table | Persist forever |
| `ChatRun` | SQLite `runs` table | Persist, status updated |
| `eventsJson` | SQLite (JSON column) | Persist sau khi run xong |
| `producedFiles` | SQLite + FS listing | Sync từ FS mtime |
| Prompt stack | In-memory per run | Không persist |
| SSE stream | In-memory | Drop khi client disconnect |
