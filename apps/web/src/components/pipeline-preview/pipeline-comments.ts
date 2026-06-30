// Per-component comments for the pipeline UI preview. Anchored to the
// screen.json node id (data-node-id) — NOT a CSS selector or pixel position —
// so a comment stays attached to "the login button" even when the branding /
// theme re-renders it. Persisted as a `screen.comments.json` sibling next to the
// screen.json (written through the project files API), so comments travel with
// the project and can later be fed to the agent that revises the screen.

import { fetchProjectFileText } from '../../providers/registry';

export interface NodeComment {
  id: string;
  /** data-node-id of the commented component (stable anchor). */
  nodeId: string;
  /** Human label captured at creation (component slug + text snippet). */
  label: string;
  text: string;
  createdAt: number;
}

/** screens/x/screen.json → screens/x/screen.comments.json */
export function commentsPathFor(screenPath: string): string {
  return screenPath.replace(/screen\.json$/i, 'screen.comments.json');
}

export async function loadComments(projectId: string, screenPath: string): Promise<NodeComment[]> {
  const text = await fetchProjectFileText(projectId, commentsPathFor(screenPath), {
    cache: 'no-store',
  }).catch(() => null);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { comments?: NodeComment[] } | NodeComment[];
    const list = Array.isArray(parsed) ? parsed : (parsed.comments ?? []);
    return list.filter((c) => c && typeof c.nodeId === 'string' && typeof c.text === 'string');
  } catch {
    return [];
  }
}

export async function saveComments(
  projectId: string,
  screenPath: string,
  comments: NodeComment[],
): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: commentsPathFor(screenPath),
      content: `${JSON.stringify({ comments }, null, 2)}\n`,
      encoding: 'utf8',
    }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string }; message?: string };
    throw new Error(j?.error?.message || j?.message || `save comments failed: ${res.status}`);
  }
}

/** Stable-ish id without Date-based collisions in a tight loop. */
export function newCommentId(nodeId: string, existing: NodeComment[]): string {
  const base = `c-${nodeId}`;
  let n = existing.length + 1;
  let id = `${base}-${n}`;
  const taken = new Set(existing.map((c) => c.id));
  while (taken.has(id)) {
    n += 1;
    id = `${base}-${n}`;
  }
  return id;
}
