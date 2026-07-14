# Build app đóng gói (DMG mac Silicon + Intel / Windows) — bản VNPAY có KGS baked

Lệnh build packaged app cho fork này, đã nhúng sẵn cấu hình KGS để **đưa mỗi app là chạy** (không cần `.env.local` ở máy người nhận). Một máy macOS build được DMG cho **cả Apple Silicon (arm64) lẫn Intel (x64)**.

Chạy mọi lệnh từ thư mục submodule: `ui/open-design-vnpay`.

## 0. Yêu cầu môi trường

- **Node 24** + **pnpm 10.33.2** (qua corepack/nvm). Trên máy hiện tại:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
  node -v   # v24.x
  pnpm -v   # 10.33.2
  ```
- Mac DMG **chỉ build được trên macOS**. Mặc định arch = CPU máy build; build arch còn lại bằng `OD_PACK_MAC_ARCH` (xem §3) → một máy Apple Silicon ra được cả arm64 lẫn x64.
- Windows `.exe`/NSIS build tốt nhất trên Windows (hoặc CI). Build trên mac chỉ tạo cấu hình, chưa kiểm thử native.

## 1. Export cấu hình KGS (BẮT BUỘC — để bake vào app)

tools/pack đọc các biến này lúc build rồi ghi vào `open-design-config.json` trong app; packaged daemon forward thành `KGS_*` env khi chạy.

```bash
export KGS_URL=https://b5.openledger.vn/kgs
export KGS_APP_ID=85fd6497-c5ce-48ee-bb3d-6f5039d66e8d
export KGS_TENANT=default
export KGS_API_KEY=<lấy từ tests/kgs/.env hoặc .env.local — KHÔNG commit key thật>
```

> ⚠️ `KGS_API_KEY` sẽ nằm trong app phân phối — ai có app đều trích được. Dùng key scope hẹp.
> Nếu KHÔNG export các biến này → app build ra sẽ default `KGS_URL=localhost:28001` (KG sync fail).
>
> 💡 Nhanh gọn: nếu repo đã có `.env.local` chứa sẵn `KGS_*` (+ `MEDIA_*`) thì chỉ cần
> `set -a; source .env.local; set +a` trước khi build — tools-pack bake hết vào `open-design-config.json`.

## 2. (Nếu sửa code trong `tools/pack`) rebuild dist trước

CLI `tools-pack` chạy từ `dist`, nên sau khi sửa `tools/pack/src/**` phải:
```bash
pnpm --filter @open-design/tools-pack build
```

## 3. Build Mac DMG — Apple Silicon (arm64) + Intel (x64)

Arch của DMG mặc định = arch máy build. Dùng `OD_PACK_MAC_ARCH` để **cross-build** arch khác từ cùng một máy — tools-pack tự build better-sqlite3 đúng arch và để electron-builder tải Electron đúng arch (xem `tools/pack/src/mac/app.ts` + `builder.ts`).

```bash
# Apple Silicon (arm64) — khi máy build là Apple Silicon (đã verify chạy được)
pnpm tools-pack mac build --to dmg

# Intel (x64) — cross-build từ máy Apple Silicon (tải Electron x64 → chậm hơn)
OD_PACK_MAC_ARCH=x64 pnpm tools-pack mac build --to dmg
```

> ⚠️ **Cả hai arch ghi ra CÙNG một file** `dmg/Open Design-default.dmg` (tên không kèm arch) → build arch sau **đè** arch trước. Khi cần cả hai, **copy DMG ra trước khi build arch kia**:
> ```bash
> DMG=".tmp/tools-pack/out/mac/namespaces/default/dmg/Open Design-default.dmg"
> pnpm tools-pack mac build --to dmg                        # arm64
> cp "$DMG" ~/Desktop/OpenDesign-arm64.dmg
> OD_PACK_MAC_ARCH=x64 pnpm tools-pack mac build --to dmg   # intel
> cp "$DMG" ~/Desktop/OpenDesign-x64.dmg
> ```

- Output DMG (chung): `.tmp/tools-pack/out/mac/namespaces/default/dmg/Open Design-default.dmg`
- `.app` theo arch: `.tmp/tools-pack/out/mac/namespaces/default/builder/mac-arm64/Open Design.app` (hoặc `mac-x64/`).
- `--to all` = app + dmg + zip · `--to app` = chỉ `.app`.
- **Signed + notarized** (bỏ bước chuột-phải-Open lần đầu) — cần Apple Developer ID cert trong keychain + biến `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`, thêm cờ `--signed`.
- Cài / dọn: `pnpm tools-pack mac install` · `pnpm tools-pack mac cleanup`

## 4. Build Windows (NSIS installer)

```bash
pnpm tools-pack win build --to nsis     # installer .exe
pnpm tools-pack win install
pnpm tools-pack win cleanup
```

- Cùng yêu cầu export `KGS_*` như trên (đã hỗ trợ bake cho Windows).
- Build native nên chạy trên Windows (better-sqlite3 build từ source — cần VS Build Tools 2022).

## 5. Verify nhanh sau build

```bash
# đổi mac-arm64 → mac-x64 nếu vừa build Intel
APP=".tmp/tools-pack/out/mac/namespaces/default/builder/mac-arm64/Open Design.app"
# arch của .app đúng chưa?
file "$APP/Contents/MacOS/Open Design" | grep -oE 'arm64|x86_64'
# KGS đã baked?
python3 -c "import json;print(json.load(open('$APP/Contents/Resources/open-design-config.json')).get('kgsUrl'))"
# web standalone có trong app? (thiếu → app fallback dev → lỗi HMR, xem Lưu ý #1)
ls "$APP/Contents/Resources/open-design-web-standalone/apps/web/server.js"
# (figma-clip assets đã bỏ — KHÔNG cần check nữa, xem Lưu ý #2)
```

## 6. Publish lên GitHub Release (feed auto-update + tải thủ công)

Script `pnpm release:github` (`scripts/release-github.ts`) đẩy DMG mac (+ Windows) lên một GitHub Release `open-design-v<version>` và sinh `metadata.json` — feed mà app tự đọc để phát hiện bản mới (`defaultMetadataUrl` trong `apps/desktop/src/main/updater.ts` trỏ `releases/latest/download/metadata.json`).

### Yêu cầu
- `gh` CLI đã đăng nhập: `gh auth login`. Repo `ducanhlaminh/open-design-vnpay` **phải public** (private → user tải asset bị 403).
- Version lấy từ `apps/packaged/package.json`. Muốn ra bản mới → **bump version trước** (vd `0.8.0` → `0.8.1`). Tag `open-design-v<ver>` đã tồn tại thì script upload đè (`--clobber`).

### Các bước (mac Silicon + Intel)
```bash
# 1. Bump apps/packaged/package.json: "version": "0.8.1"

# 2. Build 2 arch — nhớ copy DMG ra vì 2 arch CHUNG 1 path (§3)
SP=~/Desktop
DMG=".tmp/tools-pack/out/mac/namespaces/default/dmg/Open Design-default.dmg"
pnpm tools-pack mac build --to dmg && cp "$DMG" "$SP/mac-arm64.dmg"
OD_PACK_MAC_ARCH=x64 pnpm tools-pack mac build --to dmg && cp "$DMG" "$SP/mac-x64.dmg"

# 3. Publish (sinh metadata.json: platforms.mac arm64 + platforms.macIntel x64)
pnpm release:github --version 0.8.1 \
  --arm64-dmg "$SP/mac-arm64.dmg" \
  --x64-dmg "$SP/mac-x64.dmg"
# + --signed nếu build ký (§3) · + --dry-run để xem metadata trước khi upload
```

### Windows
- **Có máy Windows** — build installer thật rồi thêm vào cùng release (auto-update được):
  ```bash
  pnpm tools-pack win build --to nsis            # ra ...-setup.exe
  pnpm release:github --version 0.8.1 --win-installer "<path setup.exe>"
  # → metadata.json.platforms.win.artifacts.installer
  ```
- **Chỉ có máy mac** (KHÔNG dựng được NSIS — packer chặn "Windows installer build must run on Windows"): publish **portable ZIP**:
  ```bash
  pnpm tools-pack win build --to dir --json      # chỉ --to dir chạy trên mac
  # win-unpacked nằm ở CACHE path — field "unpackedPath" trong JSON output, KHÔNG phải out/win/.../builder/
  WINUP=$(pnpm tools-pack win build --to dir --json 2>/dev/null | grep -oE '"unpackedPath": "[^"]*"' | tail -1 | sed 's/.*: "//;s/"//')
  ditto -c -k --keepParent "$WINUP" "$SP/open-design-0.8.1-win-x64-portable.zip"
  gh release upload open-design-v0.8.1 "$SP/open-design-0.8.1-win-x64-portable.zip" \
    --repo ducanhlaminh/open-design-vnpay --clobber
  ```
  Người dùng Windows: giải nén → chạy `Open Design.exe`. (Không installer, KHÔNG auto-update — zip không nằm trong `metadata.json`.)

### Verify
```bash
gh release view open-design-v0.8.1 --repo ducanhlaminh/open-design-vnpay --json assets --jq '[.assets[].name]'
curl -fsSL https://github.com/ducanhlaminh/open-design-vnpay/releases/latest/download/metadata.json | grep releaseVersion
```

### Gotchas
- **Chưa ký** → macOS chuột phải → Open; Windows More info → Run anyway. Ký để bỏ (§3 mac; Windows Authenticode).
- Feed app đọc là bản **Latest** trên GitHub — script tự set `--latest` khi tạo release mới.
- `win --to dir` để win-unpacked trong **cache** (`unpackedPath`), không phải thư mục `out/`.

## Lưu ý quan trọng (đã gặp khi build)

1. **Đừng chạy `pnpm tools-dev` cùng namespace `default`** khi test packaged app trên cùng máy → đụng IPC socket `/tmp/open-design/ipc/default/web.sock` → packaged web sidecar không claim được IPC, fallback sang `next dev` (lỗi HMR `wss://app/_next/webpack-hmr` → `ERR_NAME_NOT_RESOLVED`). Người nhận máy khác KHÔNG gặp. Cách xử lý: `pnpm tools-dev stop` + kill runner `tools-dev run web` còn sót + `rm -f /tmp/open-design/ipc/default/*.sock`, rồi mở lại app (log phải hiện `starting standalone Next.js server`). Fix vĩnh viễn để chạy được cả hai cùng lúc: build app với version có channel suffix (vd `0.8.0-beta.1` → namespace `release-beta`) cho khỏi đụng `default`.
2. **figma-clip (ĐÃ GỠ — không còn cần)**: cơ chế copy-to-Figma cũ (figma-clip, daemon asset `glyph-atlas.json`/`snapshot.json`) đã được thay bằng **figma-h2d chạy client-side**, không còn dùng asset trong daemon. `packages/figma-clip` đã bị xoá khỏi repo, nên bước copy assets trong `tools/pack/src/{mac,win}/app.ts` giờ chỉ là **no-op** (copy nếu source còn tồn tại — hiện không). → Thư mục `prebundled/daemon/assets/` trống là **bình thường**, daemon KHÔNG crash vì điều này. (Ghi chú cũ "thiếu assets → crash" không còn đúng.)
3. **Agent CLI không bundle**: người nhận phải tự cài + login Claude Code (hoặc agent khác) để chạy pipeline.
4. Đừng sửa file bên trong `.app` đã build rồi mở lại — phá chữ ký ad-hoc, Gatekeeper từ chối. Build lại thay vì patch tay.
