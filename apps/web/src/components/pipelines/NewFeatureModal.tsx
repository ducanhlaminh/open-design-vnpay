// ── Tạo Feature mới ngay tại Open Design ─────────────────────────────────────
// Feature là thứ pipeline thật sự chạy trên (App chỉ là cặp {id, name} gắn vào
// feature, không cwd, không bước, không gì để chạy). Lúc Push mới chọn đích:
// dự án đã có trên studio thì ghi đè, chưa có thì đi qua vùng CHỜ DUYỆT
// (folder `pending--…`) cho người có quyền duyệt.
//
// Form này CHỈ hỏi thông tin của Feature: tên, và App cha nếu chưa biết. Cấu
// hình workflow (nguồn tài liệu, platform, design system, target…) ở chỗ cũ
// (RunAllModal / RunInputModal / registry), không nhồi vào đây.

import { useMemo, useState } from 'react';

import {
  ComboInput,
  FormError,
  FormField,
  PipelineFormModal,
  PrimaryButton,
  QuietButton,
  TextInput,
} from './PipelineFormModal';
import { ID_MAX, appLabelOf, toSlugId, useAppOptions } from './newProjectForm';

export function NewFeatureModal({
  onClose,
  onCreated,
  initialAppId,
}: {
  onClose: () => void;
  onCreated: (projectId: string) => void | Promise<void>;
  /** App cha đã chọn từ route — khoá lại, không cho sửa nhầm. Vắng mặt =
   *  người dùng tự chọn, bỏ trống thì feature vào nhóm "Chưa gán app". */
  initialAppId?: string;
}) {
  const apps = useAppOptions();
  const [featureName, setFeatureName] = useState('');
  const [appName, setAppName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // App cha đến từ route dưới dạng ID, nhưng người dùng chỉ nên thấy TÊN — tra
  // ngược trong danh sách đã fetch, chưa có thì tạm hiện id.
  const lockedApp = useMemo(
    () => (initialAppId ? apps.find((a) => a.id === initialAppId) : undefined),
    [initialAppId, apps],
  );
  const lockedAppLabel = lockedApp?.name || initialAppId || '';

  const appNameTrim = appName.trim();
  const featureNameTrim = featureName.trim();
  // Gõ trùng tên một App đã có thì gắn vào đúng App đó thay vì đẻ ra một App
  // thứ hai cùng tên nhưng khác id.
  const matchedApp = apps.find((a) => appLabelOf(a).trim().toLowerCase() === appNameTrim.toLowerCase());

  const canSubmit = Boolean(featureNameTrim);
  // App gắn vào feature đến từ ô người dùng gõ, TRỪ khi route đã khoá sẵn.
  const appFromInput = !initialAppId;

  const submit = async () => {
    if (busy || !canSubmit) return;
    setBusy(true);
    setError(null);

    const appId = appFromInput
      ? appNameTrim
        ? matchedApp?.id ?? toSlugId(appNameTrim)
        : ''
      : initialAppId ?? '';
    const appLabel = appFromInput ? matchedApp?.name || appNameTrim : lockedApp?.name;
    const baseId = toSlugId(featureNameTrim);

    const attempt = (projectId: string) =>
      fetch('/api/pipelines/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          name: featureNameTrim,
          ...(appId ? { appId } : {}),
          ...(appId && appLabel ? { appName: appLabel } : {}),
        }),
      });

    try {
      // Id sinh tự động nên người dùng không biết trước để tự đổi khi trùng —
      // thử id gốc, đụng 409 thì thử lại một lần với hậu tố ngắn thay vì bắt họ
      // quay lại sửa một trường họ chưa từng thấy.
      let res = await attempt(baseId);
      if (res.status === 409) {
        res = await attempt(`${baseId}-${Date.now().toString(36).slice(-4)}`.slice(0, ID_MAX));
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `tạo Feature thất bại: ${res.status}`);
      await onCreated(j?.id ?? baseId);
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
      title="Feature mới"
      icon="folder"
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
        label="Tên Feature"
        hint={
          featureNameTrim
            ? `Thư mục làm việc: ${toSlugId(featureNameTrim)}`
            : 'Tên nghiệp vụ của feature, vd Thanh toán. Mã/thư mục làm việc sinh tự động từ tên này.'
        }
      >
        {(fieldProps) => (
          <TextInput
            {...fieldProps}
            autoFocus
            placeholder="Thanh toán"
            value={featureName}
            onChange={(e) => setFeatureName(e.target.value)}
            onKeyDown={onEnter}
          />
        )}
      </FormField>

      {/* App chỉ là ngữ cảnh: đã khoá khi mở từ trong một App, còn lại là phần
          gán thêm tuỳ chọn. */}
      {appFromInput ? (
        <FormField
          label="Thuộc App (tuỳ chọn)"
          hint={
            matchedApp
              ? 'Đã có App trùng tên — feature sẽ được thêm vào App đó thay vì tạo App mới.'
              : appNameTrim
                ? `Mã App: ${toSlugId(appNameTrim)}`
                : 'Bỏ trống nếu feature không thuộc App nào. Gõ tên App có sẵn hoặc một tên mới.'
          }
        >
          {(fieldProps) => (
            <ComboInput
              {...fieldProps}
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
      ) : (
        <FormField label="Thuộc App">
          {(fieldProps) => <TextInput {...fieldProps} value={lockedAppLabel} disabled readOnly />}
        </FormField>
      )}

      {error ? <FormError>{error}</FormError> : null}
    </PipelineFormModal>
  );
}
