# Web-first: bỏ bản App, hold gen-code UI, host CLI, gỡ Docker — Master Plan

Ngày: 2026-08-13. Trạng thái: APPROVED-FOR-EXECUTION (theo chỉ đạo chủ dự án).
Phân tích nền: artifact "Open Design Web-first" + `docs/prod-docker-removal-spec.md` (spec cũ, tiền đề đã đổi).

## Mục tiêu cuối

1. Không còn phân phối bản App (Electron). Sản phẩm chạy dạng web: daemon + web mở bằng browser (localhost-web, mỗi người một máy).
2. Ba stage gen code UI của `docs-to-ui` (`ui-html`, `ui-react`, `ui-react-ds`) bị **hold** — không chạy được, hiển thị rõ là tạm khóa, output cũ không bị hỏng.
3. Agent chạy bằng **Claude CLI trên host** (không Docker sandbox), có whitelist env + kill cây process + timeout.
4. Cài đặt máy mới bằng **một lệnh curl | bash** kiểu kit-gen (tarball GitHub Releases, checksum, rollback, LaunchAgent/systemd, không sudo, không seed credential).

## Work packages

| WP | Tên | Spec | Ước lượng | Phụ thuộc |
|----|-----|------|-----------|-----------|
| 0 | Baseline & smoke host | `wp0-baseline.md` | 0.5 ngày | — |
| 1 | Hold gen-code stages | `wp1-hold-codegen.md` | 1 ngày | — (song song WP2) |
| 2 | Env whitelist tại seam spawn | `wp2-env-whitelist.md` | 0.5–1 ngày | WP0 |
| 3 | Vòng đời process host (tree-kill, timeout, sweep) | `wp3-process-lifecycle.md` | 1 ngày | WP2 (cùng đụng server.ts — TUẦN TỰ sau WP2) |
| 4 | Đảo mặc định host + surface UI/CLI | `wp4-host-default-ui.md` | 2 ngày | WP2 + WP3 |
| 5 | Gỡ bản App (deletion) | `wp5-remove-electron.md` | 1.5–2 ngày | WP4 |
| 6 | Installer + build-runtime + release | `wp6-installer.md` | 2–3 ngày | WP4 (có thể chạy song song WP5) |
| 7 | (Backlog) Host toolkit uireact — khi mở lại codegen | `wp7-backlog-host-toolkit.md` | ~2 ngày | khi un-hold |
| 8 | Bỏ JIRA ingest, tách credential Confluence khỏi MCP config | `wp8-remove-jira-confluence-cred.md` | 1–1.5 ngày | — (đụng `server.ts`, TUẦN TỰ với WP3/WP9/WP10) |
| 9 | Gỡ 2 MCP server nội bộ + OD-as-MCP-server | `wp9-remove-internal-mcp.md` | 1 ngày | WP8 (đụng `server.ts`, TUẦN TỰ) |
| 10 | Gỡ KGS, chỉ giữ media-service | `wp10-remove-kgs.md` | 1.5–2 ngày | WP8 + WP9 (đụng `server.ts`, TUẦN TỰ) |

```
WP0 ──► WP2 ──► WP3 ──► WP4 ──┬──► WP5
        ▲                     └──► WP6
WP1 (độc lập, chạy song song WP0/WP2)
WP8 ──► WP9 ──► WP10 (nhánh riêng, xuất phát từ quyết định bỏ JIRA/MCP/KGS 13/08 —
                       không phụ thuộc kỹ thuật vào WP2-WP7, nhưng CÙNG đụng server.ts
                       nên phải chạy TUẦN TỰ với bất kỳ WP nào khác đang sửa server.ts,
                       không được chạy song song với WP3 hay với nhau)
```

