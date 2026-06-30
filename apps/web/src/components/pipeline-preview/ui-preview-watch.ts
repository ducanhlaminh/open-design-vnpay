// Auto-open the pipeline UI preview when the UI pipeline (P5 / react-shadcn)
// finishes producing a `screen.json`. The Run button navigates into the seeded
// conversation (the core interactive design), so PipelinesView unmounts and
// can't watch for completion itself. This module is a tiny module-level signal
// that survives that navigation: PipelinesView calls requestUiPreviewWatch()
// on a `ui` run, and a survivor hook mounted in App (useUiPreviewAutoOpen) polls
// the project's files until a fresh screen.json appears, then opens its preview.

import { useEffect, useState } from 'react';

import { navigate } from '../../router';

export interface UiPreviewWatch {
  projectId: string;
  conversationId: string | null;
  /** Epoch ms captured just before the run kicked off; only a screen.json with
   *  a newer mtime counts as "this run's output" (ignores a prior render). */
  since: number;
}

let current: UiPreviewWatch | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function requestUiPreviewWatch(watch: UiPreviewWatch): void {
  current = watch;
  emit();
}

export function clearUiPreviewWatch(): void {
  if (!current) return;
  current = null;
  emit();
}

export function getUiPreviewWatch(): UiPreviewWatch | null {
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

interface ProjectFileLite {
  name?: string;
  path?: string;
  mtime?: number;
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] ?? p;
}

// Mounted once in App. While a watch is active, polls the project's files for a
// screen.json newer than the run start; on the first hit it clears the watch and
// navigates to that file (FileViewer → PipelineScreenViewer → embedded design-v3
// render + theme panel). Stops itself after 20 min so a stalled run never polls
// forever.
export function useUiPreviewAutoOpen(): void {
  const [watch, setWatch] = useState<UiPreviewWatch | null>(getUiPreviewWatch());

  useEffect(() => subscribe(() => setWatch(getUiPreviewWatch())), []);

  useEffect(() => {
    if (!watch) return;
    let alive = true;

    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(watch.projectId)}/files`);
        if (!res.ok) return;
        const data = (await res.json()) as { files?: ProjectFileLite[] };
        const files = data.files ?? [];
        const hit = files.find((f) => {
          const rel = f.name ?? f.path ?? '';
          return rel !== '' && basename(rel) === 'screen.json' && Number(f.mtime ?? 0) > watch.since;
        });
        if (hit && alive) {
          const rel = hit.name ?? hit.path ?? '';
          clearUiPreviewWatch();
          navigate({
            kind: 'project',
            projectId: watch.projectId,
            conversationId: watch.conversationId,
            fileName: rel,
          });
        }
      } catch {
        // Daemon down / transient — keep polling.
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 4000);
    const stop = setTimeout(() => {
      if (alive) clearUiPreviewWatch();
    }, 20 * 60 * 1000);

    return () => {
      alive = false;
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [watch?.projectId, watch?.conversationId, watch?.since]);
}
