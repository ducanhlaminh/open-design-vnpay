# F-14 & F-15: Routines & Orbit — Data Flow

## Routine Scheduling Flow

```
Daemon starts
    │
    ▼
Load all enabled routines from SQLite
    │
    ▼
For each routine:
    ├── scheduleKind = 'daily'  → schedule cron job at HH:mm every day
    ├── scheduleKind = 'weekly' → schedule cron job on named weekday
    └── scheduleKind = 'once'  → schedule one-shot timer for date
    │
    ▼
Cron fires at scheduled time
    │
    ▼
executeRoutine(routine)
    │
    ├── projectMode = 'new'
    │   └── POST /api/projects (internal) → create new project
    │       └── POST /api/projects/:id/conversations/:cid/messages
    │           └── { content: routine.prompt, agentId: routine.agentId }
    │
    └── projectMode = 'existing'
        └── POST /api/projects/:routineProjectId/conversations/:cid/messages
            └── { content: routine.prompt }
    │
    ▼
CREATE RoutineRun record:
    { routineId, trigger: 'scheduled', status: 'running', projectId, … }
    │
    ▼
Agent runs → completes
    │
    ▼
UPDATE RoutineRun:
    { status: 'succeeded', summary: '…', completedAt: now }
    │ (or 'failed' with error message)
```

## Routine CRUD Flow

```
POST /api/routines
    Body: {
      name, prompt,
      scheduleKind: 'daily',
      scheduleValue: '09:00',
      projectMode: 'new',
      skillId: 'pm-spec',
      enabled: true
    }
    │
    ▼
INSERT routine into SQLite
    │
    ▼
Register cron job in daemon scheduler
    │
    ▼
→ { routine: Routine }

---

PUT /api/routines/:id
    Body: { enabled: false }
    │
    ▼
UPDATE routine in SQLite
    ├── If disabled → cancel cron job
    └── If enabled → re-register cron job
    │
    ▼
→ { routine: Routine }

---

DELETE /api/routines/:id
    │
    ▼
Deregister cron job
    DELETE from SQLite
    → { deleted: true }
```

## Manual Trigger Flow

```
POST /api/routines/:id/run
    │
    ▼
executeRoutine(routine)
    │
    ▼
CREATE RoutineRun: { trigger: 'manual', status: 'running', … }
    │
    ▼
Agent runs → completes
    │
    ▼
UPDATE RoutineRun: { status: 'succeeded | failed' }
    │
    ▼
→ { run: RoutineRun }
```

## Run History Flow

```
GET /api/routines/:id/runs
    └── SELECT FROM routine_runs WHERE routineId = :id ORDER BY startedAt DESC
        → RoutineRun[]
```

## Orbit Daily Flow

```
Daemon: every minute, check if orbit should fire
    │
    ▼
Current time matches orbit.time?
    ├── No  → skip
    └── Yes → check: already ran today?
               ├── Yes → skip (idempotent)
               └── No  → runOrbit()
    │
    ▼
runOrbit():
    │
    ├── Pull data from all configured memory connectors:
    │   ├── GitHub: commits, PRs, issues (last 24h)
    │   ├── Slack: messages, channel activity (last 24h)
    │   └── Other connectors: calendar events, Notion updates…
    │
    ├── hasData?
    │   ├── No  → log "No connector data, skipping Orbit"
    │   └── Yes → proceed
    │
    ├── CREATE new project (orbit digest)
    │   └── metadata: { kind: 'prototype', skillId: orbit.templateSkillId }
    │
    ├── Send digest prompt to agent:
    │   "Summarize today's activity: [GitHub commits], [Slack messages], …
    │    Create a daily digest dashboard"
    │
    └── Agent generates digest artifact
        → User opens app → finds digest project ready
```

## Orbit Config Flow

```
GET /api/orbit/config
    └── → { enabled: boolean, time: 'HH:mm', templateSkillId?: string }

PUT /api/orbit/config
    Body: { enabled: true, time: '08:00', templateSkillId: 'dashboard' }
    └── UPDATE AppConfig.orbit
        → { config: OrbitConfig }

POST /api/orbit/run
    └── Force run Orbit immediately (manual trigger)
        → { status: 'started' | 'skipped_no_data' }

GET /api/orbit/status
    └── → { lastRunAt?: number, nextRunAt?: number, enabled: boolean }
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/routines` | List all routines |
| POST | `/api/routines` | Create new routine |
| GET | `/api/routines/:id` | Routine detail |
| PUT | `/api/routines/:id` | Update routine |
| DELETE | `/api/routines/:id` | Delete routine |
| POST | `/api/routines/:id/run` | Manual trigger |
| GET | `/api/routines/:id/runs` | Run history |
| GET | `/api/orbit/status` | Orbit current status |
| POST | `/api/orbit/run` | Manual orbit trigger |
| GET | `/api/orbit/config` | Read orbit config |
| PUT | `/api/orbit/config` | Update orbit config |
