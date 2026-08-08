import type { FeedbackFormDef, FeedbackQuestion, FeedbackSubmission } from '@open-design/contracts';
import styles from './FeedbackOverview.module.css';

export interface OverviewData {
  kpis: { submissions: number; users: number; nps: number | null; avgQuality: number | null };
  sectionAverages: { sectionTitle: string; average: number; questionCount: number; sampleCount: number }[];
  stepAverages: { step: string; quality: number | null; stability: number | null }[];
  productionReady: { option: string; count: number }[];
}

export interface FeedbackOverviewProps {
  forms: FeedbackFormDef[];
  submissions: FeedbackSubmission[];
  onDrill?: (sectionTitle: string) => void;
}

const average = (values: number[]): number | null =>
  values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null;

const latestForm = (forms: FeedbackFormDef[]): FeedbackFormDef | undefined =>
  forms.reduce<FeedbackFormDef | undefined>((latest, form) => (!latest || form.version > latest.version ? form : latest), undefined);

const answerValues = (answer: unknown): unknown[] => (Array.isArray(answer) ? answer : [answer]);

function scaleValues(submissions: FeedbackSubmission[], question: FeedbackQuestion): number[] {
  const values: number[] = [];
  for (const submission of submissions) {
    for (const [key, answer] of Object.entries(submission.answers)) {
      if (key !== question.id && !key.startsWith(`${question.id}@`)) continue;
      for (const value of answerValues(answer)) {
        if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
      }
    }
  }
  return values;
}

function observedChoice(answer: unknown): string[] {
  return answerValues(answer).filter((value): value is string => typeof value === 'string');
}

export function overviewAggregate(forms: FeedbackFormDef[], submissions: FeedbackSubmission[]): OverviewData {
  const current = latestForm(forms);
  const questions = new Map<string, FeedbackQuestion>();
  for (const form of forms) {
    for (const question of form.questions) {
      const previous = questions.get(question.id);
      if (!previous || form.version > (forms.find((candidate) => candidate.questions.includes(previous))?.version ?? -1)) {
        questions.set(question.id, question);
      }
    }
  }
  // The map above must use the newest definition even when object identity is not stable.
  for (const form of [...forms].sort((a, b) => a.version - b.version)) {
    for (const question of form.questions) questions.set(question.id, question);
  }

  const npsQuestion = questions.get('nps');
  const npsValues = npsQuestion ? scaleValues(submissions, npsQuestion) : [];
  const promoters = npsValues.filter((value) => value >= 9).length;
  const detractors = npsValues.filter((value) => value <= 6).length;
  const qualityQuestions = [...questions.values()].filter((question) => question.type === 'scale' && question.scaleMax === 5 && question.id !== 'nps');
  const qualityValues = qualityQuestions.flatMap((question) => scaleValues(submissions, question));

  const sectionValues = new Map<string, { title: string; values: number[]; questionCount: number }>();
  const sections = current?.sections ?? [];
  for (const section of sections) {
    const sectionQuestions = current?.questions.filter((question) => question.sectionId === section.id && question.type === 'scale' && question.scaleMax === 5) ?? [];
    const values = sectionQuestions.flatMap((question) => scaleValues(submissions, question));
    if (values.length) sectionValues.set(section.id, { title: section.title, values, questionCount: sectionQuestions.length });
  }

  const repeatedSectionIds = new Set(sections.filter((section) => section.repeatForQuestionId).map((section) => section.id));
  const stepQuality = new Map<string, number[]>();
  const stepStability = new Map<string, number[]>();
  for (const section of sections.filter((item) => repeatedSectionIds.has(item.id))) {
    const sectionQuestions = current?.questions.filter((question) => question.sectionId === section.id) ?? [];
    for (const question of sectionQuestions) {
      if (question.type !== 'scale' && question.type !== 'radio') continue;
      for (const submission of submissions) {
        for (const [key, answer] of Object.entries(submission.answers)) {
          const prefix = `${question.id}@`;
          if (!key.startsWith(prefix)) continue;
          const step = key.slice(prefix.length);
          if (!step) continue;
          if (question.type === 'scale' && question.scaleMax === 5) {
            for (const value of answerValues(answer)) {
              if (typeof value === 'number' && Number.isFinite(value)) {
                const values = stepQuality.get(step) ?? [];
                values.push(value);
                stepQuality.set(step, values);
              }
            }
          }
          if (question.type === 'radio') {
            for (const choice of observedChoice(answer)) {
              const match = choice.match(/^\s*(\d+)/);
              if (match) {
                const values = stepStability.get(step) ?? [];
                values.push(Number(match[1]));
                stepStability.set(step, values);
              }
            }
          }
        }
      }
    }
  }

  const productionQuestion = questions.get('production-ready');
  const productionCounts = new Map<string, number>();
  const orderedOptions = productionQuestion?.options ?? [];
  for (const option of orderedOptions) productionCounts.set(option, 0);
  if (productionQuestion) {
    for (const submission of submissions) {
      for (const choice of observedChoice(submission.answers[productionQuestion.id])) {
        productionCounts.set(choice, (productionCounts.get(choice) ?? 0) + 1);
      }
    }
  }
  const productionReady = submissions.length === 0 ? [] : [...productionCounts.entries()]
    .filter(([option, count]) => orderedOptions.includes(option) || count > 0)
    .sort(([a], [b]) => (orderedOptions.indexOf(a) === -1 ? 1 : orderedOptions.indexOf(b) === -1 ? -1 : orderedOptions.indexOf(a) - orderedOptions.indexOf(b)))
    .map(([option, count]) => ({ option, count }));

  return {
    kpis: {
      submissions: submissions.length,
      users: new Set(submissions.map((submission) => submission.user)).size,
      nps: npsValues.length ? Math.round(((promoters - detractors) / npsValues.length) * 100) : null,
      avgQuality: average(qualityValues),
    },
    sectionAverages: [...sectionValues.values()].map(({ title, values, questionCount }) => ({ sectionTitle: title, average: average(values) as number, questionCount, sampleCount: values.length })),
    stepAverages: [...new Set([...stepQuality.keys(), ...stepStability.keys()])].sort().map((step) => ({ step, quality: average(stepQuality.get(step) ?? []), stability: average(stepStability.get(step) ?? []) })),
    productionReady,
  };
}

