// ComponentAuditPreview — khung nhìn cho kết quả đối chiếu component THEO MÀN
// HÌNH mà bước `dr-comp` (workflow `docs-review`) ghi ra:
// `docs-review/comp/<page-slug>.components.json`.
//
// Vì sao cần một màn riêng: file đó là JSON lồng ba tầng (trang → màn hình →
// phần tử), nên mở bằng khung nhìn văn bản chung thì người đọc phải tự đếm dấu
// ngoặc để biết màn nào có bao nhiêu phần tử và phần tử nào ngoài danh mục —
// đúng công việc mà bước này sinh ra để khỏi phải làm. Và `comp/summary.md`
// KHÔNG thay được nó: summary gộp CẢ DỰ ÁN vào một bảng, còn việc thật của
// người review là đọc kết luận của MỘT trang ngay cạnh tài liệu của chính
// trang đó.
//
// Thứ tự hiển thị GIỮ NGUYÊN thứ tự trong file (tức thứ tự tài liệu). Không
// gom theo verdict: người đọc đang dò song song với tài liệu URD, đảo thứ tự
// là bắt họ tìm lại từ đầu cho mỗi dòng.
//
// Bộ lọc verdict dùng lại NGUYÊN ngôn ngữ thị giác của bộ lọc màu bên
// DocRedlinePreview (chip = ô chọn thật, ô màu kiêm chú thích, dấu tick nằm
// trong ô màu, dòng "Bấm để lọc:"). Hai màn cùng thuộc một bước review, nên
// một bộ lọc trông khác đi ở màn thứ hai chỉ làm người dùng phải học lại.
import { useEffect, useMemo, useState } from 'react';
import type { ProjectFile } from '../types';
import { fetchProjectFileText } from '../providers/registry';
import { Icon } from './Icon';
import styles from './ComponentAuditPreview.module.css';

/** Mirrors `ComponentVerdict` trong apps/daemon/src/docs-components.ts — web
 *  ĐỌC JSON daemon ghi ra, không import module của daemon (apps/web không được
 *  import apps/daemon/src/**). */
export type ComponentVerdict =
  | 'ok'
  | 'not-in-catalog'
  | 'variant-mismatch'
  | 'ambiguous'
  | 'internal';

/** Mirrors `ScreenElement` — cùng lý do như trên. */
export interface AuditElement {
  label: string;
  doc_type: string;
  component?: string;
  verdict: ComponentVerdict;
  rule_id?: string;
  note?: string;
}

/** Mirrors `ScreenInventory`. `images` được giữ trong shape để không phải parse
 *  lại khi màn hình có chỗ hiển thị ảnh mockup; hiện chưa render. */
export interface AuditScreen {
  id: string;
  name: string;
  anchor?: string;
  images?: string[];
  elements: AuditElement[];
}

/** Mirrors `PageComponentReport`. */
export interface AuditReport {
  page?: string;
  doc_path?: string;
  screens: AuditScreen[];
}

/** Nhãn tiếng Việt của từng verdict. Ngắn hơn nhãn trong `comp/summary.md` vì ở
 *  đây nó nằm trong một ô bảng chứ không phải một dòng văn xuôi. */
const VERDICT_LABEL: Record<ComponentVerdict, string> = {
  ok: 'Đạt',
  'not-in-catalog': 'Ngoài danh mục',
  'variant-mismatch': 'Sai biến thể',
  ambiguous: 'Chưa rõ',
  internal: 'Nội bộ',
};

/** Thứ tự đọc của bộ lọc: đạt trước, rồi các mức "cần xem lại" từ nặng tới
 *  nhẹ, cuối cùng là mảnh dựng nội bộ. `styles.*` có kiểu `string | undefined`
 *  (index signature của CSS Modules dưới `noUncheckedIndexedAccess`) dù lớp
 *  luôn tồn tại lúc chạy — `?? ''` chỉ để thu hẹp kiểu. */
const VERDICT_ITEMS: ReadonlyArray<{ verdict: ComponentVerdict; label: string; swatch: string }> = [
  { verdict: 'ok', label: VERDICT_LABEL.ok, swatch: styles.swatchOk ?? '' },
  { verdict: 'not-in-catalog', label: VERDICT_LABEL['not-in-catalog'], swatch: styles.swatchNotInCatalog ?? '' },
  { verdict: 'variant-mismatch', label: VERDICT_LABEL['variant-mismatch'], swatch: styles.swatchVariantMismatch ?? '' },
  { verdict: 'ambiguous', label: VERDICT_LABEL.ambiguous, swatch: styles.swatchAmbiguous ?? '' },
  { verdict: 'internal', label: VERDICT_LABEL.internal, swatch: styles.swatchInternal ?? '' },
];

