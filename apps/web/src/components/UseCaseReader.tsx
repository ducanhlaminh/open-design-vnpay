import { useMemo, useState, type ReactNode } from 'react';
import styles from './UseCaseReader.module.css';
import {
  deriveUseCasesWithEntry,
  OUTCOME_LABELS,
  STEP_KIND_LABELS,
  type FlowUseCase,
  type UseCaseOutcome,
} from './flow-usecases';
import type { FlowchartDoc, FlowchartNode } from './FlowchartPreview';

const OUTCOME_ORDER: Record<UseCaseOutcome, number> = {
  success: 0,
  neutral: 1,
  loop: 2,
  blocked: 3,
};

function pascalCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function outcomeClass(outcome: UseCaseOutcome): string {
  return styles[`outcome${pascalCase(outcome)}` as keyof typeof styles] ?? '';
}

function OutcomeBadge({ outcome }: { outcome: UseCaseOutcome }) {
  return <span className={`${styles.outcomeBadge} ${outcomeClass(outcome)}`}>{OUTCOME_LABELS[outcome]}</span>;
}

function StepCard({ step, stepIndex, renderStepExtra, last, loop }: { step: FlowUseCase['steps'][number]; stepIndex: number; renderStepExtra?: (node: FlowchartNode) => ReactNode; last?: boolean; loop?: boolean }) {
  return <article className={`${styles.stepCard} ${last && loop ? styles.stepCardLast : ''}`}>
    <div className={styles.stepTop}><span>#{stepIndex + 1}</span><span className={`${styles.kindBadge} ${styles[`kind${pascalCase(step.node.type)}` as keyof typeof styles] ?? ''}`}>{STEP_KIND_LABELS[step.node.type]}</span></div>
    <strong className={styles.stepLabel} title={step.node.label}>{step.node.label}</strong>
    {step.answer ? <span className={styles.answerChip}>Chọn: {step.answer}</span> : null}
    {renderStepExtra?.(step.node)}
  </article>;
}

