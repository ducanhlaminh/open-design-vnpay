# WP6 — Installer một-lệnh kiểu kit-gen + build-runtime + release

Ước lượng: 2–3 ngày. Phụ thuộc: WP4 (host mode là mặc định). Chạy song song WP5 được (phối hợp: WP6 không phụ thuộc code Electron). Vùng sở hữu: `deploy/host/**` (mới), `scripts/host-runtime/**` (mới), `.github/workflows/**`, `tools/pack` (chỉ phần tái dùng bundling).

Mẫu tham chiếu: `kit-gen/install.sh` của hihahihahoho/test-survey (đã phân tích 13/08 — bắt chước cấu trúc, KHÔNG copy nguyên văn). Trải nghiệm đích:

```
curl -fsSL https://raw.githubusercontent.com/<repo>/<tag>/deploy/host/install.sh -o install.sh
bash install.sh
# → 6 bước có health check → mở http://127.0.0.1:<port> → "còn một bước: claude /login"
```

## 6.1 build-runtime — `scripts/host-runtime/build-runtime.sh` (hoặc lệnh `tools-pack host`)

- Sản phẩm: `open-design-runtime-<version>-<platform>.tar.gz` với platform ∈ `darwin-arm64 | darwin-x64 | linux-x64` (đặt tên như Node dist). **Per-platform là BẮT BUỘC** vì `better-sqlite3` native (+ fsevents darwin).
- Nội dung (công thức = `deploy/Dockerfile` + bundling của tools/pack, bỏ Electron):
  - `apps/daemon/dist/` + node_modules production của daemon đúng arch (tái dùng cơ chế bundle per-arch sẵn có của tools/pack — kể cả cross-build kiểu `OD_PACK_MAC_ARCH=x64`).
  - `apps/web/out/` (static export — `OD_WEB_OUTPUT_MODE` mặc định; daemon tự serve, MỘT process).
  - `skills/`, `design-systems/`, `design-templates/`, `templates/`, `prompt-templates/` (đối chiếu danh sách tài nguyên tools/pack đang bundle cho packaged — lấy đúng danh sách đó).
  - `runtime/service/`: `com.vnpay.open-design.plist.in` + `open-design.service.in` (systemd user) — template với placeholder `@OD_BIN@`, `@OD_HOME@`.
  - `install.sh` (bản copy để update tự chứa), `VERSION`, `manifest.sha256` (checksum từng file), `release.json` snippet.
- Kèm `.sha256` cạnh mỗi tarball.

## 6.2 install.sh — `deploy/host/install.sh`

Cấu trúc theo kit-gen, khác biệt chủ đích:

| Kit-gen | OD làm theo | OD làm KHÁC |
|---|---|---|
| `~/.kitgen/releases/<v>` + symlink `current` + rollback theo health check | Y hệt, tại `~/.open-design/` | — |
| Node riêng `tools/node` nếu máy thiếu Node ≥ 20 (checksum SHASUMS256) | Y hệt (Node 24 theo `deploy/Dockerfile` — đối chiếu engines của daemon) | — |
| Manifest raw URL branch | `release.json` trỏ theo **tag/release** (immutable), không theo branch | mutable pointer là điểm trừ của kit-gen |
| python3 parse JSON + venv ảnh | — | KHÔNG dùng python3; parse JSON bằng Node riêng đã cài |
| Detect `codex` PATH → npm install fallback | Detect `claude` PATH (health check `claude --version`) → fallback chạy **native installer** `curl -fsSL https://claude.ai/install.sh | bash` (binary tự chứa, không cần Node) | pin version: đọc `claude.version` trong tarball, cài đúng pin nếu installer hỗ trợ, nếu không thì latest + ghi log |
| Không seed credential; cuối in "codex login" | Y hệt: in "còn một bước: `claude /login`" nếu probe login fail (probe = thử `claude --version` + check Keychain attribute như daemon làm) | — |
| `config.env` chmod 600 | Y hệt, tại `~/.open-design/config.env` | Nội dung OD: `OD_SANDBOX=0`, `OD_WRITE_ISOLATION=required`, `OD_DATA_DIR=$HOME/od-data/open-design`, `OD_PORT`, `KGS_URL/KGS_APP_ID/KGS_TENANT/KGS_API_KEY`, `MEDIA_URL/MEDIA_APP_ID/...`, `IDENTITY_URL` — nhận qua flags (`--kgs-url`, `--kgs-api-key`, …) hoặc `--env-file <url|path>` tải file env mẫu từ mirror nội bộ; thiếu thì để trống + cảnh báo "KG sync sẽ tắt" |
| LaunchAgent / systemd user / nohup fallback + wait_for_health + rollback | Y hệt; service chạy `node <current>/apps/daemon/dist/cli.js --no-open`, health = `GET http://127.0.0.1:$PORT/api/health` (route có sẵn) | — |
| Tar safety: 1 root, chặn `..`, checksum bắt buộc | Y hệt | — |
| `--update` | Y hệt + sau update in phiên bản từ `/api/version` (route có sẵn) | — |
| — | Chọn tarball theo `uname -s`-`uname -m` (map darwin-arm64/darwin-x64/linux-x64), lỗi rõ nếu platform lạ | kit-gen chỉ chọn platform cho Node, OD chọn cho cả runtime |
| — | Bước cuối chạy `od doctor` (hoặc `od sandbox status` mở rộng ở WP4) in checklist | — |

