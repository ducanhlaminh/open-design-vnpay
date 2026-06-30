/**
 * F-13 — MarkdownViewer
 * Fetches a markdown URL and renders it as HTML.
 * Used in DSDetailDrawer (spec tab).
 */
import { useEffect, useState } from 'react';
import { simpleMarkdown } from '../utils/markdown';

interface MarkdownViewerProps {
  url: string;
  className?: string;
}

export function MarkdownViewer({ url, className }: MarkdownViewerProps) {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!url) return;
    setLoading(true);
    setError('');
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((md) => setHtml(simpleMarkdown(md)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [url]);

  if (loading) {
    return (
      <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13 }}>
        Loading...
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 24, color: '#fa5050', fontSize: 13 }}>
        Failed to load: {error}
      </div>
    );
  }

  return (
    <div
      className={`markdown-viewer ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
      style={{
        padding: 16,
        fontSize: 13,
        lineHeight: 1.7,
        color: 'var(--color-text)',
        overflowY: 'auto',
      }}
    />
  );
}
