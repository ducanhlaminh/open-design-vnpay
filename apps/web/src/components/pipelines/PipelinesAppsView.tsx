// Pipelines drill-down — Screen 1: Apps. Top of the App → Feature → Pipeline
// → Chạy drill-down. Shows every App as a card (monogram + feature count + a
// per-feature segmented progress bar) plus a "Gần đây" strip of the last few
// features the user opened from Screen 3. No run controls live here — nothing
// is selected yet, so there is nothing to run.

import { useMemo, useState } from 'react';

import { Icon } from '../Icon';
import { SyncStateBadge } from '../project-sync';
import { navigate } from '../../router';
import { RowActionsMenu } from './RowActionsMenu';
import { isFeatureDone } from './usePipelineNav';
import type { NavApp, PipelineNav } from './usePipelineNav';
import { SYNC_COPY, syncIssueHint } from './sync-copy';
import type { ProjectSyncScopeStatus } from '@open-design/contracts';
import styles from './PipelineNavViews.module.css';

interface Props {
  nav: PipelineNav;
  /** Absent while the create-App flow isn't wired yet — the button (and any
   *  copy pointing at it) must not render without a real handler. */
  onNewApp?: () => void;
  /** Đổi tên / xóa App. Vắng mặt → không render kebab. Rổ "Chưa gán app"
   *  không bao giờ có kebab: nó không phải một App, không có gì để sửa hay
   *  xóa. */
  onEditApp?: (app: NavApp) => void;
  onDeleteApp?: (app: NavApp) => void;
  /** App-level import remains available before the machine has any App. */
  onPullAll?: () => void;
  onPushAll?: () => void;
  onReconnectSync?: () => void;
  syncReady?: boolean;
  syncIssue?: string | null;
  pullBusy?: boolean;
  pushBusy?: boolean;
  /** Origin status comes from the new status/plan/apply engine; absent while
   * the local tree is still loading its first snapshot. */
  syncStatusByAppId?: ReadonlyMap<string, ProjectSyncScopeStatus>;
  onPushApp?: (app: NavApp) => void;
  onPullApp?: (app: NavApp) => void;
}

// ── "Gần đây" — last few features opened from Screen 3 ──────────────────────
// Written by PipelinePickerView on mount; read here. localStorage is the
// right home: this is a UX nicety, not source-of-truth state, and a client
// list keeps the home screen from needing an extra daemon round-trip.
const RECENT_KEY = 'od.pipelines.recent';
const RECENT_LIMIT = 3;

/** Số card mỗi trang. Lưới quá dài thì cuộn mãi không tới đáy, mà phân trang
 *  theo URL lại kéo cả router vào một chuyện thuần hiển thị — nên trang là
 *  state cục bộ, và cỡ trang là một hằng số ở đây. */
export const APPS_PAGE_SIZE = 12;

interface RecentEntry {
  appId: string;
  featureId: string;
  appName: string;
  featureName: string;
  at: number;
}

function isRecentEntry(x: unknown): x is RecentEntry {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.appId === 'string' &&
    typeof r.featureId === 'string' &&
    typeof r.appName === 'string' &&
    typeof r.featureName === 'string' &&
    typeof r.at === 'number'
  );
}

function readRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(isRecentEntry).slice(0, RECENT_LIMIT);
  } catch {
    // Quota exceeded, disabled storage, or an embedded webview that throws on
    // access — recents are best-effort, drop silently.
    return [];
  }
}

function displayName(app: NavApp): string {
  return app.unassigned ? 'Chưa gán app' : app.name;
}

/** Hai ký tự đầu (chỉ chữ/số) của tên App, dùng cho ô monogram. Dấu cách,
 *  gạch nối, emoji… bị bỏ qua để "Retail – VN" không ra thành "R " . */
export function monogramOf(name: string): string {
  const chars: string[] = [];
  for (const ch of name) {
    if (/[\p{L}\p{N}]/u.test(ch)) chars.push(ch);
    if (chars.length === 2) break;
  }
  return chars.join('').toUpperCase();
}

/** Dải nút số của thanh phân trang: tối đa 7 ô, phần bị cắt trả về 'gap'
 *  ("…"). Tách khỏi component vì đây là số học thuần — test nó không cần
 *  dựng DOM. `current` được kẹp vào [1, total] để trang mồ côi (vừa xóa app,
 *  vừa gõ tìm kiếm) vẫn trả ra dải hợp lệ.
 *
 *  1..7 trang  → hiện đủ.
 *  Đầu dải     → 1 2 3 4 5 … 12
 *  Giữa dải    → 1 … 5 6 7 … 12
 *  Cuối dải    → 1 … 8 9 10 11 12 */
