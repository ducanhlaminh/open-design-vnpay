'use client';

import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type {
  FeedbackAnswerValue,
  FeedbackAttachment,
  FeedbackFillContext,
  FeedbackFormDef,
  FeedbackQuestion,
  FeedbackStageFileRef,
} from '@open-design/contracts';
import styles from './FeedbackFormFill.module.css';

export interface FeedbackStageOutputOption {
  stageId: string;
  stageName: string;
  files: { sourcePath: string; name: string }[];
}

export interface FeedbackFormFillProps {
  form: FeedbackFormDef;
  context: FeedbackFillContext;
  stageOutputs: FeedbackStageOutputOption[];
  onUploadImage: (file: File) => Promise<FeedbackAttachment>;
  onSubmit: (submission: {
    answers: Record<string, FeedbackAnswerValue>;
    otherTexts: Record<string, string>;
    images: FeedbackAttachment[];
    stageFiles: FeedbackStageFileRef[];
  }) => Promise<void>;
  busy?: boolean;
}

const OTHER = '__other__';
const MAX_TEXT = 4000;

type Answers = Record<string, FeedbackAnswerValue>;

type QuestionInstance = { question: FeedbackQuestion; key: string; option?: string };

function optionsFor(question: FeedbackQuestion, context: FeedbackFillContext): string[] {
  return question.optionsSource === 'workflow-steps'
    ? context.steps.map((step) => step.label)
    : question.options ?? [];
}

function selectedOptions(question: FeedbackQuestion, answers: Answers): string[] {
  const value = answers[question.id];
  return Array.isArray(value) ? value : [];
}

function instancesFor(
  form: FeedbackFormDef,
  answers: Answers,
  sectionId?: string,
): QuestionInstance[] {
  const section = form.sections?.find((item) => item.id === sectionId);
  const questions = form.questions.filter((question) => question.sectionId === sectionId);
  if (!section?.repeatForQuestionId) {
    return questions.map((question) => ({ question, key: question.id }));
  }
  const source = form.questions.find((question) => question.id === section.repeatForQuestionId);
  const options = source ? selectedOptions(source, answers).filter((option) => option !== OTHER) : [];
  return options.flatMap((option) =>
    questions.map((question) => ({ question, key: `${question.id}@${option}`, option })),
  );
}

function labelForInstance(instance: QuestionInstance): string {
  return instance.option ? `${instance.question.label} (${instance.option})` : instance.question.label;
}

/** Bản mirror có chủ đích của luật validate phía daemon. Giá trị "Khác" là chuỗi '__other__'. */
export function fillErrors(
  form: FeedbackFormDef,
  answers: Answers,
  otherTexts: Record<string, string>,
): string[] {
  const errors: string[] = [];
  const sections = form.sections ?? [];
  const instances = sections.length
    ? sections.flatMap((section) => instancesFor(form, answers, section.id))
    : instancesFor(form, answers);
  for (const instance of instances) {
    const { question, key } = instance;
    const value = answers[key];
    const label = labelForInstance(instance);
    const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    if (question.required && empty) errors.push(`Vui lòng trả lời: ${label}`);
    const hasOther = value === OTHER || (Array.isArray(value) && value.includes(OTHER));
    if (hasOther && !otherTexts[key]?.trim()) errors.push(`Vui lòng nhập nội dung Khác: ${label}`);
    if (question.type === 'text' && typeof value === 'string' && value.length > MAX_TEXT) {
      errors.push(`${label} không được vượt quá ${MAX_TEXT} ký tự`);
    }
    if (question.type === 'scale' && typeof value === 'number') {
      const min = question.scaleMin ?? 1;
      if (value < min || value > (question.scaleMax ?? 5)) errors.push(`Giá trị không hợp lệ: ${label}`);
    }
  }
  return errors;
}

