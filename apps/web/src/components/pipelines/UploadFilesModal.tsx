// UploadFilesModal — the manual "Tải file lên" affordance any stage with
// `PipelineView.acceptsUpload` gets (currently docs-review's `dr-docs`). A
// NON-tech way to drop a document straight into the run without touching
// `od files upload` on the CLI: a `.md` doc into the ACTIVE WORKFLOW's real
// docs dir (`docsDir`, resolved by the caller via `docsDirOf` in
// PipelinesView.tsx — most workflows nest under their own id, e.g.
// `docs-review/docs/`, but a "root-dir" workflow would write straight to
// `docs/`; see the warning below), or — docs-review ONLY — a review criteria
// file into `<workflowId>/criteria/` (not any stage's declared output, so it
// survives every re-run untouched — apps/daemon/src/pipelines.ts's
// `dr-docs`/`dr-review` comment block).
//
// Deliberately a SEPARATE button from Run, not folded into `proceedRun`'s
// dispatch (PipelinesView.tsx): that dispatch is a mutually-exclusive
// if/else keyed on `inputPlaceholder` / `acceptsDesignSystem` /
// `acceptsPlatform`, and every `acceptsUpload` stage today ALSO sets
// `inputPlaceholder` — an `acceptsUpload` branch there would simply never run.
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
// NOTE: a bulk folder/.zip upload path used to live here as a third target —
// moved to AppDocsUpload.tsx (NewAppModal/EditAppModal's "Tài liệu dự án"
// section) once it became clear the uploaded corpus belongs to the APP (so
// every feature can pick from one shared pool), not to a single per-project
// run. Do not re-add bulk upload here.
import { useState } from 'react';
import { Icon } from '../Icon';
import { PlModal } from './PlModal';
import { UploadDropzone, toPendingFiles, type PendingFile } from './UploadDropzone';
import { writeProjectTextFileDetailed } from '../../providers/registry';
import styles from './UploadFilesModal.module.css';

export type UploadTarget = 'docs' | 'criteria';

export function UploadFilesModal({
  projectId,
  workflowId,
  docsDir,
  pipelineName,
  onClose,
  onUploaded,
}: {
  projectId: string;
  /** Active workflow tab's id — also the 'criteria' target's own prefix
   *  (`<workflowId>/criteria/`), a docs-review-only concept (see `target`'s
   *  card below). */
  workflowId: string;
  /** Where the 'docs' target writes, relative to the project root — the
   *  workflow's real docs dir (`docsDirOf` in PipelinesView.tsx, backed by
   *  `GET /api/workflows`' `docsDir`). Falls back to `<workflowId>/docs`
   *  when the caller can't resolve one (older daemon). */
  docsDir?: string;
  pipelineName: string;
  onClose: () => void;
  /** Called after every file wrote successfully, before onClose — lets the
   *  caller refresh the pipeline list so the newly-added docs show up. */
  onUploaded: () => void;
}) {
  const resolvedDocsDir = docsDir || `${workflowId}/docs`;
  const isDocsReview = workflowId === 'docs-review';
  const [target, setTarget] = useState<UploadTarget>('docs');
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const dir = target === 'docs' ? `${resolvedDocsDir}/` : `${workflowId}/criteria/`;
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
            onClick={() => void submit()}
            disabled={busy || pending.length === 0}
          >
            <Icon name={busy ? 'spinner' : 'upload'} size={14} />
            <span>{busy ? 'Đang tải lên…' : `Tải lên (${pending.length})`}</span>
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
          <span className={styles.targetPath}>{resolvedDocsDir}/</span>
        </button>
        {/* 'criteria' is a docs-review-only concept (dr-review's own input,
            not any stage's declared output) — other workflows have nothing
            that reads it, so the card only exists for that one workflow. */}
        {isDocsReview ? (
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
        ) : null}
      </div>

      {target === 'docs' ? (
        <p className={styles.warning}>
          <Icon name="info" size={13} />
          <span>
            Chạy lại bước "{pipelineName}" sẽ XOÁ những file vừa nạp vào đây — bước đó ghi đè cả thư
            mục <code>{resolvedDocsDir}/</code>.
          </span>
        </p>
      ) : null}

      <UploadDropzone pending={pending} onAdd={addFiles} onRemove={removePending} disabled={busy} />

      {error ? (
        <div className="pl-modal-error" role="alert">
          <Icon name="info" size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </PlModal>
  );
}