export function pageItems(current: number, total: number): Array<number | 'gap'> {
  if (total <= 0) return [];
  const cur = Math.min(Math.max(Math.trunc(current), 1), total);
  const range = (from: number, to: number): number[] =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

  if (total <= 7) return range(1, total);
  if (cur <= 4) return [...range(1, 5), 'gap', total];
  if (cur >= total - 3) return [1, 'gap', ...range(total - 4, total)];
  return [1, 'gap', ...range(cur - 1, cur + 1), 'gap', total];
}

export function PipelinesAppsView({
  nav,
  onNewApp,
  onEditApp,
  onDeleteApp,
  onPullAll,
  onPushAll,
  onReconnectSync,
  syncReady = false,
  syncIssue,
  pullBusy = false,
  pushBusy = false,
  syncStatusByAppId,
  onPushApp,
  onPullApp,
}: Props): JSX.Element {
  const [recent] = useState<RecentEntry[]>(() => readRecent());
  const syncHint = syncIssueHint(syncIssue);
  const canReconnect = syncIssue !== 'identity_not_configured' && syncIssue !== 'identity_unavailable';
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nav.apps;
    return nav.apps.filter((a) => displayName(a).toLowerCase().includes(q));
  }, [nav.apps, query]);

  const isEmpty = nav.loaded && nav.apps.length === 0;
  const showSkeleton = !nav.loaded;

  // Trang hiện tại là GIÁ TRỊ DẪN XUẤT, không phải state thô: xóa app hay lọc
  // bớt có thể làm tổng trang co lại dưới `page`, và kẹp ngay tại đây thì
  // không cần một useEffect chạy sau render chỉ để sửa lại state.
  const totalPages = Math.max(1, Math.ceil(filtered.length / APPS_PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * APPS_PAGE_SIZE;
  const visible = filtered.slice(start, start + APPS_PAGE_SIZE);

  return (
    <div className={styles.page}>
      {nav.error ? (
        <div className={styles.error}>
          <Icon name="info" size={16} />
          <span>{nav.error}</span>
        </div>
      ) : null}

      {/* Header trang đứng NGOÀI panel (title + nút App mới); panel chỉ gói
          phần dữ liệu: dải Gần đây → toolbar → thân lưới + phân trang. */}
      <div className={styles.header}>
        <div className={styles.headerCopy}>
          <span className={styles.headerEyebrow}>Dự án</span>
          <h1 className={styles.title}>Quy trình tự động hóa</h1>
          <p className={styles.lede}>Chọn dự án bên dưới để chạy quy trình.</p>
        </div>
        {onNewApp || onPullAll || onPushAll ? (
          <div className={styles.headerActions}>
            {onPullAll || onPushAll ? (
              <div className={styles.syncActions} aria-label="Đồng bộ dự án">
                {onPullAll ? (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.syncButton}`}
                    onClick={onPullAll}
                    disabled={pullBusy || !syncReady}
                    title={syncReady ? 'Chọn dự án đã chia sẻ để lấy về máy này' : syncHint}
                  >
                    <Icon name={pullBusy ? 'spinner' : 'download'} size={14} />
                    {pullBusy ? 'Đang lấy về…' : SYNC_COPY.downloadTitle}
                  </button>
                ) : null}
                {onPushAll ? (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.syncButton}`}
                    onClick={onPushAll}
                    disabled={pushBusy || !syncReady || nav.apps.length === 0}
                    title={syncReady ? 'Chọn tài liệu chung và tính năng muốn chia sẻ' : syncHint}
                  >
                    <Icon name={pushBusy ? 'spinner' : 'upload'} size={14} />
                    {pushBusy ? 'Đang chia sẻ…' : 'Chia sẻ'}
                  </button>
                ) : null}
              </div>
            ) : null}
            {onNewApp ? (
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onNewApp}>
                <Icon name="plus" size={14} />
                Dự án mới
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {onPullAll && !syncReady ? (
        <div className={styles.error} role="alert">
          <Icon name="info" size={16} />
          <span>{syncHint}</span>
          {onReconnectSync && canReconnect ? (
            <button type="button" className={styles.btn} onClick={onReconnectSync}>{SYNC_COPY.reconnect}</button>
          ) : null}
        </div>
      ) : null}

      {/* Panel KHÔNG overflow:hidden — popover kebab của card cần thò ra
          ngoài mép. */}
      <section className={styles.panel}>
        {recent.length > 0 ? (
          <div className={styles.panelRecent}>
            <div className={styles.recent}>
              <span className={styles.recentLabel}>Gần đây</span>
              <div className={styles.recentList}>
                {recent.map((r) => (
                  <button
                    key={`${r.appId}/${r.featureId}`}
                    type="button"
                    className={styles.recentChip}
                    onClick={() => navigate({ kind: 'pipelines-feature', appId: r.appId, featureId: r.featureId })}
                  >
                    {r.appName}
                    <span className={styles.recentChipSep}>/</span>
                    {r.featureName}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {/* Toolbar dính dưới header. Ô tìm luôn hiện (trước đây chỉ hiện khi
            >8 app — nghĩa là đúng lúc người dùng chưa quen thì nó biến mất), số
            đếm bên cạnh cho biết bộ lọc đang giữ lại bao nhiêu app. */}
        {!showSkeleton && !isEmpty ? (
          <div className={styles.panelToolbar}>
            {/* Tên danh sách đứng đầu toolbar — người mới nhìn vào biết ngay
                lưới dưới là gì mà không phải suy từ nội dung card. */}
            <div className={styles.listHead}>
              <h2 className={styles.listHeadTitle}>Danh sách dự án</h2>
              <span className={styles.listHeadHint}>Mỗi dự án là một sản phẩm, gom các tính năng bên trong.</span>
            </div>
            <div className={styles.toolbarSearch}>
              <input
                type="search"
                className={styles.search}
                placeholder="Tìm dự án…"
                aria-label="Tìm dự án"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  // Kết quả mới thì trang cũ vô nghĩa — về đầu dải.
                  setPage(1);
                }}
              />
              <span className={styles.toolbarCount}>{filtered.length} dự án</span>
            </div>
          </div>
        ) : null}

        <div className={styles.panelBody}>
      {showSkeleton ? (
        <div className={styles.grid} aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            // eslint-disable-next-line react/no-array-index-key -- fixed-count skeleton placeholders
            <div key={i} className={styles.skeletonCard} />
          ))}
        </div>
      ) : isEmpty ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <Icon name="blocks" size={24} />
          </div>
          <div className={styles.emptyBody}>
            <p className={styles.emptyTitle}>Chưa có dự án nào trên máy này</p>
            <p className={styles.emptyText}>
              {onNewApp
                ? 'Tạo dự án mới để bắt đầu chạy quy trình.'
                : 'Dự án đã được chia sẻ? Chọn “Lấy dự án về máy” ở phía trên để bắt đầu.'}
            </p>
            {onNewApp ? (
              <div className={styles.emptyActions}>
                <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onNewApp}>
                  <Icon name="plus" size={14} />
                  Dự án mới
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.notFound}>Không có dự án nào khớp “{query.trim()}”.</div>
      ) : (
        <>
          <div className={styles.grid}>
            {visible.map((app) => {
              const n = app.features.length;
              const m = app.doneFeatures;
              const running = app.runningFeatures;
              const syncStatus = syncStatusByAppId?.get(app.id);
              const canPullFromShared = Boolean(syncStatus?.mappingValid && syncStatus.origin?.visibility === 'visible');
              const pullTitle = !syncReady
                ? syncHint
                : canPullFromShared
                  ? 'Lấy toàn bộ Dự án và các Tính năng từ kho chung'
                  : 'Dự án này chưa có bản trên kho chung';
              // Card là <button> điều hướng, nên kebab phải nằm NGOÀI nó (HTML
              // cấm button lồng button) — shell giữ chỗ neo cho cả hai.
              return (
                <div key={app.id} className={styles.cardShell}>
                  <button
                    type="button"
                    className={`${styles.card} ${app.unassigned ? styles.cardUnassigned : ''}`}
                    onClick={() => navigate({ kind: 'pipelines-app', appId: app.id })}
                  >
                    <span className={styles.cardHead}>
                      {/* Rổ "Chưa gán app" không phải một App nên không có
                          monogram để viết tắt — dùng icon thư mục thay chữ. */}
                      <span className={styles.monogram} aria-hidden="true">
                        {app.unassigned ? <Icon name="folder" size={18} /> : monogramOf(app.name)}
                      </span>
                      <span className={styles.cardHeadText}>
                        <span className={styles.cardName}>{displayName(app)}</span>
                        <span className={styles.cardMeta}>
                          {n} tính năng · {m} xong
                        </span>
                        {syncStatus ? (
                          <span className={styles.syncBadgeStack}>
                            <SyncStateBadge state={syncStatus.state} />
                            {!syncStatus.mappingValid ? <span className={styles.syncBackupHint}>Chỉ có trên máy · Đưa lên kho chung để tránh mất dữ liệu</span> : null}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    {n > 0 ? (
                      <span className={styles.cardProgress}>
                        <span className={styles.segments}>
                          {app.features.map((f) => (
                            <span
                              key={f.id}
                              className={styles.segment}
                              data-state={isFeatureDone(f) ? 'done' : f.running > 0 ? 'running' : 'idle'}
                            />
                          ))}
                        </span>
                        {/* Con số quan trọng là ĐANG CHẠY, không phải % — chip
                            chỉ hiện khi có tiến trình chạy để card im ắng thì
                            sạch sẽ. */}
                        {running > 0 ? (
                          <span className={styles.cardRunning}>
                            <span className={styles.cardRunningDot} aria-hidden="true" />
                            {running} đang chạy
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </button>
                  {!app.unassigned ? (
                    <div className={styles.cardActionGroup} aria-label={`Hành động với ${displayName(app)}`}>
                      {onPullApp ? <button type="button" className={styles.cardSyncBtn} onClick={() => onPullApp(app)} disabled={!syncReady || !canPullFromShared} aria-label={`Lấy Dự án ${displayName(app)} từ kho chung`} title={pullTitle}><Icon name="download" size={13} /></button> : null}
                      {onPushApp ? <button type="button" className={styles.cardSyncBtn} onClick={() => onPushApp(app)} disabled={!syncReady} aria-label={`Chia sẻ kết quả của Dự án ${displayName(app)}`} title={syncReady ? 'Chia sẻ toàn bộ Dự án, Tính năng và tài liệu dùng chung' : syncHint}><Icon name="upload" size={13} /></button> : null}
                      <RowActionsMenu
                        label={`Thao tác với ${displayName(app)}`}
                        actions={[
                          ...(onEditApp
                            ? [{ key: 'edit', label: 'Chỉnh sửa dự án', icon: 'pencil' as const, onSelect: () => onEditApp(app) }]
                            : []),
                          ...(onDeleteApp
                            ? [
                                {
                                  key: 'delete',
                                  label: 'Xóa khỏi máy',
                                  icon: 'trash' as const,
                                  danger: true,
                                  onSelect: () => onDeleteApp(app),
                                },
                              ]
                          : []),
                        ]}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* Một trang thì thanh phân trang chỉ là nhiễu — chỉ hiện từ 2 trang. */}
          {totalPages > 1 ? (
            <nav className={styles.pager} aria-label="Phân trang">
              <span className={styles.pagerRange}>
                {start + 1}–{start + visible.length} trong {filtered.length} dự án
              </span>
              <div className={styles.pagerControls}>
                <button
                  type="button"
                  className={styles.pagerBtn}
                  disabled={current <= 1}
                  onClick={() => setPage(current - 1)}
                >
                  <Icon name="chevron-left" size={13} />
                  Trước
                </button>
                <div className={styles.pagerNums}>
                  {pageItems(current, totalPages).map((it, i) =>
                    it === 'gap' ? (
                      // eslint-disable-next-line react/no-array-index-key -- "…" không có danh tính nào khác vị trí
                      <span key={`gap-${i}`} className={styles.pagerGap} aria-hidden="true">
                        …
                      </span>
                    ) : (
                      <button
                        key={it}
                        type="button"
                        className={styles.pagerBtn}
                        aria-label={`Trang ${it}`}
                        aria-current={it === current ? 'page' : undefined}
                        onClick={() => setPage(it)}
                      >
                        {it}
                      </button>
                    ),
                  )}
                </div>
                <button
                  type="button"
                  className={styles.pagerBtn}
                  disabled={current >= totalPages}
                  onClick={() => setPage(current + 1)}
                >
                  Sau
                  <Icon name="chevron-right" size={13} />
                </button>
              </div>
            </nav>
          ) : null}
        </>
      )}
        </div>
      </section>
    </div>
  );
}
