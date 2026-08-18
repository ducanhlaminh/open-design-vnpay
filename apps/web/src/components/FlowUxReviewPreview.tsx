// Khung nhìn "Đánh giá luồng UX" (bước dr-flow bản mới của docs-review) cho
// các file dưới `flows/<FLOW-ID>/`: sơ đồ GỐC render bằng đúng viewer của
// draw.io (hoặc Mermaid), chuyển qua lại "Hiện trạng" ↔ "Đề xuất" (phần sửa đã
// được daemon tô màu theo chú giải cố định), và panel lý do UX bên phải —
// bấm một finding thì cell liên quan sáng lên trên sơ đồ, bấm một cell thì
// finding tương ứng được chọn.
//
// Dữ liệu (đều là output của daemon `finalizeFlowUx`, KHÔNG phải của LLM
// trực tiếp): `ux-review.json` (đã chuẩn hoá), `proposed.drawio` (2 trang:
// Hiện trạng | Đề xuất) hoặc `as-is.drawio`, `as-is.mmd` / `proposed.mmd` /
// `as-is.svg` cho Mermaid, và `flows/index.json` cho tiêu đề + patchSkipped.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ProjectFile } from '../types';

import { fetchProjectFileText } from '../providers/registry';
import { DrawioViewer } from './DrawioViewer';
import { MermaidDiagram } from './MermaidDiagram';
import styles from './FlowUxReviewPreview.module.css';

export type UxSeverity = 'blocker' | 'major' | 'minor' | 'note';
export type UxVerdict = 'good' | 'needs-improvement' | 'poor';
export type UxChange = 'added' | 'modified' | 'removed' | 'none';

export interface UxFinding {
  id: string;
  severity: UxSeverity;
  heuristic?: string;
  title: string;
  reason: string;
  recommendation?: string;
  evidence?: string[];
  cells?: { asIs?: string[]; proposed?: string[] };
  change?: UxChange;
  conflictsWith?: string;
}
export interface UxReview {
  flowId: string;
  verdict: UxVerdict;
  summary: string;
  findings: UxFinding[];
}

interface IndexEntry {
  id: string;
  title?: string;
  source?: string;
  kind?: 'drawio' | 'mermaid' | 'text';
  note?: string;
  hasProposal?: boolean;
  files?: { asIs?: string; proposed?: string; review?: string; flowchart?: string; svg?: string };
  patchSkipped?: { op: { op?: string; cell?: string; id?: string; edge?: string }; reason: string }[];
}

const SEVERITY_ORDER: UxSeverity[] = ['blocker', 'major', 'minor', 'note'];
const SEVERITY_LABEL: Record<UxSeverity, string> = { blocker: 'Chặn', major: 'Nặng', minor: 'Nhẹ', note: 'Ghi chú' };
const VERDICT_LABEL: Record<UxVerdict, string> = { good: 'Luồng tốt', 'needs-improvement': 'Cần cải thiện', poor: 'Chưa đạt' };
const CHANGE_LABEL: Record<Exclude<UxChange, 'none'>, string> = { added: 'Thêm mới', modified: 'Sửa đổi', removed: 'Đề nghị bỏ' };

const FLOW_FILE_RE = /^(.*?)flows\/([^/]+)\/(ux-review\.json|proposed\.drawio|as-is\.drawio|proposed\.mmd|as-is\.mmd|as-is\.svg|patch\.json|screens\.json|cells\.json)$/i;
/** `flows/<FLOW-ID>.flowchart.json` — the derived block diagram; opens the same
 *  view when the new-format folder exists, else the caller's `fallback`. */
const FLOWCHART_FILE_RE = /^(.*?)flows\/([^/]+)\.flowchart\.json$/i;

/** File thuộc `flows/<FLOW-ID>/…` (artefact của bước Đánh giá luồng UX). */
export function isFlowUxFile(file: Pick<ProjectFile, 'name'>): boolean {
  return FLOW_FILE_RE.test(file.name) || FLOWCHART_FILE_RE.test(file.name);
}

