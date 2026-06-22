// design-v3 KG sync toolbar actions — Pull from / Push to the central KGS.
// Self-contained (mirrors HandoffButton): takes the project id, calls the daemon
// /api/projects/:id/kg-pull|kg-push endpoints, and surfaces the result via the
// shared project-actions toast. Mirrors the `od kg pull|push` CLI.
//
// Pull is KGS-override-all: it wipes the project's local KG mirror and replaces
// it from KGS, so unpushed local work is discarded — Push first to keep it.

import { useState } from 'react';
import { kgPull, kgPush } from '../providers/kgSync';
import { Icon } from './Icon';
import styles from './KgSyncButtons.module.css';

export interface KgSyncToast {
  message: string;
  details: string | null;
  code?: string | null;
}

interface Props {
  projectId: string;
  onToast?: (toast: KgSyncToast) => void;
}

export function KgSyncButtons({ projectId, onToast }: Props) {
  const [busy, setBusy] = useState<'pull' | 'push' | null>(null);

  async function doPull() {
    if (busy) return;
    setBusy('pull');
    try {
      const r = await kgPull(projectId);
      onToast?.({
        message: `Pulled ${r.nodes} nodes, ${r.edges} edges from KGS`,
        details: r.errors.length ? r.errors.join('\n') : null,
        code: r.status === 'ok' ? null : 'partial',
      });
    } catch (err) {
      onToast?.({ message: 'KG pull failed', details: err instanceof Error ? err.message : String(err), code: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function doPush() {
    if (busy) return;
    setBusy('push');
    try {
      const r = await kgPush(projectId);
      const notes = [...r.errors, ...r.caveats];
      onToast?.({
        message: `Pushed ${r.nodesPushed} nodes, ${r.edgesPushed} edges to KGS`,
        details: notes.length ? notes.join('\n') : null,
        code: r.status === 'ok' ? null : 'partial',
      });
    } catch (err) {
      onToast?.({ message: 'KG push failed', details: err instanceof Error ? err.message : String(err), code: 'error' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.group} role="group" aria-label="KG sync">
      <button
        type="button"
        className={styles.button}
        title="Pull this project from the central KG (overwrites local)"
        aria-label="Pull from KG"
        onClick={() => void doPull()}
        disabled={busy !== null}
      >
        <Icon name={busy === 'pull' ? 'refresh' : 'download'} size={14} />
        <span>{busy === 'pull' ? 'Pulling…' : 'Pull KG'}</span>
      </button>
      <button
        type="button"
        className={styles.button}
        title="Push locally-authored changes to the central KG"
        aria-label="Push to KG"
        onClick={() => void doPush()}
        disabled={busy !== null}
      >
        <Icon name={busy === 'push' ? 'refresh' : 'upload'} size={14} />
        <span>{busy === 'push' ? 'Pushing…' : 'Push KG'}</span>
      </button>
    </div>
  );
}
