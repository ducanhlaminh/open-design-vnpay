import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PipelinePulseRating, PipelineView } from '@open-design/contracts';
import { Icon } from '../Icon';
import styles from './PipelineEvaluationStep.module.css';

type Answers = Record<string, string | string[]>;

// ── Form theo TỪNG workflow ──────────────────────────────────────────────────
// Mỗi workflow có bộ bước (id trùng pipeline.id để A5 auto-tick đúng) và bộ
// PHẦN câu hỏi riêng: A/B/F/G/H dùng chung; docs-to-ui thêm C (Đầu ra UX),
// D (Figma), E (Thiết kế AI); docs-to-prd không sinh UI/Figma nên thay bằng
// duy nhất CR (Đầu ra Review). Workflow mới chưa khai báo ở đây rơi về form
// docs-to-ui (đủ dùng hơn là không có form).
type SectionId = 'A' | 'B' | 'C' | 'CR' | 'D' | 'E' | 'F' | 'G' | 'H';

interface WorkflowForm {
  pipelineOptions: readonly (readonly [string, string])[];
  viewerLabel: string;
  sections: readonly (readonly [SectionId, string])[];
  /** Mô tả luồng cho card mở form. */
  flowLabel: string;
  /** Chuỗi bước nhắc trong câu H2. */
  stepsHint: string;
  /** Nhãn câu G2 (đầu ra chính của workflow). */
  genLabel: string;
}

const FORMS: Record<string, WorkflowForm> = {
  'docs-to-ui': {
    pipelineOptions: [
      ['docs', '① Docs → Markdown'], ['docs-map', '② Bản đồ hệ thống'],
      ['cj', '③ Customer Journey'], ['ux-research', '④ UX Research'],
      ['ux', '⑤ UX Spec'], ['ux-review', '⑥ UX Heuristic Review'],
      ['ui-html', '⑦ UI-Spec (HTML)'], ['ui-react', '⑧ UI-Spec (React)'],
      ['figma', '⑨ Đẩy sang Figma'], ['viewer', '⑩ Chỉ xem kết quả'],
    ],
    viewerLabel: '⑩ Chỉ xem kết quả',
    sections: [
      ['A', 'Thông tin'], ['B', 'Từng pipeline'], ['C', 'Đầu ra UX'], ['D', 'Figma'],
      ['E', 'Thiết kế AI'], ['F', 'Trải nghiệm app'], ['G', 'Tốc độ & chi phí'], ['H', 'Tổng thể'],
    ],
    flowLabel: 'Docs → UX → UI → Figma',
    stepsHint: 'docs → cj → ux-research → ux → ux-review → ui',
    genLabel: 'Tốc độ sinh UI',
  },
  'docs-to-prd': {
    pipelineOptions: [
      ['prd-docs', '① Docs → Markdown'], ['prd-cj', '② Customer Journey'],
      ['prd-ux-research', '③ UX Research'], ['prd-review', '④ PRD Mockup Review'],
      ['viewer', '⑤ Chỉ xem kết quả'],
    ],
    viewerLabel: '⑤ Chỉ xem kết quả',
    sections: [
      ['A', 'Thông tin'], ['B', 'Từng pipeline'], ['CR', 'Đầu ra Review'],
      ['F', 'Trải nghiệm app'], ['G', 'Tốc độ & chi phí'], ['H', 'Tổng thể'],
    ],
    flowLabel: 'Docs → Journey → Research → PRD Review',
    stepsHint: 'docs → cj → ux-research → review',
    genLabel: 'Tốc độ sinh review',
  },
};

const options = {
  useFrequency: ['Dùng hằng ngày', 'Vài lần/tuần', 'Vài lần tổng cộng', 'Mới thử 1 lần'],
  stability: ['4 — Mượt, hầu như không lỗi', '3 — Thi thoảng lỗi, chạy lại được', '2 — Hay lỗi, phải mò cách né', '1 — Thường xuyên không chạy được'],
  usefulness: ['Giúp nhiều — thay phần lớn việc tay', 'Giúp vừa — làm nền để sửa tiếp', 'Giúp ít — tham khảo là chính', 'Không giúp — làm tay nhanh hơn'],
  runtime: ['Nhanh hơn kỳ vọng', 'Chấp nhận được', 'Hơi lâu', 'Quá lâu'],
  scale5: ['1', '2', '3', '4', '5'],
} as const;

