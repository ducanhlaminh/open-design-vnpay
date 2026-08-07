// UploadDropzone — the drag-drop `.md` picker + pending list, shared by the
// per-stage UploadFilesModal and the Run-all modal's upload branch. Holds no
// upload logic: the parent owns the pending list and decides where the files
// go (`<workflowId>/docs/` vs `<workflowId>/criteria/`).
import { useRef, useState } from 'react';
import { Icon } from '../Icon';
import styles from './UploadFilesModal.module.css';

export interface PendingFile {
  id: string;
  file: File;
}

/** Wrap a FileList in PendingFile records, keeping only `.md`. The id is
 *  name+mtime+size so re-picking the same file twice doesn't duplicate it. */
export function toPendingFiles(files: FileList | File[]): PendingFile[] {
  return Array.from(files)
    .filter((f) => /\.md$/i.test(f.name))
    .map((file) => ({ id: `${file.name}-${file.lastModified}-${file.size}`, file }));
}

export function UploadDropzone({
  pending,
  onAdd,
  onRemove,
  disabled,
  label = 'Kéo & thả file .md vào đây, hoặc bấm để chọn',
}: {
  pending: PendingFile[];
  onAdd: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  return (
    <>
      <div
        className={`${styles.dropzone}${dragActive ? ` ${styles.dropzoneActive}` : ''}`}
        role="presentation"
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes('Files')) setDragActive(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (event.dataTransfer.files.length) onAdd(event.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <Icon name="upload" size={20} />
        <span>{label}</span>
        <input
          ref={inputRef}
          type="file"
          accept=".md"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files?.length) onAdd(event.target.files);
            event.target.value = '';
          }}
        />
      </div>

      {pending.length > 0 ? (
        <ul className={styles.fileList}>
          {pending.map((p) => (
            <li key={p.id} className={styles.fileItem}>
              <span className={styles.fileName}>{p.file.name}</span>
              <button
                type="button"
                className={styles.fileRemove}
                onClick={() => onRemove(p.id)}
                disabled={disabled}
                aria-label={`Gỡ ${p.file.name}`}
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
