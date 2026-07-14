# F-18: Plugin System — Data Flow

## Plugin Install Flow

```
User: Marketplace → Browse plugins
    │
    ▼
GET /api/plugins (available)
    └── → Plugin[] { id, name, version, type, installed }
    │
User selects plugin → "Install"
    │
    ▼
POST /api/plugins/install
    Body: { pluginId: "marketing-scenario" }
    │
    ▼
Daemon:
    ├── Download plugin bundle from registry
    ├── Validate plugin manifest
    ├── Extract to plugins/<id>/
    ├── Register plugin tools/templates in daemon
    └── INSERT plugin record in SQLite: { installed: true }
    │
    ▼
→ { plugin: Plugin }
```

## Plugin Apply Flow

```
User: Project → "Use Plugin" → select plugin
    │
    ▼
POST /api/plugins/:id/apply
    Body: { projectId: "proj-xyz", inputs?: { … } }
    │
    ▼
Daemon:
    ├── CREATE snapshot of plugin artifacts:
    │   { id: "snap-abc", pluginId, projectId, snapshotData: { … } }
    ├── UPDATE project: { appliedPluginSnapshotId: "snap-abc" }
    └── Initialize plugin context for project
    │
    ▼
→ { snapshotId: "snap-abc", project: Project }
    │
    ▼
Next agent turn:
    Plugin context injected into prompt stack
```

## Plugin Uninstall Flow

```
POST /api/plugins/:id/uninstall
    │
    ▼
Daemon:
    ├── Deregister plugin tools/templates
    ├── DELETE snapshots WHERE pluginId = :id (or GC handles this)
    ├── UPDATE affected projects: { appliedPluginSnapshotId: null }
    ├── Remove plugin files from plugins/<id>/
    └── UPDATE plugin record: { installed: false }
    │
    ▼
→ { uninstalled: true }
```

## Snapshot GC Flow

```
startSnapshotGc()
    │
    ▼
Runs periodically (e.g., every 1 hour)
    │
    ▼
SELECT snapshots WHERE:
    ├── project.appliedPluginSnapshotId != snapshot.id
    └── createdAt < (now - retentionPeriod)
    │
    ▼
DELETE stale snapshots
    └── Log: "GC: removed N old snapshots"
```

## Plugin on Home Flow

```
Daemon startup:
    ├── Load all installed plugins
    └── Identify plugins with PluginLoopHome flag
    │
    ▼
GET /api/plugins?homeVisible=true
    └── → Plugin[] (home-visible only)
    │
    ▼
Home page: PluginLoopHome.tsx
    └── Renders plugin launch cards on home screen
    │
User clicks plugin card
    │
    ▼
POST /api/projects (create new project with plugin pre-applied)
    Body: {
      pluginId: "marketing-scenario",
      metadata: { contextPlugins: [{ pluginId }] }
    }
    │
    ▼
Navigate to new project conversation
```

## Inline Chat Plugin Rail Flow

```
User opens chat composer
    │
    ▼
GET /api/plugins?contextual=true
    └── → Plugin[] for inline rail
    │
    ▼
InlinePluginsRail renders: [Plugin A] [Plugin B] [Plugin C]
    │
User clicks plugin chip
    │
    ▼
Plugin context added to current message:
    "Using marketing-scenario plugin context…"
    │
    ▼
Plugin context injected into agent prompt for this turn
```

## Plugin Snapshot Read Flow

```
GET /api/plugins/snapshots/:id
    └── SELECT snapshot WHERE id = :id
        → PluginSnapshot { id, pluginId, projectId, snapshotData }
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/plugins` | List installed plugins |
| GET | `/api/plugins/:id` | Plugin detail |
| POST | `/api/plugins/install` | Install plugin |
| POST | `/api/plugins/:id/uninstall` | Uninstall plugin |
| POST | `/api/plugins/:id/apply` | Apply plugin to project |
| GET | `/api/plugins/snapshots/:id` | Read plugin snapshot |
