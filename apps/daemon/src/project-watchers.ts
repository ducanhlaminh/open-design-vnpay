import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { isIgnoredProjectDirName } from './project-ignored-dirs.js';
import { projectDir, resolveProjectDir } from './projects.js';

/**
 * Refcounted per-project file watcher registry.
 *
 * Subscribers receive `{type, path, kind}` events when files inside the project
 * change on disk. The first subscribe lazy-creates a watcher; the last
 * unsubscribe closes it, so we never hold descriptors for projects no UI is
 * looking at.
 *
 * 2026-08-28: dùng `fs.watch(dir, { recursive: true })` của Node thay cho
 * chokidar. chokidar ≥ 4 bỏ fsevents nên trên macOS nó `fs.watch` TỪNG FILE
 * (kqueue) = 1 file descriptor / file: một tab dự án 4 300 file giữ 4 300 fd,
 * vài tab + loạt docs-review là chạm `kern.maxfilesperproc` (61 440) → mọi
 * `spawn` (codex, memory-llm, usage) lỗi `EBADF`, agent run failed, daemon ngã.
 * `fs.watch` recursive đi qua FSEvents (macOS) / ReadDirectoryChangesW
 * (Windows) / inotify theo THƯ MỤC (Linux) — không tốn fd theo file.
 */

// Names we never want to surface as project file changes. Tested per-segment
// against the path *relative to the watch root* so that ancestor directories
// (e.g. the daemon's own `.od/` runtime dir, which contains every project) do
// not accidentally match and silence every event in the tree.
const WATCHER_ONLY_IGNORE_NAMES = new Set(['.ds_store']);
export type ProjectWatchKind = 'add' | 'change' | 'unlink';
export interface ProjectWatchEvent { type: 'file-changed'; path: string; kind: ProjectWatchKind }
export type ProjectWatchCallback = (evt: ProjectWatchEvent) => void;
export interface ProjectWatcherOptions {
  ignored?: (absPath: string) => boolean;
  /** Gộp các sự kiện của cùng một path trong `stabilityThreshold` ms rồi mới
   *  stat + phát 1 sự kiện (agent ghi file lớn theo nhiều lần write).
   *  `pollInterval` giữ cho tương thích chữ ký cũ; không còn poll. */
  awaitWriteFinish?: false | { stabilityThreshold: number; pollInterval: number };
  metadata?: unknown;
  _watcherFactory?: WatcherFactory;
}
interface WatcherEntry {
  dir: string;
  watcher: FSWatcher;
  ready: Promise<void>;
  subscribers: Set<ProjectWatchCallback>;
  closing: Promise<void> | null;
}
type WatcherFactory = (dir: string, opts: Required<Pick<ProjectWatcherOptions, 'ignored' | 'awaitWriteFinish'>>) => WatcherEntry;

export function makeIgnored(rootDir: string): (absPath: string) => boolean {
  return (absPath: string): boolean => {
    const rel = path.relative(rootDir, absPath);
    if (!rel || rel === '' || rel.startsWith('..')) return false; // never ignore root itself
    return rel.split(/[\\/]/).some((seg) => {
      const normalized = seg.toLowerCase();
      return WATCHER_ONLY_IGNORE_NAMES.has(normalized) || isIgnoredProjectDirName(normalized);
    });
  };
}

export const DEFAULT_AWAIT_WRITE_FINISH = {
  stabilityThreshold: 200,
  pollInterval: 50,
};

const registry = new Map<string, WatcherEntry>();

