# WP5 — Gỡ bản App (xóa Electron)

Ước lượng: 1.5–2 ngày. Phụ thuộc: WP4 merge xong (luôn còn đường lùi trước đó). Vùng sở hữu: `apps/desktop`, `apps/packaged`, `packages/{download,host,sidecar-proto}`, `tools/{pack,serve,dev}`, web các phần desktop-only, e2e.

## Nguyên tắc

Chủ yếu là DELETION. Coupling đã xác minh là nông: 9 file import electron, web↔daemon thuần HTTP, toàn bộ I/O pipeline thuộc daemon. Runtime chuẩn sau WP5: **daemon serve static export một process** (`node apps/daemon/dist/cli.js --no-open`, shape của `deploy/Dockerfile`) cho prod; dev giữ `pnpm tools-dev run` (daemon + web dev server, browser).

## Xóa

| Nhóm | Đích |
|---|---|
| Desktop shell | `apps/desktop/**` toàn bộ (gồm updater.ts 2218 dòng, pdf-export, diagnostics, preload) |
| Packaged Electron | `apps/packaged/src/index.ts`, `launch.ts`, `protocol.ts` (od:// scheme); **GIỮ** `headless.ts` + phần config nó cần (`config.ts` đọc lazy electron — cắt nhánh electron, giữ nhánh env) |
| Update hạ tầng | `packages/download` (chỉ updater dùng), `tools/serve` (fixture updater), `apps/daemon/src/update-apply-observations.ts`, `apps/desktop/src/main/installer-observations.ts` (đi theo apps/desktop) |
| Pack mac/win | `tools/pack/src/mac/**`, `tools/pack/src/win/**`, phần electron-builder/appimage của `linux.ts` (**GIỮ** headless portion ~L1296-1476 — WP6 dùng), `tools/pack/resources/**` (icns/ico/entitlements/notarize/7z) |
| Web desktop-only | `apps/web/src/lib/updater.ts`, `components/UpdaterPopup.tsx`, `apps/web/app/desktop-pet/**`, `components/pet/DesktopPetSurface.tsx` |
| Desktop auth gate | `apps/daemon/src/desktop-auth.ts` + nhánh gate trong `import-export-routes.ts` (~L111, ~L208) + env `OD_REQUIRE_DESKTOP_AUTH` |
| Sidecar proto | Các type/verb `Desktop*`, `EVAL/SCREENSHOT/CONSOLE/CLICK/UPDATE/EXPORT_PDF/REGISTER_DESKTOP_AUTH` trong `packages/sidecar-proto` (~86 chỗ) + handler tương ứng trong `tools/dev` (`inspect desktop`) |
| tools/dev | `APP_KEYS.DESKTOP` khỏi `DEFAULT_START_APPS` (`tools/dev/src/config.ts` ~L26-27), electron binary resolution (`config.ts` ~L79), lệnh desktop |
| e2e | `e2e/lib/desktop/**`, `e2e/tests/packaged*`, `e2e/tests/tools-dev/inspect.test.ts` phần desktop (nếu có phần web thì giữ) |
| Root | `pnpm.onlyBuiltDependencies`: bỏ `electron`, `electron-winstaller`; dependencies electron trong các package.json liên quan |
| CI | `.github/workflows/release-unsigned-manual.yml`: gỡ job mac/win ký-notarize; TẠM giữ file với job build daemon+web (WP6 sẽ thay bằng workflow tarball) |

## Giữ nguyên (dễ xóa nhầm)

- `packages/host` — GIỮ: là bridge capability-detection, mọi call site đã null-safe cho browser; xóa nó là đụng 11 call site không cần thiết. Chỉ xóa các API updater/pet trong đó nếu tsc chỉ ra dead.
- `apps/packaged/src/headless.ts` + `sidecars.ts` phần daemon/web spawn (headless dùng) — GIỮ.
- Daemon folder-picker (`/api/dialog/open-folder`, osascript/zenity/PowerShell) — GIỮ (đường browser đang dùng).
- `host-tools-routes.ts` (mở editor theo CLI shim) — GIỮ.
- Diagnostics daemon route (`diagnostics-export.ts`) — GIỮ (chỉ mất nguồn log desktop).
- PDF export browser-fallback (`apps/web/src/runtime/exports.ts` ~L640-676) — GIỮ, thành đường duy nhất.
- `packages/figma-h2d` — không đụng (thuần browser).
- IPC lifecycle (`packages/sidecar`, STATUS/SHUTDOWN) — GIỮ (headless + tools-dev dùng).

## Trình tự an toàn

1. Xóa theo bảng, để tsc/`pnpm guard` chỉ điểm dead references còn sót; sửa cuốn chiếu.
2. Rà `packages/host`: API nào không còn caller (updater, pet, pdf-export desktop) thì xóa API + type tương ứng; `detectOpenDesignHostClientType` giữ (trả 'web').
3. Rà i18n: key chỉ dùng bởi component đã xóa → xóa key khỏi 19 locale + types (tránh khối chết).
4. Chạy full test daemon + web; đối chiếu baseline.

## Ngoài phạm vi

- `deploy/` Docker self-host (giữ — không liên quan App), `charts/` Helm (giữ).
- Installer mới (WP6). `agent-sandbox.ts` (không đụng).

## Acceptance & Verify

1. `pnpm guard` + `pnpm typecheck` + `pnpm --filter @open-design/daemon test` + `pnpm --filter @open-design/web test` xanh; không tăng đỏ baseline (trừ test bị XÓA chủ đích cùng feature — liệt kê trong report).
2. `pnpm tools-dev run` chạy daemon + web, mở browser hoạt động đủ: tạo project, chat run host, pipeline docs-to-prd stage đầu (mock/skip nếu cần quota).
3. `node apps/packaged/dist/headless.mjs` (build lại packaged) khởi động daemon + web không Electron.
4. `grep -ri "from 'electron'\|require(\"electron\")\|require('electron')"` toàn repo (trừ node_modules, docs) = 0 kết quả.
5. Report: bảng file đã xóa/sửa + các quyết định biên (những chỗ giữ lại ngoài dự kiến và lý do).
