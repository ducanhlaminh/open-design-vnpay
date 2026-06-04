# DEV-T-10 — Config Service Implementation Tasks

> **Service**: `services/config-service` → Tạo mới (tách từ `preview-identity`)  
> **Effort**: 8 ngày  
> **Sprint**: Sprint 1 (Tuần 1–2)  
> **Ref**: [DEV-09-12-remaining-services.md](../../develop/DEV-09-12-remaining-services.md) section DEV-10

---

## Tổng quan

Config Service là service **cấp thiết nhất** (Sprint 1) vì Agent Service và các services khác cần lấy API keys từ đây. Được tạo mới hoàn toàn, không nâng cấp service cũ.

---

## Nhóm A — Project Setup (Ngày 1)

---

### A01 — Khởi tạo Go Module

**File**: `services/config-service/`  
**Effort**: 2h  
**Status**: `[ ]`

```bash
# Tạo thư mục + module
mkdir -p services/config-service
cd services/config-service
go mod init github.com/open-design/config-service

# Cài dependencies
go get github.com/labstack/echo/v4
go get google.golang.org/grpc
go get gorm.io/gorm gorm.io/driver/postgres
go get github.com/spf13/viper
go get go.uber.org/zap
```

**Cấu trúc thư mục**:
```
services/config-service/
├── cmd/
│   └── main.go
├── internal/
│   ├── config/
│   │   └── config.go
│   ├── domain/
│   │   ├── app_config.go
│   │   ├── secret.go
│   │   └── repository.go
│   ├── usecase/
│   │   ├── config_usecase.go
│   │   ├── secret_usecase.go
│   │   └── media_config_usecase.go
│   └── infra/
│       ├── db/
│       │   ├── postgres.go
│       │   ├── config_repo.go
│       │   └── secret_repo.go
│       └── crypto/
│           └── aes_gcm.go
├── api/proto/config/v1/
│   └── config.proto
├── migrations/
├── Dockerfile
└── go.mod
```

---

### A02 — Service Config (Viper)

**File**: `services/config-service/internal/config/config.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
type Config struct {
    Server struct {
        GRPCPort int    `mapstructure:"grpc_port"`  // 8089
        HTTPPort int    `mapstructure:"http_port"`  // 8090
    }
    Database struct {
        URL string `mapstructure:"url"`
    }
    Encryption struct {
        Key string `mapstructure:"key"`  // OD_ENCRYPTION_KEY (32+ chars)
    }
}
```

**Acceptance Criteria**:
- [ ] `OD_ENCRYPTION_KEY` env var bắt buộc — panic nếu không có
- [ ] Database URL từ `OD_DATABASE_URL`

---

## Nhóm B — Domain Layer (Ngày 1–2)

---

### B01 — `AppConfig` Entity

**File**: `services/config-service/internal/domain/app_config.go`  
**Effort**: 1h  
**Status**: `[ ]`

```go
package domain

type AppConfig struct {
    InstallationID      string
    TelemetryEnabled    bool
    TelemetryContent    bool    // if false: strip content from telemetry
    OnboardingCompleted bool
    PrivacyDecisionAt   *int64  // unix timestamp
    Version             string  // app version
}

type MediaConfig struct {
    Providers []MediaProvider
}

type MediaProvider struct {
    ID         string  // "dalle", "elevenlabs", "stability"
    Name       string
    Configured bool    // true nếu API key đã set
    KeyTail    string  // last 4 chars của key (safe to show)
}
```

---

### B02 — `Secret` Entity

**File**: `services/config-service/internal/domain/secret.go`  
**Effort**: 0.5h  
**Status**: `[ ]`

```go
type Secret struct {
    Key          string    // "ANTHROPIC_API_KEY", "OPENAI_API_KEY", etc.
    EncryptedVal []byte    // AES-256-GCM encrypted value
    UpdatedAt    time.Time
}

// Safe keys: chỉ dùng A-Z, 0-9, _
var keyPattern = regexp.MustCompile(`^[A-Z0-9_]+$`)

func ValidateSecretKey(key string) error {
    if !keyPattern.MatchString(key) {
        return ErrInvalidSecretKey
    }
    return nil
}

var (
    ErrSecretNotFound   = errors.New("secret not found")
    ErrInvalidSecretKey = errors.New("invalid secret key format")
)
```

---

### B03 — Repository Interfaces

**File**: `services/config-service/internal/domain/repository.go`  
**Effort**: 0.5h  
**Status**: `[ ]`