function makeEntry(dir: string, opts: Required<Pick<ProjectWatcherOptions, 'ignored' | 'awaitWriteFinish'>>): WatcherEntry {
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  let readyResolved = false;
  const subscribers = new Set<ProjectWatchCallback>();
  const resolveReadyOnce = () => {
    if (readyResolved) return;
    readyResolved = true;
    resolveReady();
  };

  const watcher = fsWatch(dir, { recursive: true, persistent: true });
  const entry: WatcherEntry = { dir, watcher, ready, subscribers, closing: null };

  // Path (relative, '/'-separated) → files we have already reported as
  // present. Lets a coalesced burst of rename+change on a brand-new file come
  // out as ONE `add`, and a later write as `change`. Strings only — no fds.
  const known = new Set<string>();
  const pending = new Map<string, { timer: NodeJS.Timeout; lastEventType: string }>();
  const debounceMs = opts.awaitWriteFinish ? opts.awaitWriteFinish.stabilityThreshold : 0;

  const emit = (rel: string, kind: ProjectWatchKind) => {
    const evt: ProjectWatchEvent = { type: 'file-changed', path: rel, kind };
    for (const cb of entry.subscribers) {
      try {
        cb(evt);
      } catch (err) {
        if (process.env.NODE_ENV === 'development') {
          console.warn('[project-watchers] subscriber threw on', evt.path, err);
        }
      }
    }
  };

  const settle = async (rel: string, lastEventType: string) => {
    if (entry.closing) return;
    const st = await stat(path.join(dir, rel)).catch(() => null);
    if (!st) {
      if (known.delete(rel) || lastEventType === 'rename') emit(rel, 'unlink');
      return;
    }
    if (!st.isFile()) return; // directories: chokidar never bridged addDir/unlinkDir either
    if (known.has(rel)) {
      emit(rel, 'change');
      return;
    }
    known.add(rel);
    // A pre-existing file we have not seen yet reports `change` on macOS/Linux
    // (eventType 'change'); a newly created one reports 'rename'.
    emit(rel, lastEventType === 'change' ? 'change' : 'add');
  };

  const onEvent = (eventType: string, filename: string | Buffer | null) => {
    if (!filename) return;
    const relNative = typeof filename === 'string' ? filename : filename.toString();
    const abs = path.join(dir, relNative);
    if (opts.ignored(abs)) return;
    const rel = path.relative(dir, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return;
    if (debounceMs <= 0) {
      void settle(rel, eventType);
      return;
    }
    const prev = pending.get(rel);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      const item = pending.get(rel);
      pending.delete(rel);
      void settle(rel, item?.lastEventType ?? eventType);
    }, debounceMs);
    pending.set(rel, { timer, lastEventType: eventType });
  };

  watcher.on('change', onEvent);
  // fs.FSWatcher is an EventEmitter: without an `error` listener a transient
  // FS fault (EPERM, ENOSPC, EMFILE…) would be an unhandled exception and
  // take the daemon down with it.
  watcher.on('error', (err) => {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[project-watchers] fs.watch error in', dir, err);
    }
    resolveReadyOnce();
  });
  watcher.on('close', () => {
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
  });
  // fs.watch has no initial scan, so it is live as soon as it is constructed.
  setImmediate(resolveReadyOnce);

  return entry;
}

/**
 * Subscribe to file changes for a project. Returns an unsubscribe fn and a
 * `ready` promise. The watcher is created lazily on first subscribe and closed
 * on last unsubscribe.
 */
export function subscribe(projectsRoot: string, projectId: string, onEvent: ProjectWatchCallback, opts: ProjectWatcherOptions = {}) {
  const dir = opts.metadata
    ? resolveProjectDir(projectsRoot, projectId, opts.metadata)
    : projectDir(projectsRoot, projectId);
  const key = dir;

  let entry = registry.get(key);
  if (!entry) {
    const factory = opts._watcherFactory || makeEntry;
    entry = factory(dir, {
      ignored: opts.ignored ?? makeIgnored(dir),
      awaitWriteFinish: opts.awaitWriteFinish ?? DEFAULT_AWAIT_WRITE_FINISH,
    });
    registry.set(key, entry);
  }
  entry.subscribers.add(onEvent);

  let unsubscribed = false;
  const unsubscribe = async () => {
    if (unsubscribed) return;
    unsubscribed = true;
    entry.subscribers.delete(onEvent);
    if (entry.subscribers.size === 0) {
      registry.delete(key);
      if (!entry.closing) entry.closing = Promise.resolve(entry.watcher.close());
      await entry.closing;
    }
  };

  return { unsubscribe, ready: entry.ready || Promise.resolve() };
}

/** Test-only: drop all watchers. */
export async function _resetForTests(): Promise<void> {
  const entries = Array.from(registry.values());
  registry.clear();
  await Promise.allSettled(entries.map((e) => Promise.resolve(e.watcher.close())));
}

/** Test-only: number of active watchers. */
export function _activeWatcherCount(): number {
  return registry.size;
}

/** Test-only: return the fs.FSWatcher for a given project's directory. */
export function _internalWatcherForTests(projectsRoot: string, projectId: string): FSWatcher | undefined {
  const dir = projectDir(projectsRoot, projectId);
  return registry.get(dir)?.watcher;
}