const npsClass = (value: number | null): string => (value === null ? styles.badgeNeutral ?? '' : value >= 50 ? styles.badgePositive ?? '' : value < 0 ? styles.badgeNegative ?? '' : styles.badgeNeutral ?? '');

export function FeedbackOverview({ forms, submissions, onDrill }: FeedbackOverviewProps): JSX.Element {
  if (!submissions.length) return <div className={styles.empty}>Chưa có bài gửi nào khớp bộ lọc.</div>;
  const data = overviewAggregate(forms, submissions);
  const maxProduction = Math.max(1, ...data.productionReady.map((item) => item.count));
  return (
    <div className={styles.page}>
      <div className={styles.kpis}>
        <Kpi label="Bài gửi" value={String(data.kpis.submissions)} />
        <Kpi label="Người gửi" value={String(data.kpis.users)} />
        <Kpi label="NPS" value={data.kpis.nps === null ? '—' : String(data.kpis.nps)} className={npsClass(data.kpis.nps)} />
        <Kpi label="Chất lượng TB" value={data.kpis.avgQuality === null ? '—' : `${data.kpis.avgQuality}/5`} />
      </div>
      <section className={styles.panel}>
        <h3 className={styles.panelTitle}>Điểm trung bình theo phần</h3>
        <div className={styles.bars}>
          {data.sectionAverages.map((item) => <button className={styles.barRow} key={item.sectionTitle} type="button" onClick={() => onDrill?.(item.sectionTitle)}><span className={styles.barLabel}>{item.sectionTitle}<small className={styles.sample}>{item.sampleCount} điểm dữ liệu</small></span><span className={styles.barTrack}><span className={styles.barFill} style={{ width: `${Math.max(0, Math.min(100, item.average / 5 * 100))}%` }} /></span><strong className={styles.barValue}>{item.average}</strong></button>)}
        </div>
      </section>
      <section className={styles.panel}>
        <h3 className={styles.panelTitle}>Theo từng bước pipeline</h3>
        <div className={styles.steps}>{data.stepAverages.map((item) => <div className={styles.step} key={item.step}><strong className={styles.stepTitle}>{item.step}</strong><Metric label="Chất lượng" value={item.quality} max={5} /><Metric label="Ổn định" value={item.stability} max={4} secondary /></div>)}</div>
      </section>
      {data.productionReady.length > 0 && <section className={styles.panel}><h3 className={styles.panelTitle}>Sẵn sàng dùng thật?</h3><div className={styles.productionTrack}>{data.productionReady.map((item, index) => <span className={styles.productionFill} key={item.option} style={{ width: `${item.count / data.productionReady.reduce((sum, current) => sum + current.count, 0) * 100}%`, opacity: 1 - index * 0.12 }} />)}</div><div className={styles.legend}>{data.productionReady.map((item, index) => <span className={styles.legendItem} key={item.option}><i className={styles.legendDot} style={{ opacity: 1 - index * 0.12 }} />{item.option} <b>{item.count}</b></span>)}</div></section>}
    </div>
  );
}

function Kpi({ label, value, className = '' }: { label: string; value: string; className?: string }): JSX.Element { return <div className={styles.kpi}><span className={styles.kpiLabel}>{label}</span><strong className={`${styles.kpiValue} ${className}`}>{value}</strong></div>; }
function Metric({ label, value, max, secondary = false }: { label: string; value: number | null; max: number; secondary?: boolean }): JSX.Element { return <div className={styles.metric}><span className={styles.metricLabel}>{label}</span>{value === null ? <strong className={styles.metricValue}>—</strong> : <><span className={styles.metricTrack}><span className={`${styles.metricFill} ${secondary ? styles.secondary : ''}`} style={{ width: `${Math.max(0, Math.min(100, value / max * 100))}%` }} /></span><strong className={styles.metricValue}>{value}/{max}</strong></>}</div>; }
