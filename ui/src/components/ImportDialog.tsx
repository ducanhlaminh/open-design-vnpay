/**
 * T36 — ImportDialog Component
 * Drag & drop ZIP import for Claude Design projects.
 * SRS FR-11, URD US-06-01
 */
import { useState, useRef } from 'react';
import { api } from '../api';

interface ImportDialogProps {
  onClose: () => void;
  onImported: (projectId: string, name: string) => void;
}

export function ImportDialog({ onClose, onImported }: ImportDialogProps) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (!file.name.endsWith('.zip')) {
      setError('Please select a .zip file exported from Claude Design.');
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      setError('File too large (max 100 MB).');
      return;
    }

    setUploading(true);
    setError(null);
    try {
      const { projectId, name } = await api.import.importClaudeDesignZip(file);
      onImported(projectId, name);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Invalid ZIP format. Make sure this was exported from Claude Design.',
      );
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 14,
          padding: 32,
          width: 420,
          maxWidth: '90vw',
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text)', marginBottom: 6 }}>
          Import from Claude Design
        </h2>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 24 }}>
          Drop a .zip file exported from Claude Design to import the project.
        </p>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? 'var(--color-accent)' : 'var(--color-border)'}`,
            borderRadius: 12,
            padding: '40px 24px',
            textAlign: 'center',
            cursor: 'pointer',
            background: dragOver ? 'rgba(124,109,250,0.06)' : 'var(--color-bg)',
            transition: 'all 0.15s',
          }}
        >
          {uploading ? (
            <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
              <Spinner /> Importing…
            </div>
          ) : (
            <>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📦</div>
              <div style={{ fontSize: 14, color: 'var(--color-text)', fontWeight: 500 }}>
                Drop .zip here
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                or click to browse
              </div>
            </>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />

        {error && (
          <p style={{ color: '#fa5050', fontSize: 13, marginTop: 12 }}>{error}</p>
        )}

        <button
          onClick={onClose}
          style={{
            marginTop: 20,
            width: '100%',
            padding: '8px',
            borderRadius: 8,
            border: '1px solid var(--color-border)',
            background: 'transparent',
            color: 'var(--color-text-muted)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span style={{ display: 'inline-block', marginRight: 6 }}>
      <svg width="14" height="14" viewBox="0 0 14 14" style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle' }}>
        <circle cx="7" cy="7" r="5" fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeDasharray="20 10" strokeLinecap="round" />
      </svg>
    </span>
  );
}
