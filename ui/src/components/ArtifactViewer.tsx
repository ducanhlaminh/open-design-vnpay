/**
 * T31 — ArtifactViewer Component ⭐ CORE
 * Sandboxed iframe renderer for HTML artifacts.
 * SRS FR-08, URD US-02-04
 */
import { useState, useRef } from 'react';
import { api, triggerDownload } from '../api';
import type { Artifact } from '../types';

type ViewMode = 'desktop' | 'mobile';

interface ArtifactViewerProps {
  artifact: Artifact;
  projectId: string;
  fileName?: string;
}

export function ArtifactViewer({ artifact, projectId, fileName = 'index.html' }: ArtifactViewerProps) {
  const [mode, setMode] = useState<ViewMode>('desktop');
  const [showDeploy, setShowDeploy] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const processedHtml =
    mode === 'mobile' ? addMobileViewport(artifact.html) : artifact.html;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--color-bg)',
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 14px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
          flexShrink: 0,
        }}
      >
        {/* Title */}
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--color-text)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {artifact.title}
        </span>

        {/* Mode toggle */}
        <div
          style={{
            display: 'flex',
            background: 'var(--color-bg)',
            borderRadius: 8,
            overflow: 'hidden',
            border: '1px solid var(--color-border)',
          }}
        >
          {(['desktop', 'mobile'] as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: '4px 12px',
                border: 'none',
                background: mode === m ? 'var(--color-accent)' : 'transparent',
                color: mode === m ? '#fff' : 'var(--color-text-muted)',
                fontSize: 12,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {m === 'desktop' ? '🖥' : '📱'} {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* Export chips */}
        <div style={{ display: 'flex', gap: 6 }}>
          <ExportChip
            label="HTML ↓"
            onClick={async () => {
              const blob = await api.export.exportHTML(projectId, fileName);
              triggerDownload(blob, fileName);
            }}
          />
          <ExportChip
            label="PDF ↓"
            onClick={async () => {
              const blob = await api.export.exportPDF(projectId, fileName);
              triggerDownload(blob, `${fileName}.pdf`);
            }}
          />
          <ExportChip
            label="ZIP ↓"
            onClick={async () => {
              const blob = await api.export.downloadArchiveZip(projectId);
              triggerDownload(blob, 'project.zip');
            }}
          />
          <ExportChip
            label="Deploy ↗"
            accent
            onClick={() => setShowDeploy(true)}
          />
        </div>
      </div>

      {/* Iframe container */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: mode === 'mobile' ? 'center' : 'stretch',
          justifyContent: mode === 'mobile' ? 'center' : 'stretch',
          background: '#f0f0f0',
          overflow: 'auto',
        }}
      >
        <iframe
          ref={iframeRef}
          srcDoc={processedHtml}
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
          loading="lazy"
          title={artifact.title}
          style={{
            border: 'none',
            background: '#fff',
            width: mode === 'mobile' ? 390 : '100%',
            height: mode === 'mobile' ? 844 : '100%',
            borderRadius: mode === 'mobile' ? 12 : 0,
            boxShadow: mode === 'mobile' ? '0 8px 40px rgba(0,0,0,0.3)' : 'none',
            flexShrink: 0,
          }}
        />
      </div>

      {/* Deploy dialog (lazy) */}
      {showDeploy && (
        <DeployOverlay
          projectId={projectId}
          fileName={fileName}
          onClose={() => setShowDeploy(false)}
        />
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function ExportChip({
  label,
  onClick,
  accent,
}: {
  label: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px',
        borderRadius: 6,
        border: `1px solid ${accent ? 'var(--color-accent)' : 'var(--color-border)'}`,
        background: accent ? 'rgba(124,109,250,0.15)' : 'transparent',
        color: accent ? 'var(--color-accent)' : 'var(--color-text-muted)',
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'opacity 0.15s',
      }}
    >
      {label}
    </button>
  );
}

/** Wrap HTML with mobile viewport meta so it renders at 390px */
function addMobileViewport(html: string): string {
  const meta = '<meta name="viewport" content="width=390, initial-scale=1">';
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>${meta}`);
  }
  return `${meta}${html}`;
}

// ── Deploy Overlay (T35) ──────────────────────────────────────────────────

type DeployProvider = 'vercel' | 'cloudflare';

function DeployOverlay({
  projectId,
  fileName,
  onClose,
}: {
  projectId: string;
  fileName: string;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<DeployProvider>('vercel');
  const [token, setToken] = useState('');
  const [projectName, setProjectName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [status, setStatus] = useState<'idle' | 'deploying' | 'done' | 'error'>('idle');
  const [deployUrl, setDeployUrl] = useState('');
  const [error, setError] = useState('');

  const handleDeploy = async () => {
    if (!token || !projectName) return;
    setStatus('deploying');
    setError('');
    try {
      let deployment;
      if (provider === 'vercel') {
        deployment = await api.deploy.deployToVercel(projectId, {
          fileName,
          token,
          projectName,
          teamId: teamId || undefined,
        });
      } else {
        deployment = await api.deploy.deployToCloudflare(projectId, {
          fileName,
          token,
          accountId,
          projectName,
        });
      }

      // Poll if pending
      if (deployment.status === 'pending') {
        const final = await api.deploy.pollUntilComplete(
          projectId,
          deployment.id,
          () => {},
        );
        setDeployUrl(final.url);
        setStatus(final.status === 'ready' ? 'done' : 'error');
        if (final.status === 'failed') setError(final.statusMessage ?? 'Deploy failed');
      } else {
        setDeployUrl(deployment.url);
        setStatus('done');
      }
    } catch (e) {
      setError(String(e));
      setStatus('error');
    }
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
          padding: 28,
          width: 420,
          maxWidth: '90vw',
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text)', marginBottom: 20 }}>
          Deploy to {provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages'}
        </h2>

        {/* Provider tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {(['vercel', 'cloudflare'] as DeployProvider[]).map((p) => (
            <button
              key={p}
              onClick={() => setProvider(p)}
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                border: `1px solid ${provider === p ? 'var(--color-accent)' : 'var(--color-border)'}`,
                background: provider === p ? 'rgba(124,109,250,0.15)' : 'transparent',
                color: provider === p ? 'var(--color-accent)' : 'var(--color-text-muted)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              {p === 'vercel' ? '▲ Vercel' : '☁ Cloudflare'}
            </button>
          ))}
        </div>

        {status === 'done' ? (
          <div>
            <p style={{ color: '#50dc78', marginBottom: 12 }}>✓ Deployed successfully!</p>
            <a
              href={deployUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--color-accent)', fontSize: 13 }}
            >
              {deployUrl}
            </a>
            <button onClick={onClose} style={{ display: 'block', marginTop: 16, color: 'var(--color-text-muted)', fontSize: 13, background: 'none', border: 'none', cursor: 'pointer' }}>
              Close
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <DeployInput label="API Token" value={token} onChange={setToken} type="password" />
            <DeployInput label="Project name" value={projectName} onChange={setProjectName} />
            {provider === 'vercel' && (
              <DeployInput label="Team ID (optional)" value={teamId} onChange={setTeamId} />
            )}
            {provider === 'cloudflare' && (
              <DeployInput label="Account ID" value={accountId} onChange={setAccountId} />
            )}

            {error && <p style={{ color: '#fa5050', fontSize: 13 }}>{error}</p>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
              <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-muted)', fontSize: 13, cursor: 'pointer' }}>
                Cancel
              </button>
              <button
                onClick={handleDeploy}
                disabled={status === 'deploying' || !token || !projectName}
                style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: 'var(--color-accent)', color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: status === 'deploying' ? 0.7 : 1 }}
              >
                {status === 'deploying' ? 'Deploying…' : 'Deploy'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DeployInput({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          color: 'var(--color-text)',
          fontSize: 13,
          padding: '7px 10px',
          outline: 'none',
        }}
      />
    </div>
  );
}
