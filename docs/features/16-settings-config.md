# F-21: Settings & Configuration

**Nhóm:** ⚙️ Platform — Settings  
**Nguồn code:** `apps/daemon/src/app-config.ts`, `apps/web/src/components/SettingsDialog.tsx` (245KB)  
**UI:** `SettingsDialog.tsx`, `PrivacySection.tsx`, `PrivacyConsentModal.tsx`

---

## 1. Tổng quan

Settings Dialog quản lý toàn bộ cấu hình ứng dụng, bao gồm: agent config, BYOK API keys, media providers, privacy/telemetry, theme, MCP, memory, connectors, và custom instructions.

---

## 2. App Config Schema

```typescript
interface AppConfig {
  // Agent & API
  mode: 'daemon' | 'api';
  apiKey: string;
  baseUrl: string;
  model: string;
  apiProtocol?: 'anthropic' | 'openai' | 'azure' | 'google' | 'ollama' | 'senseaudio';
  apiProtocolConfigs?: Record<ApiProtocol, ApiProtocolConfig>;
  agentId: string | null;
  
  // Skills & Design Systems
  skillId: string | null;
  designSystemId: string | null;
  disabledSkills?: string[];
  disabledDesignSystems?: string[];
  
  // Appearance
  theme?: 'system' | 'light' | 'dark';
  accentColor?: string;
  
  // Onboarding
  onboardingCompleted?: boolean;
  
  // Media
  mediaProviders?: Record<string, MediaProviderCredentials>;
  
  // Integrations
  composio?: ComposioSettings;
  
  // Advanced
  agentModels?: Record<string, AgentModelChoice>;
  agentCliEnv?: AgentCliEnvConfig;
  maxTokens?: number;
  
  // Features
  pet?: PetConfig;
  notifications?: NotificationsConfig;
  orbit?: OrbitConfig;
  
  // Privacy
  installationId?: string | null;
  privacyDecisionAt?: number | null;
  telemetry?: TelemetryConfig;
  
  // Custom
  customInstructions?: string;
}
```

---

## 3. Settings Sections

### 3.1 Agent Settings

| Setting | Mô tả |
|---------|-------|
| **Detected agents** | Danh sách 16 CLI agents với status Available/Not found |
| **Default agent** | Agent mặc định cho mọi project |
| **Per-agent model** | Chọn model khác nhau cho từng agent |
| **Agent CLI env** | Custom environment variables per-agent |
| **Test connection** | Ping agent để verify |

### 3.2 API / BYOK Settings

| Setting | Mô tả |
|---------|-------|
| **API Key** | Masked display (4 ký tự cuối) |
| **Base URL** | Custom endpoint (OpenAI-compatible) |
| **Model** | Model name |
| **Provider** | Anthropic / OpenAI / Azure / Google / Ollama / SenseAudio |
| **Max Tokens** | Override max tokens |
| **Test connection** | Verify API key hoạt động |

### 3.3 Media Provider Settings

Configure API keys cho media generation:

| Provider | Keys cần thiết |
|---------|---------------|
| **GPT-Image-2** | OpenAI API Key hoặc Azure endpoint |
| **ElevenLabs** | API Key |
| **ByteDance (Seedance)** | API Key |
| **HeyGen (HyperFrames)** | API Key |
| **Fal.ai** | API Key |
| **Venice** | API Key |

### 3.4 Appearance

| Setting | Options |
|---------|---------|
| **Theme** | System / Light / Dark |
| **Accent Color** | Color picker |

- Smooth transition khi switch theme
- Setting persist qua reload
- "System" option follow macOS/Windows OS theme

### 3.5 Privacy & Telemetry

```typescript
interface TelemetryConfig {
  metrics?: boolean;          // Aggregate usage stats (default: ON)
  content?: boolean;          // Prompts và artifacts (default: ON)
  artifactManifest?: boolean; // Artifact manifest (default: OFF)
}
```

**Controls:**
- Toggle từng loại ON/OFF riêng lẻ
- **"Delete my data"**: xóa `installationId`, reset consent (không xóa projects)
- Privacy policy link rõ ràng
- `privacyDecisionAt` timestamp khi user consent

### 3.6 Custom Instructions

```
Settings → Custom Instructions
→ Textarea (tối đa 2000 ký tự, có counter)
→ Inject vào mọi system prompt
→ Per-project override trong project settings
```

**Ví dụ:**
```
Always use BEM CSS methodology.
Add Vietnamese comments to code.
Prefer Tailwind CSS for styling.
```

### 3.7 Notifications

```typescript
interface NotificationsConfig {
  routineComplete?: boolean;
  orbitDigest?: boolean;
  mediaReady?: boolean;
}
```

### 3.8 Orbit Settings

```typescript
interface OrbitConfig {
  enabled: boolean;
  time: string;          // 'HH:mm'
  templateSkillId?: string;
}
```

### 3.9 MCP Settings

Section riêng để configure MCP clients:
- Add/remove MCP server configs
- Browse MCP templates
- OAuth connect flow

### 3.10 Memory Settings

`MemorySection.tsx`:
- Xem tất cả memory entries
- Confirm / reject / delete entries
- Clear all memories

---

## 4. Privacy Consent Modal

`PrivacyConsentModal.tsx` — Hiển thị lần đầu tiên:
- Giải thích rõ data nào được thu thập
- User chọn consent level
- Record `privacyDecisionAt`

---

## 5. i18n (Internationalization)

**Nguồn:** `apps/web/src/i18n/`

- Vietnamese (vi) — primary
- English (en)
- Multiple other languages (từ upstream)

**Tính năng:**
- Language menu trong app header (`LanguageMenu.tsx`)
- Auto-detect từ browser locale
- Manual override

---

## 6. API

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/config` | GET | Đọc app config |
| `/api/config` | PUT | Cập nhật config |
| `/api/config/reset` | POST | Reset về defaults |

---

## 7. Acceptance Criteria

**Agent/API:**
- [x] Mask API key (chỉ show 4 ký tự cuối)
- [x] Test connection trả về OK/FAIL rõ ràng
- [x] Config persist qua reload
- [x] Hỗ trợ loopback URL cho Ollama local

**Appearance:**
- [x] Light / Dark / System mode
- [x] Accent color picker
- [x] Smooth transition khi switch

**Privacy:**
- [x] Default: Metrics ON, Content ON, Artifact manifest OFF
- [x] Toggle persist sau restart
- [x] "Delete my data" không xóa projects
- [x] Privacy policy link rõ ràng

**Custom Instructions:**
- [x] Instructions inject vào mọi system prompt
- [x] Per-project override
- [x] Character limit 2000 với counter

**i18n:**
- [x] Hỗ trợ Vietnamese và English
- [x] Language switch trong UI
