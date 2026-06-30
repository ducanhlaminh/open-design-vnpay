/**
 * F-34 — FileWorkspace
 * File tree sidebar + textarea editor (CodeMirror stub for now).
 * Uses api.projects.readFile / writeFile (adapted from getProjectFile/updateProjectFile spec).
 */
import { useEffect, useState } from 'react';
import { api } from '../api';

interface FileWorkspaceProps {
  projectId: string;
  files?: string[];
}

export function FileWorkspace({ projectId, files = [] }: FileWorkspaceProps) {
  const [activeFile, setActiveFile] = useState<string | null>(files[0] ?? null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!activeFile) return;
    api.projects.readFile(projectId, activeFile)
      .then((text) => setContent(text))
      .catch(() => setContent(''));
  }, [projectId, activeFile]);

  const handleSave = async () => {
    if (!activeFile) return;
    setSaving(true);
    await api.projects.writeFile(projectId, activeFile, content);
    setSaving(false);
  };

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* File tree sidebar */}
      <div style={{ width: 180, borderRight: '1px solid var(--color-border)', overflowY: 'auto', flexShrink: 0 }}>
        {files.map((f) => (
          <button
            key={f}
            onClick={() => setActiveFile(f)}
            style={{
              display: 'block', width: '100%', padding: '6px 12px', textAlign: 'left',
              background: activeFile === f ? 'rgba(124,109,250,0.12)' : 'transparent',
              border: 'none', cursor: 'pointer',
              fontSize: 12, color: activeFile === f ? 'var(--color-accent)' : 'var(--color-text)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            📄 {f.split('/').pop()}
          </button>
        ))}
      </div>

      {/* Editor area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Editor toolbar */}
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{activeFile}</span>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 11, borderRadius: 4, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text)', cursor: 'pointer' }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>

        {/* Textarea (CodeMirror stub — replace with EditorView when T32 is implemented) */}
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          style={{
            flex: 1, resize: 'none',
            background: '#1a1a2e',
            border: 'none', outline: 'none',
            color: '#e2e2e2',
            fontFamily: 'JetBrains Mono, Fira Code, monospace',
            fontSize: 13, padding: 16, lineHeight: 1.6,
          }}
        />
        {/* TODO: Replace textarea with CodeMirror EditorView (T32) */}
      </div>
    </div>
  );
}
