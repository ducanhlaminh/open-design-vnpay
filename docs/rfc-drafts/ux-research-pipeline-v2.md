# RFC — UX Research Pipeline v2: quy trình đầy đủ từ research → UI, AI bắt buộc follow

> **Trạng thái:** draft đề xuất (chưa implement)
> **Ngày:** 2026-07-09
> **NGUỒN CHÍNH:** quy trình gốc + contract dữ liệu sống ở
> `design-v3/contract/ux/PROCESS.md` (KG Contract Hub). File này chỉ là bản
> ánh xạ triển khai (skill/PIPELINE_DEFS/validator) cho open-design-vnpay —
> khi hai bản lệch nhau, PROCESS.md thắng.
> **Bối cảnh:** pipeline hiện tại (`docs-to-html`, `docs-to-react`) đi thẳng
> `docs → customer-journey → ux-spec → ui`, **không có giai đoạn research nào**:
> không heuristic, không evidence từ user thật, persona do LLM tự bịa (chỉ
> required `name`). Trong khi đó quy trình thật của team UX VNPAY (tài liệu
> VBSP, `ui/design-v3/doc-ux/`) gồm: desk research → khảo sát đối tác →
> heuristic eval (Nielsen 10 + WCAG 2.2) → phân tích 259 review Google Play →
> roadmap ưu tiên → wireframe. RFC này đưa quy trình đó vào pipeline dưới dạng
> các stage có gate, để **AI buộc phải đi đủ các bước theo đúng thứ tự, không
> nhảy cóc, không tự bịa** — mọi output đều trace được về evidence và rule.

---

## 1. Nguyên tắc thiết kế (vì sao AI "phải follow" được)

Pipeline này ép AI follow bằng **4 tầng cưỡng chế**, không phải bằng lời dặn:

| Tầng | Cơ chế | Đã có sẵn? |
|---|---|---|
| ① Thứ tự | `PipelineDef.dependsOn` — stage chỉ active khi stage trước `succeeded` | ✅ có sẵn (`pipelines.ts` `computeActive`) |
| ② Nội dung từng bước | `SKILL.md` = system prompt của run; mỗi skill chứa checklist BẮT BUỘC + schema output | ✅ có sẵn, cần viết skill mới |
| ③ Kiểm định output | **Validator deterministic** (script python/ts) chạy sau mỗi run; output fail schema/coverage → stage KHÔNG được đánh `succeeded` | 🔴 phải thêm (hiện chỉ có `push_to_kgs.py` theo pattern converter) |
| ④ Dữ liệu rule chung | 1 rule pack heuristic duy nhất (JSON) mà mọi stage cùng đọc — sinh cũng nó, chấm cũng nó | 🔴 phải thêm (đồng bộ từ KG vpn-design-platform `deploy/local/seed-data/heuristics.json`) |

Nguyên tắc dữ liệu: **không node/claim nào không có nguồn**. Persona phải trỏ
về evidence; journey pain-point phải trỏ về evidence; quyết định layout trong
ux-spec phải trỏ về rule (`justified_by`); finding phải trỏ về rule + màn hình.

---

## 2. Quy trình tổng — 2 workflow

Giữ nguyên khung 2 luồng như team UX đang làm thật:

### Workflow R1 — `research-to-ui` (sản phẩm / chức năng MỚI)

```
[0 intake] → [1 user-research] → [2 persona] → [3 customer-journey] →
[4 ux-spec] → [5 validate-gate] → [6 ui] → [7 design-qa]
```

### Workflow R2 — `improve-existing` (cải tiến chức năng ĐANG CÓ) — luồng còn thiếu hẳn hiện nay

```
[0 intake] → [1 user-research] → [1b heuristic-eval as-is] → [2 persona] →
[3 customer-journey to-be] → [4 ux-spec] → [5 validate-gate] → [6 ui] → [7 design-qa]
```

Khác biệt duy nhất: R2 có thêm **heuristic-eval hiện trạng** (input = screenshot
app hiện tại / link Figma / APK teardown docs) và journey ở R2 là *to-be* có đối
chiếu *as-is*.

---

## 3. Chi tiết từng stage

### Stage 0 — `intake` (skill có sẵn: `jira-ingest`)

Giữ nguyên. Input: Confluence URL / JIRA key / BRD-URD upload.
Output: `docs/jira/`, `docs/confluence/` (markdown).