/** Lớp chip kết luận trong bảng — cùng họ màu với ô màu của bộ lọc để hai chỗ
 *  nói về cùng một thứ trông giống nhau. */
const VERDICT_CHIP_CLASS: Record<ComponentVerdict, string> = {
  ok: styles.verdictOk ?? '',
  'not-in-catalog': styles.verdictNotInCatalog ?? '',
  'variant-mismatch': styles.verdictVariantMismatch ?? '',
  ambiguous: styles.verdictAmbiguous ?? '',
  internal: styles.verdictInternal ?? '',
};

const VERDICT_SET = new Set<string>(Object.keys(VERDICT_LABEL));

export type VerdictFlags = Record<ComponentVerdict, boolean>;
/** Mặc định hiện HẾT: màn hình này tồn tại để đọc toàn bộ kết luận của một
 *  trang, lọc là việc người dùng chủ động làm sau đó. */
const ALL_SHOWN: VerdictFlags = {
  ok: true,
  'not-in-catalog': true,
  'variant-mismatch': true,
  ambiguous: true,
  internal: true,
};

/** File có tên `<gì đó>/comp/<gì đó>.components.json` — dùng để route trong
 *  FileViewer. Yêu cầu cả thư mục `comp/` chứ không chỉ đuôi file: đuôi
 *  `.components.json` là quy ước đủ chung để một dự án dùng nó cho thứ khác.
 *
 *  CHỈ xét tên, không xét `file.kind`: `kindFor` bên daemon
 *  (apps/daemon/src/projects.ts) xếp mọi `.json` vào bucket `'code'`, nên một
 *  điều kiện `kind === 'text'` gắn ở đây sẽ không bao giờ đúng và nhánh route
 *  thành mã chết. Việc lọc theo kind để ở phía FileViewer, cạnh các nhánh
 *  khác cùng làm vậy. */
export function isComponentAuditFile(file: ProjectFile): boolean {
  return /\/comp\/.+\.components\.json$/i.test(file.name);
}

/** Parse một file `*.components.json`.
 *
 *  Khoan dung y như `parseDocChanges` bên DocRedlinePreview: một màn hoặc một
 *  phần tử hỏng bị BỎ QUA chứ không đánh hỏng cả khung nhìn — file do LLM sinh
 *  nên thiếu một `label` là chuyện thường, mà mấy chục dòng còn lại vẫn là kết
 *  quả đáng đọc. Trả null CHỈ khi file nói chung không dùng được: không phải
 *  JSON, không phải object, hoặc không có `screens` là mảng — lúc đó không còn
 *  gì để dựng và nói thẳng "không đọc được" mới đúng.
 *
 *  Phần tử có `verdict` lạ cũng bị bỏ: verdict là thứ quyết định màu và bộ lọc,
 *  nên hiển thị một kết luận không có trong bảng nghĩa là bịa ra một kết luận. */
export function parseComponentAudit(raw: string): AuditReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.screens)) return null;

  const screens: AuditScreen[] = [];
  for (const item of root.screens) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    // Không có cả mã lẫn tên thì tiêu đề khối rỗng — một khối không nói được
    // nó là màn nào thì không giúp được ai.
    if (!id && !name) continue;

    const elements: AuditElement[] = [];
    for (const rawEl of Array.isArray(s.elements) ? s.elements : []) {
      if (!rawEl || typeof rawEl !== 'object') continue;
      const e = rawEl as Record<string, unknown>;
      const label = typeof e.label === 'string' ? e.label.trim() : '';
      if (!label) continue;
      if (typeof e.verdict !== 'string' || !VERDICT_SET.has(e.verdict)) continue;
      elements.push({
        label,
        doc_type: typeof e.doc_type === 'string' ? e.doc_type.trim() : '',
        component: typeof e.component === 'string' && e.component.trim() ? e.component.trim() : undefined,
        verdict: e.verdict as ComponentVerdict,
        rule_id: typeof e.rule_id === 'string' && e.rule_id.trim() ? e.rule_id.trim() : undefined,
        note: typeof e.note === 'string' && e.note.trim() ? e.note.trim() : undefined,
      });
    }

    screens.push({
      id,
      name,
      anchor: typeof s.anchor === 'string' && s.anchor.trim() ? s.anchor.trim() : undefined,
      images: Array.isArray(s.images)
        ? s.images.filter((img): img is string => typeof img === 'string' && !!img.trim())
        : undefined,
      elements,
    });
  }

  return {
    page: typeof root.page === 'string' && root.page.trim() ? root.page.trim() : undefined,
    doc_path: typeof root.doc_path === 'string' && root.doc_path.trim() ? root.doc_path.trim() : undefined,
    screens,
  };
}

