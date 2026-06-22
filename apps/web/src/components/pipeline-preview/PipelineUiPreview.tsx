// Combines the embedded design-v3 preview runtime with the theme/branding
// inspector and a per-component comment overlay. The panel resolves a
// composition → cssVars/cssText/tokens, which drive the iframe live
// (preview.theme). The comment layer reads the same-origin runtime DOM to anchor
// comments by screen.json node id. This is what FileViewer renders for a
// pipeline UI screen artifact (screen.json).

import { useState } from 'react';

import { PipelineCommentLayer } from './PipelineCommentLayer';
import { PipelinePreviewIframe } from './PipelinePreviewIframe';
import { ThemeInspectorPanel } from './ThemeInspectorPanel';
import type { ThemeLabResolved } from './theme-lab-api';

interface Props {
  /** Parsed + adapted screen spec (runtime {layout:{tree}} shape). */
  spec: unknown;
  /** design-v3 theme workspace (default ws-catalog-shadcn). */
  workspaceId?: string;
  /** Project + screen path — enables the per-component comment overlay. */
  projectId?: string;
  screenPath?: string;
}

export function PipelineUiPreview({ spec, workspaceId, projectId, screenPath }: Props) {
  const [resolved, setResolved] = useState<ThemeLabResolved | null>(null);
  const [mode, setMode] = useState<string>('light');
  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null);
  const [commentMode, setCommentMode] = useState(false);
  const [commentCount, setCommentCount] = useState(0);

  const canComment = Boolean(projectId && screenPath);

  return (
    <div className="pipeline-ui-preview" style={{ display: 'flex', height: '100%', width: '100%' }}>
      <div
        className="pipeline-ui-preview__canvas"
        style={{ flex: 1, minWidth: 0, position: 'relative' }}
      >
        {canComment && (
          <div className="pipeline-ui-preview__toolbar" style={toolbarStyle}>
            <button
              type="button"
              onClick={() => setCommentMode((v) => !v)}
              style={commentMode ? { ...toolbarBtn, ...toolbarBtnActive } : toolbarBtn}
              title="Comment on a component — click it in the preview"
            >
              <CommentIcon />
              <span>{commentMode ? 'Commenting…' : 'Comment'}</span>
              {commentCount > 0 && <span style={countBadge}>{commentCount}</span>}
            </button>
          </div>
        )}
        <PipelinePreviewIframe
          spec={spec}
          cssVars={resolved?.cssVars}
          cssText={resolved?.cssText}
          mode={mode}
          resolved={
            resolved
              ? { tokens: resolved.tokens, cssVars: resolved.cssVars, cssText: resolved.cssText }
              : null
          }
          onIframe={setIframeEl}
        />
        {canComment && (
          <PipelineCommentLayer
            iframe={iframeEl}
            projectId={projectId!}
            screenPath={screenPath!}
            active={commentMode}
            onCountChange={setCommentCount}
          />
        )}
      </div>
      <div
        className="pipeline-ui-preview__panel"
        style={{ width: 280, flexShrink: 0, borderLeft: '1px solid var(--border, #e5e7eb)' }}
      >
        <ThemeInspectorPanel workspaceId={workspaceId} onResolved={setResolved} onMode={setMode} />
      </div>
    </div>
  );
}

const toolbarStyle: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 8,
  zIndex: 7,
  display: 'flex',
  gap: 6,
};
const toolbarBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 28,
  padding: '0 10px',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text, #111)',
  background: 'var(--bg-elevated, #fff)',
  border: '1px solid var(--border, #e5e7eb)',
  borderRadius: 'var(--radius-sm, 6px)',
  boxShadow: 'var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.12))',
  cursor: 'pointer',
};
const toolbarBtnActive: React.CSSProperties = {
  color: '#fff',
  background: 'var(--accent, #2563eb)',
  borderColor: 'var(--accent, #2563eb)',
};
const countBadge: React.CSSProperties = {
  minWidth: 16,
  height: 16,
  padding: '0 4px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 10,
  borderRadius: 999,
  background: 'var(--accent-soft, rgba(37,99,235,0.15))',
  color: 'inherit',
};

function CommentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
    </svg>
  );
}
