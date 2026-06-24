# Build app đóng gói (DMG / Windows) — bản VNPAY có KGS baked

Lệnh build packaged app cho fork này, đã nhúng sẵn cấu hình KGS để **đưa mỗi app là chạy** (không cần `.env.local` ở máy người nhận).

Chạy mọi lệnh từ thư mục submodule: `ui/open-design-vnpay`.

## 0. Yêu cầu môi trường

- **Node 24** + **pnpm 10.33.2** (qua corepack/nvm). Trên máy hiện tại:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
  node -v   # v24.x
  pnpm -v   # 10.33.2
  ```
- Mac DMG **chỉ build được trên macOS**; arch theo CPU máy build (Apple Silicon → arm64).
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

## 2. (Nếu sửa code trong `tools/pack`) rebuild dist trước

CLI `tools-pack` chạy từ `dist`, nên sau khi sửa `tools/pack/src/**` phải:
```bash
pnpm --filter @open-design/tools-pack build
```

## 3. Build Mac DMG (đã verify chạy được)

```bash
# unsigned (mặc định) — người nhận phải chuột phải → Open lần đầu (Gatekeeper)
pnpm tools-pack mac build --to dmg

# signed + notarized (bỏ được bước chuột-phải-Open) — cần Apple Developer ID
# cert trong keychain + biến notarize (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID)
pnpm tools-pack mac build --to dmg --signed
```

- Output DMG: `.tmp/tools-pack/out/mac/namespaces/default/dmg/Open Design-default.dmg`
- `--to all` = app + dmg + zip. `--to app` = chỉ `.app`.
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
APP=".tmp/tools-pack/out/mac/namespaces/default/builder/mac-arm64/Open Design.app"
# KGS đã baked?
python3 -c "import json;print(json.load(open('$APP/Contents/Resources/open-design-config.json')).get('kgsUrl'))"
# figma-clip assets có trong daemon prebundle? (nếu thiếu → daemon crash khi mở)
ls "$APP/Contents/Resources/app/prebundled/daemon/assets/"   # phải có snapshot.json + glyph-atlas.json
```

## Lưu ý quan trọng (đã gặp khi build)

1. **Đừng chạy `pnpm tools-dev` cùng namespace `default`** khi test packaged app trên cùng máy → đụng IPC socket `/tmp/open-design/ipc/default/web.sock` → packaged web fallback sang dev server (lỗi HMR `wss://app/_next/webpack-hmr`). Người nhận không gặp. Stop dev: `pnpm tools-dev stop`.
2. **figma-clip assets**: packaging phải copy `packages/figma-clip/assets` vào `prebundled/daemon/assets` (đã fix trong `tools/pack/src/mac/app.ts` và `tools/pack/src/win/app.ts`) — nếu thiếu, daemon crash ngay khi mở ("figma-clip: không tìm thấy thư mục assets").
3. **Agent CLI không bundle**: người nhận phải tự cài + login Claude Code (hoặc agent khác) để chạy pipeline.
4. Đừng sửa file bên trong `.app` đã build rồi mở lại — phá chữ ký ad-hoc, Gatekeeper từ chối. Build lại thay vì patch tay.
