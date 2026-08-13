# Vùng chờ duyệt — dự án khai sinh ở Open Design

## Vấn đề

Trước bản này, một dự án pipeline chỉ khai sinh được ở **Pipeline Studio**. Muốn thử một
pipeline mới, người dùng phải: sang studio tạo dự án → `od kg pull-all` kéo về → mới chạy được.
Quá nhiều thao tác cho một việc chỉ để thử.

Nhưng cũng không thể cho Open Design ghi thẳng vào danh sách chính của studio: studio là nơi
nhiều đội cùng nhìn, và một máy bất kỳ đẩy lên một dự án bất kỳ thì danh sách đó mất kiểm soát.

## Cách giải

Người dùng tạo cấu trúc **2 cấp App/feature** ngay tại Open Design (feature = workspace od). Lúc
Push, đích được phân giải tự động thành một trong ba case:

| Case | Trạng thái trên studio | Xử lý |
|---|---|---|
| 3 | feature đã có | ghi đè bản gốc (hành vi cũ, không đổi) |
| 1 | App đã có, feature chưa | đẩy vào **vùng chờ duyệt** |
| 2 | chưa có cả hai | đẩy vào vùng chờ, duyệt sẽ tạo cả App |

Case 1 và 2 không ghi vào danh sách chính. Chúng vào một media folder tên
`pending--<slug>--<nonce6>` kèm phiếu `request.json`. Người có quyền `projects:approve` bên
studio thấy danh sách chờ đó và **duyệt**. Duyệt xong **owner = người submit**.

## Vì sao là prefix tên folder, không phải storage riêng

Vì **duyệt = một lần rename**, không copy byte nào.

media-service lưu đường dẫn tương đối của file trong **TAG** (`path:<rel>`), không phải cột, và
`PATCH /api/v1/folders/:id {name}` cascade đường dẫn con. Nên đổi tên
`pending--checkout--a1b2c3` → `checkout` là lossless: `_v/` (snapshot từng bản) và
`changelog.json` sống nguyên vẹn. Một storage riêng sẽ bắt buộc phải copy — và copy thì lịch sử
phiên bản là thứ đầu tiên rụng.

## Vì sao push chờ duyệt KHÔNG chạm KGS và preview-identity

Đây là ràng buộc cứng, không phải lựa chọn phong cách:

- **KGS không có API update node.** Một `DP_UI_WORKSPACE` tạo dưới tên `pending--…` là rác vĩnh
  viễn — không xoá, không đổi tên được.
- **Studio liệt kê dự án TỪ workspace KGS.** Nên chỉ cần tạo node đó là dự án chưa duyệt hiện
  ngay trong danh sách chính, tức là vòng duyệt vô nghĩa. (Hệ quả phụ có lợi: studio tự động ẩn
  folder chờ mà không cần lọc gì.)
- **identity project phải do người duyệt tạo**, dưới id cuối cùng và **AS người submit** —
  preview-identity đặt người tạo làm owner, và đó chính là toàn bộ cơ chế "owner = người submit".
  Không có group, không có khái niệm "all member".

Cụ thể, khi `staged` các bước sau bị bỏ: `ensureWorkspace`, `ensureProjectRegistered`,
`convertStageToGraph` (server.ts), và `ensureWorkspace` + `pushProject` ở tầng route
(remote-projects-routes.ts). Lần push **đầu tiên sau khi được duyệt** chạy như case 3 và làm hết những
việc đó.

## Vì sao nonce là bắt buộc

Thiếu nó, hai người cùng stage một feature trùng tên sẽ đổ file vào **cùng một folder** và trộn
lẫn kết quả của nhau — mất dữ liệu âm thầm, không lỗi nào báo.

## Vì sao id local không đổi khi được duyệt

Id local vừa là `projects.id` (PRIMARY KEY, 5 bảng con tham chiếu `ON DELETE CASCADE` mà **không**
có `ON UPDATE CASCADE`), vừa là **tên thư mục cwd** dưới `PROJECTS_DIR`, vừa neo `.odhistory`.
Đổi nó là một transaction viết tay 6 bảng cộng di chuyển thư mục — sai một nhịp là mồ côi cả thư
mục làm việc.

Thay vào đó máy local **học** id thật và ghi vào `metadata.studioConfig.remoteId`; từ đó mọi push
đi nhánh case 3 lên id đó. Không có gì trên đĩa phải di chuyển.

## Biên nhận quyết định — vì sao cần

Open Design nằm sau NAT; studio không gọi ngược vào được. Và sau khi duyệt, folder chờ **đã đổi
tên** nên không còn dấu vết nào để máy submit biết yêu cầu của mình thành id gì.

Nên mỗi quyết định ghi một file `<pendingId>.json` vào folder `pending--decisions`. Mỗi lần push,
`planPush` thấy `pendingId` biến mất khỏi registry → đọc biên nhận → cập nhật `remoteId` (hoặc
hiển thị lý do từ chối). Đây là kênh poll một chiều duy nhất giữa hai app.

## Bản đồ mã

Phía Open Design (`apps/daemon/src/`):

| File | Vai trò |
|---|---|
| `kg-sync/staging.ts` | Hằng số + parse. **Thuần** — studio mirror nó. |
| `kg-sync/push-dest.ts` | `resolvePushDest` — 3 case. **Thuần**, test bằng mảng. |
| `kg-sync/push-plan.ts` | Nạp registry (memo 30s), reconcile kết quả duyệt, gọi resolver. |
| `kg-sync/staging-store.ts` | Đọc/ghi `request.json` + biên nhận qua MediaClient. |
| `server.ts` `uploadProjectFiles` | Mọi thao tác media chạy trên `plan.destId`. |
| `remote-projects-routes.ts` `push-all` | Phân giải plan MỘT lần/dự án rồi truyền xuống. |

**Chỗ nguy hiểm nhất**: `uploadProjectFiles` có mirror-prune — nó **xoá** file trên store không
còn bản local. Bỏ sót một chỗ khi đổi sang `destId` nghĩa là một push chưa duyệt đi liệt kê rồi
xoá file của dự án thật. Sau khối tính `dest`, `projectId` chỉ còn được phép dùng cho thứ thuần
local (cwd, exports, `getProject`). `apps/daemon/tests/push-dest.test.ts` khoá 3 case đó lại.

## Điều kiện chặn trước

Push cần tạo mới mà máy **chưa đăng nhập Google** thì bị chặn ngay (`StagingBlockedError`,
`code: STAGING_NO_SUBMITTER`, HTTP 400). Vì owner sau khi duyệt = người submit, không có người
submit thì không ai làm owner được và không ai nhận được kết quả.

## Còn hở

`PATCH /api/v1/folders/:id` **không kiểm ownership** (`folder_usecase.go` nhận `requesterID` rồi
không đọc), và Open Design gửi `X-User-Role: admin`. Nghĩa là hôm nay một máy od bất kỳ vẫn có
thể tự rename folder, bỏ qua vòng duyệt. **Cổng duyệt này chỉ mang tính khuyến nghị cho tới khi
lỗ đó được vá** — ngoài phạm vi bản này nhưng phải biết rõ.
