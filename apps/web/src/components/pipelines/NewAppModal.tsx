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
// `submit` chờ import-confluence RESOLVE (thành công hay lỗi) rồi mới lật
// sang màn "App đã tạo" — AppPoolSection tự fetch pool ngay lúc mount, nên
// mount nó SỚM hơn (trước khi import xong) là một race: pool fetch đầu tiên
// trả về rỗng, "Đã nhập N trang" hiện ra nhưng card pool vẫn nói "Chưa có
// tài liệu". Đợi import xong trước khi setCreatedAppId loại bỏ race đó.
//
// `phase` hiện trạng thái từng bước thay vì im lặng trong lúc `busy`: 'creating'
// ('Đang tạo App…') → 'importing' (progress bar % thật — xem dưới — chỉ khi
// có trang tick) → setCreatedAppId. Tạo App CHỈ NẠP tài liệu vào pool —
// Tạo App chỉ nạp tài liệu vào pool; bước 1 của workflow sẽ copy các trang
// được chọn vào workspace khi chạy.
//
// Import dùng `importConfluenceInBatches` (ConfluenceTreeImport.tsx) thay vì
// một POST refs[N] duy nhất — daemon trả về MỘT response cho cả yêu cầu, nên
// batch nhỏ dần tuần tự là cách duy nhất có %-thật thay vì "im lặng rồi xong".
// Batch lỗi giữa chừng → KHÔNG rollback (phần trước đã ghi lên đĩa); vẫn
// setImportResult với phần đã nhập và hiện lỗi kèm "đã nhập X/N".