**Bổ sung bắt buộc trong SKILL.md:** cuối run phải sinh `docs/_intake-summary.json`:
mục tiêu kinh doanh, KPI, phạm vi, danh sách actor nghiệp vụ, câu hỏi mở.
Đây là input chuẩn cho stage research (thay vì để research tự đọc lại cả đống MD).

### Stage 1 — `user-research` (SKILL MỚI) ⭐ trọng tâm RFC này

Mô phỏng đúng việc team UX đã làm tay với VBSP (scrape 259 review + phân loại
+ nghiên cứu thị trường), nhưng chạy trong pipeline.

**Input:** `docs/_intake-summary.json` + run input tự do (tên app trên
store, link đối thủ, thị trường mục tiêu).

**3 việc, chạy trong 1 run:**

1. **Review mining (crawl tập khách hàng):**
   - Nguồn: Google Play / App Store của chính app (nếu cải tiến) và của
     2–4 đối thủ; forum/social nếu có (Tinhte, Reddit, group FB public...).
   - Công cụ: skill `agent-browser` (điều khiển browser thật, đọc DOM) +
     `od research search` (Tavily) cho nguồn tin gián tiếp. KHÔNG bịa review.
   - Việc AI làm: crawl → dedupe → **phân loại theo taxonomy cố định**
     (khen / báo lỗi / xả bực / feature request / hỏi-hỗ trợ / khác) → đếm
     tần suất → trích quote nguyên văn.
2. **Competitor scan:** với mỗi đối thủ, chụp/tả luồng chính, điểm mạnh-yếu
   theo cùng taxonomy; nguồn phải là URL thật.
3. **Market/context notes:** đặc thù tập người dùng (độ tuổi, kỹ năng số,
   thiết bị, mạng, ngôn ngữ) — mỗi ý kèm nguồn.

**Output (contract mới `UX_EVIDENCE`):** `research/evidence.json`

```jsonc
{
  "collected_at": "2026-07-09",
  "sources": [ { "id": "SRC-001", "type": "app_store_reviews|competitor|article|analytics|survey", "url": "...", "sampled": 259 } ],
  "evidence": [
    {
      "id": "EV-0001",
      "source_id": "SRC-001",
      "category": "bug_report",          // taxonomy cố định — enum, validator check
      "quote": "app chậm, treo, thoát đột ngột",  // nguyên văn, không paraphrase
      "frequency": 47,                    // số lượt xuất hiện trong mẫu
      "severity": "high|medium|low",
      "affects": ["login", "transfer"]    // slug màn/luồng nếu suy ra được
    }
  ],
  "summary_by_category": { "praise": 0.475, "bug_report": 0.181, "...": 0 }
}
```

kèm `research/competitors.md` (bảng so sánh, có URL) và
`research/market-notes.md`.

**Validator (③):** `skills/user-research/scripts/validate.py`
- mọi `evidence.source_id` tồn tại trong `sources`; mọi source có `url`;
- `category` thuộc enum; `frequency` là số; tối thiểu N evidence (mặc định 30)
  hoặc AI phải ghi rõ `"insufficient_data": true` + lý do (store không cho
  crawl, app chưa publish...) — cho phép degrade CÓ KHAI BÁO, không im lặng.

**Lưu ý pháp lý/kỹ thuật:** chỉ crawl trang public, tôn trọng rate-limit;
review store là dữ liệu công khai (team UX đã làm tay việc này). Nếu store
chặn, fallback = user upload CSV export (skill nhận cả 2 đường).

### Stage 1b — `heuristic-eval` (SKILL MỚI, chỉ workflow R2)

Đây chính là bước "VBSP Heuristic Evaluations" của designer, đưa vào pipeline.

**Input:** screenshot app hiện tại (user upload vào `as-is/screens/`) hoặc
link Figma (qua Figma MCP), + **rule pack chung** (§5).

**Việc AI làm:** với từng màn, đối chiếu từng rule trong rule pack →
ghi finding. KHÔNG được tự nghĩ rule ngoài pack; nếu thấy vấn đề không khớp
rule nào → ghi vào `unmatched_observations` để con người xét bổ sung rule.

**Output (contract mới `UX_FINDING`):** `research/findings.json`

```jsonc
{
  "findings": [
    {
      "id": "FND-001",
      "screen": "home",                      // slug màn as-is
      "rule_id": "UXHE-NIELSEN-STATUS",      // PHẢI tồn tại trong rule pack
      "severity": 3,                          // 0-4 theo thang Nielsen
      "observation": "màn xác nhận và OTP gộp chung",
      "evidence_ids": ["EV-0007"],            // optional: review user củng cố finding
      "recommendation": "tách màn xác nhận khỏi màn OTP",
      "phase": 1                              // 1=vị trí/thuật ngữ, 2=tương tác/luồng, 3=tính năng mới
    }
  ],
  "unmatched_observations": ["..."]
}
```

