// Holding a just-triggered pipeline at "running" until the daemon agrees.
//
// `POST /api/pipelines/run` and `.../run-all` answer 202 as soon as the work is
// QUEUED — the daemon flips the stage's stored status to `running` later, after
// work that can take seconds (an agent stage pre-pulls its upstream files from
// the media store first). Every refresh replaces the pipeline rows wholesale, so
// a refresh landing inside that window overwrites the UI's optimistic "running"
// with the daemon's stale `idle`. That matters beyond one stale row: the 2.5s
// poller only runs while some row is running, so the correction that would have
// fixed it never happens and the board sits frozen until the user leaves the
// route and comes back.
//
// The window is widest for "run all + skip succeeded", where the first stage to
// run is an agent stage rather than the fast deterministic docs ingest.
export type PendingStartRow = { id: string; status: string };

/**
 * Force `running` on rows the caller just started and the daemon still reports
 * as `idle`. MUTATES `pending`, dropping each id once the daemon reports any
 * other status (it caught up) or the id's deadline passes (a run that never
 * started must not pin the row forever).
 */
export function applyPendingStarts<T extends PendingStartRow>(
  rows: T[],
  pending: Map<string, number>,
  now: number,
): T[] {
  if (pending.size === 0) return rows;
  return rows.map((row) => {
    const deadline = pending.get(row.id);
    if (deadline === undefined) return row;
    if (row.status !== 'idle' || now > deadline) {
      pending.delete(row.id);
      return row;
    }
    return { ...row, status: 'running' };
  });
}
