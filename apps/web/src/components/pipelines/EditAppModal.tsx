// ── Đổi tên App ──────────────────────────────────────────────────────────────
// CHỈ đổi tên hiển thị. Mã App (id) là tên thư mục / khoá KGS nên không sửa
// được ở đây — đổi mã là chuyện di trú dữ liệu, không phải chuyện sửa nhãn.
//
// Cấu hình workflow không thuộc form này (nó ở RunAllModal / RunInputModal /
// registry), giống hai form khai sinh cạnh đây.

import { useEffect, useState } from 'react';
import type { DesignSystemSummary } from '@open-design/contracts';

import {
  FormError,
  FormField,
  PipelineFormModal,
  PrimaryButton,
  QuietButton,
  TextInput,
} from './PipelineFormModal';
import { AppPoolSection } from './AppPoolSection';
import { appLabelOf, useAppOptions } from './newProjectForm';
import { fetchDesignSystems } from '../../providers/registry';
import { ProjectDesignSystemPicker } from '../ProjectDesignSystemPicker';

export function EditAppModal({
  app,
  onClose,
  onSaved,
}: {
  app: { id: string; name: string; designSystemId?: string | null };
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const apps = useAppOptions();
  const [name, setName] = useState(app.name);
  const [systems, setSystems] = useState<DesignSystemSummary[] | null>(null);
  const [designSystemId, setDesignSystemId] = useState<string | null>(app.designSystemId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchDesignSystems().then((all) => {
      if (!cancelled) setSystems(all);
    });
    return () => { cancelled = true; };
  }, []);

  const nameTrim = name.trim();
  // Trùng tên một App KHÁC là bẫy: hai thẻ cùng nhãn trên lưới Apps thì người
  // dùng không biết mình đang mở cái nào.
  const duplicate = apps.some(
    (a) => a.id !== app.id && appLabelOf(a).trim().toLowerCase() === nameTrim.toLowerCase(),
  );
  const nameChanged = nameTrim !== app.name;
  const designSystemChanged = designSystemId !== (app.designSystemId ?? null);
  const canSubmit = Boolean(nameTrim) && !duplicate && (nameChanged || designSystemChanged);

  const submit = async () => {
    if (busy || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/apps/${encodeURIComponent(app.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(nameChanged ? { name: nameTrim } : {}),
          ...(designSystemChanged ? { designSystemId } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `cập nhật App thất bại: ${res.status}`);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <PipelineFormModal
      title="Đổi tên dự án"
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
        label="Tên dự án"
        hint={
          duplicate
            ? 'Đã có dự án khác dùng tên này — chọn tên khác.'
            : `Mã dự án giữ nguyên: ${app.id}`
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
        label="Design System (Figma)"
        hint="Nguồn tiêu chuẩn review cho mọi tính năng của dự án; bước “Tài liệu (nạp)” sẽ chép components.md và rules.md (nếu có) vào criteria/."
      >
        {(fieldProps) => (
          <div {...fieldProps}>
            <ProjectDesignSystemPicker
              designSystems={(systems ?? []).filter((s) => s.status !== 'draft')}
              selectedId={designSystemId}
              loading={systems === null}
              onChange={setDesignSystemId}
              popoverZIndex={1100}
              variant="form"
            />
          </div>
        )}
      </FormField>

      {error ? <FormError>{error}</FormError> : null}

      <AppPoolSection appId={app.id} />
    </PipelineFormModal>
  );
}
