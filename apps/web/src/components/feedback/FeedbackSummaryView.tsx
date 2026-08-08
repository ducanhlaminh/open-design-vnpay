import { useMemo } from 'react';
import type {
  FeedbackAttachment,
  FeedbackFormDef,
  FeedbackQuestion,
  FeedbackSubmission,
} from '@open-design/contracts';
import styles from './FeedbackSummaryView.module.css';

export interface QuestionAggregate {
  question: FeedbackQuestion;
  instanceLabel?: string;
  total: number;
  optionCounts?: { option: string; count: number }[];
  otherTexts?: string[];
  scaleAverage?: number;
  scaleCounts?: { value: number; count: number }[];
  texts?: string[];
}

export interface VersionAggregate {
  form: FeedbackFormDef;
  submissionCount: number;
  sections: { title: string; items: QuestionAggregate[] }[];
}

function answerValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : [];
}

function aggregateQuestion(
  question: FeedbackQuestion,
  submissions: FeedbackSubmission[],
  instanceLabel?: string,
): QuestionAggregate {
  const key = instanceLabel === undefined ? question.id : `${question.id}@${instanceLabel}`;
  const rows = submissions.map((submission) => ({ submission, value: submission.answers[key] })).filter(({ value }) => value !== undefined && value !== '');
  const result: QuestionAggregate = { question, ...(instanceLabel === undefined ? {} : { instanceLabel }), total: rows.length };

  if (question.type === 'text') {
    result.texts = rows
      .map(({ submission, value }) => ({ at: submission.createdAt, text: String(value), user: submission.user }))
      .sort((a, b) => b.at - a.at)
      .map(({ user, text }) => `${user}: ${text}`);
  } else if (question.type === 'scale') {
    const values = rows.map(({ value }) => Number(value)).filter(Number.isFinite);
    const min = question.scaleMin ?? 1;
    const max = question.scaleMax ?? 5;
    result.scaleAverage = values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : 0;
    result.scaleCounts = Array.from({ length: max - min + 1 }, (_, index) => {
      const value = min + index;
      return { value, count: values.filter((item) => item === value).length };
    });
  } else {
    const observed = new Map<string, number>();
    const declared = question.options ?? [];
    for (const option of declared) observed.set(option, 0);
    for (const { value } of rows) for (const option of answerValues(value)) observed.set(option, (observed.get(option) ?? 0) + 1);
    result.optionCounts = [...observed.entries()].map(([option, count]) => ({ option, count }));
    result.otherTexts = rows.flatMap(({ submission, value }) => {
      const selected = answerValues(value);
      if (!selected.includes('__other__')) return [];
      const text = submission.otherTexts?.[key];
      return text ? [text] : [];
    });
  }
  return result;
}

/** Aggregate by immutable form version; orphan submissions stay visible. */
export function aggregateFeedback(forms: FeedbackFormDef[], submissions: FeedbackSubmission[]): VersionAggregate[] {
  const byVersion = new Map<number, FeedbackSubmission[]>();
  for (const submission of submissions) byVersion.set(submission.formVersion, [...(byVersion.get(submission.formVersion) ?? []), submission]);
  const known = forms.filter((form) => byVersion.has(form.version)).sort((a, b) => b.version - a.version);
  const result: VersionAggregate[] = known.map((form) => {
    const rows = byVersion.get(form.version) ?? [];
    const sections = form.sections?.length ? form.sections : [{ id: '', title: '' }];
    return {
      form,
      submissionCount: rows.length,
      sections: sections.map((section) => {
        const questions = form.questions.filter((question) => (question.sectionId ?? '') === section.id);
        const items: QuestionAggregate[] = [];
        for (const question of questions) {
          if (section.repeatForQuestionId) {
            const prefix = `${question.id}@`;
            const labels = [...new Set(rows.flatMap((row) => Object.keys(row.answers).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))))].sort((a, b) => a.localeCompare(b));
            for (const label of labels) items.push(aggregateQuestion(question, rows, label));
          } else items.push(aggregateQuestion(question, rows));
        }
        return { title: section.title, items };
      }),
    };
  });
  const orphans = submissions.filter((submission) => !forms.some((form) => form.version === submission.formVersion));
  if (orphans.length) {
    const form: FeedbackFormDef = { version: 0, title: 'Version không rõ', questions: [], createdAt: 0 };
    const keys = [...new Set(orphans.flatMap((submission) => Object.keys(submission.answers)))].sort();
    result.push({ form, submissionCount: orphans.length, sections: [{ title: '', items: keys.map((key) => ({ question: { id: key, label: key, type: 'text' }, total: orphans.filter((row) => row.answers[key] !== undefined).length, texts: orphans.filter((row) => row.answers[key] !== undefined).sort((a, b) => b.createdAt - a.createdAt).map((row) => `${row.user}: ${String(row.answers[key])}`) })) }] });
  }
  return result;
}

