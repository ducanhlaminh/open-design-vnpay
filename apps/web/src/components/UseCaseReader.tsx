import { useMemo, useState, type ReactNode } from 'react';
import styles from './UseCaseReader.module.css';
import {
  deriveUseCases,
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

function UseCaseList({ doc, useCases, truncated, onSelect }: { doc: FlowchartDoc; useCases: FlowUseCase[]; truncated: boolean; onSelect: (id: string) => void }) {
  const ordered = [...useCases].sort((a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]);
  return (
    <div className={styles.scenarioView}>
      <div className={styles.scenarioHead}>
        <h2 className={styles.scenarioTitle}>{doc.title ?? doc.id}</h2>
        <p className={styles.scenarioMeta}>{useCases.length} kịch bản · {doc.nodes.length} bước · nguồn: <code title={doc.source}>{doc.source ?? '—'}</code></p>
      </div>
      {truncated ? <div className={styles.truncatedBanner} role="alert">Sơ đồ có quá nhiều nhánh — chỉ hiện {useCases.length} kịch bản đầu</div> : null}
      <div className={styles.scenarioList}>
        {ordered.map((useCase) => (
          <button key={useCase.id} type="button" className={styles.scenarioCard} onClick={() => onSelect(useCase.id)}>
            <OutcomeBadge outcome={useCase.outcome} />
            <span className={styles.scenarioCardBody}>
              <strong className={styles.scenarioCardTitle}>{useCase.title}</strong>
              <span className={styles.scenarioCardDescription}>{useCase.description || 'Luồng thẳng, không rẽ nhánh'}</span>
            </span>
            <span className={styles.scenarioCardSteps}>{useCase.steps.length} bước <span aria-hidden="true">→</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DetailView({ useCase, index, total, onBack, onMove, renderStepExtra }: { useCase: FlowUseCase; index: number; total: number; onBack: () => void; onMove: (delta: number) => void; renderStepExtra?: (node: FlowchartNode) => ReactNode }) {
  const loopTargetIndex = useCase.loopToNodeId ? useCase.steps.findIndex((step) => step.node.id === useCase.loopToNodeId) : -1;
  return (
    <div className={styles.detailView}>
      <div className={styles.detailHead}>
        <button type="button" className={styles.backButton} onClick={onBack}>← Kịch bản</button>
        <h2 className={styles.detailTitle}>{useCase.title}</h2>
        <OutcomeBadge outcome={useCase.outcome} />
      </div>
      <div className={styles.stepScroller}>
        <div className={styles.stepTrack}>
          {useCase.steps.map((step, stepIndex) => (
            <div className={styles.stepItem} key={`${step.node.id}-${stepIndex}`}>
              <article className={`${styles.stepCard} ${stepIndex === useCase.steps.length - 1 && useCase.outcome === 'loop' ? styles.stepCardLast : ''}`}>
                <div className={styles.stepTop}><span>#{stepIndex + 1}</span><span className={`${styles.kindBadge} ${styles[`kind${pascalCase(step.node.type)}` as keyof typeof styles] ?? ''}`}>{STEP_KIND_LABELS[step.node.type]}</span></div>
                <strong className={styles.stepLabel} title={step.node.label}>{step.node.label}</strong>
                {step.answer ? <span className={styles.answerChip}>Chọn: {step.answer}</span> : null}
                {renderStepExtra?.(step.node)}
              </article>
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
  const result = useMemo(() => deriveUseCases(doc), [doc]);
  const ordered = useMemo(() => [...result.useCases].sort((a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]), [result.useCases]);
  const selected = selectedId ? ordered.find((item) => item.id === selectedId) : undefined;
  if (!selected) return <UseCaseList doc={doc} useCases={result.useCases} truncated={result.truncated} onSelect={setSelectedId} />;
  const index = ordered.indexOf(selected);
  return <DetailView useCase={selected} index={index} total={ordered.length} onBack={() => setSelectedId(null)} onMove={(delta) => { const next = ordered[index + delta]; if (next) setSelectedId(next.id); }} renderStepExtra={renderStepExtra} />;
}
