'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  FeedbackFormDef,
  FeedbackFormSection,
  FeedbackQuestion,
  FeedbackQuestionType,
} from '@open-design/contracts';
import styles from './FeedbackFormBuilder.module.css';

export interface FeedbackFormBuilderProps {
  form: FeedbackFormDef;
  busy?: boolean;
  onSave: (draft: {
    title: string;
    sections?: FeedbackFormSection[];
    questions: FeedbackQuestion[];
  }) => Promise<void>;
}

export type FeedbackDraft = {
  title: string;
  sections?: FeedbackFormSection[];
  questions: FeedbackQuestion[];
};

const TYPES: FeedbackQuestionType[] = ['radio', 'checkbox', 'text', 'scale'];
const TYPE_LABELS: Record<FeedbackQuestionType, string> = {
  radio: 'Một lựa chọn',
  checkbox: 'Nhiều lựa chọn',
  text: 'Văn bản',
  scale: 'Thang điểm',
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function slug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'cau-hoi';
}

function newQuestion(label = ''): FeedbackQuestion {
  return { id: slug(label), label, type: 'radio', options: ['', ''], required: false };
}

/** Bản mirror có chủ đích; đổi luật daemon thì đổi cả đây. */
export function builderDraftErrors(draft: FeedbackDraft): string[] {
  const errors: string[] = [];
  if (!draft.title.trim()) errors.push('Tiêu đề không được để trống.');
  if (draft.questions.length < 1) errors.push('Form cần ít nhất một câu hỏi.');

  const ids = new Set<string>();
  for (const [index, question] of draft.questions.entries()) {
    if (!question.id || ids.has(question.id)) errors.push(`Câu ${index + 1}: id bị trùng hoặc rỗng.`);
    ids.add(question.id);
    if (!question.label.trim()) errors.push(`Câu ${index + 1}: nhãn không được để trống.`);
    if ((question.type === 'radio' || question.type === 'checkbox') && !question.optionsSource) {
      const options = question.options ?? [];
      if (options.length < 2 || options.some((option) => !option.trim())) {
        errors.push(`Câu ${index + 1}: cần ít nhất 2 lựa chọn không rỗng.`);
      } else if (new Set(options.map((option) => option.trim())).size !== options.length) {
        errors.push(`Câu ${index + 1}: lựa chọn không được trùng.`);
      }
    }
    if (question.type === 'scale' && question.scaleMax !== 5 && question.scaleMax !== 10) {
      errors.push(`Câu ${index + 1}: thang điểm phải là 5 hoặc 10.`);
    }
    if (question.type === 'text' && (question.options !== undefined || question.scaleMax !== undefined)) {
      errors.push(`Câu ${index + 1}: văn bản không được có options hoặc scaleMax.`);
    }
    if (question.allowOther && question.type !== 'radio' && question.type !== 'checkbox') {
      errors.push(`Câu ${index + 1}: "Khác" chỉ dùng cho radio/checkbox.`);
    }
    if (question.optionsSource && question.type !== 'checkbox') errors.push(`Câu ${index + 1}: optionsSource chỉ dùng cho checkbox.`);
    if (question.optionsSource && question.options !== undefined) errors.push(`Câu ${index + 1}: câu nguồn workflow không được có options.`);
    if (question.scaleMin !== undefined && question.type !== 'scale') errors.push(`Câu ${index + 1}: scaleMin chỉ dùng cho scale.`);
    if (question.scaleMin !== undefined && question.scaleMin !== 0 && question.scaleMin !== 1) errors.push(`Câu ${index + 1}: scaleMin phải là 0 hoặc 1.`);
    if (question.multiline !== undefined && question.type !== 'text') errors.push(`Câu ${index + 1}: multiline chỉ dùng cho text.`);
    if (question.prefill === 'project-id' && question.type !== 'text') errors.push(`Câu ${index + 1}: project-id chỉ dùng cho text.`);
    if (question.prefill === 'completed-steps' && (question.type !== 'checkbox' || !question.optionsSource)) {
      errors.push(`Câu ${index + 1}: completed-steps cần checkbox workflow.`);
    }
  }

  if (draft.sections !== undefined) {
    if (!draft.sections.length) errors.push('Form có sections phải có ít nhất một phần.');
    const sectionIds = new Set<string>();
    for (const section of draft.sections) {
      if (!section.id || sectionIds.has(section.id)) errors.push('Id phần bị trùng hoặc rỗng.');
      sectionIds.add(section.id);
      if (!section.title.trim()) errors.push('Tên phần không được để trống.');
    }
    for (const question of draft.questions) {
      if (!question.sectionId || !sectionIds.has(question.sectionId)) errors.push(`Câu "${question.label}" thuộc phần không tồn tại.`);
    }
    for (const [sectionIndex, section] of draft.sections.entries()) {
      if (!section.repeatForQuestionId) continue;
      const questionIndex = draft.questions.findIndex((question) => question.id === section.repeatForQuestionId);
      const source = draft.questions[questionIndex];
      const sourceSectionIndex = draft.sections.findIndex((candidate) => candidate.id === source?.sectionId);
      if (!source || source.type !== 'checkbox' || sourceSectionIndex < 0 || sourceSectionIndex >= sectionIndex || draft.sections[sourceSectionIndex]?.repeatForQuestionId) {
        errors.push(`Phần "${section.title}" lặp theo câu checkbox không hợp lệ.`);
      }
    }
  } else if (draft.questions.some((question) => question.sectionId !== undefined)) {
    errors.push('Form không có sections thì câu hỏi không được có sectionId.');
  }
  return errors;
}

