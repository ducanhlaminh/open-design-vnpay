// ── Chỉnh sửa thông tin Dự án ────────────────────────────────────────────────
// Form sửa tên hiển thị và Design System áp dụng cho Dự án. Mã Dự án (id) là
// tên thư mục nội bộ nên không sửa ở đây.
//
// Cấu hình workflow không thuộc form này (nó ở RunAllModal / RunInputModal /
// registry), giống hai form khai sinh cạnh đây.

import { useEffect, useState } from 'react';
import type { DesignSystemSummary, DocsReviewComponentSource } from '@open-design/contracts';

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
import { FigmaLinksPanel } from './FigmaLinksPanel';
import styles from './EditAppModal.module.css';

export function normalizeFigmaLinks(raw: string): { links: Array<{ url: string; fileKey: string; nodeId?: string }>; error: string | null } {
  const values = raw.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return { links: [], error: 'Dán ít nhất 1 link Figma.' };
  if (values.length > 5) return { links: [], error: 'Chỉ nhập tối đa 5 link Figma mỗi lần.' };
  const links: Array<{ url: string; fileKey: string; nodeId?: string }> = [];
  const seen = new Set<string>();
  for (const value of values) {
    let url: URL;
    try { url = new URL(value); } catch { return { links: [], error: `Link không hợp lệ: ${value}` }; }
    if (url.protocol !== 'https:' || !/^(?:www\.)?figma\.com$/i.test(url.hostname)) return { links: [], error: `Đây không phải link Figma: ${value}` };
    const match = url.pathname.match(/^\/(?:design|file)\/([^/]+)/i);
    if (!match?.[1]) return { links: [], error: `Không tìm thấy mã file trong link: ${value}` };
    let fileKey = '';
    try { fileKey = decodeURIComponent(match[1]); } catch { return { links: [], error: `Mã file không hợp lệ trong link: ${value}` }; }
    if (!/^[A-Za-z0-9]+$/.test(fileKey)) return { links: [], error: `Mã file không hợp lệ trong link: ${value}` };
    const rawNodeId = url.searchParams.get('node-id')?.trim() || undefined;
    if (rawNodeId && !/^\d+(?::|-)\d+$/.test(rawNodeId)) return { links: [], error: `node-id không hợp lệ trong link: ${value}` };
    const nodeId = rawNodeId?.replace('-', ':');
    if (seen.has(fileKey)) continue;
    seen.add(fileKey);
    const canonical = new URL(`https://www.figma.com/design/${encodeURIComponent(fileKey)}`);
    if (nodeId) canonical.searchParams.set('node-id', nodeId.replace(':', '-'));
    links.push({ url: canonical.toString(), fileKey, ...(nodeId ? { nodeId } : {}) });
  }
  return { links, error: links.length > 0 ? null : 'Dán ít nhất 1 link Figma.' };
}

export function EditAppModal({
  app,
  onClose,
  onSaved,
}: {
  app: { id: string; name: string; designSystemId?: string | null; docsReviewComponentSource?: DocsReviewComponentSource };
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const apps = useAppOptions();
  const [name, setName] = useState(app.name);
  const [systems, setSystems] = useState<DesignSystemSummary[] | null>(null);
  const [designSystemId, setDesignSystemId] = useState<string | null>(app.designSystemId ?? null);
  const initialSource = app.docsReviewComponentSource ?? { mode: 'app-design-system' as const };
  const [sourceMode, setSourceMode] = useState<DocsReviewComponentSource['mode']>(initialSource.mode);
  const [figmaLinks, setFigmaLinks] = useState(initialSource.mode === 'figma-links' ? initialSource.links.map((file) => file.url).join('\n') : '');
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
  // Nguồn Link Figma thì App KHÔNG gắn Design System (picker bị ẩn) — thứ
  // ẩn đi mà vẫn được lưu và vẫn chép rules.md vào criteria/ là trạng thái
  // ngầm gây nhầm. Đổi lại chế độ DS thì lựa chọn cũ hiện lại (state giữ).
  const effectiveDesignSystemId = sourceMode === 'app-design-system' ? designSystemId : null;
  const designSystemChanged = effectiveDesignSystemId !== (app.designSystemId ?? null);
  const normalizedLinks = normalizeFigmaLinks(figmaLinks);
  const nextSource: DocsReviewComponentSource = sourceMode === 'app-design-system'
    ? { mode: 'app-design-system' }
    : { mode: 'figma-links', links: normalizedLinks.links };
  const sourceChanged = JSON.stringify(nextSource) !== JSON.stringify(initialSource);
  const canSubmit = Boolean(nameTrim) && !duplicate
    && (sourceMode !== 'figma-links' || !normalizedLinks.error)
    && (nameChanged || designSystemChanged || sourceChanged);

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
          ...(designSystemChanged ? { designSystemId: effectiveDesignSystemId } : {}),
          ...(sourceChanged ? { docsReviewComponentSource: nextSource } : {}),
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
      title="Thông tin dự án"
      icon="blocks"
      wide
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
            data-testid="edit-app-submit"
            onClick={() => void submit()}
            disabled={busy || !canSubmit}
          >
            {busy ? 'Đang lưu…' : 'Lưu thay đổi'}
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
            data-testid="edit-app-name"
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
        label="Nguồn đối chiếu component"
        hint="Chọn nơi ứng dụng lấy component chuẩn khi chạy bước rà soát component."
      >
        {(fieldProps) => (
          <div {...fieldProps} className={styles.sourceChoices} role="radiogroup" aria-label="Nguồn đối chiếu component">
            <label className={styles.sourceChoice}>
              <input type="radio" name="component-source" checked={sourceMode === 'app-design-system'} onChange={() => setSourceMode('app-design-system')} />
              <span><strong>Design System đã nạp</strong><small>Dùng bộ component đã lưu trong dự án.</small></span>
            </label>
            <label className={styles.sourceChoice}>
              <input type="radio" name="component-source" checked={sourceMode === 'figma-links'} onChange={() => setSourceMode('figma-links')} />
              <span><strong>Link Figma</strong><small>Đọc component từ 1–5 file Figma bằng token của bạn.</small></span>
            </label>
          </div>
        )}
      </FormField>

      {sourceMode === 'figma-links' ? (
        <>
          <FormField label="Link file Figma" hint="Mỗi dòng một link (tối đa 5). Link trùng sẽ tự động được bỏ qua." error={normalizedLinks.error ?? undefined}>
            {(fieldProps) => <textarea {...fieldProps} className={styles.linksInput} rows={4} value={figmaLinks} onChange={(event) => setFigmaLinks(event.target.value)} placeholder="https://www.figma.com/design/…?node-id=…" />}
          </FormField>
          <FigmaLinksPanel links={normalizedLinks.links} linksError={normalizedLinks.error} />
        </>
      ) : null}

      {sourceMode === 'app-design-system' ? (
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
      ) : null}

      {error ? <FormError>{error}</FormError> : null}

      <AppPoolSection appId={app.id} />
    </PipelineFormModal>
  );
}
