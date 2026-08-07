// UploadFilesModal — dr-docs's manual "Tải file lên" affordance
// (`PipelineView.acceptsUpload`). A NON-tech way to drop a document straight
// into the docs-review workflow without touching `od files upload` on the
// CLI: a `.md` doc into `<workflowId>/docs/` (dr-docs's OWN output — see the
// warning below), or a review criteria file into `<workflowId>/criteria/`
// (not any stage's declared output, so it survives every re-run untouched —
// apps/daemon/src/pipelines.ts's `dr-docs`/`dr-review` comment block).
//
// Deliberately a SEPARATE button from Run, not folded into `proceedRun`'s
// dispatch (PipelinesView.tsx): that dispatch is a mutually-exclusive
// if/else keyed on `inputPlaceholder` / `acceptsDesignSystem` /
// `acceptsPlatform`, and dr-docs already sets `inputPlaceholder` — an
// `acceptsUpload` branch there would simply never run.
//
// Writes go through `writeProjectTextFileDetailed` (JSON POST
// `/api/projects/:id/files`, `providers/registry.ts`), which preserves a
// multi-segment `name` verbatim. `uploadProjectFiles` (multipart) is NOT an
// option here — its route sanitizes every `/` out of the name, so a target
// like `docs-review/docs/x.md` would land flat at the project root and the
// stage would never see it. `.md` is text, so each file is read with
// `File.text()` — no base64 round-trip, and this repo has no shared
// File→base64 helper to reuse for it anyway.
//
// A THIRD target, "Thư mục dự án (bulk)", handles a different job: the user
// exported a whole Confluence space to Markdown by hand (a folder tree of
// .md + images) and wants to drop the WHOLE folder in at once, subdirs and
// all — the two single-file targets above top out at a flat file list.
// Bulk goes through the daemon's own multi-file route
// (`POST /api/pipelines/upload-folder`), not `writeProjectTextFileDetailed`
// (that route is one-file-per-request; bulk needs one request per CHUNK of
// files — see `chunkFolderEntries`).
import { useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { PlModal } from './PlModal';
import { UploadDropzone, toPendingFiles, type PendingFile } from './UploadDropzone';
import { writeProjectTextFileDetailed } from '../../providers/registry';
import styles from './UploadFilesModal.module.css';

export type UploadTarget = 'docs' | 'criteria' | 'folder';

// ── Bulk folder upload (target: 'folder') ────────────────────────────────────
// Extension allowlist + per-file/per-chunk size caps MIRROR the daemon route's
// own limits (apps/daemon — POST /api/pipelines/upload-folder contract:
// ≤300 files/request, ≤10MB/file, ≤80MB/request). Chunk caps here are set
// safely BELOW the server's own per-request caps (200 files / 60MB) so a
// client miscount never trips the server limit.
const FOLDER_UPLOAD_ALLOWED_EXT = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.pdf',
  '.drawio',
  '.csv',
]);
// Text vs binary: md/markdown/txt/csv are read as text; everything else
// (including .svg — it's XML text, but sent as base64 to be safe) goes
// through base64. Matches the daemon contract's `text?|base64?` union.
const FOLDER_UPLOAD_TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv']);
const FOLDER_UPLOAD_MAX_FILE_BYTES = 10 * 1024 * 1024;
const FOLDER_UPLOAD_CHUNK_MAX_FILES = 200;
const FOLDER_UPLOAD_CHUNK_MAX_BYTES = 60 * 1024 * 1024;
const FOLDER_TREE_PREVIEW_CAP = 12;

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i).toLowerCase() : '';
}

function folderRelativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FolderEntry {
  path: string;
  file: File;
}

interface FolderPreview {
  rootName: string | null;
  accepted: FolderEntry[];
  skippedExt: FolderEntry[];
  skippedSize: FolderEntry[];
  totalBytes: number;
  /** Immediate subfolder (relative to the dropped root) → accepted file
   *  count — the "cây rút gọn" summary; files sitting directly in the root
   *  (no subfolder) group under '(gốc)'. */
  topFolders: Array<{ label: string; count: number }>;
}

