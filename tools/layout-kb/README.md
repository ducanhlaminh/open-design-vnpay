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
