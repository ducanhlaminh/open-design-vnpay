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
// tạo App thất bại: lỗi hiện ra ở màn kết quả, người dùng thử lại ở màn Sửa
// App (AppPoolSection's "Nhập tài liệu từ Confluence" — CHỈ hiện ở đó, màn
// kết quả bên dưới cố tình KHÔNG lặp lại affordance import thứ hai).
//
// WP22b — App tạo xong với nhiều tài liệu KHÔNG còn giam người dùng trong
// modal chờ import chạy xong: `submit` gọi `startAppImport` (job nền daemon,
// xem .tmp/pipeline/wp22-contract.md) rồi ĐÓNG MODAL NGAY khi nhận 202,
// không còn chờ RESOLVE và không còn màn "App đã tạo" trung gian cho ca
// thành công. Theo dõi tiến độ import chuyển sang `AppImportBanner`
// (PipelinesFeaturesView + AppPoolSection) — modal không còn hiện %.
//
// start-job LỖI (409/400/502…) vẫn giữ hành vi cũ: App đã tồn tại tại thời
// điểm đó (POST tạo App đã resolve OK trước), nên lỗi start KHÔNG coi là lỗi
// tạo App — modal lật sang màn "App đã tạo" để hiện lỗi, người dùng thử nhập
// lại ở màn Sửa App. Import cũ dùng `importConfluenceInBatches`
// (ConfluenceTreeImport.tsx) VẪN CÒN TỒN TẠI (dùng ở AppPoolSection/
// ConfluenceTreeImport) — chỉ NewAppModal thôi dùng nó.

import { useEffect, useState } from 'react';
import type { DocsReviewComponentSource, FigmaDesignSystemSource, ListFigmaDesignSystemSourcesResponse } from '@open-design/contracts';

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
import { startAppImport } from '../../providers/app-import-jobs';
import { appLabelOf, toSlugId, useAppOptions } from './newProjectForm';
import { fetchDesignSystems } from '../../providers/registry';
import { ProjectDesignSystemPicker } from '../ProjectDesignSystemPicker';
import styles from './EditAppModal.module.css';