```go
type AppConfigRepository interface {
    Get(ctx context.Context, key string) (string, error)
    Set(ctx context.Context, key, value string) error
    GetAll(ctx context.Context) (map[string]string, error)
    Delete(ctx context.Context, key string) error
}

type SecretRepository interface {
    Get(ctx context.Context, key string) (*Secret, error)
    Set(ctx context.Context, s *Secret) error
    Delete(ctx context.Context, key string) error
    ListKeys(ctx context.Context) ([]string, error)
}
```

---

## Nhóm C — Crypto Layer (Ngày 2–3)

---

### C01 — AES-256-GCM Encryptor

**File**: `services/config-service/internal/infra/crypto/aes_gcm.go`  
**Effort**: 1 ngày  
**Status**: `[ ]`

```go
package crypto

import (
    "crypto/aes"
    "crypto/cipher"
    "crypto/rand"
    "crypto/sha256"
    "encoding/base64"
    "io"
    
    "golang.org/x/crypto/hkdf"
)

type AESGCMEncryptor struct {
    key [32]byte
}

// NewAESGCMEncryptor: derive key từ master key + salt
func NewAESGCMEncryptor(masterKey string) (*AESGCMEncryptor, error) {
    // HKDF key derivation: master key → 32-byte AES key
    h := hkdf.New(sha256.New, []byte(masterKey), []byte("open-design-config-v1"), nil)
    var key [32]byte
    if _, err := io.ReadFull(h, key[:]); err != nil {
        return nil, err
    }
    return &AESGCMEncryptor{key: key}, nil
}

// Encrypt: AES-256-GCM với random nonce
// Output format: base64(nonce + ciphertext)
func (e *AESGCMEncryptor) Encrypt(plaintext string) ([]byte, error) {
    block, err := aes.NewCipher(e.key[:])
    if err != nil {
        return nil, err
    }
    
    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, err
    }
    
    nonce := make([]byte, gcm.NonceSize())
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return nil, err
    }
    
    ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
    result := make([]byte, base64.StdEncoding.EncodedLen(len(ciphertext)))
    base64.StdEncoding.Encode(result, ciphertext)
    return result, nil
}

// Decrypt: giải mã base64(nonce + ciphertext)
func (e *AESGCMEncryptor) Decrypt(ciphertext []byte) (string, error) {
    data := make([]byte, base64.StdEncoding.DecodedLen(len(ciphertext)))
    n, err := base64.StdEncoding.Decode(data, ciphertext)
    if err != nil {
        return "", err
    }
    data = data[:n]
    
    block, _ := aes.NewCipher(e.key[:])
    gcm, _ := cipher.NewGCM(block)
    
    nonceSize := gcm.NonceSize()
    nonce, data := data[:nonceSize], data[nonceSize:]
    
    plaintext, err := gcm.Open(nil, nonce, data, nil)
    if err != nil {
        return "", err
    }
    return string(plaintext), nil
}
```

**Test bắt buộc**:
- [ ] `Encrypt(x) → Decrypt()` trả về x (round trip)
- [ ] Encrypt 2 lần → 2 ciphertext khác nhau (random nonce)
- [ ] Tampered ciphertext → Decrypt trả về error
- [ ] Sai master key → Decrypt trả về error

---

## Nhóm D — Infrastructure (Ngày 3–5)

---

### D01 — PostgreSQL Connection

**File**: `services/config-service/internal/infra/db/postgres.go`  
**Effort**: 0.5h  
**Status**: `[ ]`

Standard GORM + postgres setup (dùng pattern từ shared hoặc copy từ service khác).

---

### D02 — `config_repo.go`

**File**: `services/config-service/internal/infra/db/config_repo.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```go
// DB model
type appConfigModel struct {
    Key       string    `gorm:"primarykey"`
    Value     string    `gorm:"not null"`
    UpdatedAt time.Time `gorm:"autoUpdateTime"`
}

// Implements domain.AppConfigRepository
type PostgresAppConfigRepo struct{ db *gorm.DB }
```

---

### D03 — `secret_repo.go`

**File**: `services/config-service/internal/infra/db/secret_repo.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```go
type secretModel struct {
    Key          string    `gorm:"primarykey"`
    EncryptedVal []byte    `gorm:"not null"`
    UpdatedAt    time.Time `gorm:"autoUpdateTime"`
}

// Implements domain.SecretRepository
type PostgresSecretRepo struct{ db *gorm.DB }
```

