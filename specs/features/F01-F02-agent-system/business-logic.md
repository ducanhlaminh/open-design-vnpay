# F-01 & F-02: Agent System — Business Logic

## Overview

The Agent System is the core execution layer of Open Design. Rather than bundling a proprietary AI model, the daemon **auto-detects** locally installed coding-agent CLIs and spawns them as child processes per-project. When no CLI is found, a BYOK (Bring Your Own Key) API proxy fills the role.

---

## Business Rules

### F-01: Multi-Agent Detection

| Rule | Detail |
|------|--------|
| **BR-01** | Daemon scans `PATH` at startup for all 16 known agent binaries |
| **BR-02** | Each agent reports status `available` \| `not_found` |
| **BR-03** | Results are cached in-memory; refreshed on UI reload |
| **BR-04** | At least **one** `available` agent **or** a valid BYOK config is required to unlock artifact creation |
| **BR-05** | Per-project agent overrides are allowed (`agentId` on project metadata) |
| **BR-06** | Per-agent models can be configured independently (`agentModels` in AppConfig) |
| **BR-07** | Custom env variables per agent CLI (`agentCliEnv` in AppConfig) |

### F-02: BYOK API Proxy

| Rule | Detail |
|------|--------|
| **BR-08** | Daemon acts as a reverse SSE proxy when no CLI agent is available |
| **BR-09** | Supports any OpenAI-compatible endpoint |
| **BR-10** | SSRF protection: loopback (`127.0.0.1`, `::1`) is ALLOWED (Ollama); private/link-local/CGNAT/multicast are REJECTED |
| **BR-11** | Upstream redirects disabled to prevent redirect-based SSRF |
| **BR-12** | SenseAudio proxy additionally exposes `generate_image` and `generate_video` tools |
| **BR-13** | All providers normalize to a unified SSE event format before returning to the client |

### Agent Spawn

| Rule | Detail |
|------|--------|
| **BR-14** | Each agent is spawned with `cwd = .od/projects/<projectId>/` |
| **BR-15** | `stdio: ['pipe', 'pipe', 'pipe']` — full stdin/stdout/stderr control |
| **BR-16** | Windows ENAMETOOLONG fallback: when command line > 8191 chars, switch to stdin injection or prompt-file |
| **BR-17** | Agent spawn must complete in < 1 second from prompt submit |

---

## Supported Agents

| Agent ID | Binary | Protocol |
|----------|--------|----------|
| `claude` | `claude` | `claude-stream-json` |
| `codex` | `codex` | `json-event-stream` |
| `gemini` | `gemini` | `json-event-stream` |
| `cursor-agent` | `cursor-agent` | `json-event-stream` |
| `devin` | `devin` | `acp-json-rpc` |
| `opencode` | `opencode` | `json-event-stream` |
| `copilot` | `copilot` | `copilot-stream-json` |
| `kiro-cli` | `kiro-cli` | `acp-json-rpc` |
| `hermes` | `hermes` | `acp-json-rpc` |
| `kimi` | `kimi` | `acp-json-rpc` |
| `kilo` | `kilo` | `acp-json-rpc` |
| `vibe-acp` | `vibe-acp` | `acp-json-rpc` |
| `pi` | `pi` | `pi-rpc` |
| `qodercli` | `qodercli` | `qoder-stream-json` |
| `qwen` | `qwen` | `plain` |
| `deepseek` | `deepseek` | `plain` |

---

## Supported BYOK Providers

| Provider | Proxy Endpoint |
|---------|---------------|
| Anthropic | `POST /api/proxy/anthropic/stream` |
| OpenAI | `POST /api/proxy/openai/stream` |
| Azure OpenAI | `POST /api/proxy/azure/stream` |
| Google (Gemini) | `POST /api/proxy/google/stream` |
| Ollama (local) | `POST /api/proxy/ollama/stream` |
| SenseAudio | `POST /api/proxy/senseaudio/stream` |

---

## Acceptance Criteria

- [ ] All 16 agents appear in the agent list with correct `available` / `not_found` status
- [ ] Connection test returns within 5 seconds
- [ ] One-click agent switch from model picker
- [ ] BYOK proxy works when no CLI agent is available
- [ ] SSRF blocking: loopback OK, private/link-local/CGNAT rejected
- [ ] Daemon requires ≥1 agent or BYOK config to unlock artifact creation