**Validator:** mọi `rule_id` resolve vào rule pack; mọi finding có `screen` +
`recommendation`; severity ∈ 0–4; mọi finding có `phase` (đây là cái tạo ra
roadmap 3 giai đoạn giống deliverable của designer).

### Stage 2 — `persona-synthesis` (SKILL MỚI, nhỏ)

**Input:** `research/evidence.json` + `docs/_intake-summary.json`.
**Output:** `research/personas.json` theo đúng field set `UX_PERSONA_PROFILE`
của KG vpn-design-platform (age_band, occupation, market, device_primary,
context_of_use, tech_savviness, error_tolerance...), **mỗi field non-obvious
phải kèm `evidence_ids`**.

```jsonc
{ "personas": [ { "id": "UPRF-001", "name": "...", "tech_savviness": "novice",
    "grounding": { "tech_savviness": ["EV-0003","EV-0011"] } } ] }
```

**Validator:** ≥1 persona; mỗi persona ≥2 evidence refs; field enum đúng schema.
→ Hết cảnh "persona chỉ cần name, LLM tự bịa".

### Stage 3 — `customer-journey` (skill có sẵn: `customer-journey-spec`, NÂNG contract)

Giữ skill, thêm 2 yêu cầu bắt buộc vào SKILL.md + validator:
- mỗi STAGE có `pain_points[]`, mỗi pain point có `evidence_ids` (từ stage 1)
  hoặc `finding_ids` (từ stage 1b với R2);
- journey gắn `persona_id` từ stage 2 (không tự tạo persona mới trong journey).

### Stage 4 — `ux-spec` (skill có sẵn, NÂNG contract) ⭐ chỗ "hết ảo"

Thêm vào SKILL.md quy trình bắt buộc (mirror thiết kế
`vpn-design-platform/docs/product/ux/new-algorithem/` tầng ①):

1. **ĐỌC rule pack trước khi sinh** (§5) — lọc rule có `applies_when` khớp
   persona/loại màn.
2. Mỗi screen/component có quyết định thiết kế đáng kể (layout, phân cấp nút,
   OTP tách/gộp, dropdown vs danh bạ...) phải ghi `justified_by: ["UXHE-..."]`.
3. Với R2: mỗi `finding` phase 1–2 của stage 1b phải được xử lý — screen spec
   ghi `addresses_findings: ["FND-001"]` hoặc khai báo `deferred` + lý do.
4. Cấm quyết lại điều journey/persona đã chốt (layout đã justified thì spec
   không được đổi ngầm).

**Validator (đây là gate quan trọng nhất — §Stage 5).**

### Stage 5 — `validate-gate` (SCRIPT, không phải LLM)

Một script duy nhất `skills/_shared/scripts/validate_ux_bundle.py` chạy toàn bộ
check chéo, là điều kiện để stage `ui` active:

- **Coverage:** mỗi journey STAGE có ≥1 screen serve nó; mỗi persona được ≥1
  journey dùng; (R2) mỗi finding phase 1–2 được addressed hoặc deferred-có-lý-do.
- **Trace:** mọi `justified_by`/`rule_id` resolve vào rule pack; mọi
  `evidence_ids` resolve vào evidence.json; không ID mồ côi.
- **Gate cứng từ rule pack:** rule `gate: true` (WCAG touch-target, contrast)
  check được trên spec (vd `min_touch_target >= 24`) → vi phạm = FAIL.
- Fail → in report `validate-report.md`, stage đánh `failed`, AI phải sửa
  và chạy lại. **Không có đường vòng.**

### Stage 6 — `ui` (skill có sẵn: `html-interactive-prototype` / `ui-react`)

Giữ nguyên (kèm `frontend-design`, `web-design-guidelines`, `taste-skill`).
Thêm 1 dòng bắt buộc vào prompt: input chính là ux-spec ĐÃ QUA GATE — cấm
thêm/bớt màn so với spec; muốn đổi phải quay lại stage 4.

### Stage 7 — `design-qa` (SKILL MỚI, nhỏ — khép vòng)

