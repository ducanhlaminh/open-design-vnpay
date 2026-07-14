# F-21: Settings & Configuration — Data Flow

## Config Read/Write Flow

```
GET /api/config
    └── Read AppConfig from SQLite / config file
        → AppConfig (full object)

PUT /api/config
    Body: Partial<AppConfig>
    │
    ▼
Daemon:
    ├── Validate config values
    ├── Merge with current config
    ├── Persist to config file
    └── → { config: AppConfig }

POST /api/config/reset
    └── Restore defaults
        → { config: AppConfig }
```

## Privacy Consent Flow

```
First app launch
    │
    ▼
Check: AppConfig.privacyDecisionAt is null?
    │
    ▼
UI: PrivacyConsentModal
    ├── Explain: Metrics collected, Content analyzed, Artifact manifest (opt-in)
    └── Buttons: [Accept All] [Customize]

User accepts:
    PUT /api/config
    Body: {
      telemetry: { metrics: true, content: true, artifactManifest: false },
      privacyDecisionAt: Date.now(),
      installationId: crypto.randomUUID()
    }

User customizes:
    → Show toggle panel → user sets each toggle
    PUT /api/config { telemetry: { … }, privacyDecisionAt: … }
```

## "Delete My Data" Flow

```
User: Settings → Privacy → Delete My Data
    │
    ▼
PUT /api/config
    Body: {
      installationId: null,
      privacyDecisionAt: null,
      telemetry: { metrics: false, content: false, artifactManifest: false }
    }
    │
    ▼
Note: Projects and conversations are NOT deleted
    └── Only identity/consent data is cleared
    │
    ▼
Next launch: PrivacyConsentModal appears again
```

## Theme Switch Flow

```
User: Settings → Appearance → Dark Mode
    │
    ▼
PUT /api/config { theme: 'dark' }
    │
    ▼
UI:
    ├── Apply CSS: document.documentElement.setAttribute('data-theme', 'dark')
    ├── CSS transition: { transition: 'background-color 0.2s, color 0.2s' }
    └── Setting persists in AppConfig
    │
    ▼
'System' option:
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', …)
```

## Custom Instructions Flow

```
User: Settings → Custom Instructions
    └── Textarea (max 2000 chars, live counter)
    │
    ▼
PUT /api/config { customInstructions: "Always use BEM CSS…" }
    │
    ▼
Every agent turn:
    Daemon assembles prompt:
    └── Append at end: "\n\n## User Instructions\n{customInstructions}"
    │
    ▼
Per-project override:
    PATCH /api/projects/:id { customInstructions: "Project-specific…" }
    └── Project's customInstructions OVERRIDES global setting for this project
```

## API Key Masking Flow

```
User opens Settings → API
    │
    ▼
GET /api/config
    └── apiKey: "…xyz" (only last 4 chars)
    │
    ▼
UI displays: "•••••••••••••••xyz"
    │
    ▼
User enters new key:
    PUT /api/config { apiKey: "sk-ant-api03-…full-key" }
    └── Full key stored in config file
        → On next GET, masked again
```

## i18n Language Switch Flow

```
User: Header → Language → Vietnamese
    │
    ▼
i18n.changeLanguage('vi')
    └── All UI strings reload in Vietnamese
    │
    ▼
Store preference:
    localStorage.setItem('lang', 'vi')
    │
    ▼
Auto-detect on next load:
    navigator.language → 'vi' → load Vietnamese
    (if no manual override)
```

## Agent Connection Test Flow

```
User: Settings → Agents → Test Connection
    │
    ├── CLI agent:
    │   POST /api/agents/test { agentId: "claude" }
    │   → Daemon: spawn claude --version (timeout 5s)
    │   → { ok: true, version: "1.2.3" }
    │
    └── BYOK API:
        POST /api/agents/test { apiKey, baseUrl, model }
        → Daemon: send minimal request to API (timeout 5s)
        → { ok: true } | { ok: false, error: "Invalid API key" }
```

## Notifications Config Flow

```typescript
interface NotificationsConfig {
  routineComplete?: boolean;  // Notify when scheduled routine finishes
  orbitDigest?: boolean;      // Notify when Orbit digest is ready
  mediaReady?: boolean;       // Notify when image/video/audio generation completes
}
```

```
PUT /api/config
    Body: { notifications: { routineComplete: true, mediaReady: true } }
    │
    ▼
Daemon:
    ├── On routine completion → OS notification (if routineComplete: true)
    ├── On Orbit digest ready → OS notification (if orbitDigest: true)
    └── On media task ready → OS notification (if mediaReady: true)
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/config` | Read full AppConfig |
| PUT | `/api/config` | Update config (partial update) |
| POST | `/api/config/reset` | Reset to defaults |