/** `flows/<id>/x.json` → `{ dir: '<prefix>flows/<id>/', flowsDir: '<prefix>flows/', flowId }`. */
export function flowUxLocationOf(fileName: string): { dir: string; flowsDir: string; flowId: string } | null {
  const m = FLOW_FILE_RE.exec(fileName) ?? FLOWCHART_FILE_RE.exec(fileName);
  if (!m) return null;
  return { dir: `${m[1]}flows/${m[2]}/`, flowsDir: `${m[1]}flows/`, flowId: m[2]! };
}

/** Đọc `ux-review.json` khoan dung: finding hỏng bị bỏ, không làm sập khung. */
export function parseUxReview(raw: string, flowId: string): UxReview | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const findings: UxFinding[] = [];
  const list = Array.isArray(o.findings) ? o.findings : [];
  list.forEach((f, i) => {
    if (!f || typeof f !== 'object') return;
    const x = f as Record<string, unknown>;
    const title = typeof x.title === 'string' ? x.title : '';
    const reason = typeof x.reason === 'string' ? x.reason : '';
    if (!title && !reason) return;
    const strList = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined);
    const cellsRaw = x.cells && typeof x.cells === 'object' ? (x.cells as Record<string, unknown>) : {};
    const asIs = strList(cellsRaw.asIs);
    const proposed = strList(cellsRaw.proposed);
    const finding: UxFinding = {
      id: typeof x.id === 'string' && x.id ? x.id : `UX-${String(i + 1).padStart(2, '0')}`,
      severity: SEVERITY_ORDER.includes(x.severity as UxSeverity) ? (x.severity as UxSeverity) : 'minor',
      title: title || reason.slice(0, 80),
      reason,
    };
    if (typeof x.heuristic === 'string') finding.heuristic = x.heuristic;
    if (typeof x.recommendation === 'string') finding.recommendation = x.recommendation;
    const ev = strList(x.evidence);
    if (ev?.length) finding.evidence = ev;
    if (asIs?.length || proposed?.length) finding.cells = { ...(asIs?.length ? { asIs } : {}), ...(proposed?.length ? { proposed } : {}) };
    if (typeof x.change === 'string' && ['added', 'modified', 'removed', 'none'].includes(x.change)) finding.change = x.change as UxChange;
    if (typeof x.conflictsWith === 'string') finding.conflictsWith = x.conflictsWith;
    findings.push(finding);
  });
  const verdict = (['good', 'needs-improvement', 'poor'] as UxVerdict[]).includes(o.verdict as UxVerdict)
    ? (o.verdict as UxVerdict)
    : findings.some((f) => f.severity === 'blocker')
      ? 'poor'
      : findings.length
        ? 'needs-improvement'
        : 'good';
  return {
    flowId: typeof o.flowId === 'string' && o.flowId ? o.flowId : flowId,
    verdict,
    summary: typeof o.summary === 'string' ? o.summary : '',
    findings,
  };
}