export interface FeedbackSummaryViewProps {
  /** Forms + submissions ĐÃ qua bộ lọc của host (FeedbackHomeView giữ filter
   * chung cho cả hai tab Tổng quan / Chi tiết). */
  forms: FeedbackFormDef[];
  submissions: FeedbackSubmission[];
  attachmentUrl: (path: string) => string;
}

/** Id anchor của một PHẦN trong tab Chi tiết — tab Tổng quan drill xuống bằng
 * scrollIntoView theo id này. */
export function sectionAnchorId(title: string): string {
  return `fb-sec-${title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function OptionBars({ item }: { item: QuestionAggregate }) {
  const counts = item.optionCounts ?? [];
  const max = Math.max(1, ...counts.map((entry) => entry.count));
  return <div className={styles.bars}>{counts.map(({ option, count }) => <div className={styles.barRow} key={option}><span className={styles.barLabel}>{option === '__other__' ? 'Khác' : option}</span><span className={styles.barTrack}><span className={styles.barFill} style={{ width: `${(count / max) * 100}%` }} /></span><span className={styles.barCount}>{count}</span></div>)}</div>;
}

function ScaleView({ item }: { item: QuestionAggregate }) {
  const max = item.question.scaleMax ?? 5;
  return <div className={styles.scale}><strong className={styles.average}>TB {item.scaleAverage ?? 0}/{max}</strong><div className={styles.histogram}>{(item.scaleCounts ?? []).map(({ value, count }) => <div className={styles.histogramCol} key={value}><span className={styles.histogramBar} style={{ height: `${Math.max(count * 18, count ? 18 : 3)}px` }} /><span>{value} <b>{count}</b></span></div>)}</div></div>;
}

function QuestionCard({ item }: { item: QuestionAggregate }) {
  return <article className={styles.question}><div className={styles.questionHeader}><h4 className={styles.questionTitle}>{item.question.label}</h4>{item.instanceLabel ? <span className={styles.badge}>{item.instanceLabel}</span> : null}</div>{item.question.type === 'scale' ? <ScaleView item={item} /> : item.question.type === 'text' ? <div className={styles.texts}>{(item.texts ?? []).map((text, index) => <p className={styles.textAnswer} key={`${text}-${index}`}>{text}</p>)}</div> : <><OptionBars item={item} />{item.otherTexts?.length ? <div className={styles.otherTexts}><strong>Khác</strong>{item.otherTexts.map((text, index) => <p className={styles.textAnswer} key={`${text}-${index}`}>{text}</p>)}</div> : null}</>}</article>;
}

function Attachments({ attachments, attachmentUrl }: { attachments: FeedbackAttachment[]; attachmentUrl: (path: string) => string }) {
  if (!attachments.length) return null;
  return <section className={styles.attachments}><h3 className={styles.sectionTitle}>Đính kèm</h3><div className={styles.gallery}>{attachments.map((attachment) => <a className={styles.attachment} href={attachmentUrl(attachment.path)} target="_blank" rel="noreferrer" key={attachment.path}><span className={styles.attachmentVisual}>{attachment.kind === 'image' ? <img className={styles.thumbnail} src={attachmentUrl(attachment.path)} alt={attachment.name} /> : '📄'}</span><span className={styles.attachmentName}>{attachment.name}</span>{attachment.stageId ? <span className={styles.stage}>{attachment.stageId}</span> : null}</a>)}</div></section>;
}

export function FeedbackSummaryView({ forms, submissions, attachmentUrl }: FeedbackSummaryViewProps): JSX.Element {
  const aggregates = useMemo(() => aggregateFeedback(forms, submissions), [forms, submissions]);
  const allAttachments = aggregates.map((aggregate) => ({ aggregate, attachments: submissions.filter((submission) => submission.formVersion === aggregate.form.version).flatMap((submission) => submission.attachments ?? []) }));
  return <main className={styles.page}>{!submissions.length ? <p className={styles.empty}>Chưa có bài gửi phù hợp. Hãy thử tắt bộ lọc.</p> : <div className={styles.versions}>{allAttachments.map(({ aggregate, attachments }) => <section className={styles.version} key={`${aggregate.form.version}-${aggregate.form.title}`}><h2 className={styles.versionTitle}>v{aggregate.form.version} · {aggregate.form.title} · {aggregate.submissionCount} bài gửi</h2>{aggregate.sections.map((section, index) => <section className={styles.section} id={section.title ? sectionAnchorId(section.title) : undefined} key={`${section.title}-${index}`}>{section.title ? <h3 className={styles.sectionTitle}>{section.title}</h3> : null}{section.items.map((item) => <QuestionCard item={item} key={`${item.question.id}-${item.instanceLabel ?? ''}`} />)}</section>)}<Attachments attachments={attachments} attachmentUrl={attachmentUrl} /></section>)}</div>}</main>;
}
