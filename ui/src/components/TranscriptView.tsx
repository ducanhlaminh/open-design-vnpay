/**
 * F-35 — TranscriptView
 * Fetches and displays conversation transcript entries. Export to JSON button.
 * Uses api.projects.getTranscriptUrl to fetch raw JSON.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';

interface TranscriptViewProps {
  projectId: string;
}

interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: string;
}

export function TranscriptView({ projectId }: TranscriptViewProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const url = api.projects.getTranscriptUrl(projectId);
    fetch(url, { credentials: 'include' })
      .then((r) => r.json())
      .then((resp) => setEntries(Array.isArray(resp) ? resp : resp.entries ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) {
    return <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13 }}>Loading transcript...</div>;
  }
  if (entries.length === 0) {
    return <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13, textAlign: 'center' }}>No transcript yet</div>;
  }

  return (
    <div style={{ padding: 16, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button
          onClick={() => {
            const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `transcript-${projectId}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-muted)', cursor: 'pointer' }}
        >
          ↓ Export JSON
        </button>
      </div>
      {entries.map((e) => (
        <div key={e.id} style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: e.role === 'user' ? '#6ac47e' : e.role === 'assistant' ? 'var(--color-accent)' : '#f5a623' }}>{e.role}</span>
            <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{new Date(e.timestamp).toLocaleTimeString()}</span>
          </div>
          <pre style={{ fontSize: 11, color: 'var(--color-text)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' }}>{e.content}</pre>
        </div>
      ))}
    </div>
  );
}