function parseIndexEntry(raw: string | null, flowId: string): IndexEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { flows?: unknown }).flows) ? ((parsed as { flows: unknown[] }).flows) : [];
    const hit = list.find((e) => e && typeof e === 'object' && (e as { id?: unknown }).id === flowId);
    return (hit as IndexEntry | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Số trang trong một mxfile (`<diagram …>` đếm được). */
export function drawioPageCount(xml: string): number {
  return (xml.match(/<diagram\b/gi) ?? []).length || 1;
}

type ViewMode = 'as-is' | 'proposed' | 'svg';

interface LoadedFlow {
  review: UxReview | null;
  index: IndexEntry | null;
  drawioXml: string | null; // proposed.drawio (2 trang) hoặc as-is.drawio (1 trang)
  drawioHasProposal: boolean;
  mermaidAsIs: string | null;
  mermaidProposed: string | null;
  svg: string | null;
}

export function FlowUxReviewPreview({
  projectId,
  file,
  fallback,
}: {
  projectId: string;
  file: ProjectFile;
  /** Rendered instead when the flow has no new-format data (legacy dr-flow run)
   *  and, for text-only flows, inside the diagram pane (there is no source
   *  diagram to show — the derived block diagram is the best view). */
  fallback?: ReactNode;
}) {
  const loc = useMemo(() => flowUxLocationOf(file.name), [file.name]);
  const [data, setData] = useState<LoadedFlow | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<ViewMode>('as-is');
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!loc) return;
    let cancelled = false;
    setData(null);
    setFailed(false);
    setActiveId(null);
    const get = (rel: string) => fetchProjectFileText(projectId, rel);
    void (async () => {
      const [reviewRaw, indexRaw, proposedDrawio, asIsDrawio, mmdAsIs, mmdProposed, svg] = await Promise.all([
        get(`${loc.dir}ux-review.json`),
        get(`${loc.flowsDir}index.json`),
        get(`${loc.dir}proposed.drawio`),
        get(`${loc.dir}as-is.drawio`),
        get(`${loc.dir}as-is.mmd`),
        get(`${loc.dir}proposed.mmd`),
        get(`${loc.dir}as-is.svg`),
      ]);
      if (cancelled) return;
      const review = reviewRaw ? parseUxReview(reviewRaw, loc.flowId) : null;
      const drawioXml = proposedDrawio ?? asIsDrawio;
      if (!review && !drawioXml && !mmdAsIs) {
        setFailed(true);
        return;
      }
      const loaded: LoadedFlow = {
        review,
        index: parseIndexEntry(indexRaw, loc.flowId),
        drawioXml,
        drawioHasProposal: !!proposedDrawio && drawioPageCount(proposedDrawio) >= 2,
        mermaidAsIs: mmdAsIs,
        mermaidProposed: mmdProposed,
        svg,
      };
      setData(loaded);
      // Mặc định mở "Đề xuất" khi có — đó là thứ người review cần xem trước.
      setMode(loaded.drawioHasProposal || loaded.mermaidProposed ? 'proposed' : 'as-is');
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, loc, file.mtime]);

  const findings = data?.review?.findings ?? [];
  const active = useMemo(() => findings.find((f) => f.id === activeId) ?? null, [findings, activeId]);
  const highlightCells = useMemo(() => {
    if (!active?.cells) return [] as string[];
    return mode === 'proposed' ? [...(active.cells.proposed ?? active.cells.asIs ?? [])] : [...(active.cells.asIs ?? [])];
  }, [active, mode]);
  const cellToFinding = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of findings) {
      for (const id of f.cells?.asIs ?? []) if (!map.has(`as-is:${id}`)) map.set(`as-is:${id}`, f.id);
      for (const id of f.cells?.proposed ?? []) if (!map.has(`proposed:${id}`)) map.set(`proposed:${id}`, f.id);
    }
    return map;
  }, [findings]);

  if (!loc) return <div className={styles.message}>File không thuộc thư mục flows/&lt;FLOW-ID&gt;/.</div>;
  if (failed) {
    if (fallback) return <>{fallback}</>;
    return <div className={styles.message}>Chưa có dữ liệu đánh giá cho luồng <code>{loc.flowId}</code> — chạy bước "Đánh giá luồng UX".</div>;
  }
  if (!data) return <div className={styles.message}>Đang tải…</div>;

  const title = data.index?.title ?? loc.flowId;
  const kind: IndexEntry['kind'] = data.index?.kind ?? (data.drawioXml ? 'drawio' : data.mermaidAsIs ? 'mermaid' : 'text');
  const hasProposal = kind === 'drawio' ? data.drawioHasProposal : kind === 'mermaid' ? !!data.mermaidProposed : false;
  const counts = SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);

  const onCellClick = (cellId: string | null) => {
    if (!cellId) return;
    const hit = cellToFinding.get(`${mode === 'proposed' ? 'proposed' : 'as-is'}:${cellId}`) ?? cellToFinding.get(`as-is:${cellId}`) ?? cellToFinding.get(`proposed:${cellId}`);
    if (hit) setActiveId(hit);
  };

  return (
    <div className={styles.root}>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <h2 className={styles.title}>{title}</h2>
          {data.review ? (
            <span className={`${styles.verdict} ${styles[`verdict_${data.review.verdict.replace('-', '_')}`] ?? ''}`} data-testid="verdict">
              {VERDICT_LABEL[data.review.verdict]}
            </span>
          ) : null}
          {counts.map(([s, n]) => (
            <span key={s} className={`${styles.count} ${styles[`sev_${s}`]}`}>
              {n} {SEVERITY_LABEL[s].toLowerCase()}
            </span>
          ))}
        </div>
        {data.index?.source ? (
          <div className={styles.source}>
            Nguồn: <code>{data.index.source}</code>
          </div>
        ) : null}
        {data.review?.summary ? <p className={styles.summary}>{data.review.summary}</p> : null}
      </header>

      <div className={styles.body}>
        <section className={styles.diagram} aria-label="Sơ đồ luồng">
          <div className={styles.diagramBar}>
            <div className={styles.modeBar} role="tablist" aria-label="Chế độ xem sơ đồ">
              <button type="button" role="tab" aria-selected={mode === 'as-is'} className={`${styles.modeBtn} ${mode === 'as-is' ? styles.modeBtnActive : ''}`} onClick={() => setMode('as-is')}>
                Hiện trạng
              </button>
              {hasProposal ? (
                <button type="button" role="tab" aria-selected={mode === 'proposed'} className={`${styles.modeBtn} ${mode === 'proposed' ? styles.modeBtnActive : ''}`} onClick={() => setMode('proposed')}>
                  Đề xuất
                </button>
              ) : null}
              {kind === 'mermaid' && data.svg ? (
                <button type="button" role="tab" aria-selected={mode === 'svg'} className={`${styles.modeBtn} ${mode === 'svg' ? styles.modeBtnActive : ''}`} onClick={() => setMode('svg')}>
                  Ảnh gốc
                </button>
              ) : null}
            </div>
            {hasProposal ? (
              <div className={styles.legend} aria-label="Chú giải màu đề xuất">
                <span className={`${styles.legendItem} ${styles.legend_added}`}>Thêm mới</span>
                <span className={`${styles.legendItem} ${styles.legend_modified}`}>Sửa đổi</span>
                <span className={`${styles.legendItem} ${styles.legend_removed}`}>Đề nghị bỏ</span>
              </div>
            ) : null}
            {kind === 'drawio' && data.drawioXml ? (
              <a
                className={styles.download}
                href={`data:application/xml;charset=utf-8,${encodeURIComponent(data.drawioXml)}`}
                download={`${loc.flowId}${hasProposal ? '.proposed' : ''}.drawio`}
              >
                Tải .drawio
              </a>
            ) : null}
          </div>
          <div className={styles.diagramBox}>
            {kind === 'drawio' && data.drawioXml ? (
              <DrawioViewer
                className={styles.drawio}
                xml={data.drawioXml}
                page={mode === 'proposed' && data.drawioHasProposal ? 1 : 0}
                highlightCells={highlightCells}
                onCellClick={onCellClick}
              />
            ) : null}
            {kind === 'mermaid' ? (
              // Vừa chiều RỘNG rồi đọc từ trên xuống (không co cả sơ đồ vào
              // khung thành ảnh tí hon); cuộn/kéo/zoom như viewer draw.io.
              mode === 'svg' && data.svg ? (
                <MermaidDiagram code="" svg={data.svg} initialFit="width" />
              ) : (
                <MermaidDiagram code={(mode === 'proposed' ? data.mermaidProposed : null) ?? data.mermaidAsIs ?? ''} initialFit="width" />
              )
            ) : null}
            {kind === 'text' && fallback ? <div className={styles.fallbackBox}>{fallback}</div> : null}
            {kind === 'text' && !fallback ? (
              <div className={styles.message}>
                Tài liệu không có sơ đồ nguồn — luồng được dựng từ chữ. Mở <code>{loc.flowsDir}{loc.flowId}.flowchart.json</code> để xem sơ đồ.
              </div>
            ) : null}
          </div>
          {data.index?.patchSkipped?.length ? (
            <div className={styles.warn}>
              {data.index.patchSkipped.length} thao tác đề xuất không áp được lên sơ đồ:{' '}
              {data.index.patchSkipped.map((s, i) => (
                <span key={i}>
                  <code>{s.op?.op ?? '?'}</code> {s.op?.cell ?? s.op?.edge ?? s.op?.id ?? ''} — {s.reason}
                  {i < data.index!.patchSkipped!.length - 1 ? '; ' : ''}
                </span>
              ))}
            </div>
          ) : null}
        </section>

        <aside className={styles.panel} aria-label="Lý do UX">
          <div className={styles.panelHead}>
            <span>Phát hiện UX</span>
            <span className={styles.panelMeta}>{findings.length}</span>
          </div>
          {!data.review ? (
            <div className={styles.message}>Chưa có ux-review.json cho luồng này.</div>
          ) : findings.length === 0 ? (
            <div className={styles.okBox}>Không có phát hiện nào — luồng đạt checklist. {data.review.summary ? '' : 'Bước đánh giá không ghi thêm nhận xét.'}</div>
          ) : (
            <ol className={styles.list}>
              {SEVERITY_ORDER.flatMap((sev) => findings.filter((f) => f.severity === sev)).map((f) => {
                const isActive = f.id === activeId;
                return (
                  <li key={f.id}>
                    <button
                      type="button"
                      className={`${styles.card} ${isActive ? styles.cardActive : ''}`}
                      aria-pressed={isActive}
                      onClick={() => setActiveId(isActive ? null : f.id)}
                      data-testid={`finding-${f.id}`}
                    >
                      <div className={styles.cardTop}>
                        <span className={`${styles.sev} ${styles[`sev_${f.severity}`]}`}>{SEVERITY_LABEL[f.severity]}</span>
                        <span className={styles.fid}>{f.id}</span>
                        {f.change && f.change !== 'none' ? <span className={`${styles.change} ${styles[`legend_${f.change}`]}`}>{CHANGE_LABEL[f.change]}</span> : null}
                      </div>
                      <div className={styles.cardTitle}>{f.title}</div>
                      {f.heuristic ? <div className={styles.heuristic}>{f.heuristic}</div> : null}
                      <p className={styles.reason}>{f.reason}</p>
                      {f.recommendation ? (
                        <p className={styles.reco}>
                          <strong>Đề xuất:</strong> {f.recommendation}
                        </p>
                      ) : null}
                      {f.conflictsWith ? <p className={styles.conflict}>Không đề xuất sửa vì vướng {f.conflictsWith}.</p> : null}
                      {f.evidence?.length ? (
                        <ul className={styles.evidence}>
                          {f.evidence.map((e, i) => (
                            <li key={i}>
                              <code>{e}</code>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {f.cells?.asIs?.length || f.cells?.proposed?.length ? (
                        <div className={styles.cells}>
                          {(mode === 'proposed' ? f.cells.proposed ?? f.cells.asIs ?? [] : f.cells.asIs ?? []).map((c) => (
                            <span key={c} className={styles.cellChip}>
                              {c}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {data.index?.note ? <div className={styles.note}>Ghi chú: {data.index.note}</div> : null}
        </aside>
      </div>
    </div>
  );
}