export function NewAppModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (appId: string) => void | Promise<void>;
}) {
  const apps = useAppOptions();
  const [name, setName] = useState('');
  const [systems, setSystems] = useState<Awaited<ReturnType<typeof fetchDesignSystems>> | null>(null);
  const [designSystemId, setDesignSystemId] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<'app-design-system' | 'figma-design-system'>('app-design-system');
  const [figmaSources, setFigmaSources] = useState<FigmaDesignSystemSource[] | null>(null);
  const [figmaDesignSystemSourceId, setFigmaDesignSystemSourceId] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [relatedTicked, setRelatedTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'creating' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // App vừa tạo xong nhưng START IMPORT lỗi: giữ modal MỞ thêm một bước để
  // hiện lỗi đó + pool (rỗng, vì import chưa chạy lô nào) — đóng modal luôn
  // thì người dùng phải tự mở lại App vừa tạo (kebab → Sửa) mới thấy được lỗi.
  // Ca THÀNH CÔNG (202, hoặc không tick trang nào) không còn màn này —
  // xem docblock đầu file. `onCreated` (điều hướng sang màn Features) chỉ
  // gọi khi bấm "Xong" ở bước này, hoặc ngay khi thành công ở nhánh dưới.
  const [createdAppId, setCreatedAppId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    void fetchDesignSystems().then(setSystems);
    void fetch('/api/figma-design-systems')
      .then(async (response) => {
        if (!response.ok) throw new Error(`Không tải được Design system Figma: ${response.status}`);
        return response.json() as Promise<ListFigmaDesignSystemSourcesResponse>;
      })
      .then((body) => setFigmaSources(body.sources))
      .catch(() => setFigmaSources([]));
  }, []);

  const nameTrim = name.trim();
  // Trùng tên KHÔNG được im lặng tái dùng App cũ: người dùng đang bấm "App
  // mới", nếu ta lặng lẽ trả về App có sẵn thì họ tin là vừa tạo một App khác.
  const duplicate = apps.some((a) => appLabelOf(a).trim().toLowerCase() === nameTrim.toLowerCase());
  const componentSource: DocsReviewComponentSource = { mode: 'app-design-system' };
  const canSubmit = Boolean(nameTrim) && !duplicate
    && (sourceMode !== 'figma-design-system' || Boolean(figmaDesignSystemSourceId));

  const submit = async () => {
    if (busy || !canSubmit) return;
    setBusy(true);
    setPhase('creating');
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
          // Picker DS bị ẩn ở chế độ Link Figma → không gửi lựa chọn ẩn.
          ...(designSystemId && sourceMode === 'app-design-system' ? { designSystemId } : {}),
          ...(sourceMode === 'figma-design-system' && figmaDesignSystemSourceId ? { figmaDesignSystemSourceId } : {}),
          docsReviewComponentSource: componentSource,
        }),
      });
      const j = await res.json().catch(() => ({}));
      // 409 = mã đã có. KHÔNG tự thêm hậu tố: khác Feature, App là thứ người
      // dùng sẽ gọi tên hằng ngày, "retail-3f2a" đằng sau lưng họ là sai.
      if (!res.ok) throw new Error(j?.error || `tạo App thất bại: ${res.status}`);
      newAppId = j?.id ?? appId;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase(null);
      setBusy(false);
      return;
    }

    // Từ đây App đã tồn tại — mọi lỗi tiếp theo là lỗi START IMPORT, không
    // phải lỗi tạo App. Không tick trang nào → hành vi cũ nguyên vẹn: không
    // gọi start, đóng modal luôn.
    if (ticked.size > 0) {
      const started = await startAppImport(newAppId, { refs: [...ticked], relatedRefs: [...relatedTicked] });
      if (!started.ok) {
        // Modal lật sang màn "App đã tạo" CHỈ để hiện lỗi này — đóng câm là
        // nuốt mất thông tin người dùng cần thấy. Chưa lô nào chạy nên pool
        // vẫn rỗng; người dùng thử lại ở màn Sửa App.
        setImportError(`${started.error} — chưa nhập trang nào, thử lại ở màn Sửa App.`);
        setPhase(null);
        setBusy(false);
        setCreatedAppId(newAppId);
        return;
      }
      // 202: job đã bắt đầu chạy nền daemon. Modal KHÔNG chờ nữa — tiến độ
      // hiện ở AppImportBanner (màn App / AppPoolSection) sau khi đóng.
    }
    setPhase(null);
    setBusy(false);
    await onCreated(newAppId);
    onClose();
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
        wide
        onClose={() => void finish()}
        footer={
          <PrimaryButton icon="check" onClick={() => void finish()}>
            Xong
          </PrimaryButton>
        }
      >
        <FormText>App “{nameTrim}” đã tạo.</FormText>
        {importError ? <FormError>{importError}</FormError> : null}
        {/* Màn xác nhận: cây trang pool (rỗng — job start lỗi, chưa lô nào chạy). */}
        <AppPoolSection appId={createdAppId} hideImport />
      </PipelineFormModal>
    );
  }

  return (
    <PipelineFormModal
      title="Dự án mới"
      icon="blocks"
      busy={busy}
      wide
      onClose={onClose}
      footer={
        <>
          <QuietButton onClick={onClose} disabled={busy}>
            Hủy
          </QuietButton>
          <PrimaryButton
            icon="check"
            busy={busy}
            data-testid="new-app-submit"
            onClick={() => void submit()}
            disabled={busy || !canSubmit}
          >
            {busy ? 'Đang tạo…' : 'Tạo'}
          </PrimaryButton>
        </>
      }
    >
      <FormField
        label="Tên dự án"
        hint={
          duplicate
            ? 'Dự án đã tồn tại — chọn tên khác, hoặc mở dự án đó và thêm tính năng vào.'
            : nameTrim
              ? `Mã dự án: ${toSlugId(nameTrim)}`
              : 'Tên sản phẩm/hệ thống, vd Retail, BIDV. Mã dự án sinh tự động từ tên này.'
        }
      >
        {(fieldProps) => (
          <TextInput
            {...fieldProps}
            autoFocus
            data-testid="new-app-name"
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
              <input type="radio" name="new-app-component-source" checked={sourceMode === 'app-design-system'} onChange={() => setSourceMode('app-design-system')} />
              <span><strong>Design System đã nạp</strong><small>Dùng bộ component đã lưu trong dự án.</small></span>
            </label>
            <label className={styles.sourceChoice}>
              <input type="radio" name="new-app-component-source" checked={sourceMode === 'figma-design-system'} onChange={() => setSourceMode('figma-design-system')} />
              <span><strong>Design system từ link Figma</strong><small>Chọn một danh mục component đã nạp ở trang Design system.</small></span>
            </label>
          </div>
        )}
      </FormField>

      {sourceMode === 'figma-design-system' ? (
        <FormField label="Design system Figma" hint="Chỉ hiển thị nguồn đã nạp catalog thành công. Link và token được quản lý ở trang Design system.">
          {(fieldProps) => (
            <select {...fieldProps} className={styles.sourceSelect} value={figmaDesignSystemSourceId ?? ''} onChange={(event) => setFigmaDesignSystemSourceId(event.target.value || null)}>
              <option value="">{figmaSources === null ? 'Đang tải…' : 'Chọn Design system Figma'}</option>
              {(figmaSources ?? []).filter((source) => source.catalog !== null && (source.status === 'ready' || source.status === 'error')).map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name} · {source.catalog?.componentCount ?? 0} component{source.status === 'error' ? ' · dùng bản cập nhật gần nhất' : ''}
                </option>
              ))}
            </select>
          )}
        </FormField>
      ) : null}

      {sourceMode === 'app-design-system' ? (
        <FormField
          label="Design System (Figma)"
          hint="Tuỳ chọn. Bộ này là nguồn tiêu chuẩn review cho mọi tính năng của dự án; bước “Tài liệu (nạp)” sẽ chép components.md và rules.md (nếu có) vào criteria/."
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

      <FormField
        label="Tài liệu Confluence (tùy chọn)"
        // Số trang đã tick là chip trong đầu panel picker, nên hint ở đây chỉ
        // còn nói điều panel không nói được: chuyện gì xảy ra khi bấm Tạo.
        hint={
          ticked.size > 0
            ? 'Các trang này bắt đầu nhập vào kho tài liệu ngay khi bấm Tạo — modal đóng luôn, xem tiến độ ở màn dự án.'
            : 'Tìm và tick trang muốn nhập ngay khi tạo dự án, hoặc bỏ qua và nhập sau ở màn Sửa dự án.'
        }
      >
        {(fieldProps) => (
          <ConfluenceTreePicker {...fieldProps} ticked={ticked} onTickedChange={setTicked} relatedTicked={relatedTicked} onRelatedTickedChange={setRelatedTicked} disabled={busy} />
        )}
      </FormField>

      {phase === 'creating' ? <FormText>Đang tạo dự án…</FormText> : null}
      {error ? <FormError>{error}</FormError> : null}
    </PipelineFormModal>
  );
}
