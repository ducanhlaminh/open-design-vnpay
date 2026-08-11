// Auto-register pushed projects into preview-identity — the SAME registry
// pipeline-studio reads (server/access.ts), so a project pushed from Open
// Design shows up in the studio already owned by whoever pushed it, without
// an admin registering it by hand.
//
// Replicates the studio's registration recipe byte-for-byte:
//   1. identity project row created AS the owner (X-User-ID = owner id) with
//      name = KGS project id and metadata.kgsProjectId — the join key the
//      studio resolves projects by.
//   2. the shared service account (service@pipeline-studio.local) is added
//      as viewer so the studio's registeredMap() — which lists projects AS
//      that service user — can see it.
//
// Everything here is BEST-EFFORT: registration failing must never fail a
// push that already succeeded. No IDENTITY_URL / no machine user → skipped.

import { randomBytes } from 'node:crypto';
import { isIdentityUuid } from '../auth-routes.js';

/** Must match pipeline-studio's SERVICE_EMAIL (server/access.ts) — one shared
 *  resolver identity means one shared project registry. */
const SERVICE_EMAIL = 'service@pipeline-studio.local';

export interface RegistryOwner {
  /** preview-identity user id (auth-routes machine user `sub`). */
  id: string;
  email: string;
  name?: string;
}

export type RegisterOutcome = 'registered' | 'exists' | 'skipped' | 'error';

function identityUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.IDENTITY_URL ?? '').replace(/\/+$/, '');
}

async function idFetch(
  base: string,
  path: string,
  init: RequestInit = {},
  actorId = 'open-design',
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-user-id': actorId, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { ok: res.ok, status: res.status, json };
}

let serviceIdCache: string | null = null;

async function serviceAccountId(base: string): Promise<string | null> {
  if (serviceIdCache) return serviceIdCache;
  try {
    const found = await idFetch(base, `/api/v1/admin/users?search=${encodeURIComponent(SERVICE_EMAIL)}&limit=5`);
    const o = (found.json ?? {}) as Record<string, unknown>;
    const arr = (o.users ?? o.items ?? o.data ?? []) as Array<{ id?: string; email?: string }>;
    const match = (Array.isArray(arr) ? arr : []).find(
      (u) => u.email?.toLowerCase() === SERVICE_EMAIL,
    );
    if (match?.id) {
      serviceIdCache = match.id;
      return match.id;
    }
    const created = await idFetch(base, '/api/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: SERVICE_EMAIL,
        name: 'Pipeline Studio Service',
        password: randomBytes(24).toString('base64url'),
      }),
    });
    const c = (created.json ?? {}) as { user?: { id?: string }; id?: string };
    serviceIdCache = c.user?.id ?? c.id ?? null;
    return serviceIdCache;
  } catch {
    return null;
  }
}

interface IdentityProject {
  id: string;
  name: string;
  metadata?: Record<string, unknown> | null;
  /** Returned by GET /projects for the caller's effective project role. */
  role?: string;
}

export type RemoteAccessRole = 'owner' | 'admin' | 'editor' | 'viewer';

function accessRoleOf(value: unknown): RemoteAccessRole | null {
  return value === 'owner' || value === 'admin' || value === 'editor' || value === 'viewer'
    ? value
    : null;
}

const kgsIdOf = (p: IdentityProject): string => {
  const viaMeta = p.metadata && typeof p.metadata === 'object' ? p.metadata.kgsProjectId : null;
  return typeof viaMeta === 'string' && viaMeta.trim() ? viaMeta.trim() : p.name;
};

// Registered-set cache: push-all walks every project; one listing per burst.
let registeredCache: { at: number; ids: Set<string> } | null = null;
const REGISTERED_TTL_MS = 15_000;

async function registeredIds(base: string): Promise<Set<string> | null> {
  if (registeredCache && Date.now() - registeredCache.at < REGISTERED_TTL_MS) {
    return registeredCache.ids;
  }
  const svc = await serviceAccountId(base);
  if (!svc) return null;
  const out = await idFetch(base, '/api/v1/projects?limit=200', {}, svc);
  if (!out.ok) return null;
  const o = (out.json ?? {}) as Record<string, unknown>;
  const arr = (o.projects ?? (o.data as Record<string, unknown> | undefined)?.projects ?? []) as IdentityProject[];
  const ids = new Set((Array.isArray(arr) ? arr : []).map(kgsIdOf));
  registeredCache = { at: Date.now(), ids };
  return ids;
}

/* ── membership scope (dự án khai sinh ở studio → od chỉ pull dự án mình
   được add vào) ─────────────────────────────────────────────────────────── */

/** KGS project ids the identity user is a member/owner of. Null when
 *  identity is unreachable (caller decides fail-open vs fail-closed). */
let memberAccessCache: { at: number; userId: string; roles: Map<string, RemoteAccessRole> } | null = null;
const MEMBER_ACCESS_TTL_MS = 15_000;

