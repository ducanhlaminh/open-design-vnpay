# App rename: sync tên lên remote ngay lúc PATCH, không đợi push Feature

Ước lượng: 0.5-1 ngày (thay đổi TS gọn, không có phần OS-level/CI cần verify
riêng — test được đầy đủ bằng mock `MediaClient` ngay trên máy dev). Phụ
thuộc: không phụ thuộc kỹ thuật vào 2 spec Windows đang chạy song song
(`20260814-windows-write-isolation`, `20260814-windows-native-install`) —
không đụng file chung.

Vùng sở hữu: `apps/daemon/src/pipeline-routes.ts` (route
`PATCH /api/pipelines/apps/:id`, verify vị trí chính xác bằng grep
`app.patch('/api/pipelines/apps/:id'` trước khi sửa — KHÔNG tin line number
từ spec này, file trôi nhanh), test mở rộng trong
`apps/daemon/tests/pipeline-app-edit-routes.test.ts` (file test có sẵn cho
đúng route này — verify bằng cách đọc file trước khi thêm case).

**KHÔNG đụng**: `apps/daemon/src/kg-sync/remote-registry.ts` (logic đọc tên
khi liệt kê registry — không cần sửa, nó đã đọc tươi mỗi lần gọi),
`apps/daemon/src/kg-sync/media-client.ts` (class `MediaClient` đã đủ API cần
dùng, không cần thêm method mới), nhánh `designSystemId` của route PATCH này
(chỉ sửa nhánh `name`).

## Bối cảnh

`PATCH /api/pipelines/apps/:id` hiện tại (`pipeline-routes.ts:730-763`) chỉ
ghi 2 chỗ **local**: row `pipeline_apps` (DB, qua `upsertPipelineAppName`) và
`studioConfig.appName` denormalize trên từng Feature local của App đó. Comment
sẵn trong code tự thừa nhận: "row local chỉ là cái tên phủ lên... không đổi
gì trên studio" — tên mới **không** lên remote (`app.json`/`project.json`
trên media store) cho tới khi có 1 Feature con của App đó được push tiếp lần
sau (`server.ts:14530-14562` đọc lại `pipeline_apps.name` lúc đó để build
`app.json`, rồi `server.ts:14671-14675` mới thật sự ghi lên remote).

Lỗ hổng: **1 App không còn Feature local nào để push thì rename không bao
giờ chạm remote** — máy khác pull App đó vẫn thấy tên cũ vĩnh viễn. Đây
chính là lý do 3 App cũ bị lỗi tên hiển thị (BIDV/Kế toán/PMKT...) không tự
sửa được chỉ bằng cách đổi tên trên UI.

`MediaClient` (`kg-sync/media-client.ts`) đã có sẵn `downloadFile(projectId,
filePath): Promise<Buffer>` (throw nếu không tìm thấy) và
`syncProjectFiles(projectId, files: LocalSyncFile[])` với
`LocalSyncFile = {path, stage, mime, content: Buffer}`. `pipeline-routes.ts`
đã import sẵn `MediaClient, mediaConfigFromEnv` ở đầu file (dòng ~193, dùng ở
chỗ khác trong cùng file, ví dụ route feedback attachment ở
`pipeline-routes.ts:1160-1180` dựng `new MediaClient(mediaConfigFromEnv())`
tại chỗ) — **không cần thread thêm dependency mới vào
`RegisterPipelineRoutesDeps`**, dùng lại đúng pattern instantiate-tại-chỗ đã
có tiền lệ trong file này.

## Thiết kế

Thêm 1 helper trong `pipeline-routes.ts`, gọi trong nhánh `hasName && name`
của route PATCH, SAU khi `upsertPipelineAppName` + update local features đã
chạy xong, TRƯỚC khi trả response:

```ts
async function syncAppNameToRemote(
  media: Pick<MediaClient, 'downloadFile' | 'syncProjectFiles'>,
  appId: string,
  name: string,
): Promise<boolean> {
  for (const { path, stage } of [
    { path: 'app.json', stage: 'app' },
    { path: 'project.json', stage: 'config' },
  ]) {
    try {
      const buf = await media.downloadFile(appId, path);
      const config = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
      const updated = `${JSON.stringify({ ...config, name }, null, 2)}\n`;
      await media.syncProjectFiles(appId, [
        { path, stage, mime: 'application/json', content: Buffer.from(updated) },
      ]);
      return true;
    } catch {
      // Not this file — try the next candidate, or give up (App not on
      // remote yet / unreachable) after the last one.
    }
  }
  return false;
}
```