/** "Cần xem lại" = mọi verdict KHÁC 'ok', kể cả 'internal'. Giữ đúng định nghĩa
 *  của `mergeComponentReports` phía daemon: hai chỗ đếm cùng một con số thì
 *  không được đếm theo hai cách, nếu không summary và màn này sẽ cãi nhau. */
function needsReview(el: AuditElement): boolean {
  return el.verdict !== 'ok';
}

export function ComponentAuditPreview({ projectId, file }: { projectId: string; file: ProjectFile }) {
  const [raw, setRaw] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [shown, setShown] = useState<VerdictFlags>(ALL_SHOWN);
  const setVerdictShown = (verdict: ComponentVerdict, on: boolean) =>
    setShown((prev) => ({ ...prev, [verdict]: on }));

  useEffect(() => {
    let cancelled = false;
    setRaw(null);
    setMissing(false);
    void fetchProjectFileText(projectId, file.name).then((text) => {
      if (cancelled) return;
      if (text == null) setMissing(true);
      else setRaw(text);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime]);

  const report = useMemo(() => (raw == null ? null : parseComponentAudit(raw)), [raw]);

  // Số đếm lấy trên TOÀN BỘ trang, không theo bộ lọc: thanh tóm tắt trả lời
  // "trang này có gì", còn bộ lọc chỉ chọn xem phần nào — nếu con số tụt theo
  // bộ lọc thì người dùng tắt một chip là tưởng phần tử biến mất khỏi file.
  const counts = useMemo(() => {
    const perVerdict: Record<ComponentVerdict, number> = {
      ok: 0,
      'not-in-catalog': 0,
      'variant-mismatch': 0,
      ambiguous: 0,
      internal: 0,
    };
    let elements = 0;
    let issues = 0;
    for (const screen of report?.screens ?? []) {
      for (const el of screen.elements) {
        elements += 1;
        perVerdict[el.verdict] += 1;
        if (needsReview(el)) issues += 1;
      }
    }
    return { screens: report?.screens.length ?? 0, elements, issues, perVerdict };
  }, [report]);

  // Màn không còn phần tử nào sau khi lọc bị ẩn CẢ KHỐI — một danh sách toàn
  // tiêu đề rỗng làm người đọc phải cuộn qua những màn không liên quan để tìm
  // màn có vấn đề, tức là bộ lọc không lọc được gì.
  const visibleScreens = useMemo(() => {
    return (report?.screens ?? [])
      .map((screen) => ({ screen, elements: screen.elements.filter((el) => shown[el.verdict]) }))
      .filter((entry) => entry.elements.length > 0);
  }, [report, shown]);

  if (missing) {
    return (
      <div className="viewer">
        <div className={`viewer-body ${styles.message}`}>Không đọc được file đối chiếu component.</div>
      </div>
    );
  }
  if (raw == null) {
    return (
      <div className="viewer">
        <div className={`viewer-body ${styles.message}`}>Đang tải…</div>
      </div>
    );
  }
  if (!report) {
    // Không crash: file hỏng vẫn là kết quả của một lượt chạy, nên nói rõ hỏng
    // ở đâu để người dùng biết phải chạy lại bước nào.
    return (
      <div className="viewer">
        <div className={`viewer-body ${styles.message} ${styles.error}`}>
          Không đọc được kết quả đối chiếu: <code>{file.name}</code> không phải JSON hợp lệ hoặc không có
          danh sách <code>screens</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="viewer">
      <div className={`viewer-body ${styles.viewerBody}`}>
        <div className={styles.wrap}>
          <div className={styles.strip}>
            <span className={styles.tally}>
              {counts.screens} màn hình · {counts.elements} phần tử · {counts.issues} cần xem lại
            </span>
            <VerdictFilters shown={shown} onChange={setVerdictShown} counts={counts.perVerdict} />
          </div>
          {report.page || report.doc_path ? (
            <div className={styles.pageLine}>
              <Icon name="file" size={12} />
              <span className={styles.pageName}>{report.page ?? report.doc_path}</span>
              {report.page && report.doc_path ? <code className={styles.docPath}>{report.doc_path}</code> : null}
            </div>
          ) : null}

          <div className={styles.body}>
            {counts.screens === 0 ? (
              <p className={styles.empty}>Không có màn hình nào trong trang này.</p>
            ) : visibleScreens.length === 0 ? (
              <p className={styles.empty}>Không còn phần tử nào khớp bộ lọc đang bật.</p>
            ) : (
              visibleScreens.map(({ screen, elements }, i) => (
                <section
                  key={`${screen.id || screen.name}#${i}`}
                  className={styles.screen}
                  data-screen-id={screen.id || screen.name}
                >
                  <h3 className={styles.screenHead}>
                    {screen.id ? <span className={styles.screenId}>{screen.id}</span> : null}
                    {screen.id && screen.name ? <span className={styles.screenSep}>·</span> : null}
                    {screen.name ? <span className={styles.screenName}>{screen.name}</span> : null}
                    <span className={styles.screenCount}>{elements.length} phần tử</span>
                  </h3>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Tên trường</th>
                        <th>Tài liệu khai</th>
                        <th>Component</th>
                        <th>Kết luận</th>
                      </tr>
                    </thead>
                    <tbody>
                      {elements.map((el, j) => (
                        // Fragment theo chỉ số vì `label` có thể trùng trong
                        // cùng một màn (hai nút "Xoá" ở hai vùng khác nhau).
                        <ElementRows key={`${el.label}#${j}`} element={el} />
                      ))}
                    </tbody>
                  </table>
                </section>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Một phần tử = một dòng, cộng MỘT dòng note thụt vào ngay dưới khi có.
 *
 *  Note nằm ở dòng riêng chứ không nhét vào ô "Kết luận": nó là một câu văn
 *  ("Danh mục không có 'Icon menu'; gần nhất là Popover"), nhét vào ô thứ tư sẽ
 *  kéo cột đó rộng ra và làm ba cột kia bị bó lại ở mọi dòng — kể cả những dòng
 *  không có note. */
function ElementRows({ element }: { element: AuditElement }) {
  const chipClass = VERDICT_CHIP_CLASS[element.verdict];
  return (
    <>
      <tr className={styles.row} data-verdict={element.verdict}>
        <td className={styles.cellLabel}>{element.label}</td>
        <td className={styles.cellDocType}>{element.doc_type || '—'}</td>
        <td className={styles.cellComponent}>
          {element.component ? (
            <>
              <span>{element.component}</span>
              {element.rule_id ? <code className={styles.ruleId}>{element.rule_id}</code> : null}
            </>
          ) : (
            '—'
          )}
        </td>
        <td className={styles.cellVerdict}>
          <span className={`${styles.verdict} ${chipClass}`}>{VERDICT_LABEL[element.verdict]}</span>
        </td>
      </tr>
      {element.note ? (
        <tr className={styles.noteRow} data-note-for={element.label}>
          <td className={styles.noteCell} colSpan={4}>
            <span className={styles.note}>{element.note}</span>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Bộ lọc verdict — CHÍNH LÀ chú thích màu, đúng cách gộp của `HighlightFilters`
 *  bên DocRedlinePreview: chú thích ("chip đỏ nghĩa là ngoài danh mục") và bộ
 *  lọc ("ẩn mấy dòng đạt đi") nói về cùng năm thứ, tách ra thì màn hình liệt kê
 *  cùng một danh sách hai lần và người dùng phải tự ghép chúng với nhau.
 *
 *  Ô tick nằm TRONG ô màu để chip đọc ra ngay là checkbox; dòng "Bấm để lọc:"
 *  là thứ duy nhất nói cho người dùng biết hàng chip này bấm được. */
function VerdictFilters({
  shown,
  onChange,
  counts,
}: {
  shown: VerdictFlags;
  onChange: (verdict: ComponentVerdict, next: boolean) => void;
  counts?: Partial<Record<ComponentVerdict, number>>;
}) {
  return (
    <div className={styles.filters} role="group" aria-label="Lọc theo kết luận">
      <span className={styles.filtersHint}>Bấm để lọc:</span>
      {VERDICT_ITEMS.map(({ verdict, label, swatch }) => {
        const on = shown[verdict];
        const n = counts?.[verdict];
        return (
          <label
            key={verdict}
            className={`${styles.chip} ${on ? '' : styles.chipOff ?? ''}`}
            title={on ? `Ẩn phần tử "${label}"` : `Hiện phần tử "${label}"`}
          >
            <input
              type="checkbox"
              className={styles.chipInput}
              checked={on}
              onChange={(ev) => onChange(verdict, ev.target.checked)}
            />
            <span className={`${styles.chipSwatch} ${swatch}`}>
              <span className={styles.chipCheck} aria-hidden="true">
                ✓
              </span>
            </span>
            {label}
            {typeof n === 'number' ? <span className={styles.chipCount}>{n}</span> : null}
          </label>
        );
      })}
    </div>
  );
}