function questionForType(question: FeedbackQuestion, type: FeedbackQuestionType): FeedbackQuestion {
  const next: FeedbackQuestion = { id: question.id, label: question.label, type, required: question.required, sectionId: question.sectionId };
  if (type === 'radio' || type === 'checkbox') {
    next.options = ['', ''];
    next.allowOther = question.allowOther;
  }
  if (type === 'scale') next.scaleMax = 5;
  return next;
}

export function FeedbackFormBuilder({ form, busy = false, onSave }: FeedbackFormBuilderProps): JSX.Element {
  const [draft, setDraft] = useState<FeedbackDraft>(() => clone({ title: form.title, sections: form.sections, questions: form.questions }));
  const [saveError, setSaveError] = useState('');
  useEffect(() => setDraft(clone({ title: form.title, sections: form.sections, questions: form.questions })), [form.version]);

  const errors = useMemo(() => builderDraftErrors(draft), [draft]);
  const sections = draft.sections;
  const updateQuestion = (index: number, patch: Partial<FeedbackQuestion>) => setDraft((current) => ({ ...current, questions: current.questions.map((q, i) => (i === index ? { ...q, ...patch } : q)) }));
  const updateOption = (qi: number, oi: number, value: string) => setDraft((current) => ({ ...current, questions: current.questions.map((q, i) => i === qi ? { ...q, options: (q.options ?? []).map((option, j) => j === oi ? value : option) } : q) }));
  const removeQuestion = (index: number) => setDraft((current) => ({ ...current, questions: current.questions.filter((_, i) => i !== index) }));
  const moveQuestion = (index: number, direction: -1 | 1) => setDraft((current) => { const questions = [...current.questions]; const target = index + direction; if (target < 0 || target >= questions.length) return current; const currentQuestion = questions[index]; const targetQuestion = questions[target]; if (!currentQuestion || !targetQuestion) return current; questions[index] = targetQuestion; questions[target] = currentQuestion; return { ...current, questions }; });
  const addQuestion = (sectionId?: string) => setDraft((current) => ({ ...current, questions: [...current.questions, { ...newQuestion(), ...(sectionId ? { sectionId } : {}) }] }));
  const addSections = () => setDraft((current) => ({ ...current, sections: [{ id: 'phan-1', title: 'Phần 1' }], questions: current.questions.map((question) => ({ ...question, sectionId: 'phan-1' })) }));
  const addSection = () => setDraft((current) => { const id = `phan-${(current.sections?.length ?? 0) + 1}`; return { ...current, sections: [...(current.sections ?? []), { id, title: `Phần ${current.sections!.length + 1}` }] }; });
  const updateSection = (index: number, patch: Partial<FeedbackFormSection>) => setDraft((current) => ({ ...current, sections: current.sections?.map((section, i) => i === index ? { ...section, ...patch } : section) }));
  const moveSection = (index: number, direction: -1 | 1) => setDraft((current) => { const next = [...(current.sections ?? [])]; const target = index + direction; if (target < 0 || target >= next.length) return current; const currentSection = next[index]; const targetSection = next[target]; if (!currentSection || !targetSection) return current; next[index] = targetSection; next[target] = currentSection; return { ...current, sections: next }; });
  const removeSection = (index: number) => setDraft((current) => current.sections && current.questions.some((question) => question.sectionId === current.sections![index]?.id) ? current : ({ ...current, sections: current.sections?.filter((_, i) => i !== index) }));
  const save = async () => { setSaveError(''); try { await onSave(clone(draft)); } catch (error) { setSaveError(error instanceof Error ? error.message : 'Không thể lưu form.'); } };
  const priorRepeatSources = (sectionIndex: number) => (sections ?? []).slice(0, sectionIndex).filter((section) => !section.repeatForQuestionId).flatMap((section) => draft.questions.filter((question) => question.sectionId === section.id && question.type === 'checkbox'));

  const renderQuestion = (question: FeedbackQuestion, index: number) => (
    <article className={styles.question} key={`${question.id}-${index}`}>
      <div className={styles.questionHead}><strong>Câu {index + 1}</strong><div className={styles.actions}><button className={styles.iconButton} type="button" onClick={() => moveQuestion(index, -1)} disabled={index === 0} aria-label={`Đưa câu ${index + 1} lên`}>↑</button><button className={styles.iconButton} type="button" onClick={() => moveQuestion(index, 1)} disabled={index === draft.questions.length - 1} aria-label={`Đưa câu ${index + 1} xuống`}>↓</button><button className={styles.removeButton} type="button" onClick={() => removeQuestion(index)}>Xóa</button></div></div>
      <label className={styles.field}>Nhãn<input className={styles.input} value={question.label} onChange={(event) => updateQuestion(index, { label: event.target.value, id: question.id === slug(question.label) ? slug(event.target.value) : question.id })} /></label>
      <label className={styles.field}>Kiểu<select className={styles.input} value={question.type} onChange={(event) => setDraft((current) => ({ ...current, questions: current.questions.map((q, i) => i === index ? questionForType(q, event.target.value as FeedbackQuestionType) : q) }))}>{TYPES.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}</select></label>
      {sections && <label className={styles.field}>Thuộc phần<select className={styles.input} value={question.sectionId ?? ''} onChange={(event) => updateQuestion(index, { sectionId: event.target.value })}>{sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}</select></label>}
      <label className={styles.check}><input type="checkbox" checked={question.required ?? false} onChange={(event) => updateQuestion(index, { required: event.target.checked })} /> Bắt buộc</label>
      {(question.type === 'radio' || question.type === 'checkbox') && <>
        {question.type === 'checkbox' && <label className={styles.check}><input type="checkbox" checked={question.optionsSource === 'workflow-steps'} onChange={(event) => updateQuestion(index, event.target.checked ? { optionsSource: 'workflow-steps', options: undefined } : { optionsSource: undefined, options: ['', ''] })} /> Lựa chọn = các bước pipeline</label>}
        {question.type === 'checkbox' && question.optionsSource === 'workflow-steps' && <label className={styles.check}><input type="checkbox" checked={question.prefill === 'completed-steps'} onChange={(event) => updateQuestion(index, { prefill: event.target.checked ? 'completed-steps' : undefined })} /> Tự tick các bước đã chạy</label>}
        {!question.optionsSource && <div className={styles.options}><span className={styles.subLabel}>Lựa chọn</span>{(question.options ?? []).map((option, optionIndex) => <div className={styles.optionRow} key={optionIndex}><input className={styles.input} value={option} onChange={(event) => updateOption(index, optionIndex, event.target.value)} /><button className={styles.removeButton} type="button" onClick={() => updateQuestion(index, { options: (question.options ?? []).filter((_, i) => i !== optionIndex) })}>Xóa dòng</button></div>)}<button className={styles.secondaryButton} type="button" onClick={() => updateQuestion(index, { options: [...(question.options ?? []), ''] })}>Thêm lựa chọn</button></div>}
        <label className={styles.check}><input type="checkbox" checked={question.allowOther ?? false} onChange={(event) => updateQuestion(index, { allowOther: event.target.checked })} /> Cho phép chọn "Khác" + điền tay</label>
      </>}
      {question.type === 'scale' && <div className={styles.inline}><label className={styles.field}>Thang điểm<select className={styles.input} value={question.scaleMax ?? 5} onChange={(event) => updateQuestion(index, { scaleMax: Number(event.target.value) as 5 | 10 })}><option value="5">5</option><option value="10">10</option></select></label><label className={styles.check}><input type="checkbox" checked={question.scaleMin === 0} onChange={(event) => updateQuestion(index, { scaleMin: event.target.checked ? 0 : undefined })} /> Bắt đầu từ 0</label></div>}
      {question.type === 'text' && <div className={styles.inline}><label className={styles.check}><input type="checkbox" checked={question.multiline ?? false} onChange={(event) => updateQuestion(index, { multiline: event.target.checked ? true : undefined })} /> Nhiều dòng</label><label className={styles.check}><input type="checkbox" checked={question.prefill === 'project-id'} onChange={(event) => updateQuestion(index, { prefill: event.target.checked ? 'project-id' : undefined })} /> Mồi sẵn tên dự án</label></div>}
    </article>
  );

  return <form className={styles.root} onSubmit={(event) => { event.preventDefault(); if (!errors.length && !busy) void save(); }}>
    <label className={styles.titleField}>Tiêu đề<input className={styles.titleInput} value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /></label>
    {sections ? <div className={styles.sections}>{sections.map((section, sectionIndex) => <section className={styles.section} key={section.id}><div className={styles.sectionHead}><input className={styles.input} aria-label={`Tên phần ${sectionIndex + 1}`} value={section.title} onChange={(event) => updateSection(sectionIndex, { title: event.target.value })} /><div className={styles.actions}><button className={styles.iconButton} type="button" onClick={() => moveSection(sectionIndex, -1)} disabled={sectionIndex === 0} aria-label="Đưa phần lên">↑</button><button className={styles.iconButton} type="button" onClick={() => moveSection(sectionIndex, 1)} disabled={sectionIndex === sections.length - 1} aria-label="Đưa phần xuống">↓</button><button className={styles.removeButton} type="button" title="Chỉ xóa được phần không có câu hỏi" disabled={draft.questions.some((question) => question.sectionId === section.id)} onClick={() => removeSection(sectionIndex)}>Xóa phần</button></div></div><label className={styles.field}>Lặp theo<select className={styles.input} value={section.repeatForQuestionId ?? ''} onChange={(event) => updateSection(sectionIndex, { repeatForQuestionId: event.target.value || undefined })}><option value="">Không lặp</option>{priorRepeatSources(sectionIndex).map((question) => <option key={question.id} value={question.id}>{question.label}</option>)}</select></label>{draft.questions.filter((question) => question.sectionId === section.id).map((question) => renderQuestion(question, draft.questions.indexOf(question)))}<button className={styles.secondaryButton} type="button" onClick={() => addQuestion(section.id)}>+ Câu hỏi</button></section>)}<button className={styles.secondaryButton} type="button" onClick={addSection}>+ Phần</button></div> : <div className={styles.questions}>{draft.questions.map(renderQuestion)}<button className={styles.secondaryButton} type="button" onClick={() => addQuestion()}>Thêm câu hỏi</button><button className={styles.secondaryButton} type="button" onClick={addSections}>Chia thành phần</button></div>}
    {(errors.length > 0 || saveError) && <div className={styles.errors} role="alert">{[...errors, ...(saveError ? [saveError] : [])].map((error, index) => <div key={`${error}-${index}`}>{error}</div>)}</div>}
    <div className={styles.footer}><button className={styles.primaryButton} type="submit" disabled={errors.length > 0 || busy}>Lưu (tạo version mới)</button><span className={styles.note}>Lưu tạo version mới — câu trả lời đã gửi cho version cũ không bị ảnh hưởng.</span></div>
  </form>;
}
