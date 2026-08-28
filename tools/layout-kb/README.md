# tools/layout-kb — builder kho bố cục (Enrico)

`node tools/layout-kb/build.mjs [--out ~/layout-kb] [--topics list,form,...] [--max-per-topic 12] [--with-screenshots] [--force]`

Dựng `~/layout-kb/` (env `LAYOUT_KB_DIR` cho daemon) từ dataset **Enrico**
(Aalto, MIT — https://github.com/luileito/enrico): tải `hierarchies.zip`,
`metadata.zip`, `wireframes.zip` (~10 MB, http → redirect https) + `design_topics.csv`
(repo GitHub; server Aalto không có file này), cache ở `<out>/.cache/`, giải nén
bằng CLI `unzip`. Không tải `screenshots.zip` (110 MB) trừ khi `--with-screenshots`.

Mỗi màn: hierarchy JSON → hàng theo dải y → band (`appbar · search · list(N) ·
grid-2 · form(N) · button · fab · tabbar …`, từ `componentLabel` Rico + class +
hình học) → signature. Theo topic giữ ≤6 template phổ biến + ≤12 màn mẫu đa dạng,
chỉ copy wireframe của màn được chọn. Output: `manifest.json`, `wireframes/<id>.png`,
`README.md`, `curate.json` (`{ "exclude": [id…] }` — deny-list, tôn trọng khi rebuild).

Node ≥ 20, không dependency npm. Idempotent/resumable. Consumer: `apps/daemon/src/layout-kb.ts`
(stage dr-mockup, `mockups/_inputs.json.screens[].layoutRefs`).

Manifest **schema_version 2** (WP layout-kb-web): mỗi topic có `platform: mobile | web` (vắng = mobile), file có `sources[]`.
Topic web tầng 1 (`web-table`, `web-detail`, `web-form`, `web-dashboard`, `web-settings`, `web-auth`, `web-list`, `web-wizard`) viết tay ở `web-templates.json` — build.mjs merge sau topic Enrico (`samples: []`).
Màn web trong daemon chỉ nhận topic `web-*` (`WEB_ARCHETYPE_TOPICS`); tầng 2 dữ liệu thật = `build-web.mjs` (chạy sau build.mjs).

## Tầng 2 — dữ liệu web thật: `build-web.mjs` (WP layout-kb-web, Executor C)

`node tools/layout-kb/build-web.mjs [--out ~/layout-kb] [--admin|--no-admin] [--webui] [--webui-dir DIR] [--templates adminlte,tabler] [--max-per-topic 12] [--force] [--playwright-dir DIR] [--viewport 1440x900] [--dump]`

Chạy **SAU** `build.mjs` (build.mjs ghi lại topic web về tầng 1). Merge vào `manifest.json` hiện có:
giữ nguyên topic mobile (byte-identical) + khuôn tay của `web-templates.json`; THÊM template thật
(`source: build-web:<nguồn>`, ≤6 template/topic tính cả khuôn tay; khuôn tay trùng signature thì chỉ
nối id sample) và `samples[]` thật (`wireframes/web/<id>.png`, ≤ `--max-per-topic`). Idempotent:
chạy lại thay đúng phần có `source: build-web:*`, không nhân đôi; `curate.json.exclude` nhận id web
(`adminlte-tables-data`, `webui-<id>`). Cache `.cache/web/<template>/<page>.json` (hộp DOM đã trích) —
`--force` render lại.

Pipeline: `web-band.mjs` (thuần, test `node --test tools/layout-kb/web-band.test.mjs`): hộp DOM
(tag/role/class từ khoá/bbox/số input) → vùng cấu trúc (sidenav cột trái · topbar/header-nav gộp
nhiều thanh kề nhau · footer · modal) → unit (card/form nhìn con: có table → table, ≥2 input → form
/form-2col, chart, kpi nhỏ…) → hàng theo y trong vùng nội dung (hàng cao 2 cột không chồng x → cột
chính + band `summary`) → gộp (`input×N` → `form(N)`, hàng input/nút ngay trước table → `filterbar`)
→ signature → sketch 12×40 (sidenav chiếm 8 cột trái) → topic `web-*` (`topicFor`: tên/URL + band;
`admin-templates.json.pages[].topic` override). Wireframe = SVG hộp xám vẽ từ bbox → PNG qua Playwright
(không trình duyệt → ghi `.svg`, manifest trỏ `.svg`; daemon chỉ truyền đường dẫn).

Nguồn (`manifest.sources[]`):
- `--admin` (mặc định bật, `admin-templates.json`): **AdminLTE 4.9.1** (MIT, `ColorlibHQ/AdminLTE`, dist qua
  jsDelivr `gh@4.9.1/dist/` — jsDelivr trả `.html` là `text/plain`, script ép lại `text/html` qua `page.route`)
  24 trang; **Tabler 1.4.0** (MIT, `tabler/tabler`, bản build chính thức tại `preview.tabler.io` — release
  không đính kèm zip HTML, jsDelivr gh không phục vụ repo; các trang PRO trả "Page 404" đã loại) 35 trang.
  Render bằng **Playwright 1.60 có sẵn trong pnpm workspace** (`node_modules/.pnpm/playwright@1.60.0`,
  chromium-1223 ở `~/Library/Caches/ms-playwright`) — script tự tìm; máy khác không có thì
  `mkdir /tmp/pw && cd /tmp/pw && npm i playwright && npx playwright install chromium` rồi `--playwright-dir /tmp/pw`.
- `--webui` (mặc định TẮT): HF **`biglab/webui-7k`** (WebUI, CMU — giấy phép "other": điều khoản nghiên cứu
  `js0nwu/webui/COPYRIGHT.txt`, ảnh chụp có thể chứa nội dung bản quyền → chỉ dùng bbox/class/axtree, KHÔNG
  copy ảnh). Format đã kiểm (2026-08-28, qua HF API + `sample/` trên GitHub): repo chỉ có `train_split_web7k.json`
  (mảng id) + `train_split_web7k.zip.001` (4,29 GB) + `.002` (4,07 GB) — phải `cat` ghép rồi `unzip`; mỗi id
  một thư mục, mỗi viewport (`default_1280-720|1366-768|1536-864|1920-1080`, `iPad-Pro`, `iPhone-13 Pro`) có
  `-bb.json.gz` `{backendNodeId: {x,y,width,height}}`, `-box.json.gz` (content/padding/border/margin),
  `-class.json.gz` `{id: {"0": cls…}}`, `-axtree.json.gz` `{nodes[]: nodeId, role.value, name.value,
  childIds, backendDOMNodeId}`, `-viewport.json.gz` `{id: bool}`, `-html.html`, `-url.txt`, `-screenshot*.webp`.
  Không có tên split "resampled" riêng trên HF (chỉ webui-7k / webui-70k / webui-350k). Ingest
  (`webuiSampleToElements`) đọc `default_1920-1080-*`, thứ tự = DFS axtree, tag suy từ role; đã chạy thử trên
  sample GitHub `1656554031731` (`--no-admin --webui-dir DIR`) → `header-nav › text › actions › text › list › footer`.
  CHƯA kiểm: tải 8,4 GB thật (cấu trúc thư mục trong zip — script quét lồng ≤2 cấp), chất lượng topic heuristic
  trên 7k trang (topic theo `title` + URL + band, chưa có `curate.json` deny-list nào).
