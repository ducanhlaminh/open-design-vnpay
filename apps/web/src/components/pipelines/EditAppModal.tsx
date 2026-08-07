// ── Đổi tên App ──────────────────────────────────────────────────────────────
// CHỈ đổi tên hiển thị. Mã App (id) là tên thư mục / khoá KGS nên không sửa
// được ở đây — đổi mã là chuyện di trú dữ liệu, không phải chuyện sửa nhãn.
//
// Cấu hình workflow không thuộc form này (nó ở RunAllModal / RunInputModal /
// registry), giống hai form khai sinh cạnh đây.

import { useState } from 'react';

import {
  ConfluenceRootField,
  FormError,
  FormField,
  PipelineFormModal,
  PrimaryButton,
  QuietButton,
  TextInput,
} from './PipelineFormModal';
import { appConfluenceRoots, appLabelOf, useAppOptions } from './newProjectForm';

/** Order-insensitive array equality — used to detect whether the roots
 *  picker actually changed anything (chip add/remove doesn't preserve
 *  order, so a plain index compare would false-positive on "changed"). */
function sameRoots(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function EditAppModal({
  app,
  onClose,
  onSaved,
}: {
  app: { id: string; name: string; confluenceRoots?: string[]; confluenceRoot?: string | null };
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const apps = useAppOptions();
  const [name, setName] = useState(app.name);
  const initialRoots = appConfluenceRoots(app);
  const [confluenceRoots, setConfluenceRoots] = useState<string[]>(initialRoots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameTrim = name.trim();
  // Trùng tên một App KHÁC là bẫy: hai thẻ cùng nhãn trên lưới Apps thì người
  // dùng không biết mình đang mở cái nào.
  const duplicate = apps.some(
    (a) => a.id !== app.id && appLabelOf(a).trim().toLowerCase() === nameTrim.toLowerCase(),
  );
  const confluenceRootsChanged = !sameRoots(confluenceRoots, initialRoots);
  const canSubmit =
    Boolean(nameTrim) && !duplicate && (nameTrim !== app.name || confluenceRootsChanged);

  const submit = async () => {
    if (busy || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/apps/${encodeURIComponent(app.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: nameTrim,
          // [] clears — always send when changed so emptying the chips can
          // clear every root.
          ...(confluenceRootsChanged ? { confluenceRoots } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `đổi tên App thất bại: ${res.status}`);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <PipelineFormModal
      title="Đổi tên App"
      icon="blocks"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <QuietButton onClick={onClose} disabled={busy}>
            Hủy
          </QuietButton>
          <PrimaryButton icon="check" busy={busy} onClick={() => void submit()} disabled={busy || !canSubmit}>
            {busy ? 'Đang lưu…' : 'Lưu'}
          </PrimaryButton>
        </>
      }
    >
      <FormField
        label="Tên App"
        hint={
          duplicate
            ? 'Đã có App khác dùng tên này — chọn tên khác.'
            : `Mã App giữ nguyên: ${app.id}`
        }
      >
        {(fieldProps) => (
          <TextInput
            {...fieldProps}
            autoFocus
            placeholder="Retail"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        )}
      </FormField>

      <FormField
        label="Confluence root"
        hint="Tùy chọn, chọn được nhiều — gõ tên trang để tìm/duyệt cây rồi tick (hoặc dán link/page id thẳng). Bỏ hết chip để gỡ."
      >
        {(fieldProps) => (
          <ConfluenceRootField
            {...fieldProps}
            placeholder="Gõ tên trang để tìm, hoặc dán link/page id…"
            value={confluenceRoots}
            onValueChange={setConfluenceRoots}
            onEnter={() => void submit()}
          />
        )}
      </FormField>

      {error ? <FormError>{error}</FormError> : null}
    </PipelineFormModal>
  );
}
