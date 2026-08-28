// The machine's owner (last Google login) as a `.odhistory` commit author.
// Same formula as the `historyActor` closure in server.ts — extracted so
// route modules (project-sync) can fence pulls without importing server.ts.

import { getMachineUser, identityUserIdOf } from './auth-routes.js';
import type { HistoryActor } from './project-history.js';

export function historyActor(): HistoryActor | null {
  const m = getMachineUser();
  const id = identityUserIdOf(m);
  return m && id ? { id, email: m.email, name: m.name } : null;
}