// Câu bắt buộc + PHẦN chứa nó (theo id phần — index tính theo form của từng
// workflow, để báo đúng câu thiếu và nhảy tới đúng phần).
const REQUIRED: { id: string; section: SectionId; label: string }[] = [
  { id: 'A1', section: 'A', label: 'Vai trò' },
  { id: 'A2', section: 'A', label: 'Dự án đã dùng' },
  { id: 'A5', section: 'A', label: 'Phần đã dùng' },
  { id: 'H1', section: 'H', label: 'Pipeline đã đủ?' },
  { id: 'H4', section: 'H', label: 'Sẵn sàng dùng thật?' },
  { id: 'H5', section: 'H', label: 'Khả năng giới thiệu' },
  { id: 'H6', section: 'H', label: 'Nếu sửa một điều' },
];

function Field({ id, label, required, children }: { id: string; label: string; required?: boolean; children: React.ReactNode }) {
  return <div className={styles.field}><label className={styles.label} htmlFor={id}><span>{id}. {label}</span>{required ? <em>Bắt buộc</em> : null}</label>{children}</div>;
}

// Ô "nêu rõ" hiện ra khi người dùng chọn "Khác" (chỉ khi call-site truyền onOther).
function OtherInput({ show, value, onChange }: { show: boolean; value?: string; onChange?: (v: string) => void }) {
  if (!show || !onChange) return null;
  return <input className={styles.otherInput} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="Nêu rõ “Khác”…" />;
}

function Choice({ id, values, value, onChange, other, onOther }: { id: string; values: readonly string[]; value?: string; onChange: (value: string) => void; other?: string; onOther?: (v: string) => void }) {
  return <>
    <div className={styles.choiceGrid}>{values.map((item) => <label key={item} className={styles.choice} data-selected={value === item ? 'yes' : 'no'}><input type="radio" name={id} checked={value === item} onChange={() => onChange(item)} /><span>{item}</span></label>)}</div>
    <OtherInput show={value === 'Khác'} value={other} onChange={onOther} />
  </>;
}

function Checks({ values, selected, onChange, other, onOther }: { values: readonly string[]; selected: string[]; onChange: (values: string[]) => void; other?: string; onOther?: (v: string) => void }) {
  return <>
    <div className={styles.checkGrid}>{values.map((item) => <label key={item} className={styles.check} data-selected={selected.includes(item) ? 'yes' : 'no'}><input type="checkbox" checked={selected.includes(item)} onChange={() => onChange(selected.includes(item) ? selected.filter((value) => value !== item) : [...selected, item])} /><span>{item}</span></label>)}</div>
    <OtherInput show={selected.includes('Khác')} value={other} onChange={onOther} />
  </>;
}

