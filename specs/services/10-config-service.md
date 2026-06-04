# 10 — Config Service

> **Port gRPC**: 8089  
> **Domain**: App configuration, secrets management, API keys

---

## 1. Vai trò & Trách nhiệm

Thay thế config logic trong `server.ts` + `db.ts` (`app_config` table):

- **App config**: Lưu và sync app preferences (telemetry, installationId, privacyDecisionAt)
- **API keys**: Lưu LLM API keys, media provider keys (encrypted at rest)
- **Secrets distribution**: Cung cấp keys cho các services khác (chỉ qua gRPC, không expose ra HTTP)
- **Desktop auth**: Handle desktop-specific OAuth flows

---

## 2. Cấu trúc thư mục

```
config-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── domain/
│   │   ├── app_config.go         # AppConfig entity (preferences)
│   │   ├── secret.go             # Secret entity (encrypted key-value)
│   │   └── repository.go
│   │
│   ├── usecase/
│   │   ├── config_usecase.go     # GetConfig, UpdateConfig
│   │   ├── secret_usecase.go     # GetSecret, SetSecret (encrypted)
│   │   └── media_config_usecase.go # GetMediaConfig, UpdateMediaConfig
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── config_repo.go
│   │   │   └── secret_repo.go
│   │   └── crypto/
│   │       └── aes_encryptor.go  # AES-256-GCM encryption for secrets
│   │
│   └── delivery/
│       ├── grpc/
│       │   └── handler.go
│       └── http/
│           └── health.go
│
├── proto/
│   └── config/v1/config.proto
└── Dockerfile
```

---

## 3. Domain Model

```go
// domain/app_config.go
type AppConfig struct {
    InstallationID       string    // anonymous UUID (daemon-owned)
    TelemetryEnabled     bool
    TelemetryContent     bool
    TelemetryArtifacts   bool
    PrivacyDecisionAt    *time.Time
    OnboardingCompleted  bool
    Theme                string    // "dark" | "light" | "system"
    Language             string
}

// domain/secret.go
type Secret struct {
    Key          string          // e.g., "anthropic_api_key", "openai_api_key"
    EncryptedVal []byte          // AES-256-GCM encrypted
    UpdatedAt    time.Time
}

// Provider-specific media config
type MediaConfig struct {
    DefaultImageProvider string
    DefaultVideoProvider string
    DefaultAudioProvider string
    // Provider-specific settings (non-secret)
    ProviderSettings map[string]map[string]any
}
```

---

## 4. Secret Encryption

```go
// infra/crypto/aes_encryptor.go
type AESEncryptor struct {
    key []byte // 32-byte key derived from machine ID + env secret
}

func (e *AESEncryptor) Encrypt(plaintext string) ([]byte, error) {
    block, _ := aes.NewCipher(e.key)
    gcm, _ := cipher.NewGCM(block)
    nonce := make([]byte, gcm.NonceSize())
    rand.Read(nonce)
    return gcm.Seal(nonce, nonce, []byte(plaintext), nil), nil
}

func (e *AESEncryptor) Decrypt(ciphertext []byte) (string, error) {
    block, _ := aes.NewCipher(e.key)
    gcm, _ := cipher.NewGCM(block)
    nonceSize := gcm.NonceSize()
    nonce, data := ciphertext[:nonceSize], ciphertext[nonceSize:]
    plaintext, err := gcm.Open(nil, nonce, data, nil)
    return string(plaintext), err
}
```

---

## 5. Security Rules

| Rule | Chi tiết |
|------|----------|
| Secrets never in HTTP response | Chỉ trả về `tail` (4 ký tự cuối) cho frontend |
| gRPC-only distribution | Secrets chỉ được cấp cho services qua gRPC internal |
| Encrypted at rest | AES-256-GCM, key từ machine ID + env |
| No localStorage | Frontend không bao giờ được nhận full API key |
| Audit log | Mọi secret access được log |

---

## 6. gRPC Protocol

```protobuf
syntax = "proto3";
package config.v1;

service ConfigService {
    // App config (exposed via Gateway to frontend)
    rpc GetAppConfig(GetAppConfigRequest) returns (AppConfig);
    rpc UpdateAppConfig(UpdateAppConfigRequest) returns (AppConfig);

    // Media config (exposed via Gateway)
    rpc GetMediaConfig(GetMediaConfigRequest) returns (MediaConfig);
    rpc UpdateMediaConfig(UpdateMediaConfigRequest) returns (MediaConfig);

    // Secrets (internal only — NOT exposed via Gateway)
    rpc GetSecret(GetSecretRequest) returns (GetSecretResponse);
    rpc SetSecret(SetSecretRequest) returns (google.protobuf.Empty);
    rpc DeleteSecret(DeleteSecretRequest) returns (google.protobuf.Empty);
    rpc ListSecretKeys(ListSecretKeysRequest) returns (ListSecretKeysResponse);

    // Token validation (for Gateway auth)
    rpc ValidateDesktopToken(ValidateDesktopTokenRequest) returns (ValidateDesktopTokenResponse);
}

message AppConfig {
    string installation_id = 1;
    bool   telemetry_enabled = 2;
    bool   telemetry_content = 3;
    bool   telemetry_artifacts = 4;
    optional google.protobuf.Timestamp privacy_decision_at = 5;
    bool   onboarding_completed = 6;
    string theme = 7;
    string language = 8;
}

message GetSecretResponse {
    string value = 1;  // plaintext — only returned to internal services
    string key_tail = 2; // last 4 chars — safe for frontend
}
```

---

## 7. Database Schema

```sql
CREATE TABLE app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE secrets (
    key            TEXT PRIMARY KEY,
    encrypted_val  BYTEA NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pre-populated keys:
-- 'anthropic_api_key', 'openai_api_key', 'google_api_key',
-- 'azure_openai_endpoint', 'azure_openai_key',
-- 'ollama_host',
-- 'dalle_api_key', 'stability_api_key', 'replicate_api_key',
-- 'elevenlabs_api_key', 'senseaudio_api_key',
-- 'composio_api_key'
```

---

## 8. Interservice Usage

```
Agent Service → Config Service: GET anthropic_api_key (để spawn agent)
Media Service → Config Service: GET dalle_api_key (để generate image)
Plugin Service → Config Service: GET composio_api_key (Composio API)
Memory Service → Config Service: GET openai_api_key (để embed)
Telemetry Service → Config Service: GET installation_id, telemetry_enabled
```
