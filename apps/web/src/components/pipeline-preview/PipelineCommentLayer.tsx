// Per-component comment overlay for the pipeline UI preview. The runtime iframe
// is same-origin (served from /preview-runtime-v3/), so the host can read its
// DOM directly — no runtime rebuild, no postMessage bridge. We locate the
// design-v3 nodes by their data-node-id (the screen.json node id the adapter
// propagates) and anchor comments to that id, so pins survive theme/branding
// switches and re-renders (unlike CSS-selector / pixel anchoring).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from './PipelineCommentLayer.module.css';
import {
  loadComments,
  newCommentId,
  saveComments,
  type NodeComment,
} from './pipeline-comments';

interface Props {
  iframe: HTMLIFrameElement | null;
  projectId: string;
  screenPath: string;
  active: boolean;
  onCountChange?: (n: number) => void;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface Target {
  nodeId: string;
  label: string;
  rect: Rect;
}

function escapeId(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(id);
  return id.replace(/["\\]/g, '\\$&');
}

export function PipelineCommentLayer({ iframe, projectId, screenPath, active, onCountChange }: Props) {
  const [comments, setComments] = useState<NodeComment[]>([]);
  const [hover, setHover] = useState<Target | null>(null);
  const [draft, setDraft] = useState<Target | null>(null);
  const [draftText, setDraftText] = useState('');
  const [openPin, setOpenPin] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [, setTick] = useState(0);
  const layerRef = useRef<HTMLDivElement | null>(null);

  // Load persisted comments for this screen.
  useEffect(() => {
    let alive = true;
    void loadComments(projectId, screenPath).then((list) => {
      if (alive) setComments(list);
    });
    return () => {
      alive = false;
    };
  }, [projectId, screenPath]);

  useEffect(() => onCountChange?.(comments.length), [comments.length, onCountChange]);

  const doc = (): Document | null => {
    try {
      return iframe?.contentDocument ?? null;
    } catch {
      return null;
    }
  };

  // Live rect for a node id, in overlay coordinates (= the iframe's own viewport,
  // since the overlay exactly overlays the iframe).
  const rectForNode = useCallback(
    (nodeId: string): Rect | null => {
      const d = doc();
      if (!d) return null;
      const el = d.querySelector(`[data-node-id="${escapeId(nodeId)}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    },
    [iframe],
  );

  const targetAtPoint = useCallback(
    (clientX: number, clientY: number): Target | null => {
      const d = doc();
      if (!d || !iframe) return null;
      const frame = iframe.getBoundingClientRect();
      const x = clientX - frame.left;
      const y = clientY - frame.top;
      let el = d.elementFromPoint(x, y) as Element | null;
      while (el && el !== d.documentElement) {
        const nodeId = el.getAttribute?.('data-node-id');
        if (nodeId) {
          const r = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);
          return {
            nodeId,
            label: txt ? `${tag} · "${txt}"` : tag,
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          };
        }
        el = el.parentElement;
      }
      return null;
    },
    [iframe],
  );

  // Recompute pin positions on iframe scroll / resize / theme reflow. A light
  // interval covers reflows we can't subscribe to (theme cssText re-injection);
  // it only runs while there is something to position.
  useEffect(() => {
    const needsTracking = active || comments.length > 0 || draft !== null;
    if (!needsTracking) return;
    const bump = () => setTick((t) => (t + 1) % 1_000_000);
    const id = window.setInterval(bump, 250);
    window.addEventListener('resize', bump);
    let win: Window | null = null;
    try {
      win = iframe?.contentWindow ?? null;
      win?.addEventListener('scroll', bump, true);
    } catch {
      win = null;
    }
    return () => {
      window.clearInterval(id);
      window.removeEventListener('resize', bump);
      try {
        win?.removeEventListener('scroll', bump, true);
      } catch {
        /* gone */
      }
    };
  }, [active, comments.length, draft, iframe]);

  // Leaving comment mode clears transient UI.
  useEffect(() => {
    if (!active) {
      setHover(null);
      setDraft(null);
      setDraftText('');
    }
  }, [active]);

  const persist = async (next: NodeComment[]) => {
    setComments(next);
    setSaving(true);
    try {
      await saveComments(projectId, screenPath, next);
    } catch {
      // Keep the optimistic state; a reload reconciles from disk.
    } finally {
      setSaving(false);
    }
  };

  // The capture surface blocks pointer events to the runtime, so forward wheel
  // to the runtime's scroll container — otherwise long screens can't scroll
  // while commenting.
  const onCaptureWheel = (e: React.WheelEvent) => {
    const d = doc();
    if (!d) return;
    const scroller =
      (d.querySelector('[data-theme-frame] .overflow-y-auto') as HTMLElement | null) ??
      (d.scrollingElement as HTMLElement | null);
    if (scroller) {
      scroller.scrollTop += e.deltaY;
      scroller.scrollLeft += e.deltaX;
    }
  };

  const onCaptureMove = (e: React.MouseEvent) => {
    if (draft) return;
    setHover(targetAtPoint(e.clientX, e.clientY));
  };
  const onCaptureClick = (e: React.MouseEvent) => {
    const t = targetAtPoint(e.clientX, e.clientY);
    if (!t) return;
    setDraft(t);
    setDraftText('');
    setHover(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const text = draftText.trim();
    if (!text) {
      setDraft(null);
      return;
    }
    const comment: NodeComment = {
      id: newCommentId(draft.nodeId, comments),
      nodeId: draft.nodeId,
      label: draft.label,
      text,
      createdAt: Date.now(),
    };
    setDraft(null);
    setDraftText('');
    await persist([...comments, comment]);
  };

  const removeComment = async (id: string) => {
    setOpenPin(null);
    await persist(comments.filter((c) => c.id !== id));
  };

  // Group comments by node so multiple comments share one pin.
  const pins = useMemo(() => {
    const byNode = new Map<string, NodeComment[]>();
    for (const c of comments) {
      const arr = byNode.get(c.nodeId) ?? [];
      arr.push(c);
      byNode.set(c.nodeId, arr);
    }
    return Array.from(byNode.entries());
  }, [comments]);

  const draftRect = draft ? (rectForNode(draft.nodeId) ?? draft.rect) : null;

  return (
    <div ref={layerRef} className={styles.layer}>
      {active && (
        <div
          className={styles.capture}
          onMouseMove={onCaptureMove}
          onMouseLeave={() => setHover(null)}
          onClick={onCaptureClick}
          onWheel={onCaptureWheel}
        />
      )}

      {active && hover && !draft && (
        <div
          className={styles.hoverBox}
          style={{ left: hover.rect.left, top: hover.rect.top, width: hover.rect.width, height: hover.rect.height }}
        >
          <span className={styles.hoverTag}>{hover.nodeId}</span>
        </div>
      )}

      {pins.map(([nodeId, list], i) => {
        const rect = rectForNode(nodeId);
        if (!rect) return null;
        const isOpen = list.some((c) => c.id === openPin);
        return (
          <div key={nodeId}>
            <div
              className={styles.anchorBox}
              style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            />
            <button
              type="button"
              className={isOpen ? `${styles.pin} ${styles.pinOpen}` : styles.pin}
              style={{ left: rect.left, top: rect.top }}
              onClick={() => setOpenPin(isOpen ? null : (list[0]?.id ?? null))}
              title={`${list.length} comment${list.length > 1 ? 's' : ''} on ${nodeId}`}
            >
              {i + 1}
            </button>
            {isOpen && (
              <div
                className={styles.popover}
                style={{ left: rect.left, top: rect.top + Math.max(rect.height, 18) + 6 }}
              >
                <div className={styles.popHead}>
                  <span className={styles.popNode} title={nodeId}>{nodeId}</span>
                  <button type="button" className={styles.popClose} onClick={() => setOpenPin(null)}>×</button>
                </div>
                {list.map((c) => (
                  <div key={c.id} className={styles.commentItem}>
                    <p className={styles.commentText}>{c.text}</p>
                    <button type="button" className={styles.commentDel} onClick={() => void removeComment(c.id)}>
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {draft && draftRect && (
        <>
          <div
            className={styles.draftBox}
            style={{ left: draftRect.left, top: draftRect.top, width: draftRect.width, height: draftRect.height }}
          />
          <div
            className={styles.composer}
            style={{ left: draftRect.left, top: draftRect.top + Math.max(draftRect.height, 18) + 6 }}
          >
            <div className={styles.composerHead} title={draft.label}>{draft.nodeId}</div>
            <textarea
              className={styles.composerInput}
              autoFocus
              value={draftText}
              placeholder="Comment on this component…"
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveDraft();
                if (e.key === 'Escape') {
                  setDraft(null);
                  setDraftText('');
                }
              }}
            />
            <div className={styles.composerActions}>
              <button type="button" className={styles.btnGhost} onClick={() => { setDraft(null); setDraftText(''); }}>
                Cancel
              </button>
              <button type="button" className={styles.btnPrimary} disabled={saving || !draftText.trim()} onClick={() => void saveDraft()}>
                {saving ? 'Saving…' : 'Comment'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