Chạy lại **chính rule pack heuristic** trên UI vừa sinh (screenshot các màn
prototype/react qua skill `screenshot`/`full-page-screenshot`) → `qa/report.json`
cùng format `UX_FINDING`. Findings severity ≥3 → stage `failed`, quay về stage 6.
Đây là bước thay cho việc designer hiện phải tự chạy Antigravity + Figma Console
MCP đánh nhãn (báo cáo của team ghi nhận "kết quả chưa đạt" — vì thiếu rule pack
chuẩn; giờ rule pack là một, sinh và chấm cùng một bộ).

---

## 4. Thay đổi code cụ thể (đề xuất)

### 4.1. `apps/daemon/src/pipelines.ts` — thêm 2 workflow

```ts
// ── Workflow R1: research → UI (sản phẩm mới) ──────────────────────────
{ id: 'r1-docs',      name: 'Docs → Markdown',        skillId: 'jira-ingest',           dependsOn: [],            outputs: ['docs/'] , inputPlaceholder: 'Confluence/JIRA hoặc upload BRD' },
{ id: 'r1-research',  name: 'User Research (crawl)',  skillId: 'user-research',         extraSkillIds: ['agent-browser'], dependsOn: ['r1-docs'],     outputs: ['research/evidence.json', 'research/competitors.md', 'research/market-notes.md'], inputPlaceholder: 'Tên app trên store / link đối thủ / thị trường' },
{ id: 'r1-persona',   name: 'Persona (evidence-based)', skillId: 'persona-synthesis',   dependsOn: ['r1-research'], outputs: ['research/personas.json'] },
{ id: 'r1-cj',        name: 'Customer Journey',       skillId: 'customer-journey-spec', dependsOn: ['r1-persona'],  outputs: ['-customer-journey.json', 'cj/'] },
{ id: 'r1-ux',        name: 'UX Spec (rule-driven)',  skillId: 'ux-spec',               dependsOn: ['r1-cj'],       outputs: ['-ux-spec.json', 'ux/'] },
{ id: 'r1-gate',      name: 'Validate Gate',          skillId: 'validate-ux-bundle',    dependsOn: ['r1-ux'],       outputs: ['validate-report.md'] },
{ id: 'r1-ui',        name: 'UI (React app)',         skillId: 'ui-react',              extraSkillIds: ['frontend-design','web-design-guidelines','taste-skill'], dependsOn: ['r1-gate'], outputs: ['react/'], acceptsDesignSystem: true },
{ id: 'r1-qa',        name: 'Design QA (heuristic)',  skillId: 'design-qa',             extraSkillIds: ['full-page-screenshot'], dependsOn: ['r1-ui'], outputs: ['qa/report.json'] },

// ── Workflow R2: improve-existing (thêm heuristic-eval as-is) ──────────
// r2-docs → r2-research → r2-heval → r2-persona → r2-cj → r2-ux → r2-gate → r2-ui → r2-qa
{ id: 'r2-heval',     name: 'Heuristic Eval (as-is)', skillId: 'heuristic-eval',        dependsOn: ['r2-research'], outputs: ['research/findings.json'], inputPlaceholder: 'Upload screenshot vào as-is/screens/ hoặc dán link Figma' },
```

```ts
export const WORKFLOWS = [
  ...,
  { id: 'research-to-ui',   name: 'Research → UI (mới)',        pipelineIds: ['r1-docs','r1-research','r1-persona','r1-cj','r1-ux','r1-gate','r1-ui','r1-qa'] },
  { id: 'improve-existing', name: 'Cải tiến chức năng hiện có', pipelineIds: ['r2-docs','r2-research','r2-heval','r2-persona','r2-cj','r2-ux','r2-gate','r2-ui','r2-qa'] },
];
```

### 4.2. Validator hook (thay đổi daemon nhỏ nhưng then chốt)

Thêm field vào `PipelineDef`:

```ts
/** Script (skill-relative) chạy sau run; exit != 0 → stage `failed` kèm report. */
validateScript?: string; // vd 'scripts/validate.py'
```

Daemon sau khi run xong + outputs xuất hiện → chạy script trong cwd workflow →
chỉ đánh `succeeded` khi exit 0. (Pattern giống `convertToGraph` converter
hiện có, nhưng là gate thay vì converter.)

### 4.3. Skill mới cần viết

| Skill | Cỡ | Lõi |
|---|---|---|
| `user-research` | vừa | prompt crawl + taxonomy + schema evidence; scripts/validate.py |
| `heuristic-eval` | vừa | prompt đối chiếu rule pack trên screenshot/Figma; schema findings |
| `persona-synthesis` | nhỏ | prompt tổng hợp persona từ evidence; schema |
| `validate-ux-bundle` | nhỏ | SKILL.md chỉ là wrapper gọi script (stage script-only) |
| `design-qa` | nhỏ | screenshot UI → chấm theo rule pack → findings |