/** Effective per-project roles returned by identity for this exact user. */
export async function memberProjectAccess(
  userId: string,
): Promise<Map<string, RemoteAccessRole> | null> {
  const base = identityUrl();
  if (!base || !isIdentityUuid(userId)) return null;
  try {
    if (
      memberAccessCache && memberAccessCache.userId === userId
      && Date.now() - memberAccessCache.at < MEMBER_ACCESS_TTL_MS
    ) {
      return memberAccessCache.roles;
    }
    const out = await idFetch(base, '/api/v1/projects?limit=200', {}, userId);
    if (!out.ok) return null;
    const o = (out.json ?? {}) as Record<string, unknown>;
    const arr = (o.projects ?? (o.data as Record<string, unknown> | undefined)?.projects ?? []) as IdentityProject[];
    const roles = new Map<string, RemoteAccessRole>();
    for (const project of Array.isArray(arr) ? arr : []) {
      const role = accessRoleOf(project.role);
      // Identity always emits role. If an older deployment omits it, allow
      // discovery but conservatively describe the result as viewer.
      roles.set(kgsIdOf(project), role ?? 'viewer');
    }
    memberAccessCache = { at: Date.now(), userId, roles };
    return roles;
  } catch {
    return null;
  }
}

/** KGS project ids the identity user is a member/owner of. Null when
 * identity is unreachable (caller decides fail-open vs fail-closed). */
export async function memberProjectIds(userId: string): Promise<Set<string> | null> {
  const access = await memberProjectAccess(userId);
  return access ? new Set(access.keys()) : null;
}

let adminCache: { at: number; ids: Set<string> } | null = null;

/** Whether the user holds the identity RBAC role `admin` (app admin — sees
 *  every project, mirroring pipeline-studio's resolveIsAdmin). */
export async function isIdentityAdmin(userId: string): Promise<boolean> {
  const base = identityUrl();
  if (!base || !isIdentityUuid(userId)) return false;
  try {
    if (!adminCache || Date.now() - adminCache.at > 30_000) {
      const list = await idFetch(base, '/api/v1/admin/roles');
      const o = (list.json ?? {}) as Record<string, unknown>;
      const roles = (o.roles ?? o.data ?? []) as Array<{ id?: string; name?: string }>;
      const admin = (Array.isArray(roles) ? roles : []).find((r) => r.name === 'admin');
      if (!admin?.id) return false;
      const out = await idFetch(base, `/api/v1/admin/roles/${admin.id}/users`);
      const oo = (out.json ?? {}) as Record<string, unknown>;
      const users = (oo.users ?? oo.data ?? []) as Array<{ id?: string }>;
      adminCache = {
        at: Date.now(),
        ids: new Set((Array.isArray(users) ? users : []).map((u) => u.id ?? '').filter(Boolean)),
      };
    }
    return adminCache.ids.has(userId);
  } catch {
    return false;
  }
}

/** The pull/discovery scope for a machine user:
 *  - identity chưa cấu hình → không đồng bộ (local app vẫn dùng được);
 *  - user là app admin → all;
 *  - user thường → đúng các dự án được add (fail-closed khi identity lỗi);
 *  - chưa đăng nhập → không thấy gì (fail-closed, kèm reason cho UI). */
export async function pullScopeFor(
  userId: string | null,
): Promise<{ all: boolean; ids: Set<string>; reason?: string }> {
  if (!identityUrl()) {
    return {
      all: false,
      ids: new Set(),
      reason: 'kho dự án chưa được kết nối với preview-identity',
    };
  }
  if (!userId) {
    return { all: false, ids: new Set(), reason: 'chưa đăng nhập — đăng nhập Google trong app để thấy dự án của bạn' };
  }
  if (!isIdentityUuid(userId)) {
    return { all: false, ids: new Set(), reason: 'tài khoản chưa kết nối với preview-identity' };
  }
  if (await isIdentityAdmin(userId)) return { all: true, ids: new Set() };
  const ids = await memberProjectIds(userId);
  if (!ids) {
    return { all: false, ids: new Set(), reason: 'không liên lạc được preview-identity — thử lại sau' };
  }
  return { all: false, ids };
}

/**
 * Ensure `projectId` is registered in preview-identity with `owner` as its
 * owner. Idempotent; never throws.
 */
export async function ensureProjectRegistered(
  projectId: string,
  displayName: string,
  owner: RegistryOwner | null,
): Promise<RegisterOutcome> {
  const base = identityUrl();
  if (!base || !owner || !isIdentityUuid(owner.id)) return 'skipped';
  try {
    const existing = await registeredIds(base);
    if (!existing) return 'error';
    if (existing.has(projectId)) return 'exists';

    // Create AS the owner — identity makes the creator the project owner,
    // which is exactly the attribution we want.
    const created = await idFetch(
      base,
      '/api/v1/projects',
      {
        method: 'POST',
        body: JSON.stringify({
          name: projectId,
          metadata: {
            kgsProjectId: projectId,
            ...(displayName && displayName !== projectId ? { displayName } : {}),
            registeredBy: 'open-design',
          },
        }),
      },
      owner.id,
    );
    if (!created.ok) return 'error';
    const project = ((created.json as Record<string, unknown>)?.project ?? {}) as { id?: string };

    // Grant the shared service account viewer so the studio's registry
    // resolver sees the project. Best-effort — owner attribution stands
    // regardless.
    const svc = await serviceAccountId(base);
    if (svc && project.id) {
      await idFetch(
        base,
        `/api/v1/projects/${project.id}/members/users`,
        { method: 'POST', body: JSON.stringify({ userId: svc, role: 'viewer' }) },
        owner.id,
      ).catch(() => {});
    }
    registeredCache = null;
    return 'registered';
  } catch {
    return 'error';
  }
}
