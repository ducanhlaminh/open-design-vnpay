# F-14 & F-15: Routines & Orbit — Business Logic

## Overview

**Routines** are cron-based automations that periodically create new projects or send messages to existing ones, using a specified agent, skill, and prompt.  
**Orbit** is a special built-in routine that runs daily, aggregating activity data from memory connectors and creating a digest project.

---

## Routines (F-14) — Business Rules

| Rule | Detail |
|------|--------|
| **BR-01** | Routines run on a schedule: `daily` (at a time), `weekly` (on a day), or `once` (a specific date) |
| **BR-02** | Timezone awareness — schedules fire at correct local time |
| **BR-03** | Routines can target `new` project (creates fresh each run) or `existing` project (appends message) |
| **BR-04** | Each routine run is tracked: status `running → succeeded | failed`, with summary and error |
| **BR-05** | Routines can be enabled/disabled without deletion |
| **BR-06** | Manual trigger is supported for testing |
| **BR-07** | Run history is retained for all triggered runs |

### Schedule Types

| scheduleKind | scheduleValue | Example |
|-------------|--------------|---------|
| `daily` | `HH:mm` | `"09:00"` — run every day at 9:00 AM |
| `weekly` | day name | `"monday"` — run every Monday |
| `once` | date string | `"2026-06-05"` — run once on that date |

---

## Orbit (F-15) — Business Rules

| Rule | Detail |
|------|--------|
| **BR-08** | Orbit runs daily at a configured time (default: 08:00) |
| **BR-09** | Orbit aggregates activity from **all configured memory connectors** (GitHub, Slack, Notion, etc.) |
| **BR-10** | If no connector data is available, Orbit does **not** run — avoids creating empty projects |
| **BR-11** | Orbit creates a new digest project each day |
| **BR-12** | Manual trigger via `POST /api/orbit/run` |
| **BR-13** | Template skill can be configured for the digest project format |
| **BR-14** | Orbit config is stored in `AppConfig.orbit` |

---

## Data Models

```typescript
interface Routine {
  id: string;
  name: string;
  prompt: string;
  scheduleKind: 'daily' | 'weekly' | 'once';
  scheduleValue: string;         // '09:00' | 'monday' | '2026-06-05'
  scheduleJson?: RoutineSchedule;
  projectMode: 'new' | 'existing';
  projectId?: string;            // Required when projectMode = 'existing'
  skillId?: string;
  agentId?: string;
  contextJson?: object;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

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

interface OrbitConfig {
  enabled: boolean;
  time: string;            // 'HH:mm' format
  templateSkillId?: string | null;
}
```

---

## Use Cases

### Weekly Design Summary

```
Routine:
  Name: "Weekly Design Summary"
  Schedule: weekly, monday, 09:00
  Prompt: "Summarize this week's design projects and highlight key decisions"
  Skill: pm-spec
  Mode: new project

Result: Every Monday 9 AM → new project with summary created
```

### Daily Orbit Digest

```
Orbit config:
  Time: 08:00
  Enabled: true

Result: Every morning 8 AM →
  - Pull GitHub commits, Slack messages
  - Create digest project
  - User opens app to find digest ready
```

---

## Acceptance Criteria

**Routines:**
- [ ] Schedule: daily / weekly / specific time
- [ ] Timezone awareness
- [ ] Run history with status, error, summary
- [ ] Manual trigger to test
- [ ] Enable/disable without deleting
- [ ] Target: new project or existing project

**Orbit:**
- [ ] Orbit fires at configured time
- [ ] Summary from memory connectors
- [ ] Does not run if no connector data
- [ ] Manual trigger supported
