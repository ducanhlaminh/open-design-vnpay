/**
 * F-31 — WorkspacePanel
 * Right panel of ProjectPage — 3 tabs: Preview (ArtifactViewer) | Files (FileWorkspace) | Transcript (TranscriptView).
 */
import { useState } from 'react';
import { ArtifactViewer } from './ArtifactViewer';
import { FileWorkspace } from './FileWorkspace';
import { TranscriptView } from './TranscriptView';
import type { Artifact } from '../types';

interface WorkspacePanelProps {
  artifact: Artifact | null;
  projectId: string;
  files?: string[];
}

type WorkspaceTab = 'preview' | 'files' | 'transcript';

export function WorkspacePanel({ artifact, projectId, files = [] }: WorkspacePanelProps) {
  const [tab, setTab] = useState<WorkspaceTab>('preview');

  return (
    <div
      id="workspace-panel"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--color-bg)',
      }}
    >
      {/* Tab bar */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
        paddingLeft: 8,
      }}>
        {(['preview', 'files', 'transcript'] as WorkspaceTab[]).map((t) => (
          <button
            key={t}
            id={`workspace-tab-${t}`}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 16px',
              fontSize: 12,
              border: 'none',
              cursor: 'pointer',
              background: 'transparent',
              color: tab === t ? 'var(--color-text)' : 'var(--color-text-muted)',
              borderBottom: tab === t ? '2px solid var(--color-accent)' : '2px solid transparent',
              fontWeight: tab === t ? 600 : 400,
              textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'preview' && artifact && (
          <ArtifactViewer artifact={artifact} projectId={projectId} />
        )}
        {tab === 'preview' && !artifact && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--color-text-muted)', fontSize: 13 }}>
            No preview yet — send a message to generate
          </div>
        )}
        {tab === 'files' && (
          <FileWorkspace projectId={projectId} files={files} />
        )}
        {tab === 'transcript' && (
          <TranscriptView projectId={projectId} />
        )}
      </div>
    </div>
  );
}
