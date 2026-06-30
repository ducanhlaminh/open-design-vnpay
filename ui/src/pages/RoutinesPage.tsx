/**
 * F-44 — RoutinesPage
 * Lists scheduled/automated AI tasks. Empty state if no routines.
 * Uses api.routines if available (graceful fallback to empty).
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Routine } from '../api';

export default function RoutinesPage() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.routines.listRoutines()
      .then((resp) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = Array.isArray(resp) ? resp : (resp as any).items ?? [];
        setRoutines(list);
      })
      .catch(() => setRoutines([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', margin: '0 0 6px' }}>Routines</h1>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0 }}>
          Schedule automated AI design tasks to run on a recurring basis.
        </p>
      </div>

      {loading ? (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 13, padding: 40, textAlign: 'center' }}>
          Loading routines...
        </div>
      ) : routines.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 80, color: 'var(--color-text-muted)', fontSize: 13 }}>
          <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.3 }}>🔁</div>
          <div style={{ fontWeight: 500, marginBottom: 8, color: 'var(--color-text)' }}>No routines yet</div>
          <div>Routines allow you to schedule automated design tasks.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {routines.map((r) => (
            <div key={r.id} style={{ padding: '12px 16px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', background: 'var(--color-surface)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: r.enabled ? '#6ac47e' : 'var(--color-border)', flexShrink: 0 }} />
              <div style={{ fontSize: 14, color: r.enabled ? 'var(--color-text)' : 'var(--color-text-muted)', flex: 1, fontWeight: 500 }}>{r.name}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.scheduleKind}: {r.scheduleValue}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