function initialAnswers(form: FeedbackFormDef, context: FeedbackFillContext): Answers {
  const answers: Answers = {};
  for (const question of form.questions) {
    if (question.prefill === 'project-id') answers[question.id] = context.projectId;
    if (question.prefill === 'completed-steps') {
      const values = context.steps.filter((step) => step.completed).map((step) => step.label);
      if (values.length) answers[question.id] = values;
    }
  }
  return answers;
}

export function FeedbackFormFill({
  form,
  context,
  stageOutputs,
  onUploadImage,
  onSubmit,
  busy = false,
}: FeedbackFormFillProps): JSX.Element {
  const [answers, setAnswers] = useState<Answers>(() => initialAnswers(form, context));
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>({});
  const [stageFiles, setStageFiles] = useState<FeedbackStageFileRef[]>([]);
  const [images, setImages] = useState<FeedbackAttachment[]>([]);
  const [uploads, setUploads] = useState<{ file: File; url: string; error?: string }[]>([]);
  const [currentSection, setCurrentSection] = useState(0);
  const [sent, setSent] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const sections = form.sections ?? [];
  const wizard = sections.length > 0;

  useEffect(() => {
    setAnswers(initialAnswers(form, context));
    setOtherTexts({});
    setStageFiles([]);
    setImages([]);
    setUploads([]);
    setCurrentSection(0);
    setSent(false);
    setSubmitAttempted(false);
  }, [form, context]);

  const errors = useMemo(() => fillErrors(form, answers, otherTexts), [form, answers, otherTexts]);
  const visibleInstances = wizard
    ? instancesFor(form, answers, sections[currentSection]?.id)
    : instancesFor(form, answers);
  const activeSection = wizard ? sections[currentSection] : undefined;
  const repeatSection = activeSection?.repeatForQuestionId;
  const sourceQuestion = repeatSection ? form.questions.find((q) => q.id === repeatSection) : undefined;
  const sourceSelected = sourceQuestion ? selectedOptions(sourceQuestion, answers).filter((value) => value !== OTHER) : [];

  function setAnswer(key: string, value: FeedbackAnswerValue): void {
    setAnswers((current) => ({ ...current, [key]: value }));
  }

  function toggleCheckbox(key: string, option: string): void {
    const current = Array.isArray(answers[key]) ? answers[key] : [];
    setAnswer(key, current.includes(option) ? current.filter((item) => item !== option) : [...current, option]);
  }

  async function upload(file: File, index: number): Promise<void> {
    try {
      const attachment = await onUploadImage(file);
      setImages((current) => [...current, attachment]);
      setUploads((current) => current.filter((_, itemIndex) => itemIndex !== index));
    } catch (error) {
      setUploads((current) => current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, error: error instanceof Error ? error.message : 'Không thể tải ảnh' } : item,
      ));
    }
  }

  function handleFiles(event: React.ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
    if (images.length + uploads.length + files.length > 10) {
      setUploads((current) => [...current, { file: files[0]!, url: '', error: 'Chỉ được đính kèm tối đa 10 ảnh' }]);
      return;
    }
    files.forEach((file) => {
      const item = { file, url: URL.createObjectURL(file) };
      setUploads((current) => {
        const next = [...current, item];
        void upload(file, next.length - 1);
        return next;
      });
    });
  }

  function firstMissingSection(): number {
    for (let index = 0; index < sections.length; index += 1) {
      const sectionInstances = instancesFor(form, answers, sections[index]!.id);
      if (fillErrors({ ...form, sections: [sections[index]! ] }, answers, otherTexts).length) return index;
      if (sectionInstances.some(({ question, key }) => question.required && answers[key] === undefined)) return index;
    }
    return -1;
  }

  async function submit(): Promise<void> {
    setSubmitAttempted(true);
    if (errors.length || uploads.some((uploadItem) => !uploadItem.error)) {
      if (wizard) {
        const first = firstMissingSection();
        if (first >= 0) setCurrentSection(first);
      }
      return;
    }
    await onSubmit({ answers, otherTexts, images, stageFiles });
    setSent(true);
  }

  if (sent) return <div className={styles.success}>Đã gửi — cảm ơn!</div>;

  const attachmentSection = !wizard || currentSection === sections.length - 1;
  const stageOptionsVisible = stageOutputs.some((stage) => stage.files.length);
  // Chỉ hiện danh sách lỗi SAU khi người dùng bấm Gửi — form mới mở lúc nào
  // cũng "thiếu" mọi câu required, liệt kê ngay từ đầu là một bức tường đỏ.
  const showErrors = submitAttempted && errors.length > 0;

  return (
    <div className={`${styles.root} ${wizard ? styles.wizard : ''}`}>
      <div className={styles.header}><h2 className={styles.title}>{form.title}</h2></div>
      {wizard && <aside className={styles.sidebar} aria-label="Các phần">
        <nav className={styles.sectionNav}>{sections.map((section, index) => (
          <button className={`${styles.sectionButton} ${index === currentSection ? styles.sectionButtonActive : ''}`} key={section.id} type="button" onClick={() => setCurrentSection(index)}>
            <span className={styles.sectionNumber}>{index + 1}</span>{section.title}
          </button>
        ))}</nav>
        <div className={styles.progress}><div className={styles.progressBar} style={{ width: `${((currentSection + 1) / sections.length) * 100}%` }} /></div>
      </aside>}
      <main className={styles.content}>
        {wizard && <h3 className={styles.sectionTitle}>{activeSection?.title}</h3>}
        {repeatSection && !sourceSelected.length && <p className={styles.hint}>Chọn ở phần trước: {sourceQuestion?.label}</p>}
        {visibleInstances.map((instance, index) => <div className={styles.instance} key={instance.key}>{instance.option && (index === 0 || visibleInstances[index - 1]!.option !== instance.option) && <h4 className={styles.instanceTitle}>{instance.question.label} ({instance.option})</h4>}<QuestionField instance={instance} answers={answers} context={context} otherTexts={otherTexts} setAnswer={setAnswer} toggleCheckbox={toggleCheckbox} setOtherTexts={setOtherTexts} /></div>)}
        {attachmentSection && <>
          {stageOptionsVisible && <section className={styles.attachments}><h3 className={styles.subheading}>Đính kèm output</h3>{stageOutputs.filter((stage) => stage.files.length).map((stage) => <div className={styles.stageGroup} key={stage.stageId}><div className={styles.stageName}>{stage.stageName}</div>{stage.files.map((file) => { const checked = stageFiles.some((item) => item.stageId === stage.stageId && item.sourcePath === file.sourcePath); return <label className={styles.checkOption} key={file.sourcePath}><input type="checkbox" checked={checked} onChange={() => setStageFiles((current) => checked ? current.filter((item) => !(item.stageId === stage.stageId && item.sourcePath === file.sourcePath)) : [...current, { stageId: stage.stageId, sourcePath: file.sourcePath, name: file.name }])} /><span>{file.name}</span></label>; })}</div>)}</section>}
          <section className={styles.attachments}><h3 className={styles.subheading}>Đính ảnh</h3><input className={styles.fileInput} type="file" accept="image/*" multiple onChange={handleFiles} disabled={busy || images.length + uploads.length >= 10} />{uploads.map((item, index) => <div className={styles.imageRow} key={`${item.file.name}-${index}`}>{item.url && <img className={styles.thumbnail} src={item.url} alt={item.file.name} />}<span className={styles.imageName}>{item.file.name}</span>{item.error ? <span className={styles.error}>{item.error}</span> : <span className={styles.hint}>Đang tải…</span>}{item.error && <button className={styles.textButton} type="button" onClick={() => void upload(item.file, index)}>Thử lại</button>}</div>)}{images.map((image, index) => <div className={styles.imageRow} key={`${image.path}-${index}`}><span className={styles.imageName}>{image.name}</span><button className={styles.textButton} type="button" onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Gỡ</button></div>)}</section>
        </>}
        {showErrors && errors.length > 0 && <ul className={styles.errorList}>{errors.map((error) => <li key={error}>{error}</li>)}</ul>}
      </main>
      <footer className={styles.footer}>
        {wizard && <button className={styles.button} type="button" disabled={currentSection === 0} onClick={() => setCurrentSection((value) => value - 1)}>Quay lại</button>}
        {wizard && currentSection < sections.length - 1 ? <button className={`${styles.button} ${styles.primary}`} type="button" onClick={() => setCurrentSection((value) => value + 1)}>Tiếp tục</button> : <button className={`${styles.button} ${styles.primary}`} type="button" disabled={busy || uploads.some((item) => !item.error) || (!wizard && errors.length > 0)} onClick={() => void submit()}>Gửi phản hồi{showErrors && errors.length > 0 ? ` (${errors.length})` : ''}</button>}
      </footer>
    </div>
  );
}