---

### D04 — Database Migrations

**Files**: `services/config-service/migrations/`  
**Effort**: 0.5h  
**Status**: `[ ]`

```sql
-- 001_create_app_config.sql
CREATE TABLE app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed defaults
INSERT INTO app_config (key, value) VALUES
    ('installation_id', gen_random_uuid()::text),
    ('telemetry_enabled', 'true'),
    ('telemetry_content', 'false'),
    ('onboarding_completed', 'false')
ON CONFLICT DO NOTHING;

-- 002_create_secrets.sql
CREATE TABLE secrets (
    key            TEXT PRIMARY KEY,
    encrypted_val  BYTEA NOT NULL,
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Nhóm E — Use Cases (Ngày 5–6)

---

### E01 — `ConfigUseCase`

**File**: `services/config-service/internal/usecase/config_usecase.go`  
**Effort**: 1 ngày  
**Status**: `[ ]`

```go
type ConfigUseCase struct {
    configRepo domain.AppConfigRepository
}

// GetAppConfig: return AppConfig entity từ DB keys
func (uc *ConfigUseCase) GetAppConfig(ctx context.Context) (*domain.AppConfig, error) {
    keys, err := uc.configRepo.GetAll(ctx)
    // Map key-value → AppConfig struct
    return &domain.AppConfig{
        InstallationID:      keys["installation_id"],
        TelemetryEnabled:    keys["telemetry_enabled"] == "true",
        OnboardingCompleted: keys["onboarding_completed"] == "true",
    }, nil
}

// UpdateAppConfig: update specific fields
func (uc *ConfigUseCase) UpdateAppConfig(ctx context.Context, req UpdateAppConfigRequest) (*domain.AppConfig, error)

// GetVersion: return current app version
func (uc *ConfigUseCase) GetVersion(ctx context.Context) string
```

---

### E02 — `SecretUseCase`

**File**: `services/config-service/internal/usecase/secret_usecase.go`  
**Effort**: 1 ngày  
**Status**: `[ ]`

```go
type SecretUseCase struct {
    secretRepo domain.SecretRepository
    crypto     *crypto.AESGCMEncryptor
}

// GetSecret: internal only — trả về plaintext (không expose qua Gateway)
func (uc *SecretUseCase) GetSecret(ctx context.Context, key string) (string, error) {
    secret, err := uc.secretRepo.Get(ctx, key)
    if err != nil {
        return "", err
    }
    return uc.crypto.Decrypt(secret.EncryptedVal)
}

// SetSecret: encrypt + store
func (uc *SecretUseCase) SetSecret(ctx context.Context, key, value string) error {
    if err := domain.ValidateSecretKey(key); err != nil {
        return err
    }
    encrypted, err := uc.crypto.Encrypt(value)
    if err != nil {
        return err
    }
    return uc.secretRepo.Set(ctx, &domain.Secret{
        Key:          key,
        EncryptedVal: encrypted,
    })
}

// GetKeyTail: last 4 chars of decrypted key (safe for frontend display)
func (uc *SecretUseCase) GetKeyTail(ctx context.Context, key string) (string, error) {
    value, err := uc.GetSecret(ctx, key)
    if err != nil || len(value) < 4 {
        return "", err
    }
    return "..." + value[len(value)-4:], nil
}
```

---

### E03 — `MediaConfigUseCase`

**File**: `services/config-service/internal/usecase/media_config_usecase.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```go
type MediaConfigUseCase struct {
    secretUC *SecretUseCase
}

// GetMediaConfig: return providers với configured status + key tail (không có plaintext key)
func (uc *MediaConfigUseCase) GetMediaConfig(ctx) (*domain.MediaConfig, error) {
    providers := []struct{ id, keyName string }{
        {"dalle", "OPENAI_API_KEY"},
        {"elevenlabs", "ELEVENLABS_API_KEY"},
        {"stability", "STABILITY_API_KEY"},
        {"fal", "FAL_API_KEY"},
    }
    
    var result []domain.MediaProvider
    for _, p := range providers {
        tail, err := uc.secretUC.GetKeyTail(ctx, p.keyName)
        result = append(result, domain.MediaProvider{
            ID:         p.id,
            Configured: err == nil,
            KeyTail:    tail,
        })
    }
    return &domain.MediaConfig{Providers: result}, nil
}
```

---