**Ghi chú WP8-10**: nhánh việc phát sinh từ investigation ngày 13/08 (quyết định: hệ thống đã REST-first cho Confluence, JIRA/MCP/KGS đều không phải hard dependency — xem hội thoại lúc quyết định để biết đầy đủ bối cảnh). Khác batch với WP1-WP7 (đó là kế hoạch App-removal/host-mode/installer gốc). `server.ts` giờ có 4 WP muốn vào (WP3, WP8, WP9, WP10) — nguyên tắc chung #2 (verify line ref bằng grep trước khi sửa) áp dụng NGHIÊM NGẶT hơn cho các WP này vì file trôi nhanh theo từng WP merge trước đó.

## Nguyên tắc chung (áp cho MỌI WP — chép vào prompt của sub-agent)

1. **Không xóa code Docker ở WP1–WP4.** Docker sandbox thành một *chế độ* tắt-mặc-định (`OD_SANDBOX=1` bật lại được). Chỉ WP5 mới xóa code, và chỉ xóa phần Electron — không xóa `agent-sandbox.ts`.
2. **Line refs trong spec là mốc 13/08** — trước khi sửa, xác minh lại bằng grep/symbol search; `server.ts` rất lớn (~19k dòng), line trôi nhanh.
3. **Baseline test đang đỏ sẵn một số nhóm** (xem `baseline.md` sau khi WP0 chạy). Chỉ được phép: không làm đỏ thêm. Không tự sửa test đỏ ngoài phạm vi WP.
4. Gate bắt buộc trước khi báo xong: `pnpm guard` + `pnpm typecheck` xanh; test của khu vực mình sửa xanh (daemon: `pnpm --filter @open-design/daemon test -- <file>`; web: `pnpm --filter @open-design/web test -- <file>`).
5. **Không commit, không push.** Để nguyên working tree, báo cáo danh sách file đã sửa.
6. Daemon chạy tsx **không hot-reload route** — nếu tự chạy thử phải restart tools-dev; restart daemon PHẢI kèm restart web.
7. Mọi capability đổi ở BE phải có **cả UI lẫn CLI** (quy ước AGENTS.md của repo).
8. Chuỗi hiển thị mới: thêm key i18n cho **đủ 19 locale** (`apps/web/src/i18n/locales/*.ts` + `types.ts`) — tiếng Việt + tiếng Anh viết thật, các locale khác dùng bản tiếng Anh.
9. Vùng sở hữu file khi chạy song song: WP1 sở hữu `pipelines.ts`/`pipeline-routes.ts`/web pipelines; WP2+WP3 sở hữu seam spawn trong `server.ts` + `runs.ts`; không WP nào khác được sửa file thuộc vùng của WP đang chạy.

## Prompt mẫu giao cho sonnet-executor

```
Đọc và thực thi spec: specs/change/20260813-web-first/wpN-<tên>.md
trong repo /Users/anhnd13/Documents/VNPAY/AI/vpn-design-platform-figma-design-system/ui/open-design-vnpay

Bắt buộc đọc thêm mục "Nguyên tắc chung" trong plan.md cùng thư mục.
Làm ĐÚNG phạm vi spec — mục "Ngoài phạm vi" là cấm tuyệt đối.
Line refs là mốc 13/08: xác minh lại bằng grep trước khi sửa.
Tự verify theo mục "Acceptance & Verify" của spec.
Không commit. Trả về report: file đã sửa, quyết định đã đưa, kết quả từng lệnh verify, việc còn lại (nếu có).
```

## Quyết định đã chốt (không mở lại trong quá trình thực thi)

- Hold **cả 3** stage terminal (`ui-html`, `ui-react`, `ui-react-ds`) — danh sách nằm ở 1 hằng `HELD_STAGE_IDS`, đổi ý sau = sửa 1 dòng.
- Multi-account Claude: **bỏ** ở host mode (chỉ dùng login của CLI trên máy).
- Cách ly đọc: **bỏ**, chỉ chặn ghi (seatbelt). Windows: không còn là target end-user.
- Nền tảng chạy daemon: macOS (arm64/x64) + Linux x64.
- Desktop pet: **xóa** cùng bản App.
- Kênh phân phối: tarball GitHub Releases + install.sh (mirror nội bộ qua `--release-url`).
