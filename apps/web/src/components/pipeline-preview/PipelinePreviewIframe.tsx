// Host for the embedded design-v3 preview runtime (preview-runtime-v3), served
// from /preview-runtime-v3/index.html. Ported from ui/preview's PreviewIframe,
// stripped to the essentials: the screen `spec` (a react-shadcn / design-v3
// render tree) and `cssVars` (resolved by the theme panel) come in as props
// instead of from an RTK query + websocket. Mirrors the same postMessage
// protocol the runtime understands: preview.render / preview.theme /
// preview.setMode, and listens for preview.ready / preview.error.

import { useCallback, useEffect, useRef, useState } from 'react';

// Bump when apps/web/public/preview-runtime-v3 is refreshed (browsers cache the
// embedded runtime bundle aggressively).
const RUNTIME_V3_VERSION = '1';

interface Props {
  /** The screen render tree (parsed screen.json). Posted as preview.render. */
  spec: unknown;
  /** design-v3 resolved theme vars to apply inside the runtime (live preview). */
  cssVars?: Record<string, string>;
  /** design-v3 composition surface rules (cssText). */
  cssText?: string;
  /** Full resolver output (tokens feed Asset/icon resolution in the runtime). */
  resolved?: { tokens?: unknown[]; cssVars?: Record<string, string>; cssText?: string } | null;
  /** Light/dark — the runtime toggles its `.dark` class on this. */
  mode?: string;
  interactionMode?: 'static' | 'interactive';
  className?: string;
  /** Receives the iframe element so a host overlay (comment layer) can read its
   *  same-origin DOM (data-node-id rects). Called with null on unmount. */
  onIframe?: (el: HTMLIFrameElement | null) => void;
}

export function PipelinePreviewIframe({
  spec,
  cssVars,
  cssText,
  resolved,
  mode,
  interactionMode = 'static',
  className,
  onIframe,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const runtimeSrc = `/preview-runtime-v3/index.html?v=${RUNTIME_V3_VERSION}`;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'preview.ready') {
        setReady(true);
        setRuntimeError(null);
      }
      if (msg.type === 'preview.error') {
        setRuntimeError(typeof msg.error === 'string' ? msg.error : 'Preview runtime error');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Post the screen spec once the runtime is ready (or when the spec changes).
  const specKey = (() => {
    try {
      return JSON.stringify(spec);
    } catch {
      return '';
    }
  })();
  const postSpec = useCallback(() => {
    if (!ready || !spec || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      { type: 'preview.render', spec, interactionMode, state: undefined },
      window.location.origin,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, specKey, interactionMode]);
  useEffect(() => {
    postSpec();
  }, [postSpec]);

  // Lightweight mode toggle (no full re-render).
  useEffect(() => {
    if (!ready || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      { type: 'preview.setMode', interactionMode },
      window.location.origin,
    );
  }, [interactionMode, ready]);

  // Push the resolved theme whenever ready or the vars change.
  const themeKey = cssVars ? JSON.stringify(cssVars) : '';
  const postTheme = useCallback(() => {
    if (!ready || !iframeRef.current?.contentWindow) return;
    if (!cssVars || Object.keys(cssVars).length === 0) return;
    iframeRef.current.contentWindow.postMessage(
      { type: 'preview.theme', cssVars, cssText, resolved: resolved ?? undefined, mode },
      window.location.origin,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, themeKey, cssText, resolved, mode]);
  useEffect(() => {
    postTheme();
  }, [postTheme]);

  return (
    <div className={`pipeline-preview-iframe ${className ?? ''}`} style={{ position: 'relative', height: '100%', width: '100%' }}>
      {runtimeError && (
        <div className="pipeline-preview-iframe__error" role="alert">
          {runtimeError}
        </div>
      )}
      <iframe
        ref={(el) => {
          iframeRef.current = el;
          onIframe?.(el);
        }}
        src={runtimeSrc}
        title="Pipeline UI preview"
        sandbox="allow-same-origin allow-scripts"
        style={{ height: '100%', width: '100%', border: 0, background: 'var(--background, #fff)' }}
      />
    </div>
  );
}