### 4.4. `packages/contracts` — dọn + thêm

- Khôi phục source cho contract KG (hiện chỉ còn `dist/api/kg.d.ts` mồ côi,
  `push_to_kgs.py` tự claim "mirror TS validator" nhưng bản TS đã chết) —
  hoặc xoá hẳn dist chết và chốt **JSON Schema là source of truth duy nhất**
  đặt tại `skills/_shared/schemas/*.schema.json` (evidence / finding / persona /
  ux-spec / cj), validator python + TS đều load từ đó.
- Thêm type `UxEvidence`, `UxFinding`, `UxPersonaProfile` export từ contracts
  cho web UI hiển thị (SpecPreview có thể render bảng evidence/findings).

## 5. Rule pack chung — 1 nguồn duy nhất

`skills/_shared/heuristics.json` — đồng bộ (copy có ghi nguồn) từ KG
vpn-design-platform `deploy/local/seed-data/heuristics.json`, nâng cấp:

- Đủ **Nielsen 10** (hiện pack mới cover ~6/10) + WCAG 2.2.
- Chốt ngưỡng touch-target thống nhất toàn hệ: **gate = WCAG 2.5.8 AA 24px,
  khuyến nghị 44px** (doc VBSP đang ghi "≥32px theo WCAG 2.2" — 32px không
  phải giá trị WCAG; cần thống nhất lại với team UX).
- Format giữ nguyên: `id, name, group, gate, priority, applies_when, then,
  evidence[], improves_quality[], confidence`.
- Đây cũng chính là pack để team designer chạy auto heuristic-eval trên Figma
  (thay cho tiêu chuẩn ad-hoc trong PRD mà báo cáo AI ghi "kết quả chưa đạt").

Về lâu dài: pack sống trong KG (`UX_HEURISTIC` nodes), pipeline pull về file
lúc chạy — nhưng MVP dùng file JSON commit trong repo là đủ.

## 6. Mapping về KG vpn-design-platform (để 2 hệ không lệch nhau)

| File output pipeline | Node KG | Ghi chú |
|---|---|---|
| `research/evidence.json` | `UX_EVIDENCE` (promote từ demo sample vào schema chính) | edge `SUPPORTED_BY` |
| `research/findings.json` | `UX_FINDING` (node MỚI cần thêm schema) | edges `VIOLATES` → UX_HEURISTIC, `FOUND_ON` → screen |
| `research/personas.json` | `UX_PERSONA_PROFILE` | đã có, dùng đúng field set |
| `*-customer-journey.json` | `USER_FLOW` + `STAGE` | đã có |
| `*-ux-spec.json` | `S_SCREEN_SPEC` + `DP_UI_COMPONENT` + edge `JUSTIFIED_BY` | thêm edge justified_by |

(Việc push KG là bước sau — 2 workflow này trước mắt file-only như hiện trạng;
khi bật lại converter thì mapping trên là contract.)

## 7. Thứ tự triển khai đề xuất

1. **Rule pack chung** (§5) — 1 file JSON, unblock mọi thứ khác.
2. **Skill `user-research` + validator** — giá trị thấy ngay, demo được bằng
   chính case VBSP (crawl lại review Google Play so với 259 review tay).
3. **Validator hook trong daemon** (§4.2) + `validate-ux-bundle`.
4. Nâng contract `ux-spec`/`customer-journey-spec` (justified_by, evidence_ids).
5. Skill `heuristic-eval` + workflow `improve-existing`.
6. `persona-synthesis`, `design-qa`, wiring 2 workflow vào `WORKFLOWS`.

## 8. Rủi ro / câu hỏi mở

- **Crawl bị chặn:** Google Play web cần scroll JS (agent-browser xử được),
  App Store có RSS review công khai; fallback upload CSV luôn phải có.
- **Chi phí run:** stage research là run dài (crawl + phân loại). Cân nhắc
  giới hạn mẫu (mặc định 200–300 review, như designer làm 259).
- **Ai duyệt giữa chừng?** Quy trình chuẩn có điểm "trình đối tác/review nội
  bộ". Pipeline nên dừng tự nhiên ở gate (stage 5) để con người đọc
  `validate-report.md` + SpecPreview trước khi bấm chạy UI — không auto-run
  toàn chuỗi.
- **Đồng bộ rule pack 2 repo** (open-design-vnpay ↔ vpn-design-platform KG):
  MVP copy tay + ghi version; sau này pull từ KGS API.
