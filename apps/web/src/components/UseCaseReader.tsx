import { useEffect, useMemo, useState, type ReactNode } from 'react';
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

type StepExtraRenderer = (node: FlowchartNode, surface?: 'card' | 'carousel') => ReactNode;

function StepCard({ step, stepIndex, renderStepExtra, last, loop }: { step: FlowUseCase['steps'][number]; stepIndex: number; renderStepExtra?: StepExtraRenderer; last?: boolean; loop?: boolean }) {
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

function DetailView({ useCase, entryPath, index, total, onBack, onMove, renderStepExtra }: { useCase: FlowUseCase; entryPath: FlowUseCase['steps']; index: number; total: number; onBack: () => void; onMove: (delta: number) => void; renderStepExtra?: StepExtraRenderer }) {
  const [activeStep, setActiveStep] = useState(0);
  const allSteps = [...entryPath, ...useCase.steps];
  const loopTargetIndex = useCase.loopToNodeId ? allSteps.findIndex((step) => step.node.id === useCase.loopToNodeId) : -1;
  const current = allSteps[Math.min(activeStep, Math.max(0, allSteps.length - 1))];
  const currentExtra = current ? renderStepExtra?.(current.node, 'carousel') : null;
  const isShared = activeStep < entryPath.length;
  const canGoBack = activeStep > 0;
  const canGoForward = activeStep < allSteps.length - 1;
  useEffect(() => setActiveStep(0), [useCase.id]);
  return (
    <div className={styles.detailView}>
      <div className={styles.detailHead}>
        <button type="button" className={styles.backButton} onClick={onBack}>← Kịch bản</button>
        <div className={styles.detailHeadingText}>
          <span className={styles.detailEyebrow}>Chi tiết kịch bản {index + 1}/{total}</span>
          <h2 className={styles.detailTitle}>{useCase.title}</h2>
        </div>
        <div className={styles.detailOutcome}><OutcomeBadge outcome={useCase.outcome} /></div>
      </div>
      <section
        className={styles.stepCarousel}
        aria-label={`Các bước của ${useCase.title}`}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' && canGoBack) setActiveStep((value) => value - 1);
          if (event.key === 'ArrowRight' && canGoForward) setActiveStep((value) => value + 1);
        }}
      >
        <div className={styles.stepCarouselTopbar}>
          <div>
            <span className={styles.stepCarouselLabel}>{isShared ? 'Bước chung' : 'Bước của nhánh này'}</span>
            <strong>Bước {activeStep + 1} / {allSteps.length}</strong>
          </div>
          <div className={styles.stepCarouselArrows}>
            <button type="button" aria-label="Bước trước" title="Bước trước (←)" disabled={!canGoBack} onClick={() => setActiveStep((value) => value - 1)}>‹</button>
            <button type="button" aria-label="Bước tiếp theo" title="Bước tiếp theo (→)" disabled={!canGoForward} onClick={() => setActiveStep((value) => value + 1)}>›</button>
          </div>
        </div>
        {current ? (
          <article key={`${useCase.id}-${activeStep}`} className={`${styles.stepCarouselSlide} ${!currentExtra ? styles.stepCarouselSlideTextOnly : ''} ${useCase.outcome === 'loop' && !canGoForward ? styles.stepCarouselSlideLoop : ''}`} tabIndex={0}>
            <div className={styles.stepCarouselCopy}>
              <div className={styles.stepTop}>
                <span>#{activeStep + 1}</span>
                <span className={`${styles.kindBadge} ${styles[`kind${pascalCase(current.node.type)}` as keyof typeof styles] ?? ''}`}>{STEP_KIND_LABELS[current.node.type]}</span>
              </div>
              <h3 className={styles.stepCarouselTitle}>{current.node.label}</h3>
              {current.answer ? <span className={styles.answerChip}>Lựa chọn: {current.answer}</span> : null}
              {useCase.outcome === 'loop' && !canGoForward ? (
                <div className={styles.loopNotice}>↩ {loopTargetIndex >= 0 ? `Quay lại bước #${loopTargetIndex + 1}` : 'Quay lại bước trước'}</div>
              ) : null}
            </div>
            {currentExtra ? <div className={styles.stepCarouselPreview}>{currentExtra}</div> : null}
          </article>
        ) : <div className={styles.stepCarouselEmpty}>Kịch bản chưa có bước để hiển thị.</div>}
        <div className={styles.stepCarouselProgress} role="tablist" aria-label="Chọn bước">
          {allSteps.map((step, stepIndex) => (
            <button
              key={`${step.node.id}-${stepIndex}`}
              type="button"
              role="tab"
              aria-selected={stepIndex === activeStep}
              className={stepIndex === activeStep ? styles.stepProgressActive : ''}
              onClick={() => setActiveStep(stepIndex)}
              title={`Bước ${stepIndex + 1}: ${step.node.label}`}
            >
              <span>{stepIndex + 1}</span>
              <small>{step.node.label}</small>
            </button>
          ))}
        </div>
      </section>
      <p className={styles.detailDescription}>{useCase.description || 'Luồng thẳng, không rẽ nhánh'}</p>
      <div className={styles.detailNav}>
        <button type="button" disabled={index === 0} onClick={() => onMove(-1)}>‹ Kịch bản trước</button>
        <button type="button" disabled={index === total - 1} onClick={() => onMove(1)}>Kịch bản sau ›</button>
      </div>
    </div>
  );
}

export function UseCaseReader({ doc, renderStepExtra }: { doc: FlowchartDoc; renderStepExtra?: StepExtraRenderer }): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const result = useMemo(() => deriveUseCasesWithEntry(doc), [doc]);
  const ordered = useMemo(() => [...result.useCases].sort((a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]), [result.useCases]);
  const selected = selectedId ? ordered.find((item) => item.id === selectedId) : undefined;
  if (!selected) return <UseCaseList doc={doc} entryPath={result.entryPath} useCases={result.useCases} truncated={result.truncated} onSelect={setSelectedId} />;
  const index = ordered.indexOf(selected);
  return <DetailView useCase={selected} entryPath={result.entryPath} index={index} total={ordered.length} onBack={() => setSelectedId(null)} onMove={(delta) => { const next = ordered[index + delta]; if (next) setSelectedId(next.id); }} renderStepExtra={renderStepExtra} />;
}