export function PipelineEvaluationStep({ projectId, workflowId, pipeline, pipelines, runId, submitted, onSubmitted }: {
  projectId: string; workflowId: string; pipeline: PipelineView; pipelines: PipelineView[]; runId: string; submitted: boolean; onSubmitted: () => void;
}) {
  const form = FORMS[workflowId] ?? FORMS['docs-to-ui']!;
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState(0);
  const [answers, setAnswers] = useState<Answers>(() => {
    const completedIds = new Set(
      pipelines
        .filter((item) => item.status === 'succeeded' || item.status === 'failed')
        .map((item) => item.id),
    );
    return {
      A2: projectId,
      A5: form.pipelineOptions
        .filter(([id]) => completedIds.has(id))
        .map(([, label]) => label),
    };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedRun, setLoadedRun] = useState<string | null>(null);

  // "Xem đánh giá": khi mở lại một run đã gửi, nạp câu trả lời đã lưu (GET) vào
  // form — trước đây nó mở form trống nên "xem" chẳng thấy gì.
  useEffect(() => {
    if (!open || !submitted || loadedRun === runId) return;
    void fetch(`/api/pipelines/feedback?projectId=${encodeURIComponent(projectId)}`)
      .then((response) => (response.ok ? response.json() : { feedback: [] }))
      .then((data: { feedback?: Array<{ runId: string; answers?: unknown }> }) => {
        const record = (data.feedback ?? []).find((item) => item.runId === runId);
        if (record?.answers && typeof record.answers === 'object' && !Array.isArray(record.answers)) {
          setAnswers(record.answers as Answers);
        }
        setLoadedRun(runId);
      })
      .catch(() => undefined);
  }, [open, submitted, runId, projectId, loadedRun]);
  const set = (id: string, value: string | string[]) => setAnswers((current) => ({ ...current, [id]: value }));
  const used = (answers.A5 as string[] | undefined) ?? [];
  const progress = Math.round(((section + 1) / form.sections.length) * 100);
  const secId = form.sections[section]![0];
  const lastSectionId = form.sections[form.sections.length - 1]![0];
  const sectionIndexOf = (id: SectionId) => Math.max(0, form.sections.findIndex(([sid]) => sid === id));
  const rating = useMemo<PipelinePulseRating>(() => {
    const willingness = answers.H4;
    if (willingness === 'Có, làm luồng chính') return 'ready';
    if (willingness === 'Có, làm luồng phụ song song cách cũ') return 'minor_edits';
    if (willingness === 'Chưa — cần cải thiện thêm') return 'major_edits';
    return 'unusable';
  }, [answers.H4]);
  const submit = async () => {
    // Chỉ liệt kê ĐÚNG câu còn thiếu (thay vì luôn liệt kê cả 7), và nhảy tới
    // phần chứa câu thiếu đầu tiên để người dùng thấy ngay.
    const missing = REQUIRED.filter((req) => {
      const value = answers[req.id];
      if (Array.isArray(value)) return value.length === 0;
      return typeof value !== 'string' || value.trim() === '';
    });
    if (missing.length > 0) {
      setError(`Còn thiếu ${missing.length} câu bắt buộc: ${missing.map((m) => `${m.id} (${m.label})`).join(', ')}.`);
      setSection(sectionIndexOf(missing[0]!.section));
      return;
    }
    setSaving(true); setError(null);
    try {
      const response = await fetch('/api/pipelines/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        projectId, workflowId, pipelineId: pipeline.id, runId, rating, surveyKind: 'deep', answers,
        comment: typeof answers.H7 === 'string' ? answers.H7 : '', issues: [],
      }) });
      if (!response.ok && response.status !== 409) throw new Error((await response.json().catch(() => ({}))).error || `submit failed: ${response.status}`);
      onSubmitted(); setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  return <>
    <li className={styles.step} data-complete={submitted ? 'yes' : 'no'}>
      <div className={styles.spine}><span className={styles.node}>{submitted ? <Icon name="check" size={16} /> : <Icon name="star" size={15} />}</span></div>
      <div className={styles.card}>
        <div className={styles.art}><span>{String(pipelines.length + 1).padStart(2, '0')}</span><Icon name="comment" size={30} /></div>
        <div className={styles.summary}><div className={styles.eyebrow}>BƯỚC CUỐI WORKFLOW</div><h3>Đánh giá chất lượng pipeline</h3><p>Chấm độ ổn định, chất lượng đầu ra, tốc độ và mức hữu ích của toàn bộ {form.flowLabel}.</p><div className={styles.meta}><span>{form.sections.length} nhóm câu hỏi</span><span>8–12 phút</span><span>Tự gắn metadata run</span></div></div>
        <button type="button" className={styles.start} onClick={() => setOpen(true)}>{submitted ? 'Xem đánh giá' : 'Bắt đầu đánh giá'}<Icon name="chevron-right" size={15} /></button>
      </div>
    </li>
    {open ? createPortal(<div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="evaluation-title">
        <aside className={styles.nav}><div><div className={styles.navBrand}><Icon name="star" size={18} /><span>Pipeline Evaluation</span></div><p>{projectId}</p></div><nav>{form.sections.map(([id, name], index) => <button key={id} type="button" data-active={section === index ? 'yes' : 'no'} onClick={() => setSection(index)}><span>{id}</span>{name}</button>)}</nav><div className={styles.navProgress}><span>{progress}% hoàn thành</span><div><i style={{ width: `${progress}%` }} /></div></div></aside>
        <main className={styles.content}><header className={styles.header}><div><span>PHẦN {secId} / {lastSectionId}</span><h2 id="evaluation-title">{form.sections[section]![1]}</h2></div><button type="button" onClick={() => setOpen(false)} aria-label="Đóng"><Icon name="close" size={18} /></button></header><div className={styles.form}>
          {secId === 'A' ? <><Field id="A1" label="Vai trò của bạn" required><Choice id="A1" values={['UX Designer', 'UI Designer', 'BA', 'Developer', 'PM/PO', 'Khác']} value={answers.A1 as string} onChange={(value) => set('A1', value)} other={answers.A1_other as string} onOther={(v) => set('A1_other', v)} /></Field><Field id="A2" label="Dự án đã dùng pipeline" required><input value={answers.A2 as string} onChange={(event) => set('A2', event.target.value)} /></Field><Field id="A3" label="Mức độ sử dụng" required><Choice id="A3" values={options.useFrequency} value={answers.A3 as string} onChange={(value) => set('A3', value)} /></Field><Field id="A4" label="Mức quen với công cụ AI (1–5)"><Choice id="A4" values={options.scale5} value={answers.A4 as string} onChange={(value) => set('A4', value)} /></Field><Field id="A5" label="Bạn đã dùng những phần nào?" required><Checks values={form.pipelineOptions.map(([, label]) => label)} selected={used} onChange={(value) => set('A5', value)} /></Field></> : null}
          {secId === 'B' ? <>{used.filter((item) => item !== form.viewerLabel).map((name, index) => <section className={styles.pipelineBlock} key={name}><h3>{name}</h3><Field id={`B${index + 1}.1`} label="Mức độ chạy ổn định" required><Choice id={`B${index}.1`} values={options.stability} value={answers[`B.${name}.stability`] as string} onChange={(value) => set(`B.${name}.stability`, value)} /></Field><Field id={`B${index + 1}.2`} label="Không ổn ở đâu?"><Checks values={['Cài đặt / môi trường / đăng nhập', 'Kết nối nguồn', 'Treo / timeout', 'Sai format / thiếu file', 'Mất dữ liệu', 'Lỗi hiển thị', 'Khác']} selected={(answers[`B.${name}.issues`] as string[]) ?? []} onChange={(value) => set(`B.${name}.issues`, value)} other={answers[`B.${name}.issues_other`] as string} onOther={(value) => set(`B.${name}.issues_other`, value)} /></Field><Field id={`B${index + 1}.3`} label="Chất lượng output (1–5)" required><Choice id={`B${index}.3`} values={options.scale5} value={answers[`B.${name}.quality`] as string} onChange={(value) => set(`B.${name}.quality`, value)} /></Field><Field id={`B${index + 1}.4`} label="Mức hữu ích" required><Choice id={`B${index}.4`} values={options.usefulness} value={answers[`B.${name}.usefulness`] as string} onChange={(value) => set(`B.${name}.usefulness`, value)} /></Field><Field id={`B${index + 1}.5`} label="Thời gian chạy"><Choice id={`B${index}.5`} values={options.runtime} value={answers[`B.${name}.runtime`] as string} onChange={(value) => set(`B.${name}.runtime`, value)} /></Field></section>)}</> : null}
          {secId === 'C' ? <><Field id="C1" label="Journey/UX Spec đúng nghiệp vụ (1–5)" required><Choice id="C1" values={options.scale5} value={answers.C1 as string} onChange={(v) => set('C1', v)} /></Field><Field id="C2" label="Những case thường bị thiếu" required><Checks values={['Luồng phụ', 'Case lỗi / exception', 'Loading / empty / error', 'Phân quyền / actor phụ', 'Validation form', 'Không thiếu đáng kể']} selected={(answers.C2 as string[]) ?? []} onChange={(v) => set('C2', v)} /></Field><Field id="C3" label="Bản UX dùng được ở mức nào?"><Choice id="C3" values={['Làm thẳng wireframe', 'Làm khung thảo luận', 'Chỉ tham khảo', 'Không dùng']} value={answers.C3 as string} onChange={(v) => set('C3', v)} /></Field><Field id="C4" label="Tiết kiệm thời gian"><Choice id="C4" values={['>70%', '30–70%', '<30%', 'Không tiết kiệm', 'Tốn thêm thời gian']} value={answers.C4 as string} onChange={(v) => set('C4', v)} /></Field><Field id="C5" label="Điều phải sửa nhiều nhất"><textarea value={(answers.C5 as string) ?? ''} onChange={(e) => set('C5', e.target.value)} /></Field><Field id="C6" label="Mức tin kết quả AI"><Choice id="C6" values={['Tin, ít kiểm tra lại', 'Tin một phần, luôn đối chiếu', 'Không tin, kiểm tra từng ý']} value={answers.C6 as string} onChange={(v) => set('C6', v)} /></Field></> : null}
          {secId === 'CR' ? <><Field id="C1" label="Review chỉ ra vấn đề ĐÚNG thực tế (1–5)" required><Choice id="C1" values={options.scale5} value={answers.C1 as string} onChange={(v) => set('C1', v)} /></Field><Field id="C2" label="Loại vấn đề review hay bỏ sót" required><Checks values={['Mockup sai/thiếu so với text nghiệp vụ', 'Luồng phụ / edge case', 'Trạng thái loading / empty / error', 'Phân quyền / actor phụ', 'Thuật ngữ / UX writing', 'Không thiếu đáng kể']} selected={(answers.C2 as string[]) ?? []} onChange={(v) => set('C2', v)} /></Field><Field id="C3" label="Báo cáo review dùng được ở mức nào?"><Choice id="C3" values={['Gửi thẳng cho team sửa mockup', 'Làm khung thảo luận', 'Chỉ tham khảo', 'Không dùng']} value={answers.C3 as string} onChange={(v) => set('C3', v)} /></Field><Field id="C4" label="Tiết kiệm thời gian so với tự review"><Choice id="C4" values={['>70%', '30–70%', '<30%', 'Không tiết kiệm', 'Tốn thêm thời gian']} value={answers.C4 as string} onChange={(v) => set('C4', v)} /></Field><Field id="C5" label="Điều phải sửa nhiều nhất trong báo cáo"><textarea value={(answers.C5 as string) ?? ''} onChange={(e) => set('C5', e.target.value)} /></Field><Field id="C6" label="Mức tin kết quả AI"><Choice id="C6" values={['Tin, ít kiểm tra lại', 'Tin một phần, luôn đối chiếu', 'Không tin, kiểm tra từng ý']} value={answers.C6 as string} onChange={(v) => set('C6', v)} /></Field></> : null}
          {secId === 'D' ? <><Field id="D1" label="Cấu trúc file Figma chuẩn (1–5)" required><Choice id="D1" values={options.scale5} value={answers.D1 as string} onChange={(v) => set('D1', v)} /></Field><Field id="D2" label="Phần chưa chuẩn"><Checks values={['Tên layer', 'Component / variant', 'Auto-layout', 'Font / màu / token', 'Icon / ảnh', 'Thiếu màn / state', 'Không có gì đáng kể']} selected={(answers.D2 as string[]) ?? []} onChange={(v) => set('D2', v)} /></Field><Field id="D3" label="Tỷ lệ phải sửa lại" required><Choice id="D3" values={['<10%', '10–30%', '30–60%', '>60%']} value={answers.D3 as string} onChange={(v) => set('D3', v)} /></Field><Field id="D4" label="So với tự dựng Figma" required><Choice id="D4" values={['Tiết kiệm nhiều', 'Tiết kiệm chút ít', 'Ngang nhau', 'Tốn hơn']} value={answers.D4 as string} onChange={(v) => set('D4', v)} /></Field><Field id="D5" label="Muốn bổ sung gì nhất?"><textarea value={(answers.D5 as string) ?? ''} onChange={(e) => set('D5', e.target.value)} /></Field></> : null}
          {secId === 'E' ? <>{([['E1', 'Thiết kế AI đẹp'], ['E2', 'Mức nhất quán'], ['E3', 'Bám design system'], ['E5', 'UX writing / thuật ngữ']] as Array<[string, string]>).map(([id, label]) => <Field key={id} id={id} label={`${label} (1–5)`} required><Choice id={id} values={options.scale5} value={answers[id] as string} onChange={(v) => set(id, v)} /></Field>)}<Field id="E4" label="Độ phủ nghiệp vụ" required><Choice id="E4" values={['Đủ màn và case', 'Đủ màn chính, thiếu case phụ', 'Thiếu màn chính', 'Sai nghiệp vụ']} value={answers.E4 as string} onChange={(v) => set('E4', v)} /></Field><Field id="E6" label="Prototype tương tác"><Choice id="E6" values={['Đủ luồng', 'Được một phần', 'Hầu như tĩnh', 'Không mở được']} value={answers.E6 as string} onChange={(v) => set('E6', v)} /></Field></> : null}
          {secId === 'F' ? <><Field id="F1" label="Tốc độ tổng thể" required><Choice id="F1" values={['Nhanh, mượt', 'Ổn, đôi lúc chậm', 'Chậm, hay lag', 'Rất chậm / hay đơ']} value={answers.F1 as string} onChange={(v) => set('F1', v)} /></Field><Field id="F2" label="Chỗ hay lag"><Checks values={['Mở project / chuyển tab', 'Preview HTML/React', 'Canvas / React Flow', 'Chat khi agent chạy', 'Push/pull dữ liệu', 'Đăng nhập / SSO', 'Không gặp']} selected={(answers.F2 as string[]) ?? []} onChange={(v) => set('F2', v)} /></Field>{([['F3', 'Độ ổn định'], ['F4', 'Mức dễ dùng']] as Array<[string, string]>).map(([id, label]) => <Field key={id} id={id} label={`${label} (1–5)`} required><Choice id={id} values={options.scale5} value={answers[id] as string} onChange={(v) => set(id, v)} /></Field>)}<Field id="F5" label="Điều khó chịu nhất"><textarea value={(answers.F5 as string) ?? ''} onChange={(e) => set('F5', e.target.value)} /></Field></> : null}
          {secId === 'G' ? <><Field id="G1" label="Tốc độ sinh tài liệu" required><Choice id="G1" values={['<5 phút', '5–15 phút', '15–30 phút', '>30 phút']} value={answers.G1 as string} onChange={(v) => set('G1', v)} /></Field><Field id="G2" label={form.genLabel} required><Choice id="G2" values={['<5 phút', '5–15 phút', '15–30 phút', '>30 phút']} value={answers.G2 as string} onChange={(v) => set('G2', v)} /></Field><Field id="G3" label="Trong lúc chờ AI"><Choice id="G3" values={['Theo dõi log/chat', 'Làm việc khác', 'Quên luôn']} value={answers.G3 as string} onChange={(v) => set('G3', v)} /></Field><Field id="G4" label="Giá trị so với chi phí token"><Choice id="G4" values={['Rất đáng', 'Đáng', 'Chưa đáng', 'Không biết chi phí']} value={answers.G4 as string} onChange={(v) => set('G4', v)} /></Field></> : null}
          {secId === 'H' ? <><Field id="H1" label="Pipeline đã đủ cho quy trình?" required><Choice id="H1" values={['Đủ', 'Gần đủ', 'Thiếu nhiều', 'Sai hướng']} value={answers.H1 as string} onChange={(v) => set('H1', v)} /></Field><Field id="H2" label={`Thiếu bước nào? (ngoài ${form.stepsHint})`}><Checks values={['Research người dùng / đối thủ (định lượng)', 'Persona có dữ liệu', 'Human review gate (người duyệt)', 'Design QA tự động', 'Xuất slide/docx', 'Quản lý phiên bản / so sánh run', 'Khác']} selected={(answers.H2 as string[]) ?? []} onChange={(v) => set('H2', v)} other={answers.H2_other as string} onOther={(v) => set('H2_other', v)} /></Field><Field id="H3" label="Bước thừa / không dùng"><input value={(answers.H3 as string) ?? ''} onChange={(e) => set('H3', e.target.value)} /></Field><Field id="H4" label="Sẵn sàng dùng cho dự án thật?" required><Choice id="H4" values={['Có, làm luồng chính', 'Có, làm luồng phụ song song cách cũ', 'Chưa — cần cải thiện thêm', 'Không']} value={answers.H4 as string} onChange={(v) => set('H4', v)} /></Field><Field id="H5" label="Khả năng giới thiệu (0–10)" required><Choice id="H5" values={Array.from({ length: 11 }, (_, i) => String(i))} value={answers.H5 as string} onChange={(v) => set('H5', v)} /></Field><Field id="H6" label="Nếu chỉ sửa một điều, bạn sửa gì?" required><textarea value={(answers.H6 as string) ?? ''} onChange={(e) => set('H6', e.target.value)} /></Field><Field id="H7" label="Ý kiến khác"><textarea value={(answers.H7 as string) ?? ''} onChange={(e) => set('H7', e.target.value)} /></Field></> : null}
        </div><footer className={styles.footer}><button type="button" disabled={section === 0} onClick={() => setSection((value) => Math.max(0, value - 1))}>Quay lại</button><span>{error}</span>{section < form.sections.length - 1 ? <button type="button" className={styles.primary} onClick={() => setSection((value) => Math.min(form.sections.length - 1, value + 1))}>Tiếp tục <Icon name="chevron-right" size={14} /></button> : <button type="button" className={styles.primary} disabled={saving} onClick={() => void submit()}>{saving ? 'Đang gửi…' : 'Gửi đánh giá'} <Icon name="check" size={14} /></button>}</footer></main>
      </div>
    </div>, document.body) : null}
  </>;
}
