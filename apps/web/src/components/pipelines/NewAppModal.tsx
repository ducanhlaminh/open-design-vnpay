// ── Tạo App mới ─────────────────────────────────────────────────────────────
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
//
// Nhập tài liệu Confluence ngay trong màn Tạo (không phải một bước riêng sau
// khi tạo xong): người dùng tick trang ngay lúc còn đang gõ tên App, rồi bấm
// "Tạo" một lần — tick 0 trang vẫn tạo được bình thường (import bị bỏ qua).
// App đã tồn tại trước khi gọi import-confluence, nên import lỗi KHÔNG coi là
// tạo App thất bại: lỗi hiện ra ở màn kết quả, người dùng thử lại ngay trong
// AppPoolSection (đã có sẵn "Nhập tài liệu từ Confluence" cho đúng việc đó).

import { useState } from 'react';
import type { AppPoolImportResponse } from '@open-design/contracts';

import {
  FormError,
  FormField,
  FormText,
  PipelineFormModal,
  PrimaryButton,
  QuietButton,
  TextInput,
} from './PipelineFormModal';
import { AppPoolSection } from './AppPoolSection';
import { ConfluenceTreePicker } from './ConfluenceTreeImport';
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
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // App vừa tạo xong: giữ modal MỞ thêm một bước để hiện kết quả nhập tài
  // liệu (nếu có) + pool đầy đủ — đóng modal luôn thì người dùng phải tự mở
  // lại App vừa tạo (kebab → Sửa) mới thấy được phần Import/pool. `onCreated`
  // (điều hướng sang màn Features) chỉ gọi khi bấm "Xong" ở bước này.
  const [createdAppId, setCreatedAppId] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<AppPoolImportResponse | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

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
    let newAppId: string;
    try {
      const res = await fetch('/api/pipelines/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appId,
          name: nameTrim,
        }),
      });
      const j = await res.json().catch(() => ({}));
      // 409 = mã đã có. KHÔNG tự thêm hậu tố: khác Feature, App là thứ người
      // dùng sẽ gọi tên hằng ngày, "retail-3f2a" đằng sau lưng họ là sai.
      if (!res.ok) throw new Error(j?.error || `tạo App thất bại: ${res.status}`);
      newAppId = j?.id ?? appId;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }

    // Từ đây App đã tồn tại — mọi lỗi tiếp theo là lỗi IMPORT, không phải lỗi
    // tạo App. Modal vẫn chuyển sang màn kết quả; lỗi (nếu có) hiện ở đó.
    setCreatedAppId(newAppId);
    if (ticked.size > 0) {
      try {
        const refs = [...ticked];
        const importRes = await fetch(`/api/pipelines/apps/${encodeURIComponent(newAppId)}/import-confluence`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refs }),
        });
        const importJson = await importRes.json().catch(() => ({}));
        if (!importRes.ok) throw new Error(importJson?.error || `Nhập tài liệu thất bại (${importRes.status}).`);
        setImportResult(importJson as AppPoolImportResponse);
      } catch (cause) {
        setImportError(cause instanceof Error ? cause.message : 'Nhập tài liệu thất bại.');
      }
    }
    setBusy(false);
  };

  const finish = async () => {
    if (!createdAppId) return;
    await onCreated(createdAppId);
    onClose();
  };

  if (createdAppId) {
    return (
      <PipelineFormModal
        title="App đã tạo"
        icon="blocks"
        onClose={() => void finish()}
        footer={
          <PrimaryButton icon="check" onClick={() => void finish()}>
            Xong
          </PrimaryButton>
        }
      >
        <FormText>
          App “{nameTrim}” đã tạo.
          {importResult
            ? ` Đã nhập ${importResult.imported} trang mới${importResult.updated > 0 ? `, cập nhật ${importResult.updated} trang` : ''}.`
            : null}
        </FormText>
        {importError ? <FormError>{importError} — App vẫn đã tạo; nhập lại bên dưới.</FormError> : null}
        <AppPoolSection appId={createdAppId} />
      </PipelineFormModal>
    );
  }

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
        label="Tài liệu Confluence (tùy chọn)"
        hint={
          ticked.size > 0
            ? `${ticked.size} trang đã tick — nhập ngay khi bấm Tạo.`
            : 'Tìm và tick trang muốn nhập ngay khi tạo App, hoặc bỏ qua và nhập sau ở màn Sửa App.'
        }
      >
        {(fieldProps) => (
          <ConfluenceTreePicker {...fieldProps} ticked={ticked} onTickedChange={setTicked} disabled={busy} />
        )}
      </FormField>

      {error ? <FormError>{error}</FormError> : null}
    </PipelineFormModal>
  );
}
