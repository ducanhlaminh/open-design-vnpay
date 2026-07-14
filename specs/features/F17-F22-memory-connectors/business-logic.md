# F-17 & F-22: Memory System & Connectors — Business Logic

## Overview

The **Memory System** enables agents to remember information across different conversations by extracting and persisting memory entries. The **Connectors** system links external services (GitHub, Slack, Notion, etc.) via Composio, feeding data into both the memory system and the Orbit daily digest.

---

## Memory System (F-17) — Business Rules

| Rule | Detail |
|------|--------|
| **BR-01** | Memory entries are **extracted automatically** from conversation content |
| **BR-02** | Extracted entries start with status `suggested` |
| **BR-03** | User must **confirm** or **reject** each suggested entry |
| **BR-04** | Only `confirmed` entries are injected into future conversation contexts |
| **BR-05** | User can manually delete any memory entry |
| **BR-06** | Entries carry a `confidence` score (0–1) indicating extraction certainty |
| **BR-07** | Entries can have tags for organization |
| **BR-08** | A toast notification appears when new memories are suggested |
| **BR-09** | Memories can be viewed and managed in Settings → Memory |

### Memory Entry Lifecycle

```
Conversation → Extract → suggested
                        ↓
              User confirm → confirmed → Inject into future context
              User reject  → rejected  → Not used
              User delete  → Removed from DB
```

---

## Connectors (F-22) — Business Rules

| Rule | Detail |
|------|--------|
| **BR-10** | Connectors integrate with external services via **Composio** middleware |
| **BR-11** | Composio supports 200+ integrations; Open Design exposes the most common ones |
| **BR-12** | Each connector authenticates via OAuth through Composio |
| **BR-13** | Credentials are stored per-connector |
| **BR-14** | Connector data is pulled on demand and fed to the memory system |
| **BR-15** | Connector data is also used as input for the Orbit daily digest |
| **BR-16** | Deduplication logic prevents re-extracting the same memories from connector data |

### Supported Connectors

| Connector | Data Extracted |
|-----------|---------------|
| GitHub | Commits, PRs, issues, code activity |
| Slack | Messages, channel activity |
| Notion | Pages, database updates |
| Google Calendar | Events, meetings |
| Linear | Issues, project updates |
| Jira | Tickets, sprints |
| + 200 more via Composio | — |

### Community Pets (Gamification)

| Rule | Detail |
|------|--------|
| **BR-17** | Virtual pet in UI grows based on usage (gamification element) |
| **BR-18** | Community pets sync via server |
| **BR-19** | Pet config: `{ name?, kind?, enabled? }` |

---

## Data Models

```typescript
interface MemoryEntry {
  id: string;
  content: string;          // Memory content
  source: string;           // conversationId or connectorId
  confidence: number;       // 0–1 confidence score
  status: 'suggested' | 'confirmed' | 'rejected';
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

interface ComposioSettings {
  apiKey?: string;
  enabled: boolean;
}

interface PetConfig {
  name?: string;
  kind?: string;
  enabled?: boolean;
}
```

---

## Acceptance Criteria

**Memory:**
- [ ] Memory entries automatically extracted from conversations
- [ ] User can confirm/reject each entry
- [ ] Confirmed entries injected into future conversation context
- [ ] Delete memory entry
- [ ] Memory toast notification

**Connectors:**
- [ ] Per-connector credential store
- [ ] Connect via OAuth (Composio)
- [ ] Disconnect / revoke
- [ ] Memory extraction from connector data
- [ ] Connector data feeds into Orbit digest
