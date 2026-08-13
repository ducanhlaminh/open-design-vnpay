# WP7 (BACKLOG) — Host toolkit cho ui-react/ui-react-ds khi mở lại codegen

Trạng thái: KHÔNG thực thi trong đợt này. Kích hoạt khi quyết định un-hold `ui-react`/`ui-react-ds`. Ước lượng: ~2 ngày.

Nội dung chi tiết đã có ở `docs/prod-docker-removal-spec.md` §6 (Phase 4) — spec đó vẫn chính xác. Tóm tắt để không phải đọc lại từ đầu:

1. `ensureUireactToolkit()` trong daemon (~40 dòng, khuôn `ensureRunnerEnv` của `react-demo.ts`): seed `<runtimeDataDir>/uireact-toolkit/<version>/` từ `builder/base/package.json` + lockfile, `npx pnpm install --frozen-lockfile`, idempotent.
2. Nhánh thứ ba trong 2 file `build.sh` (hoặc port hẳn sang `build.mjs` chạy bằng `OD_NODE_BIN` — khuyến nghị, xóa luôn phụ thuộc bash): khi có `UIREACT_TOOLKIT_DIR` → symlink `<target>/node_modules` → toolkit, chạy gate `tsc --noEmit && vite build` như cũ.
3. **Cạm bẫy đã test, đừng làm sai** (spec cũ §6.1): symlink `<project>/node_modules` → toolkit là cách ĐÚNG; symlink project thành con của toolkit là cách SAI (Node resolve theo realpath → ERR_MODULE_NOT_FOUND).
4. **Chống write-amplification** (§6.1b): sau khi seed toolkit phải `chmod -R a-w`; seatbelt profile KHÔNG cấp quyền ghi thư mục toolkit.
5. Dọn symlink sau build (trap unlink) — vì `react/node_modules` không nằm trong `syncExclude`.
6. Un-hold: xóa id khỏi `HELD_STAGE_IDS` (WP1) + gỡ test held tương ứng.

Điều kiện tiên quyết khi kích hoạt: WP1–WP6 đã merge; quyết định sản phẩm về việc mở lại mảng gen code.
