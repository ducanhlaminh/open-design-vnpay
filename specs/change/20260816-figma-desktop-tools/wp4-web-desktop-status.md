# WP4 — Web: dòng trạng thái "Figma Desktop" trong `FigmaLinksPanel`

Đọc `spec.md` cùng thư mục trước. Endpoint do WP2 tạo (chạy song song) — trong
web chỉ cần contract type; **KHÔNG import từ `@open-design/contracts`** cho type
mới (contracts có thể chưa build lúc bạn typecheck): khai báo type cục bộ y hệt
trong `apps/web/src/state/figma-config.ts`:

```ts
export interface FigmaDesktopStatusResponse {
  available: boolean; detail?: string; activeFileTitle?: string | null; canSwitch: boolean; platform: string;
}
export async function fetchFigmaDesktopStatus(signal?: AbortSignal): Promise<FigmaDesktopStatusResponse | null>;
// GET /api/figma-desktop/status; !res.ok hoặc lỗi mạng → null
```

## Vùng sở hữu
- SỬA `apps/web/src/state/figma-config.ts` (thêm type + hàm trên).
- SỬA `apps/web/src/components/pipelines/FigmaLinksPanel.tsx` + `FigmaLinksPanel.module.css`.
- SỬA `apps/web/tests/components/pipelines/figma-links-panel.test.tsx` (thêm case; **giữ 4 case cũ xanh** — stub fetch của test hiện tại trả `{ok:true}` cho URL lạ, hãy cập nhật `stubDaemon` để trả status hợp lệ mặc định `{available:true, canSwitch:true, platform:'darwin', activeFileTitle:'UI Kit'}` và cho phép override).
- KHÔNG đụng daemon/contracts/NewAppModal/EditAppModal.

## Hành vi
Thêm **một `div.row` thứ ba** dưới hàng "kiểm tra link" (trước `verifyError`), chỉ hiển thị khi
`links.length > 0 || linksError` (tức là người dùng đang dùng nguồn Link Figma):

- Lúc mount (và khi bấm "Kiểm tra lại" của hàng này) gọi `fetchFigmaDesktopStatus`.
- `null` (daemon lỗi) → không render gì.
- `available:true` → 
  `<strong>Figma Desktop</strong>` + `<span data-ok="true">Đang chạy · MCP bật{activeFileTitle ? ` · đang mở “${activeFileTitle}”` : ''}</span>`
  và dòng phụ `<small>Khi chạy bước Màn hình → Component, agent sẽ tự mở từng component trong file bạn khai để đối chiếu.</small>`.
- `available:false` →
  `<span data-ok="false">{detail ?? 'Chưa kết nối được.'}</span>` + `<small>Không bắt buộc: thiếu Figma Desktop thì bước này chỉ đối chiếu theo catalog.</small>`.
- `canSwitch:false` (và available) → thêm `<small>Máy này không tự chuyển file được — hãy mở đúng file trong Figma trước khi chạy.</small>`.
- Nút `Kiểm tra lại` (class `styles.linkButton`, `data-testid="figma-desktop-recheck"`).
- Tái dùng class có sẵn (`.row`, `.rowText`, `.linkButton`, `span[data-ok]`); chỉ thêm CSS mới nếu thật cần (vd `.hint` cho `<small>` nếu chưa có style phù hợp).

## Test thêm (`figma-links-panel.test.tsx`)
1. có token, status available + title → thấy text `Đang chạy · MCP bật · đang mở “UI Kit”`.
2. status `available:false, detail:'Figma Desktop chưa chạy…'` → thấy detail + text `Không bắt buộc`.
3. bấm `figma-desktop-recheck` → fetch `/api/figma-desktop/status` được gọi lần 2.
4. `links=[]` và `linksError=null` → KHÔNG gọi `/api/figma-desktop/status`.

## Verify
```
cd apps/web && npx vitest run tests/components/pipelines/figma-links-panel.test.tsx tests/components/pipelines/app-design-system.test.tsx && pnpm --filter @open-design/web typecheck
```
