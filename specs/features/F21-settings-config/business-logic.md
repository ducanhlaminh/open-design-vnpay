# F-21: Settings & Configuration — Business Logic

## Overview

Settings Dialog is the central configuration hub for the entire application. It manages agent setup, BYOK API keys, media providers, privacy/telemetry controls, appearance, MCP configs, memory management, orbit, i18n, and custom instructions.

---

## Business Rules

### Agent & API Settings

| Rule | Detail |
|------|--------|
| **BR-01** | All 16 detected agents display with `Available` / `Not found` status |
| **BR-02** | Default agent can be set globally; per-project override allowed |
| **BR-03** | Per-agent model selection is available (e.g., claude with opus-4 vs. sonnet) |
| **BR-04** | Custom environment variables per CLI agent (`agentCliEnv`) |
| **BR-05** | Connection test validates configuration within 5 seconds |
| **BR-06** | API key displays masked (only last 4 characters visible) |
| **BR-07** | Custom `baseUrl` allows any OpenAI-compatible endpoint |
| **BR-08** | Loopback URLs (`localhost`, `127.0.0.1`) are allowed for Ollama |

### Appearance Settings

| Rule | Detail |
|------|--------|
| **BR-09** | Theme: System \| Light \| Dark |
| **BR-10** | `System` follows macOS/Windows OS theme preference |
| **BR-11** | Theme switch uses smooth CSS transition |
| **BR-12** | Accent color selectable via color picker |
| **BR-13** | Settings persist across reload and daemon restart |

### Privacy & Telemetry

| Rule | Detail |
|------|--------|
| **BR-14** | Three telemetry levels: `metrics` (default ON), `content` (default ON), `artifactManifest` (default OFF) |
| **BR-15** | Each toggle is independent |
| **BR-16** | "Delete my data" removes `installationId` and resets consent — does **not** delete projects |
| **BR-17** | Privacy policy link is clearly visible |
| **BR-18** | `privacyDecisionAt` timestamp recorded when user consents |
| **BR-19** | Privacy Consent Modal shown on first launch |

### Custom Instructions

| Rule | Detail |
|------|--------|
| **BR-20** | Custom instructions text field: max 2000 characters with counter |
| **BR-21** | Instructions are injected into every system prompt |
| **BR-22** | Per-project override (`project.customInstructions`) takes precedence over global |

### Media Provider Settings

| Provider | Keys Required |
|---------|--------------|
| GPT-Image-2 | OpenAI API Key or Azure endpoint |
| ElevenLabs | API Key |
| ByteDance (Seedance) | API Key |
| HeyGen (HyperFrames) | API Key |
| Fal.ai | API Key |
| Venice | API Key |

### i18n (Internationalization)

| Rule | Detail |
|------|--------|
| **BR-23** | Primary languages: Vietnamese (vi) and English (en) |
| **BR-24** | Language auto-detected from browser locale |
| **BR-25** | Manual language override via language menu in app header |
| **BR-26** | Multiple additional languages from upstream are supported |

---

## AppConfig Schema

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
  onboardingCompleted?: boolean;
}
```

---

## Acceptance Criteria

**Agent/API:**
- [ ] Mask API key (only show last 4 characters)
- [ ] Connection test returns OK/FAIL clearly
- [ ] Config persists across reload
- [ ] Loopback URL supported for Ollama

**Appearance:**
- [ ] Light / Dark / System mode
- [ ] Accent color picker
- [ ] Smooth transition on switch

**Privacy:**
- [ ] Default: Metrics ON, Content ON, Artifact manifest OFF
- [ ] Toggle persists after restart
- [ ] "Delete my data" does not delete projects
- [ ] Privacy policy link visible

**Custom Instructions:**
- [ ] Injected into every system prompt
- [ ] Per-project override
- [ ] 2000 character limit with counter

**i18n:**
- [ ] Vietnamese and English supported
- [ ] Language switch in UI
