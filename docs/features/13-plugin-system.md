# F-18: Plugin System

**Nhóm:** 🧩 Platform — Plugins  
**Nguồn code:** `apps/daemon/src/plugins/`  
**UI:** `PluginsView.tsx` (68KB), `PluginDetailView.tsx`, `PluginsSection.tsx`, `PluginLoopHome.tsx`

---

## 1. Tổng quan

Plugin system cho phép **mở rộng functionality** của daemon thông qua installable plugins. Mỗi plugin có thể thêm tools, templates, hoặc custom workflows vào dự án.

---

## 2. Plugin Lifecycle

```
Install → Snapshot → Apply → Run Pipeline → Uninstall
```

| Phase | Mô tả |
|-------|-------|
| **Install** | Download và register plugin |
| **Snapshot** | Capture state hiện tại của plugin artifacts |
| **Apply** | Apply plugin vào một project cụ thể |
| **Run Pipeline** | Execute plugin workflow |
| **Uninstall** | Remove plugin, cleanup snapshots |

---

## 3. Plugin Snapshots

```typescript
interface PluginSnapshot {
  id: string;
  pluginId: string;
  projectId: string;
  snapshotData: object;
  createdAt: number;
}
```

- Snapshot GC (`startSnapshotGc()`) — tự động dọn snapshots cũ
- `appliedPluginSnapshotId` trong Project metadata để track

---

## 4. Plugin Types

Dựa trên `PluginsHomeSection.tsx` và `PluginsSection.tsx`:

| Type | Mô tả |
|------|-------|
| **Scenario plugins** | Thêm scenario context vào chat (marketing, finance, v.v.) |
| **Tool plugins** | Thêm custom tools cho agent |
| **Template plugins** | Thêm project templates |
| **Connector plugins** | Thêm custom data connectors |

---

## 5. Plugin Loop Home

`PluginLoopHome.tsx` — Plugin được hiển thị trên Home:
- User có thể launch plugin trực tiếp từ Home
- Plugin pre-configures project với context và tools

---

## 6. Inline Plugins Rail

`InlinePluginsRail.tsx` — Plugins hiển thị inline trong chat composer:
- Quick-access để activate plugin trong conversation
- Context-aware plugin suggestions

---

## 7. API

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/plugins` | GET | Danh sách plugins đã cài |
| `/api/plugins/:id` | GET | Chi tiết plugin |
| `/api/plugins/install` | POST | Cài plugin |
| `/api/plugins/:id/uninstall` | POST | Gỡ plugin |
| `/api/plugins/:id/apply` | POST | Apply plugin vào project |
| `/api/plugins/snapshots/:id` | GET | Đọc plugin snapshot |

---

## 8. Plugin Marketplace

`MarketplaceView.tsx` — Giao diện browse và cài plugin:
- List available plugins
- Plugin details và preview
- Install / Uninstall actions

---

## 9. Acceptance Criteria

- [x] Install / Uninstall plugin
- [x] Apply plugin vào project
- [x] Plugin snapshot tracking
- [x] Snapshot GC tự động
- [x] Plugin hiển thị trong Home và inline chat
