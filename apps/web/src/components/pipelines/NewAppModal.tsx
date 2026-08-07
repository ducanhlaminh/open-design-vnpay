// ── Tạo App mới ngay tại Open Design ─────────────────────────────────────────
// Trước đây App chỉ khai sinh được ở Pipeline Studio, nên chỉ để thử một
// pipeline người dùng phải sang studio tạo rồi `od kg pull-all` kéo về.
//
// Form này CHỈ hỏi thông tin của App. App tạo xong tồn tại với 0 feature và
// hiện ngay trên lưới Apps (xem nhánh "App rỗng vẫn phải hiện" trong
// usePipelineNav.groupByApp), nên không cần bắt người dùng nghĩ tên feature
// đầu tiên ngay lúc này — màn Features rỗng đã có sẵn CTA "Feature mới".
//
// Cấu hình workflow (nguồn tài liệu, platform, design system, target…) KHÔNG
// thuộc form này; nó ở chỗ cũ (RunAllModal / RunInputModal / registry).

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
import { appLabelOf, toSlugId, useAppOptions } from './newProjectForm';

export function NewAppModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (appId: string) => void | Promise<void>;
}) {
  const apps = useAppOptions();
  const [name, setName] = useState('');
  const [confluenceRoots, setConfluenceRoots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameTrim = name.trim();
  // Trùng tên KHÔNG được im lặng tái dùng App cũ: người dùng đang bấm "App
  // mới", nếu ta lặng lẽ trả về App có sẵn thì họ tin là vừa tạo một App khác.
  const duplicate = apps.some((a) => appLabelOf(a).trim().toLowerCase() === nameTrim.toLowerCase());
  const canSubmit = Boolean(nameTrim) && !duplicate;

  const submit = async () => {
    if (busy || !canSubmit) return;
    setBusy(true);
    setError(null);
    const appId = toSlugId(nameTrim);
    try {
      const res = await fetch('/api/pipelines/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appId,
          name: nameTrim,
          ...(confluenceRoots.length ? { confluenceRoots } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      // 409 = mã đã có. KHÔNG tự thêm hậu tố: khác Feature, App là thứ người
      // dùng sẽ gọi tên hằng ngày, "retail-3f2a" đằng sau lưng họ là sai.
      if (!res.ok) throw new Error(j?.error || `tạo App thất bại: ${res.status}`);
      await onCreated(j?.id ?? appId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <PipelineFormModal
      title="App mới"
      icon="blocks"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <QuietButton onClick={onClose} disabled={busy}>
            Hủy
          </QuietButton>
          <PrimaryButton icon="check" busy={busy} onClick={() => void submit()} disabled={busy || !canSubmit}>
            {busy ? 'Đang tạo…' : 'Tạo'}
          </PrimaryButton>
        </>
      }
    >
      <FormField
        label="Tên App"
        hint={
          duplicate
            ? 'App đã tồn tại — chọn tên khác, hoặc mở App đó và thêm feature vào.'
            : nameTrim
              ? `Mã App: ${toSlugId(nameTrim)}`
              : 'Tên sản phẩm/hệ thống, vd Retail, BIDV. Mã App sinh tự động từ tên này.'
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
        hint="Tùy chọn, chọn được nhiều — gõ tên trang để tìm/duyệt cây rồi tick (hoặc dán link/page id thẳng). Đặt sẵn ở đây thì màn Run source của từng feature có thêm tab chọn trang từ các cây này thay vì dán link mỗi lần."
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
