// AppDocsUpload — "Tài liệu dự án" section on the App forms (NewAppModal /
// EditAppModal): the App now OWNS an uploaded docs corpus (a folder tree or
// a single .zip export), separate from — and in addition to — its
// Confluence root(s). Features under the App then PICK files from this
// corpus at run time (RunInputModal's "Tài liệu App" tab, "File đã nạp"
// section), instead of every feature re-uploading its own copy.
//
// Moved here from UploadFilesModal.tsx (previous iteration wrongly put bulk
// upload on the per-FEATURE "Tải file lên" modal; the corpus belongs on the
// App, not a run). The classify/chunk/zip-progress/drag-drop-folder machinery
// is unchanged from that iteration — only the endpoints moved, from the
// per-project `/api/pipelines/upload-folder|upload-zip` to the per-App
// `/api/pipelines/apps/:appId/upload-folder|upload-zip`.
//
// `appId` is nullable: NewAppModal renders this section before the App
// exists (no id to upload against yet) — it shows a "save first" hint with
// no pickers. EditAppModal always has a real id.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import styles from './AppDocsUpload.module.css';

// ── Size/chunk caps ───────────────────────────────────────────────────────────
// MIRROR the daemon route's own limits (POST /api/pipelines/apps/:appId/
// upload-folder contract: ≤300 files/request, ≤10MB/file, ≤80MB/request).
// Chunk caps here are set safely BELOW the server's own per-request caps
// (200 files / 60MB) so a client miscount never trips the server limit.
//
// NO extension allowlist: the daemon dropped its own server-side allowlist
// (it was silently skipping ~117 real files per import — extensionless docs,
// .tmp/.html/.render/.tfss) in favor of path sanitize + the size/count caps
// below doing the real gatekeeping. Every file goes up regardless of
// extension, including files with none at all.
// Text vs binary: md/markdown/txt/csv are read as text; everything else goes
// through base64 (safe default for anything we don't know is plain text —
// includes extensionless files, since we can't tell). Matches the daemon
// contract's `text?|base64?` union.
const DOCS_TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv']);
const DOCS_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DOCS_CHUNK_MAX_FILES = 200;
const DOCS_CHUNK_MAX_BYTES = 60 * 1024 * 1024;
const DOCS_TREE_PREVIEW_CAP = 12;
const ZIP_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i).toLowerCase() : '';
}

function folderRelativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DocsEntry {
  path: string;
  file: File;
}

interface DocsPreview {
  rootName: string | null;
  accepted: DocsEntry[];
  skippedSize: DocsEntry[];
  totalBytes: number;
  /** Immediate subfolder (relative to the dropped root) → accepted file
   *  count — the "cây rút gọn" summary; files sitting directly in the root
   *  (no subfolder) group under '(gốc)'. */
  topFolders: Array<{ label: string; count: number }>;
}

/** Classifies every picked file (ONLY the 10MB cap — no extension filter,
 *  every file goes up regardless of type) and derives the preview summary
 *  shown before upload — pure so it's cheap to recompute on every folder
 *  pick without re-reading any file content. */