import { useEffect, useRef, useState } from 'react';
import type { AppPoolImportResponse, DocsReviewComponentSource } from '@open-design/contracts';

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
import { ConfluenceImportBatchError, ConfluenceTreePicker, importConfluenceInBatches } from './ConfluenceTreeImport';
import { ProgressBar } from './ProgressBar';
import { appLabelOf, toSlugId, useAppOptions } from './newProjectForm';
import { fetchDesignSystems } from '../../providers/registry';
import { ProjectDesignSystemPicker } from '../ProjectDesignSystemPicker';
import { normalizeFigmaLinks } from './EditAppModal';
import { FigmaLinksPanel } from './FigmaLinksPanel';
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
  const [sourceMode, setSourceMode] = useState<DocsReviewComponentSource['mode']>('app-design-system');
  const [figmaLinks, setFigmaLinks] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [relatedTicked, setRelatedTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'creating' | 'importing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // App vừa tạo xong: giữ modal MỞ thêm một bước để hiện kết quả nhập tài
  // liệu (nếu có) + pool đầy đủ — đóng modal luôn thì người dùng phải tự mở
  // lại App vừa tạo (kebab → Sửa) mới thấy được phần Import/pool. `onCreated`
  // (điều hướng sang màn Features) chỉ gọi khi bấm "Xong" ở bước này.
  const [createdAppId, setCreatedAppId] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<AppPoolImportResponse | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  // "Dừng nhập" while batches are flying: abort the in-flight batch, skip the
  // rest. The App already exists at that point, so we keep whatever landed
  // and close like a success — the pool section shows what got imported.
  const importAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => importAbortRef.current?.abort(), []);

  useEffect(() => {
    void fetchDesignSystems().then(setSystems);
  }, []);

  const nameTrim = name.trim();
  // Trùng tên KHÔNG được im lặng tái dùng App cũ: người dùng đang bấm "App
  // mới", nếu ta lặng lẽ trả về App có sẵn thì họ tin là vừa tạo một App khác.
  const duplicate = apps.some((a) => appLabelOf(a).trim().toLowerCase() === nameTrim.toLowerCase());
  const normalizedLinks = normalizeFigmaLinks(figmaLinks);
  const componentSource: DocsReviewComponentSource = sourceMode === 'app-design-system'
    ? { mode: 'app-design-system' }
    : { mode: 'figma-links', links: normalizedLinks.links };
  const canSubmit = Boolean(nameTrim) && !duplicate
    && (sourceMode !== 'figma-links' || !normalizedLinks.error);

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

    // Từ đây App đã tồn tại — mọi lỗi tiếp theo là lỗi IMPORT, không phải lỗi
    // tạo App; nhưng vẫn phải RESOLVE trước khi lật màn (xem docblock ở đầu
    // file) để AppPoolSection's mount-time pool fetch thấy đúng dữ liệu.
    let importFailed = false;
    if (ticked.size > 0) {
      setPhase('importing');
      const refs = [...ticked];
      setImportProgress({ done: 0, total: refs.length });
      const controller = new AbortController();
      importAbortRef.current = controller;
      try {
        const result = await importConfluenceInBatches(newAppId, refs, (done, total) => setImportProgress({ done, total }), [...relatedTicked], controller.signal);
        setImportResult(result);
      } catch (cause) {
        if (cause instanceof ConfluenceImportBatchError && cause.aborted) {
          // Người dùng bấm Dừng: App + các trang đã nhập được giữ nguyên,
          // đóng modal như thành công (phần còn lại nhập sau ở Sửa dự án).
          if (cause.succeededRefs.length > 0) setImportResult(cause.partial);
        } else if (cause instanceof ConfluenceImportBatchError) {
          importFailed = true;
          setImportError(
            `${cause.message} (đã nhập ${cause.succeededRefs.length}/${refs.length} trang trước khi lỗi — không rollback)`,
          );
          if (cause.succeededRefs.length > 0) setImportResult(cause.partial);
        } else {
          importFailed = true;
          setImportError(cause instanceof Error ? cause.message : 'Nhập tài liệu thất bại.');
        }
      }
      importAbortRef.current = null;
      setImportProgress(null);
    }
    // KHÔNG còn màn "App đã tạo" trung gian: thành công → đóng modal luôn,
    // card App mới xuất hiện là xác nhận. Màn xác nhận CHỈ giữ cho ca import
    // LỖI — đóng câm khi lỗi là nuốt mất thông tin người dùng cần thấy.
    setPhase(null);
    setBusy(false);
    if (importFailed) {
      setCreatedAppId(newAppId);
      return;
    }
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
        <FormText>
          App “{nameTrim}” đã tạo.
          {importResult
            ? ` Đã nhập ${importResult.imported} trang mới${importResult.updated > 0 ? `, cập nhật ${importResult.updated} trang` : ''}.`
            : null}
          {' '}Tài liệu đã nạp vào App — bước 1 của workflow sẽ copy trang được chọn vào workspace khi chạy.
        </FormText>
        {importError ? <FormError>{importError} — App vẫn đã tạo; nhập lại ở màn Sửa App.</FormError> : null}
        {/* Màn xác nhận NẠP: cây trang để soát lại đã import đúng chưa. */}
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
          {phase === 'importing' ? (
            <QuietButton onClick={() => importAbortRef.current?.abort()} data-testid="new-app-stop-import">
              Dừng nhập
            </QuietButton>
          ) : (
            <QuietButton onClick={onClose} disabled={busy}>
              Hủy
            </QuietButton>
          )}
          <PrimaryButton
            icon="check"
            busy={busy}
            data-testid="new-app-submit"
            onClick={() => void submit()}
            disabled={busy || !canSubmit}
          >
            {phase === 'importing' ? 'Đang nhập tài liệu…' : busy ? 'Đang tạo…' : 'Tạo'}
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
              <input type="radio" name="new-app-component-source" checked={sourceMode === 'figma-links'} onChange={() => setSourceMode('figma-links')} />
              <span><strong>Link Figma</strong><small>Đọc component từ 1–5 file Figma bằng token của bạn.</small></span>
            </label>
          </div>
        )}
      </FormField>

      {sourceMode === 'figma-links' ? (
        <>
          <FormField label="Link file Figma" hint="Mỗi dòng một link (tối đa 5). Link trùng sẽ tự động được bỏ qua." error={normalizedLinks.error ?? undefined}>
            {(fieldProps) => (
              <textarea
                {...fieldProps}
                className={styles.linksInput}
                rows={4}
                value={figmaLinks}
                onChange={(event) => setFigmaLinks(event.target.value)}
                placeholder="https://www.figma.com/design/…?node-id=…"
              />
            )}
          </FormField>
          <FigmaLinksPanel links={normalizedLinks.links} linksError={normalizedLinks.error} />
        </>
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
            ? 'Các trang này được nhập vào kho tài liệu của dự án ngay khi bấm Tạo.'
            : 'Tìm và tick trang muốn nhập ngay khi tạo dự án, hoặc bỏ qua và nhập sau ở màn Sửa dự án.'
        }
      >
        {(fieldProps) => (
          <ConfluenceTreePicker {...fieldProps} ticked={ticked} onTickedChange={setTicked} relatedTicked={relatedTicked} onRelatedTickedChange={setRelatedTicked} disabled={busy} />
        )}
      </FormField>

      {phase === 'creating' ? <FormText>Đang tạo dự án…</FormText> : null}
      {phase === 'importing' ? (
        importProgress ? (
          <ProgressBar
            label={`Đang nhập tài liệu… ${importProgress.done}/${importProgress.total} trang (${
              importProgress.total > 0 ? Math.round((importProgress.done / importProgress.total) * 100) : 0
            }%)`}
            percent={importProgress.total > 0 ? (importProgress.done / importProgress.total) * 100 : 0}
          />
        ) : (
          <FormText>{`Đang nhập tài liệu từ Confluence (${ticked.size} trang)…`}</FormText>
        )
      ) : null}
      {error ? <FormError>{error}</FormError> : null}
    </PipelineFormModal>
  );
}