function QuestionField({ instance, answers, context, otherTexts, setAnswer, toggleCheckbox, setOtherTexts }: {
  instance: QuestionInstance; answers: Answers; context: FeedbackFillContext; otherTexts: Record<string, string>;
  setAnswer: (key: string, value: FeedbackAnswerValue) => void; toggleCheckbox: (key: string, option: string) => void;
  setOtherTexts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}): JSX.Element {
  const { question, key } = instance;
  const options = optionsFor(question, context);
  const value = answers[key];
  const other = value === OTHER || (Array.isArray(value) && value.includes(OTHER));
  // div + role="group" thay cho fieldset/legend: hai element đó mang style UA
  // và luật layout riêng (fieldset từng bỏ qua flex/grid) nên hiển thị vỡ tùy
  // trình duyệt/global css — div trung tính thì module css toàn quyền.
  return <div className={styles.field}><div className={styles.label}>{question.label}{question.required && <span className={styles.required}> *</span>}</div>
    {question.type === 'text' && (question.multiline ? <textarea aria-label={question.label} className={styles.textarea} value={typeof value === 'string' ? value : ''} maxLength={MAX_TEXT} onChange={(event) => setAnswer(key, event.target.value)} /> : <input aria-label={question.label} className={styles.input} value={typeof value === 'string' ? value : ''} maxLength={MAX_TEXT} onChange={(event) => setAnswer(key, event.target.value)} />)}
    {question.type === 'scale' && <div className={styles.scale}>{Array.from({ length: (question.scaleMax ?? 5) - (question.scaleMin ?? 1) + 1 }, (_, index) => index + (question.scaleMin ?? 1)).map((number) => <button className={styles.scaleButton} key={number} type="button" aria-pressed={value === number} onClick={() => setAnswer(key, number)}>{number}</button>)}<span className={styles.scaleLabels}><span>Tệ</span><span>Tốt</span></span></div>}
    {(question.type === 'radio' || question.type === 'checkbox') && (options.length ? <div className={styles.options}>{[...options, ...(question.allowOther ? [OTHER] : [])].map((option) => <label className={styles.checkOption} data-selected={(question.type === 'radio' ? value === option : Array.isArray(value) && value.includes(option)) ? 'yes' : 'no'} key={option}><input type={question.type === 'radio' ? 'radio' : 'checkbox'} name={key} checked={question.type === 'radio' ? value === option : Array.isArray(value) && value.includes(option)} onChange={() => question.type === 'radio' ? setAnswer(key, option) : toggleCheckbox(key, option)} /><span>{option === OTHER ? 'Khác' : option}</span></label>)}</div> : <p className={styles.hint}>Không có bước nào trong ngữ cảnh</p>)}
    {other && <input className={styles.otherInput} aria-label={`Nội dung khác cho ${question.label}`} value={otherTexts[key] ?? ''} onChange={(event) => setOtherTexts((current) => ({ ...current, [key]: event.target.value }))} placeholder="Nhập nội dung khác" />}
  </div>;
}
