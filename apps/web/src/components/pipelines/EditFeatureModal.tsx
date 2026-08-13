// ── Sửa Feature: đổi tên và/hoặc chuyển App cha ──────────────────────────────
// Hai việc này ở chung một form vì chúng là cùng một câu hỏi ("feature này tên
// gì, thuộc đâu") và người dùng thường sửa cả hai một lượt sau khi đặt tên sai.
//
// Bỏ trống ô App = GỠ feature khỏi App (nó rơi về rổ "Chưa gán app"), gửi
// `appId: null` — khác với "không sửa gì", nên phải là null tường minh chứ
// không phải chuỗi rỗng.
//
// Mã/thư mục làm việc (id) không sửa được ở đây, giống EditAppModal.

import { useState } from 'react';
import type { PipelineProject } from '@open-design/contracts';

import {
  ComboInput,
  FormError,
  FormField,
  PipelineFormModal,
  PrimaryButton,
  QuietButton,
  TextInput,
} from './PipelineFormModal';
import { appLabelOf, toSlugId, useAppOptions } from './newProjectForm';

export function EditFeatureModal({
  feature,
  onClose,
  onSaved,
}: {
  feature: PipelineProject;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const apps = useAppOptions();
  const initialAppLabel = feature.app ? feature.app.name || feature.app.id : '';
  const [featureName, setFeatureName] = useState(feature.name);
  const [appName, setAppName] = useState(initialAppLabel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const featureNameTrim = featureName.trim();
  const appNameTrim = appName.trim();
  // Gõ trùng tên một App đã có thì gắn vào đúng App đó thay vì đẻ ra một App
  // thứ hai cùng tên nhưng khác id (cùng luật với NewFeatureModal).
  const matchedApp = apps.find((a) => appLabelOf(a).trim().toLowerCase() === appNameTrim.toLowerCase());

  const nameChanged = featureNameTrim !== feature.name;
  const appChanged = appNameTrim !== initialAppLabel.trim();
  const canSubmit = Boolean(featureNameTrim) && (nameChanged || appChanged);

  const submit = async () => {
    if (busy || !canSubmit) return;
    setBusy(true);
    setError(null);

    // Chỉ gửi phần người dùng thật sự đổi: PATCH trường không đổi là cách âm
    // thầm ghi đè dữ liệu mà họ không hề chạm vào.
    const body: { name?: string; appId?: string | null; appName?: string } = {};
    if (nameChanged) body.name = featureNameTrim;
    if (appChanged) {
      if (!appNameTrim) {
        body.appId = null;
      } else {
        body.appId = matchedApp?.id ?? toSlugId(appNameTrim);
        body.appName = matchedApp?.name || appNameTrim;
      }
    }

    try {
      const res = await fetch(`/api/pipelines/projects/${encodeURIComponent(feature.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `lưu Feature thất bại: ${res.status}`);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const onEnter = (e: { key: string }) => {
    if (e.key === 'Enter') void submit();
  };

  return (
    <PipelineFormModal
      title="Sửa tính năng"
      icon="folder"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <QuietButton onClick={onClose} disabled={busy}>
            Hủy
          </QuietButton>
          <PrimaryButton
            icon="check"
            busy={busy}
            data-testid="edit-feature-submit"
            onClick={() => void submit()}
            disabled={busy || !canSubmit}
          >
            {busy ? 'Đang lưu…' : 'Lưu'}
          </PrimaryButton>
        </>
      }
    >
      <FormField label="Tên tính năng" hint={`Thư mục làm việc giữ nguyên: ${feature.id}`}>
        {(fieldProps) => (
          <TextInput
            {...fieldProps}
            autoFocus
            data-testid="edit-feature-name"
            placeholder="Thanh toán"
            value={featureName}
            onChange={(e) => setFeatureName(e.target.value)}
            onKeyDown={onEnter}
          />
        )}
      </FormField>

      <FormField
        label="Thuộc dự án (tuỳ chọn)"
        hint={
          !appNameTrim
            ? 'Bỏ trống = gỡ tính năng khỏi dự án, nó về nhóm “Chưa thuộc dự án”.'
            : matchedApp
              ? 'Đã có dự án trùng tên — tính năng sẽ chuyển vào dự án đó thay vì tạo dự án mới.'
              : `Dự án mới sẽ được tạo, mã dự án: ${toSlugId(appNameTrim)}`
        }
      >
        {(fieldProps) => (
          <ComboInput
            {...fieldProps}
            data-testid="edit-feature-app-picker"
            placeholder="Retail"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            onKeyDown={onEnter}
            options={apps.map((a) => ({
              value: appLabelOf(a),
              label: a.origin === 'remote' ? 'trên studio' : 'local',
            }))}
          />
        )}
      </FormField>

      {error ? <FormError>{error}</FormError> : null}
    </PipelineFormModal>
  );
}