/** Classifies every picked file (extension allowlist + 10MB cap) and derives
 *  the preview summary shown before upload — pure so it's cheap to recompute
 *  on every folder pick without re-reading any file content. */
function buildFolderPreview(files: File[]): FolderPreview {
  const accepted: FolderEntry[] = [];
  const skippedExt: FolderEntry[] = [];
  const skippedSize: FolderEntry[] = [];
  let rootName: string | null = null;
  const topFolderCounts = new Map<string, number>();
  for (const file of files) {
    const path = folderRelativePath(file);
    if (!path) continue;
    if (!rootName) rootName = path.split('/')[0] ?? null;
    const ext = extOf(path);
    if (!FOLDER_UPLOAD_ALLOWED_EXT.has(ext)) {
      skippedExt.push({ path, file });
      continue;
    }
    // Not asked for explicitly, but the daemon route hard-rejects >10MB
    // files anyway (`skipped` in its response) — flagging it client-side
    // keeps the preview's "will upload" count accurate and skips reading +
    // base64-encoding a file we already know the server will bounce.
    if (file.size > FOLDER_UPLOAD_MAX_FILE_BYTES) {
      skippedSize.push({ path, file });
      continue;
    }
    accepted.push({ path, file });
    const segs = path.split('/');
    const label = segs.length > 2 ? segs[1]! : '(gốc)';
    topFolderCounts.set(label, (topFolderCounts.get(label) ?? 0) + 1);
  }
  const totalBytes = accepted.reduce((sum, e) => sum + e.file.size, 0);
  const topFolders = [...topFolderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
  return { rootName, accepted, skippedExt, skippedSize, totalBytes, topFolders };
}

/** File → base64, chunked at 32KB so `String.fromCharCode(...)` never blows
 *  the engine's max-call-argument limit on a large (up to 10MB) buffer. */
async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function toUploadPayload(entry: FolderEntry): Promise<{ path: string; text?: string; base64?: string }> {
  if (FOLDER_UPLOAD_TEXT_EXT.has(extOf(entry.path))) {
    return { path: entry.path, text: await entry.file.text() };
  }
  return { path: entry.path, base64: await fileToBase64(entry.file) };
}

/** Greedy bucketing: a chunk fills up to `FOLDER_UPLOAD_CHUNK_MAX_FILES`
 *  files OR `FOLDER_UPLOAD_CHUNK_MAX_BYTES`, whichever comes first. Every
 *  accepted file is already ≤10MB (`buildFolderPreview` filtered larger
 *  ones out), so a single file can never alone exceed the byte budget. */
function chunkFolderEntries(entries: FolderEntry[]): FolderEntry[][] {
  const chunks: FolderEntry[][] = [];
  let current: FolderEntry[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const overFiles = current.length + 1 > FOLDER_UPLOAD_CHUNK_MAX_FILES;
    const overBytes = current.length > 0 && currentBytes + entry.file.size > FOLDER_UPLOAD_CHUNK_MAX_BYTES;
    if (current.length > 0 && (overFiles || overBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entry.file.size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ── Drag-drop-a-folder support (bonus path — the picker input covers v1) ────
// `<input webkitdirectory>` gives every File a real `.webkitRelativePath`
// natively; a DRAGGED folder does not — DataTransferItem.webkitGetAsEntry()
// gives filesystem entries we have to walk ourselves and stamp the relative
// path onto each File by hand (same trick DesignSystemFlow.tsx's drag-drop
// reader already uses in this repo — reimplemented here in trimmed form
// rather than importing that file's private helpers).
interface WebkitFsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}
interface WebkitFsFileEntry extends WebkitFsEntry {
  file: (success: (f: File) => void, fail: (e: unknown) => void) => void;
}
interface WebkitFsDirEntry extends WebkitFsEntry {
  createReader: () => {
    readEntries: (success: (entries: WebkitFsEntry[]) => void, fail: (e: unknown) => void) => void;
  };
}

function isWebkitFsEntry(x: unknown): x is WebkitFsEntry {
  if (!x || typeof x !== 'object') return false;
  const c = x as Partial<WebkitFsEntry>;
  return typeof c.name === 'string' && typeof c.isFile === 'boolean' && typeof c.isDirectory === 'boolean';
}

async function readDirEntries(dir: WebkitFsDirEntry): Promise<WebkitFsEntry[]> {
  const reader = dir.createReader();
  const all: WebkitFsEntry[] = [];
  // readEntries only returns a batch at a time — call until it's empty.
  for (;;) {
    const batch = await new Promise<WebkitFsEntry[]>((resolve, reject) => {
      reader.readEntries(resolve as (e: WebkitFsEntry[]) => void, reject);
    });
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

async function filesFromWebkitEntry(entry: WebkitFsEntry, relPath: string): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as WebkitFsFileEntry).file(resolve, reject);
    });
    if (!folderRelativePath(file) || folderRelativePath(file) === file.name) {
      Object.defineProperty(file, 'webkitRelativePath', { value: relPath, configurable: true });
    }
    return [file];
  }
  if (!entry.isDirectory) return [];
  const children = await readDirEntries(entry as WebkitFsDirEntry);
  const nested = await Promise.all(children.map((c) => filesFromWebkitEntry(c, `${relPath}/${c.name}`)));
  return nested.flat();
}

/** Best-effort: falls back to the flat `dataTransfer.files` list (no
 *  subfolders) if the browser doesn't expose `webkitGetAsEntry` at all. */
async function filesFromFolderDrop(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    // Cast through `unknown` first: the DOM lib's own `webkitGetAsEntry():
    // FileSystemEntry | null` type would otherwise win the intersection and
    // defeat `isWebkitFsEntry`'s narrowing below.
    .map((item) => item.webkitGetAsEntry?.() as unknown)
    .filter(isWebkitFsEntry);
  if (entries.length === 0) return Array.from(dataTransfer.files ?? []);
  const nested = await Promise.all(entries.map((e) => filesFromWebkitEntry(e, e.name)));
  return nested.flat();
}

export function UploadFilesModal({
  projectId,
  workflowId,
  pipelineName,
  onClose,
  onUploaded,
}: {
  projectId: string;
  /** e.g. `docs-review` — the workflow folder prefix the target dirs hang off. */
  workflowId: string;
  pipelineName: string;
  onClose: () => void;
  /** Called after every file wrote successfully, before onClose — lets the
   *  caller refresh the pipeline list so the newly-added docs show up. */
  onUploaded: () => void;
}) {
  const [target, setTarget] = useState<UploadTarget>('docs');
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bulk-folder-only state — kept separate from the single-file `pending`
  // list above (different shape: raw Files with a relative path, not a
  // PendingFile id list) and only read/written while target === 'folder'.
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [folderDragActive, setFolderDragActive] = useState(false);
  const [folderProgress, setFolderProgress] = useState<{ done: number; total: number } | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const folderPreview = useMemo(() => buildFolderPreview(folderFiles), [folderFiles]);

  function addFiles(files: FileList | File[]) {
    const next = toPendingFiles(files);
    if (!next.length) return;
    setPending((cur) => [...cur, ...next]);
  }

  function removePending(id: string) {
    setPending((cur) => cur.filter((p) => p.id !== id));
  }

  async function submit() {
    if (busy || pending.length === 0) return;
    setBusy(true);
    setError(null);
    const dir = target === 'docs' ? `${workflowId}/docs/` : `${workflowId}/criteria/`;
    const failures: string[] = [];
    for (const p of pending) {
      const content = await p.file.text();
      const result = await writeProjectTextFileDetailed(projectId, `${dir}${p.file.name}`, content);
      if (!result.ok) failures.push(`${p.file.name}: ${result.message}`);
    }
    setBusy(false);
    if (failures.length > 0) {
      setError(failures.join('; '));
      return;
    }
    onUploaded();
    onClose();
  }

  // Sequential, chunked upload against POST /api/pipelines/upload-folder.
  // Stops at the FIRST failed chunk (shows which file range failed) —
  // chunks that already landed are NOT rolled back, per spec; re-opening
  // the modal and re-picking the same folder is the retry path (files that
  // already wrote are simple overwrites, not duplicates).
  async function submitFolder() {
    if (busy || folderPreview.accepted.length === 0) return;
    setBusy(true);
    setError(null);
    const chunks = chunkFolderEntries(folderPreview.accepted);
    const total = folderPreview.accepted.length;
    let done = 0;
    setFolderProgress({ done: 0, total });
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      try {
        const files = await Promise.all(chunk.map(toUploadPayload));
        const res = await fetch('/api/pipelines/upload-folder', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, workflowId, files }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        done += chunk.length;
        setFolderProgress({ done, total });
      } catch (err) {
        const from = done + 1;
        const to = done + chunk.length;
        setError(
          `Lô ${i + 1}/${chunks.length} (file ${from}–${to}/${total}) lỗi: ` +
            `${err instanceof Error ? err.message : String(err)}. ${done} file trước đó đã tải lên thành công, ` +
            'không bị hoàn tác — sửa lỗi rồi tải lại thư mục để tiếp tục.',
        );
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    onUploaded();
    onClose();
  }

  const canSubmit = target === 'folder' ? folderPreview.accepted.length > 0 : pending.length > 0;
  const submitCount = target === 'folder' ? folderPreview.accepted.length : pending.length;
  const submitLabel = busy
    ? target === 'folder' && folderProgress
      ? `Đang tải… (${folderProgress.done}/${folderProgress.total})`
      : 'Đang tải lên…'
    : `Tải lên (${submitCount})`;

  return (
    <PlModal
      title={`Tải file lên · ${pipelineName}`}
      icon="upload"
      size="md"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pl-btn" onClick={onClose} disabled={busy}>
            Huỷ
          </button>
          <button
            type="button"
            className="pl-btn pl-btn--run"
            onClick={() => void (target === 'folder' ? submitFolder() : submit())}
            disabled={busy || !canSubmit}
          >
            <Icon name={busy ? 'spinner' : 'upload'} size={14} />
            <span>{submitLabel}</span>
          </button>
        </>
      }
    >
      <div className={styles.targets} role="radiogroup" aria-label="Đích lưu file">
        <button
          type="button"
          role="radio"
          aria-checked={target === 'docs'}
          className={`${styles.targetCard}${target === 'docs' ? ` ${styles.targetCardSelected}` : ''}`}
          onClick={() => setTarget('docs')}
        >
          <span className={styles.targetTitle}>Tài liệu</span>
          <span className={styles.targetPath}>{workflowId}/docs/</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={target === 'criteria'}
          className={`${styles.targetCard}${target === 'criteria' ? ` ${styles.targetCardSelected}` : ''}`}
          onClick={() => setTarget('criteria')}
        >
          <span className={styles.targetTitle}>Bộ tiêu chí</span>
          <span className={styles.targetPath}>{workflowId}/criteria/</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={target === 'folder'}
          className={`${styles.targetCard}${target === 'folder' ? ` ${styles.targetCardSelected}` : ''}`}
          onClick={() => setTarget('folder')}
        >
          <span className={styles.targetTitle}>Thư mục dự án (bulk)</span>
          <span className={styles.targetPath}>{workflowId}/docs/…</span>
        </button>
      </div>

      {target === 'docs' ? (
        <p className={styles.warning}>
          <Icon name="info" size={13} />
          <span>
            Chạy lại bước "Tài liệu → Markdown" sẽ XOÁ những file vừa nạp vào đây — bước đó ghi đè cả
            thư mục <code>docs/</code>.
          </span>
        </p>
      ) : null}

      {target === 'folder' ? (
        <>
          <p className={styles.warning}>
            <Icon name="info" size={13} />
            <span>
              Xuất Confluence ra Markdown thủ công (kèm ảnh) rồi kéo cả thư mục vào đây — ghi vào{' '}
              <code>{workflowId}/docs/</code>, giữ nguyên cây thư mục con. Cùng cảnh báo bị ghi đè như
              trên khi chạy lại bước "Tài liệu → Markdown".
            </span>
          </p>

          <div
            className={`${styles.dropzone}${folderDragActive ? ` ${styles.dropzoneActive}` : ''}`}
            role="presentation"
            onDragEnter={(event) => {
              if (event.dataTransfer.types.includes('Files')) setFolderDragActive(true);
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              setFolderDragActive(true);
            }}
            onDragLeave={(event) => {
              const next = event.relatedTarget;
              if (next instanceof Node && event.currentTarget.contains(next)) return;
              setFolderDragActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setFolderDragActive(false);
              void filesFromFolderDrop(event.dataTransfer).then((files) => {
                if (files.length) setFolderFiles(files);
              });
            }}
            onClick={() => folderInputRef.current?.click()}
          >
            <Icon name="upload" size={20} />
            <span>Kéo & thả cả thư mục vào đây, hoặc bấm để chọn</span>
            <input
              ref={folderInputRef}
              type="file"
              multiple
              hidden
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                if (files.length) setFolderFiles(files);
              }}
            />
          </div>

          {folderFiles.length > 0 ? (
            <div className={styles.folderSummary}>
              <div className={styles.folderSummaryRow}>
                <strong>{folderPreview.accepted.length}</strong> file sẽ tải lên ·{' '}
                {formatBytes(folderPreview.totalBytes)}
                {folderPreview.rootName ? (
                  <span className={styles.folderRoot}> · {folderPreview.rootName}/</span>
                ) : null}
              </div>
              {folderPreview.topFolders.length > 0 ? (
                <ul className={styles.folderTree}>
                  {folderPreview.topFolders.slice(0, FOLDER_TREE_PREVIEW_CAP).map((f) => (
                    <li key={f.label}>
                      {f.label}/ <span className={styles.folderTreeCount}>{f.count}</span>
                    </li>
                  ))}
                  {folderPreview.topFolders.length > FOLDER_TREE_PREVIEW_CAP ? (
                    <li className={styles.folderTreeMore}>
                      +{folderPreview.topFolders.length - FOLDER_TREE_PREVIEW_CAP} thư mục khác
                    </li>
                  ) : null}
                </ul>
              ) : null}
              {folderPreview.skippedExt.length + folderPreview.skippedSize.length > 0 ? (
                <p className={styles.folderSkipped}>
                  <Icon name="info" size={12} />
                  <span>
                    Bỏ qua {folderPreview.skippedExt.length + folderPreview.skippedSize.length} file
                    {folderPreview.skippedExt.length > 0
                      ? ` — ${folderPreview.skippedExt.length} không thuộc định dạng cho phép`
                      : ''}
                    {folderPreview.skippedSize.length > 0
                      ? `${folderPreview.skippedExt.length > 0 ? ',' : ' —'} ${folderPreview.skippedSize.length} vượt 10MB`
                      : ''}
                    .
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}

          {busy && folderProgress ? (
            <div className={styles.folderProgress}>
              <div className={styles.folderProgressBar}>
                <div
                  className={styles.folderProgressFill}
                  style={{ width: `${Math.round((folderProgress.done / Math.max(1, folderProgress.total)) * 100)}%` }}
                />
              </div>
              <span className={styles.folderProgressLabel}>
                {folderProgress.done}/{folderProgress.total} file
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <UploadDropzone pending={pending} onAdd={addFiles} onRemove={removePending} disabled={busy} />
      )}

      {error ? (
        <div className="pl-modal-error" role="alert">
          <Icon name="info" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </PlModal>
  );
}