function UseCaseList({ doc, entryPath, useCases, truncated, onSelect }: { doc: FlowchartDoc; entryPath: FlowUseCase['steps']; useCases: FlowUseCase[]; truncated: boolean; onSelect: (id: string) => void }) {
  const [entryOpen, setEntryOpen] = useState(false);
  const ordered = [...useCases].sort((a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]);
  const entrySummary = entryPath.map((step) => step.node.label).join(' → ');
  return (
    <div className={styles.scenarioView}>
      <div className={styles.scenarioHead}>
        <h2 className={styles.scenarioTitle}>{doc.title ?? doc.id}</h2>
        <p className={styles.scenarioMeta}>{useCases.length} kịch bản · {doc.nodes.length} bước · nguồn: <code title={doc.source}>{doc.source ?? '—'}</code></p>
      </div>
      {truncated ? <div className={styles.truncatedBanner} role="alert">Sơ đồ có quá nhiều nhánh — chỉ hiện {useCases.length} kịch bản đầu</div> : null}
      {entryPath.length > 0 ? <section className={styles.entrySummary}>
        <button type="button" className={styles.entrySummaryButton} aria-expanded={entryOpen} onClick={() => setEntryOpen((open) => !open)}>
          <strong>Các bước chung</strong><span className={styles.entrySummaryText}>{entrySummary}</span><span aria-hidden="true">{entryOpen ? '⌃' : '⌄'}</span>
        </button>
        {entryOpen ? <div className={styles.entryTrack}>{entryPath.map((step, index) => <div className={styles.stepItem} key={`${step.node.id}-${index}`}><StepCard step={step} stepIndex={index} />{index < entryPath.length - 1 ? <span className={styles.stepArrow} aria-hidden="true">→</span> : null}</div>)}</div> : null}
      </section> : null}
      <div className={styles.scenarioList}>
        {ordered.map((useCase) => (
          <button key={useCase.id} type="button" className={styles.scenarioCard} onClick={() => onSelect(useCase.id)}>
            <OutcomeBadge outcome={useCase.outcome} />
            <span className={styles.scenarioCardBody}>
              <strong className={styles.scenarioCardTitle}>{useCase.title}</strong>
              <span className={styles.scenarioCardDescription}>{useCase.description || 'Luồng thẳng, không rẽ nhánh'}</span>
            </span>
            <span className={styles.scenarioCardSteps}>{useCase.steps.length + entryPath.length} bước <span aria-hidden="true">→</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DetailView({ useCase, entryPath, index, total, onBack, onMove, renderStepExtra }: { useCase: FlowUseCase; entryPath: FlowUseCase['steps']; index: number; total: number; onBack: () => void; onMove: (delta: number) => void; renderStepExtra?: (node: FlowchartNode) => ReactNode }) {
  const [entryOpen, setEntryOpen] = useState(false);
  const allSteps = [...entryPath, ...useCase.steps];
  const loopTargetIndex = useCase.loopToNodeId ? allSteps.findIndex((step) => step.node.id === useCase.loopToNodeId) : -1;
  return (
    <div className={styles.detailView}>
      <div className={styles.detailHead}>
        <button type="button" className={styles.backButton} onClick={onBack}>← Kịch bản</button>
        <h2 className={styles.detailTitle}>{useCase.title}</h2>
        <OutcomeBadge outcome={useCase.outcome} />
      </div>
      <div className={styles.stepScroller}>
        <div className={styles.stepTrack}>
          {entryPath.length > 0 ? <div className={styles.stepItem}><button type="button" className={styles.entryCollapsed} aria-expanded={entryOpen} onClick={() => setEntryOpen((open) => !open)}>↪ Các bước chung ({entryPath.length}) <span aria-hidden="true">{entryOpen ? '⌃' : '⌄'}</span></button>{entryOpen ? entryPath.map((step, stepIndex) => <div className={styles.stepItem} key={`entry-${step.node.id}-${stepIndex}`}><StepCard step={step} stepIndex={stepIndex} renderStepExtra={renderStepExtra} />{stepIndex < entryPath.length - 1 ? <span className={styles.stepArrow} aria-hidden="true">→</span> : null}</div>) : null}{useCase.steps.length > 0 ? <span className={styles.stepArrow} aria-hidden="true">→</span> : null}</div> : null}
          {useCase.steps.map((step, stepIndex) => (
            <div className={styles.stepItem} key={`${step.node.id}-${stepIndex}`}>
              <StepCard step={step} stepIndex={entryPath.length + stepIndex} renderStepExtra={renderStepExtra} last={stepIndex === useCase.steps.length - 1} loop={useCase.outcome === 'loop'} />
              {stepIndex < useCase.steps.length - 1 ? <span className={styles.stepArrow} aria-hidden="true">→</span> : null}
            </div>
          ))}
          {useCase.outcome === 'loop' ? <div className={styles.loopItem}><span className={styles.stepArrow} aria-hidden="true">→</span><article className={`${styles.stepCard} ${styles.loopCard}`}><strong>↩ {loopTargetIndex >= 0 ? `Quay lại bước #${loopTargetIndex + 1}` : 'Quay lại bước trước'}</strong></article></div> : null}
        </div>
      </div>
      <p className={styles.detailDescription}>{useCase.description || 'Luồng thẳng, không rẽ nhánh'}</p>
      <div className={styles.detailNav}>
        <button type="button" disabled={index === 0} onClick={() => onMove(-1)}>‹ Kịch bản trước</button>
        <button type="button" disabled={index === total - 1} onClick={() => onMove(1)}>Kịch bản sau ›</button>
      </div>
    </div>
  );
}

export function UseCaseReader({ doc, renderStepExtra }: { doc: FlowchartDoc; renderStepExtra?: (node: FlowchartNode) => ReactNode }): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const result = useMemo(() => deriveUseCasesWithEntry(doc), [doc]);
  const ordered = useMemo(() => [...result.useCases].sort((a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]), [result.useCases]);
  const selected = selectedId ? ordered.find((item) => item.id === selectedId) : undefined;
  if (!selected) return <UseCaseList doc={doc} entryPath={result.entryPath} useCases={result.useCases} truncated={result.truncated} onSelect={setSelectedId} />;
  const index = ordered.indexOf(selected);
  return <DetailView useCase={selected} entryPath={result.entryPath} index={index} total={ordered.length} onBack={() => setSelectedId(null)} onMove={(delta) => { const next = ordered[index + delta]; if (next) setSelectedId(next.id); }} renderStepExtra={renderStepExtra} />;
}
