// Remote registry — a top-level page (route `/remote-registry`) listing every
// project on the remote stores (KGS graph ⊕ media-service files) and letting the
// user delete a project's FILES from the server (Phase 1; graph deletion not yet
// supported). Deletion is irreversible, so each row uses an inline two-step
// confirm. Mirrors `od kg remote list|delete`.

import { useCallback, useEffect, useState } from 'react';
import type { RemoteProject } from '@open-design/contracts';

import { Icon } from './Icon';
import { deleteRemoteProject, listRemoteProjects } from '../providers/remoteRegistry';
import styles from './RemoteRegistryView.module.css';

export function RemoteRegistryView() {
  const [projects, setProjects] = useState<RemoteProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await listRemoteProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (projectId: string) => {
    setBusyId(projectId);
    setError(null);
    setNotice(null);
    try {
      const result = await deleteRemoteProject(projectId, 'files');
      setConfirmingId(null);
      setNotice(`Deleted ${result.filesDeleted} remote file(s) from “${projectId}”.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className={styles.page} aria-labelledby="remote-registry-title" data-testid="remote-registry-view">
      <header className={styles.hero}>
        <div className={styles.copy}>
          <span className={styles.eyebrow}>
            <Icon name="layers-filled" size={13} />
            Remote
          </span>
          <h1 id="remote-registry-title" className={styles.title}>
            Remote registry
          </h1>
          <p className={styles.lede}>
            Projects that live on the remote stores — KGS graph ⊕ media-service files. Deleting here
            removes <strong>files</strong> from the media-service and is <strong>irreversible</strong>.
            Graph deletion is not supported yet.
          </p>
        </div>
        <button type="button" className="pl-btn" onClick={() => void load()} disabled={loading || busyId !== null}>
          <Icon name={loading ? 'spinner' : 'refresh'} size={14} />
          <span>{loading ? 'Loading…' : 'Refresh'}</span>
        </button>
      </header>

      {notice ? (
        <div className={styles.notice} role="status">
          <Icon name="check" size={15} />
          <span>{notice}</span>
        </div>
      ) : null}
      {error ? (
        <div className={styles.error} role="alert">
          <Icon name="info" size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <div className={styles.state}>
          <Icon name="spinner" size={16} /> Loading…
        </div>
      ) : projects.length === 0 ? (
        <div className={styles.state}>No projects on the remote stores.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Project</th>
              <th>Stores</th>
              <th className={styles.actionCol} />
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const confirming = confirmingId === p.projectId;
              const busy = busyId === p.projectId;
              return (
                <tr key={p.projectId}>
                  <td>
                    <span className={styles.name}>{p.name}</span>
                    {p.name !== p.projectId ? <span className={styles.pid}>{p.projectId}</span> : null}
                  </td>
                  <td>
                    <span className={styles.badges}>
                      {p.inKgs ? <span className={styles.badge}>KGS</span> : null}
                      {p.inMedia ? (
                        <span className={styles.badge}>
                          {p.files} file{p.files === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className={styles.actionCol}>
                    {!p.inMedia ? (
                      <span className={styles.noFiles}>no files</span>
                    ) : confirming ? (
                      <span className={styles.confirm}>
                        <button
                          type="button"
                          className="pl-btn pl-btn--xs pl-btn--danger"
                          onClick={() => void remove(p.projectId)}
                          disabled={busy}
                        >
                          <Icon name={busy ? 'spinner' : 'trash'} size={13} />
                          <span>{busy ? 'Deleting…' : `Delete ${p.files} file${p.files === 1 ? '' : 's'}`}</span>
                        </button>
                        <button
                          type="button"
                          className="pl-btn pl-btn--xs"
                          onClick={() => setConfirmingId(null)}
                          disabled={busy}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="pl-btn pl-btn--xs"
                        onClick={() => setConfirmingId(p.projectId)}
                        disabled={busyId !== null}
                      >
                        <Icon name="trash" size={13} />
                        <span>Delete files</span>
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
