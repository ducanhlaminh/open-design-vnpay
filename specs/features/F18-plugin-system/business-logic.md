# F-18: Plugin System — Business Logic

## Overview

The Plugin System allows extending the daemon's functionality through installable plugins. Plugins can add tools, templates, scenario contexts, or custom connectors to a project. Each plugin goes through a lifecycle: install → snapshot → apply → run pipeline → uninstall.

---

## Business Rules

### Plugin Lifecycle

| Rule | Detail |
|------|--------|
| **BR-01** | Plugin lifecycle: `Install → Snapshot → Apply → Run Pipeline → Uninstall` |
| **BR-02** | Installing a plugin downloads and registers it in the daemon |
| **BR-03** | Snapshot captures the current state of plugin artifacts before applying |
| **BR-04** | Applying a plugin associates it with a specific project |
| **BR-05** | `appliedPluginSnapshotId` in Project metadata tracks the active plugin snapshot |
| **BR-06** | Uninstalling a plugin cleans up snapshots and removes registration |

### Plugin Types

| Type | Description |
|------|-------------|
| **Scenario plugins** | Add scenario context (marketing, finance, legal, etc.) to chat |
| **Tool plugins** | Add custom tools for the agent |
| **Template plugins** | Add project templates |
| **Connector plugins** | Add custom data connectors |

### Plugin Snapshots

| Rule | Detail |
|------|--------|
| **BR-07** | Snapshots persist plugin state for rollback capability |
| **BR-08** | Snapshot GC (`startSnapshotGc()`) automatically cleans old snapshots |
| **BR-09** | Projects reference their active snapshot via `appliedPluginSnapshotId` |

### Plugin Discovery in UI

| Rule | Detail |
|------|--------|
| **BR-10** | Plugins with `PluginLoopHome` are launchable directly from the Home page |
| **BR-11** | `InlinePluginsRail` shows plugins inline in the chat composer for quick access |
| **BR-12** | Plugin Marketplace allows browsing and installing available plugins |
| **BR-13** | Projects created with a pinned plugin hide the in-composer plugin rail |

---

## Plugin Registry Integration

Plugins are distributed via a **plugin registry** (defined in `packages/registry-protocol/`):
- Official plugins: `plugins/_official/`
- Community plugins: `plugins/community/`
- User can also install from custom registry or direct URL

---

## Data Model

```typescript
interface PluginSnapshot {
  id: string;
  pluginId: string;
  projectId: string;
  snapshotData: object;
  createdAt: number;
}

interface Plugin {
  id: string;
  name: string;
  description: string;
  version: string;
  type: 'scenario' | 'tool' | 'template' | 'connector';
  installed: boolean;
  installedAt?: number;
}
```

---

## Acceptance Criteria

- [ ] Install / Uninstall plugin
- [ ] Apply plugin to a project
- [ ] Plugin snapshot tracking
- [ ] Automatic snapshot GC
- [ ] Plugin appears in Home and inline chat