Thứ tự thử `app.json` trước `project.json` mirror đúng precedence
`remote-registry.ts`'s `loadRemoteProjects` dùng để RESOLVE tên hiển thị
(`isApp ? [APP_MARKER_PATH, PROJECT_CONFIG_PATH] : [PROJECT_CONFIG_PATH]`) —
patch đúng file mà registry thực sự đọc tên từ đó, giữ nguyên MỌI field khác
trong JSON (chỉ override `name`, spread phần còn lại) để không đụng
`contextVersion`/`contextDigest`/`appId`/`designSystemId`/
`appContextBinding` đang sống trong file đó.

Trong route handler:
```ts
if (hasName && name) {
  upsertPipelineAppName(db, { id: appId, name, createdAt: Date.now() });
  for (const f of featuresOfApp(appId)) { /* ...code hiện có... */ }

  remoteSynced = (await remoteAppIds())?.has(appId)
    ? await syncAppNameToRemote(new MediaClient(mediaConfigFromEnv()), appId, name).catch(() => false)
    : null; // null = App chưa từng có trên remote, không có gì để sync
}
```
`remoteSynced` (`true | false | null`) trả thêm vào response JSON — `false`
nghĩa là App có trên remote nhưng sync thất bại (remote không with tới được,
hoặc cả 2 file `app.json`/`project.json` đều không tồn tại/không đọc được) —
UI sau này có thể dùng field này để cảnh báo, nhưng **sửa UI không thuộc
phạm vi spec này** (chỉ thêm field vào response, không đụng frontend).

**Bắt buộc best-effort**: lỗi mạng/remote không with tới được KHÔNG được làm
fail request PATCH — rename local (đã ghi DB + feature metadata) phải luôn
thành công độc lập với remote. Đây là bất biến đã có sẵn của route này
(check hiện tại `remoteAppIds()` cũng catch lỗi trả `null` thay vì throw) —
giữ đúng tinh thần đó.

## Ngoài phạm vi

- Máy khác **đã pull App đó về local rồi** không tự refresh tên — đó là vấn
  đề cache riêng của máy đó, không phải việc của spec này (registry đọc tươi
  mỗi lần đã đúng, nhưng App/Feature đã materialize local là bản sao riêng).
- 2 máy rename App đó khác nhau gần như đồng thời rồi cùng PATCH — vẫn
  last-write-wins, không thêm conflict detection/merge. Không tệ hơn hành vi
  hiện tại (chỉ là cửa sổ race hẹp hơn).
- Nhánh `designSystemId` của cùng route PATCH — không đổi behavior, không
  sync design system lên remote.
- Sửa UI để hiển thị `remoteSynced` — chỉ thêm field vào response.
- Diagnose/fix riêng 3 App cũ bị lỗi tên (BIDV/Kế toán/PMKT) — spec này chỉ
  sửa CƠ CHẾ; verify 3 app cụ thể đó có đúng hình dạng `app.json`/
  `project.json` trên remote hay không là việc riêng, làm SAU khi cơ chế này
  merge.

## Tests

Mở rộng `apps/daemon/tests/pipeline-app-edit-routes.test.ts` (đọc file
trước để theo đúng convention mock hiện có — có thể file này đã tự dựng 1
fake `MediaClient`-like object hoặc mock module, dùng lại nếu có thay vì tạo
kiểu mock mới). Case cần cover:
1. App tồn tại trên remote với `app.json` sẵn — PATCH đổi tên → verify
   `syncProjectFiles` được gọi đúng `appId`, đúng `path: 'app.json'`, JSON
   content giữ nguyên field cũ + `name` mới. Response có `remoteSynced: true`.
2. App chỉ có `project.json` (không có `app.json`, legacy) — verify patch
   đúng file đó, `stage: 'config'`.
3. App tồn tại trên remote nhưng cả 2 file đều không đọc được (download lỗi)
   — response vẫn 200, `remoteSynced: false`, row DB local vẫn được ghi đúng
   (rename local không bị fail lây).
4. App CHƯA từng có trên remote (chỉ local) — `remoteSynced: null`, không
   gọi `downloadFile`/`syncProjectFiles` (tránh gọi remote vô ích).
5. Case hiện có của route (rename thuần local, không đụng remote logic) vẫn
   pass nguyên — không phá test cũ.

## Acceptance & Verify

1. `pnpm guard` + `pnpm typecheck` xanh.
2. Toàn bộ test trong `pipeline-app-edit-routes.test.ts` xanh (cũ + case mới
   thêm ở trên).
3. Grep xác nhận `syncAppNameToRemote` chỉ patch field `name`, không xóa/ghi
   đè field khác trong JSON gốc (đọc lại code, không chỉ tin test pass).
4. Report ghi rõ: response shape mới của route PATCH (field `remoteSynced`
   thêm vào) — đây là thay đổi API surface, dù nhỏ, cần liệt kê tường minh
   để người khác biết nếu có consumer nào khác đang đọc response này.