function buildDocsPreview(files: File[]): DocsPreview {
  const accepted: DocsEntry[] = [];
  const skippedSize: DocsEntry[] = [];
  let rootName: string | null = null;
  const topFolderCounts = new Map<string, number>();
  for (const file of files) {
    const path = folderRelativePath(file);
    if (!path) continue;
    if (!rootName) rootName = path.split('/')[0] ?? null;
    // Not asked for explicitly, but the daemon route hard-rejects >10MB
    // files anyway (`skipped` in its response) — flagging it client-side
    // keeps the preview's "will upload" count accurate and skips reading +
    // base64-encoding a file we already know the server will bounce.
    if (file.size > DOCS_MAX_FILE_BYTES) {
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
  return { rootName, accepted, skippedSize, totalBytes, topFolders };
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

async function toUploadPayload(entry: DocsEntry): Promise<{ path: string; text?: string; base64?: string }> {
  if (DOCS_TEXT_EXT.has(extOf(entry.path))) {
    return { path: entry.path, text: await entry.file.text() };
  }
  return { path: entry.path, base64: await fileToBase64(entry.file) };
}

/** Greedy bucketing: a chunk fills up to `DOCS_CHUNK_MAX_FILES` files OR
 *  `DOCS_CHUNK_MAX_BYTES`, whichever comes first. Every accepted file is
 *  already ≤10MB (`buildDocsPreview` filtered larger ones out), so a single
 *  file can never alone exceed the byte budget. */
function chunkDocsEntries(entries: DocsEntry[]): DocsEntry[][] {
  const chunks: DocsEntry[][] = [];
  let current: DocsEntry[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const overFiles = current.length + 1 > DOCS_CHUNK_MAX_FILES;
    const overBytes = current.length > 0 && currentBytes + entry.file.size > DOCS_CHUNK_MAX_BYTES;
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

/** Shared "receipt" shown after either bulk path (folder chunks or a single
 *  zip) finishes successfully — same {written, skipped} shape the daemon
 *  returns from both routes. */
interface BulkUploadResult {
  written: number;
  skipped: Array<{ path: string; reason?: string }>;
}

/** POSTs a zip as multipart/form-data via XMLHttpRequest (not `fetch` —
 *  `fetch` has no upload-progress event) so a 90-200MB body can show a real
 *  percentage instead of an indeterminate spinner. */
function uploadZipWithProgress(
  url: string,
  form: FormData,
  onProgress: (pct: number) => void,
): Promise<BulkUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: { written?: number; skipped?: BulkUploadResult['skipped']; error?: string } = {};
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        /* non-JSON body — status-based error message below still applies */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ written: body.written ?? 0, skipped: Array.isArray(body.skipped) ? body.skipped : [] });
      } else {
        reject(new Error(body.error || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Lỗi mạng khi tải file .zip lên'));
    xhr.send(form);
  });
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

// ── Corpus summary (GET /api/pipelines/apps/:appId/docs-files) ──────────────
export interface AppDocsFile {
  path: string;
  size: number;
}

/** Fetches the App's current uploaded-docs corpus — used both by this
 *  section (EditAppModal's "current corpus" summary) and by RunInputModal's
 *  "File đã nạp" tree (a separate consumer, its own fetch). */
export function useAppDocsFiles(appId: string | null): {
  files: AppDocsFile[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [files, setFiles] = useState<AppDocsFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!appId) {
      setFiles(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/pipelines/apps/${encodeURIComponent(appId)}/docs-files`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        if (alive) setFiles(Array.isArray(j.files) ? j.files : []);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [appId, nonce]);

  return { files, loading, error, reload: () => setNonce((n) => n + 1) };
}

/** "Tài liệu dự án" — the App form section that owns upload. `appId === null`
 *  (NewAppModal, before the App is saved) renders a save-first hint only. */
export function AppDocsUploadSection({ appId }: { appId: string | null }) {
  const { files: corpus, loading: corpusLoading, error: corpusError, reload: reloadCorpus } = useAppDocsFiles(appId);

  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [folderDragActive, setFolderDragActive] = useState(false);
  const [folderProgress, setFolderProgress] = useState<{ done: number; total: number } | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const folderPreview = useMemo(() => buildDocsPreview(folderFiles), [folderFiles]);

  const [zipFile, setZipFile] = useState<File | null>(null);
  const [zipUploadPct, setZipUploadPct] = useState<number | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkUploadResult | null>(null);

  function pickFolderFiles(files: File[]) {
    if (!files.length) return;
    setError(null);
    setBulkResult(null);
    setZipFile(null);
    setFolderFiles(files);
  }

  function pickZip(file: File) {
    if (file.size > ZIP_UPLOAD_MAX_BYTES) {
      setError(`File .zip vượt quá 200MB (${formatBytes(file.size)}) — không thể tải lên.`);
      return;
    }
    setError(null);
    setBulkResult(null);
    setFolderFiles([]);
    setZipFile(file);
  }

  async function submitFolder() {
    if (!appId || busy || folderPreview.accepted.length === 0) return;
    setBusy(true);
    setError(null);
    setBulkResult(null);
    const chunks = chunkDocsEntries(folderPreview.accepted);
    const total = folderPreview.accepted.length;
    let done = 0;
    let written = 0;
    const skipped: BulkUploadResult['skipped'] = [];
    setFolderProgress({ done: 0, total });
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      try {
        const uploadFiles = await Promise.all(chunk.map(toUploadPayload));
        const res = await fetch(`/api/pipelines/apps/${encodeURIComponent(appId)}/upload-folder`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ files: uploadFiles }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        written += typeof j.written === 'number' ? j.written : chunk.length;
        if (Array.isArray(j.skipped)) skipped.push(...j.skipped);
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
        setFolderProgress(null);
        return;
      }
    }
    setBusy(false);
    setFolderProgress(null);
    setBulkResult({ written, skipped });
    reloadCorpus();
  }

  async function submitZip() {
    if (!appId || busy || !zipFile) return;
    if (zipFile.size > ZIP_UPLOAD_MAX_BYTES) {
      setError(`File .zip vượt quá 200MB (${formatBytes(zipFile.size)}) — không thể tải lên.`);
      return;
    }
    setBusy(true);
    setError(null);
    setBulkResult(null);
    setZipUploadPct(0);
    try {
      const form = new FormData();
      form.append('file', zipFile, zipFile.name);
      const result = await uploadZipWithProgress(
        `/api/pipelines/apps/${encodeURIComponent(appId)}/upload-zip`,
        form,
        setZipUploadPct,
      );
      setBulkResult(result);
      reloadCorpus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setZipUploadPct(null);
    }
  }

  const corpusCount = corpus?.length ?? 0;
  const corpusBytes = corpus?.reduce((sum, f) => sum + f.size, 0) ?? 0;

  if (!appId) {
    return (
      <div className={styles.field}>
        <span className={styles.fieldLabel}>Tài liệu dự án</span>
        <p className={styles.hint}>
          Lưu App trước — sau đó mở lại (Sửa App) để nạp thư mục hoặc file .zip tài liệu cho cả dự
          án dùng chung.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>Tài liệu dự án</span>
      <p className={styles.hint}>
        Nạp thư mục (kéo cả cây, giữ nguyên đường dẫn) hoặc 1 file .zip — kho tài liệu chung của App,
        mỗi feature chọn trang cần dùng ở màn Chạy thay vì tự tải lại.
      </p>

      {corpusLoading ? (
        <p className={styles.hint}>Đang tải kho tài liệu hiện có…</p>
      ) : corpusError ? (
        <p className={styles.hint}>Không tải được kho tài liệu hiện có: {corpusError}</p>
      ) : corpusCount > 0 ? (
        <p className={styles.corpusSummary}>
          <Icon name="file" size={13} />
          <span>
            Đã có <strong>{corpusCount}</strong> file · {formatBytes(corpusBytes)}
          </span>
        </p>
      ) : null}

      {bulkResult ? (
        <div className={styles.summary}>
          <div className={styles.summaryRow}>
            <Icon name="check" size={14} /> Đã ghi <strong>{bulkResult.written}</strong> file.
          </div>
          {bulkResult.skipped.length > 0 ? (
            <ul className={styles.tree}>
              {bulkResult.skipped.slice(0, DOCS_TREE_PREVIEW_CAP).map((s, i) => (
                <li key={`${s.path}-${i}`}>
                  {s.path} <span className={styles.treeCount}>{s.reason || 'bỏ qua'}</span>
                </li>
              ))}
              {bulkResult.skipped.length > DOCS_TREE_PREVIEW_CAP ? (
                <li className={styles.treeMore}>
                  +{bulkResult.skipped.length - DOCS_TREE_PREVIEW_CAP} file khác bị bỏ qua
                </li>
              ) : null}
            </ul>
          ) : null}
          <button type="button" className={styles.linkBtn} onClick={() => setBulkResult(null)}>
            Nạp thêm
          </button>
        </div>
      ) : zipFile ? (
        <div className={styles.summary}>
          <div className={styles.summaryRow}>
            <Icon name="file" size={13} /> <strong>{zipFile.name}</strong> · {formatBytes(zipFile.size)}
            {!busy ? (
              <button type="button" className={styles.linkBtn} style={{ marginLeft: 8 }} onClick={() => setZipFile(null)}>
                Bỏ chọn — quay lại chọn thư mục
              </button>
            ) : null}
          </div>
          {busy && zipUploadPct !== null ? (
            <div className={styles.progress}>
              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: `${zipUploadPct}%` }} />
              </div>
              <span className={styles.progressLabel}>{zipUploadPct}%</span>
            </div>
          ) : null}
          <button
            type="button"
            className={styles.uploadBtn}
            disabled={busy}
            onClick={() => void submitZip()}
          >
            <Icon name={busy ? 'spinner' : 'upload'} size={13} />
            <span>{busy ? 'Đang tải lên…' : `Tải file .zip lên (${formatBytes(zipFile.size)})`}</span>
          </button>
        </div>
      ) : (
        <>
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
              // A single dropped .zip switches straight to zip mode — no
              // point walking it as a "folder" of one file.
              const dropped = Array.from(event.dataTransfer.files ?? []);
              if (dropped.length === 1 && /\.zip$/i.test(dropped[0]!.name)) {
                pickZip(dropped[0]!);
                return;
              }
              void filesFromFolderDrop(event.dataTransfer).then((droppedFiles) => {
                if (droppedFiles.length) pickFolderFiles(droppedFiles);
              });
            }}
            onClick={() => folderInputRef.current?.click()}
          >
            <Icon name="upload" size={18} />
            <span>Kéo & thả cả thư mục (hoặc 1 file .zip) vào đây, hoặc bấm để chọn thư mục</span>
            <input
              ref={folderInputRef}
              type="file"
              multiple
              hidden
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(event) => {
                const pickedFiles = Array.from(event.target.files ?? []);
                event.target.value = '';
                pickFolderFiles(pickedFiles);
              }}
            />
          </div>
          <button type="button" className={styles.linkBtn} onClick={() => zipInputRef.current?.click()}>
            …hoặc chọn 1 file .zip thay vì thư mục
          </button>
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) pickZip(file);
            }}
          />

          {folderFiles.length > 0 ? (
            <div className={styles.summary}>
              <div className={styles.summaryRow}>
                <strong>{folderPreview.accepted.length}</strong> file sẽ tải lên ·{' '}
                {formatBytes(folderPreview.totalBytes)}
                {folderPreview.rootName ? <span className={styles.corpusMuted}> · {folderPreview.rootName}/</span> : null}
              </div>
              {folderPreview.topFolders.length > 0 ? (
                <ul className={styles.tree}>
                  {folderPreview.topFolders.slice(0, DOCS_TREE_PREVIEW_CAP).map((f) => (
                    <li key={f.label}>
                      {f.label}/ <span className={styles.treeCount}>{f.count}</span>
                    </li>
                  ))}
                  {folderPreview.topFolders.length > DOCS_TREE_PREVIEW_CAP ? (
                    <li className={styles.treeMore}>
                      +{folderPreview.topFolders.length - DOCS_TREE_PREVIEW_CAP} thư mục khác
                    </li>
                  ) : null}
                </ul>
              ) : null}
              {folderPreview.skippedSize.length > 0 ? (
                <p className={styles.skipped}>
                  <Icon name="info" size={12} />
                  <span>
                    Bỏ qua {folderPreview.skippedSize.length} file vượt 10MB.
                  </span>
                </p>
              ) : null}
              {busy && folderProgress ? (
                <div className={styles.progress}>
                  <div className={styles.progressBar}>
                    <div
                      className={styles.progressFill}
                      style={{ width: `${Math.round((folderProgress.done / Math.max(1, folderProgress.total)) * 100)}%` }}
                    />
                  </div>
                  <span className={styles.progressLabel}>
                    {folderProgress.done}/{folderProgress.total} file
                  </span>
                </div>
              ) : null}
              <button
                type="button"
                className={styles.uploadBtn}
                disabled={busy || folderPreview.accepted.length === 0}
                onClick={() => void submitFolder()}
              >
                <Icon name={busy ? 'spinner' : 'upload'} size={13} />
                <span>{busy ? 'Đang tải…' : `Tải lên (${folderPreview.accepted.length})`}</span>
              </button>
            </div>
          ) : null}
        </>
      )}

      {error ? (
        <div className={styles.error} role="alert">
          <Icon name="info" size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