Flags tối thiểu: `--archive`, `--release-url`, `--sha256`, `--port`, `--data-dir`, `--env-file`, `--no-start`, `--update`, `-h`. Không sudo. `set -eu`. Progress 6 bước in tiếng Việt (theo phong cách kit-gen: "1/6 Kiểm tra gói cài đặt" …).

## 6.3 Release workflow — `.github/workflows/release-host-runtime.yml`

- Trigger: tag `v*` (manual dispatch cho phép chọn ref).
- Job matrix 3 platform: build daemon dist + web out + bundle node_modules đúng arch (darwin trên macos runner arm64 + cross x64 theo cơ chế tools/pack; linux trên ubuntu) → tarball + sha256 → upload GitHub Release + cập nhật `release.json` (asset của release, không phải file trên branch).
- KHÔNG bake secret nào vào tarball (khác hẳn packaged cũ: KGS/SESSION_SECRET từng nằm trong bundle — nay là việc của config.env trên máy).
- Gỡ/thay `release-unsigned-manual.yml` phần đã chết sau WP5 (phối hợp: nếu WP5 chưa merge, chỉ THÊM workflow mới, chưa xóa cũ).

## 6.4 Docs

- `deploy/host/README.md`: cài mới / update / rollback thủ công (`ln -sfn` bản trước + restart) / gỡ (`launchctl bootout` + xóa `~/.open-design`; DATA ở `OD_DATA_DIR` không tự xóa) / mirror nội bộ.
- Cập nhật `QUICKSTART.md` trỏ sang đường cài mới.

## Tests

- `deploy/tests/` (vitest có sẵn cho deploy scripts — xem `deploy/tests/install.test.ts` làm mẫu): test shell qua bats-style hoặc vitest+execa: tar safety (2 root → fail; `..` path → fail; checksum sai → fail), chọn platform từ uname giả, config.env sinh đúng + chmod 600, rollback khi health fail (mock health).
- CI: job chạy install.sh với `--archive` local + `--no-start` trên macos + ubuntu runner.

## Ngoài phạm vi

- Ký/notarize (không còn .app). Auto-update trong app (banner /api/version là đủ; update = chạy lại install.sh).
- Windows installer. Multi-user server. Docker self-host `deploy/` (giữ nguyên, không đụng).

## Acceptance & Verify

1. Máy mac sạch (hoặc user test mới): một lệnh curl+bash với `--archive` local → service chạy, `http://127.0.0.1:<port>` mở được UI, `/api/health` OK, in nhắc `claude /login`.
2. `install.sh --update` với tarball v2 giả → symlink đổi, health OK; tarball hỏng/health fail → tự rollback về v1 và service sống.
3. Tarball không chứa secret (grep `KGS_API_KEY|SESSION_SECRET` trong tarball = 0).
4. `shasum -c manifest.sha256` pass trong release đã giải nén.