## Nhóm F — gRPC Proto + Handler (Ngày 6–7)

---

### F01 — Proto Definition

**File**: `services/config-service/api/proto/config/v1/config.proto`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

```protobuf
service ConfigService {
    // Public — exposed via Gateway to Frontend
    rpc GetAppConfig(google.protobuf.Empty) returns (AppConfig);
    rpc UpdateAppConfig(UpdateAppConfigRequest) returns (AppConfig);
    rpc GetMediaConfig(google.protobuf.Empty) returns (MediaConfig);
    rpc UpdateMediaConfig(UpdateMediaConfigRequest) returns (MediaConfig);

    // Internal Only — NOT exposed via Gateway
    rpc GetSecret(GetSecretRequest) returns (GetSecretResponse);
    rpc SetSecret(SetSecretRequest) returns (google.protobuf.Empty);
    rpc DeleteSecret(DeleteSecretRequest) returns (google.protobuf.Empty);
    rpc ListSecretKeys(google.protobuf.Empty) returns (ListSecretKeysResponse);
}

message GetSecretResponse {
    string value    = 1;  // plaintext — internal only
    string key_tail = 2;  // last 4 chars — safe for frontend
}
```

---

### F02 — gRPC Handler

**File**: `services/config-service/internal/delivery/grpc/handler.go`  
**Effort**: 1 ngày  
**Status**: `[ ]`

```go
type ConfigGRPCHandler struct {
    configpb.UnimplementedConfigServiceServer
    configUC *usecase.ConfigUseCase
    secretUC *usecase.SecretUseCase
    mediaUC  *usecase.MediaConfigUseCase
}

func (h *ConfigGRPCHandler) GetAppConfig(ctx, req) (*configpb.AppConfig, error)
func (h *ConfigGRPCHandler) UpdateAppConfig(ctx, req) (*configpb.AppConfig, error)
func (h *ConfigGRPCHandler) GetMediaConfig(ctx, req) (*configpb.MediaConfig, error)
func (h *ConfigGRPCHandler) GetSecret(ctx, req) (*configpb.GetSecretResponse, error)
func (h *ConfigGRPCHandler) SetSecret(ctx, req) (*emptypb.Empty, error)
```

**Security**:
- [ ] `GetSecret` endpoint: verify caller là internal service (không phải frontend)
- [ ] Log access đến `GetSecret` với service name

---

### F03 — HTTP Handler (Gateway-exposed)

**File**: `services/config-service/internal/delivery/http/config_handler.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

Expose HTTP endpoints riêng (hoặc qua Gateway gRPC proxy). Gateway gọi Config Service qua gRPC và convert sang JSON response.

---

## Nhóm G — Tests (Ngày 7–8)

---

### G01 — Crypto Tests (Critical)

**File**: `services/config-service/internal/infra/crypto/aes_gcm_test.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

- [ ] Round trip: encrypt → decrypt
- [ ] Random nonce: 2 encrypts khác nhau
- [ ] Wrong key: decrypt fail
- [ ] Tampered ciphertext: decrypt fail
- [ ] Empty string: encrypt/decrypt
- [ ] Unicode string: encrypt/decrypt

---

### G02 — Secret Use Case Tests

**File**: `secret_usecase_test.go`  
**Effort**: 0.5 ngày  
**Status**: `[ ]`

- [ ] `SetSecret` → `GetSecret` round trip
- [ ] `GetKeyTail` trả về đúng 4 chars cuối
- [ ] Invalid key format → error
- [ ] Secret not found → error

---

### G03 — Integration Test

**Effort**: 0.5 ngày  
**Status**: `[ ]`

```go
// Với real PostgreSQL (testcontainers)
func TestGetAppConfig_Integration(t *testing.T)
func TestSetGetSecret_Integration(t *testing.T)
```

---

## Acceptance Criteria (DEV-10)

- [ ] `GET /api/app-config` trả về config (key names, không có secret values)
- [ ] `PUT /api/app-config` cập nhật được fields
- [ ] `GET /api/media/config` trả về providers với `configured`, `keyTail`
- [ ] `PUT /api/media/config` lưu API keys được encrypt
- [ ] gRPC `GetSecret` trả về plaintext (internal only)
- [ ] gRPC `SetSecret` encrypt và lưu vào PostgreSQL
- [ ] Encryption key không bao giờ log ra
- [ ] `docker build .` thành công
- [ ] `go test ./... -race` pass
- [ ] `/health` → 200 OK
