import { useRef, type KeyboardEvent } from 'react';

import styles from './DocRedlineModeControls.module.css';
import { modeCountLabel, type PreviewMode } from './redline-mode';

export interface DocRedlineModeControlsProps {
  mode: PreviewMode;
  changeCount: number;
  noteCount: number;
  onModeChange: (mode: PreviewMode) => void;
  placement: 'document' | 'rail';
}

const MODES: readonly PreviewMode[] = ['changes', 'notes'];

/**
 * Controlled mode switch shared by the document header and annotation rail.
 * The parent owns the single mode state so both placements always agree.
 */
export function DocRedlineModeControls({
  mode,
  changeCount,
  noteCount,
  onModeChange,
  placement,
}: DocRedlineModeControlsProps) {
  const changeRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLButtonElement>(null);

  function activate(nextMode: PreviewMode, moveFocus: boolean): void {
    if (moveFocus) {
      (nextMode === 'changes' ? changeRef : noteRef).current?.focus();
    }
    if (nextMode !== mode) onModeChange(nextMode);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentMode: PreviewMode): void {
    const currentIndex = MODES.indexOf(currentMode);
    let nextMode: PreviewMode | undefined;

    switch (event.key) {
      case 'ArrowLeft':
        nextMode = MODES[(currentIndex - 1 + MODES.length) % MODES.length];
        break;
      case 'ArrowRight':
        nextMode = MODES[(currentIndex + 1) % MODES.length];
        break;
      case 'Home':
        nextMode = MODES[0];
        break;
      case 'End':
        nextMode = MODES[MODES.length - 1];
        break;
      default:
        return;
    }

    event.preventDefault();
    if (nextMode) activate(nextMode, true);
  }

  return (
    <div
      className={styles.root ?? ''}
      role="tablist"
      aria-label="Chế độ xem tài liệu"
      data-placement={placement}
    >
      {MODES.map((itemMode) => {
        const selected = itemMode === mode;
        const count = itemMode === 'changes' ? changeCount : noteCount;
        const idPrefix = `doc-redline-${placement}`;
        return (
          <button
            key={itemMode}
            id={`${idPrefix}-${itemMode}-tab`}
            ref={itemMode === 'changes' ? changeRef : noteRef}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-tabpanel`}
            tabIndex={selected ? 0 : -1}
            className={`${styles.tab ?? ''} ${selected ? styles.tabSelected ?? '' : ''}`}
            onClick={() => activate(itemMode, false)}
            onKeyDown={(event) => handleKeyDown(event, itemMode)}
          >
            {modeCountLabel(itemMode, count)}
          </button>
        );
      })}
    </div>
  );
}
