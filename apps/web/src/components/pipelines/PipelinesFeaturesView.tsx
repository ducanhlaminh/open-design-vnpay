// Pipelines drill-down — Screen 2: Features of one App. Rows (not cards) so
// progress can be compared down a column at a glance. Filtering is scoped to
// this App's features only — the status counts on the toolbar chips are
// derived from the same `PipelineProject[]` the cards on Screen 1 read, so
// they never disagree with what Screen 1 showed for this App.

import { useMemo, useState } from 'react';
import type { PipelineProject, PipelineWorkflowSummary } from '@open-design/contracts';

import { Icon } from '../Icon';
import { navigate } from '../../router';
import { RowActionsMenu } from './RowActionsMenu';
import { featureStatus, isFeatureDone, isFeatureUntouched, runningWorkflows } from './usePipelineNav';
import type { PipelineNav } from './usePipelineNav';
import styles from './PipelineNavViews.module.css';

interface Props {
  nav: PipelineNav;
  appId: string;
  /** Mở hộp thoại tạo feature với App này điền sẵn. Vắng mặt → không render
   *  nút tạo, và phần copy rỗng bên dưới cũng phải không nhắc tới nó. */
  onNewFeature?: () => void;
  /** Sửa / xóa một feature. Vắng mặt → không render mục tương ứng trong kebab. */
  onEditFeature?: (feature: PipelineProject) => void;
  onDeleteFeature?: (feature: PipelineProject) => void;
}

type StatusFilter = 'all' | 'running' | 'done' | 'idle';

// Nhãn trạng thái, dùng cho cả badge tổng của row và chip của từng workflow.
// `running` là SỐ workflow đang chạy: từ 2 trở lên thì nói ra con số — "Đang
// chạy" trơn không cho biết là đang chạy song song, mà đó đúng là thứ người
// dùng mở phần xổ để xem. Một dòng workflow thì luôn là 1 (mặc định).
function statusLabel(status: 'done' | 'running' | 'idle', running = 1): string {
  if (status === 'running') return running >= 2 ? `Đang chạy · ${running} wf` : 'Đang chạy';
  if (status === 'done') return 'Xong';
  return 'Chưa chạy';
}

function workflowStatus(w: PipelineWorkflowSummary): 'done' | 'running' | 'idle' {
  if (w.running > 0) return 'running';
  if (w.total > 0 && w.done >= w.total) return 'done';
  return 'idle';
}

// 3-letter key chip: first three letter/digit characters of the name, upper
// cased. Short names (fewer than 3 alnum chars) just show what's there.
function keyOf(name: string): string {
  const alnum = name.replace(/[^\p{L}\p{N}]/gu, '');
  return (alnum.slice(0, 3) || '?').toUpperCase();
}

export function PipelinesFeaturesView({
  nav,
  appId,
  onNewFeature,
  onEditFeature,
  onDeleteFeature,
}: Props): JSX.Element {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  // Xổ được NHIỀU row cùng lúc: so trạng thái workflow giữa hai feature là việc
  // bình thường, mà kiểu "mở cái này đóng cái kia" thì không so được.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const app = nav.appById(appId);

  const counts = useMemo(() => {
    const features = app?.features ?? [];
    let running = 0;
    let done = 0;
    let idle = 0;
    for (const f of features) {
      const s = featureStatus(f);
      if (s === 'running') running += 1;
      else if (s === 'done') done += 1;
      else if (isFeatureUntouched(f)) idle += 1;
    }
    return { all: features.length, running, done, idle };
  }, [app]);

  const filtered = useMemo(() => {
    const features = app?.features ?? [];
    const q = query.trim().toLowerCase();
    return features.filter((f) => {
      if (q && !f.name.toLowerCase().includes(q)) return false;
      if (filter === 'all') return true;
      if (filter === 'running') return runningWorkflows(f) > 0;
      if (filter === 'done') return isFeatureDone(f);
      if (filter === 'idle') return isFeatureUntouched(f);
      return true;
    });
  }, [app, filter, query]);

  if (nav.loaded && !app) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <div className={styles.headerCopy}>
            <h1 className={styles.title}>Pipelines</h1>
            <p className={styles.lede}>Chọn feature để chạy pipeline.</p>
          </div>
        </div>
        <div className={styles.breadcrumb}>
          <button
            type="button"
            className={styles.backBtn}
            onClick={() => navigate({ kind: 'home', view: 'pipelines' })}
            aria-label="Quay lại Apps"
            title="Quay lại Apps"
          >
            <Icon name="arrow-left" size={14} />
          </button>
          <button
            type="button"
            className={styles.breadcrumbLink}
            onClick={() => navigate({ kind: 'home', view: 'pipelines' })}
          >
            Apps
          </button>
        </div>
        <div className={styles.notFound}>
          <span>Không tìm thấy app này.</span>
          <button
            type="button"
            className={`${styles.btn}`}
            onClick={() => navigate({ kind: 'home', view: 'pipelines' })}
          >
            <Icon name="arrow-left" size={14} />
            Về Apps
          </button>
        </div>
      </div>
    );
  }

  const appName = app ? (app.unassigned ? 'Chưa gán app' : app.name) : '';
  const hasFeatures = (app?.features.length ?? 0) > 0;

  return (
    <div className={styles.page}>
      <div className={styles.breadcrumb}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => navigate({ kind: 'home', view: 'pipelines' })}
          aria-label="Quay lại Apps"
          title="Quay lại Apps"
        >
          <Icon name="arrow-left" size={14} />
        </button>
        <button
          type="button"
          className={styles.breadcrumbLink}
          onClick={() => navigate({ kind: 'home', view: 'pipelines' })}
        >
          Apps
        </button>
        <span className={styles.breadcrumbSep}>›</span>
        <span className={styles.breadcrumbCurrent}>{appName}</span>
      </div>

      {/* Cùng khung với màn Apps: header trang (tên thực thể + mô tả + nút
          hành động chính) đứng NGOÀI, danh sách nằm trong panel bên dưới. */}
      <div className={styles.header}>
        <div className={styles.headerCopy}>
          <h1 className={styles.title}>{appName}</h1>
          <p className={styles.lede}>
            {counts.all} feature · {counts.done} xong — chọn feature để chạy pipeline.
          </p>
        </div>
        {onNewFeature && hasFeatures ? (
          <div className={styles.headerActions}>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onNewFeature}>
              <Icon name="plus" size={13} />
              <span>Feature mới</span>
            </button>
          </div>
        ) : null}
      </div>

      <section className={styles.panel}>
        {hasFeatures ? (
          <div className={styles.panelToolbar}>
            <div className={styles.listHead}>
              <h2 className={styles.listHeadTitle}>Danh sách feature</h2>
              <span className={styles.listHeadHint}>
                Mỗi dòng là một feature — bấm để xổ trạng thái từng workflow bên trong.
              </span>
            </div>
            <div className={styles.toolbarGroup}>
              <div className={styles.filterChips}>
                <button
                  type="button"
                  className={styles.filterChip}
                  aria-pressed={filter === 'all'}
                  onClick={() => setFilter('all')}
                >
                  Tất cả <span className={styles.filterChipCount}>{counts.all}</span>
                </button>
                <button
                  type="button"
                  className={styles.filterChip}
                  aria-pressed={filter === 'running'}
                  onClick={() => setFilter('running')}
                >
                  Đang chạy <span className={styles.filterChipCount}>{counts.running}</span>
                </button>
                <button
                  type="button"
                  className={styles.filterChip}
                  aria-pressed={filter === 'done'}
                  onClick={() => setFilter('done')}
                >
                  Xong <span className={styles.filterChipCount}>{counts.done}</span>
                </button>
                <button
                  type="button"
                  className={styles.filterChip}
                  aria-pressed={filter === 'idle'}
                  onClick={() => setFilter('idle')}
                >
                  Chưa chạy <span className={styles.filterChipCount}>{counts.idle}</span>
                </button>
              </div>
              <input
                type="search"
                className={styles.search}
                placeholder="Tìm feature…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
        ) : null}

        <div className={styles.panelBody}>
      {!hasFeatures ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <Icon name="pipeline" size={24} />
          </div>
          <div className={styles.emptyBody}>
            <p className={styles.emptyTitle}>App này chưa có feature nào</p>
            <p className={styles.emptyText}>
              {onNewFeature
                ? 'Tạo feature đầu tiên để bắt đầu chạy pipeline.'
                : 'Nhờ quản lý cấp quyền tạo, hoặc kéo feature đã có trên Pipeline Studio về bằng "Tải dự án về…" trên màn Chạy.'}
            </p>
            {/* Chỉ render CTA khi thật sự bấm được. Câu hướng dẫn trỏ vào một
                nút đang bị ẩn là ngõ cụt — đúng lỗi đang có ở màn Apps của
                Pipeline Studio. */}
            {onNewFeature ? (
              <div className={styles.emptyActions}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  onClick={onNewFeature}
                >
                  <Icon name="plus" size={13} />
                  <span>Feature mới</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <Icon name="search" size={24} />
          </div>
          <div className={styles.emptyBody}>
            <p className={styles.emptyText}>Không có feature nào khớp bộ lọc.</p>
          </div>
        </div>
      ) : (
        <div className={styles.rowList}>
          {filtered.map((f) => {
            const status = featureStatus(f);
            const running = runningWorkflows(f);
            const open = expanded.has(f.id);
            const panelId = `pnv-wf-${f.id}`;
            const openFeature = () => navigate({ kind: 'pipelines-feature', appId, featureId: f.id });
            // Click row = xổ/đóng trạng thái workflow (hành vi mặc định người
            // dùng chọn); vào màn chi tiết đi qua kebab "Xem chi tiết". Server
            // cũ không trả `workflows` thì không có gì để xổ → giữ điều hướng.
            const onRowClick = f.workflows ? () => toggleExpanded(f.id) : openFeature;
            // Row là <button> nên kebab VÀ nút xổ phải là phần tử
            // anh em bên cạnh nó, không lồng vào trong (HTML cấm button trong
            // button). Phần xổ cũng là con của shell, không phải của row.
            return (
              <div key={f.id} className={styles.rowShell}>
                {/* Server cũ không trả `workflows` → không có gì để xổ, nên
                    không dựng nút dẫn tới một hộp rỗng. */}
                {f.workflows ? (
                  <button
                    type="button"
                    className={styles.rowExpand}
                    aria-expanded={open}
                    aria-controls={panelId}
                    aria-label={`Trạng thái từng workflow của ${f.name}`}
                    title="Trạng thái từng workflow"
                    data-open={open ? 'true' : undefined}
                    onClick={() => toggleExpanded(f.id)}
                  >
                    <Icon name="chevron-down" size={14} />
                  </button>
                ) : (
                  <span className={styles.rowExpandSpacer} />
                )}
                <button
                  type="button"
                  className={styles.row}
                  aria-expanded={f.workflows ? open : undefined}
                  aria-controls={f.workflows ? panelId : undefined}
                  onClick={onRowClick}
                >
                  <span className={styles.rowKey}>{keyOf(f.name)}</span>
                  <span className={styles.rowName}>{f.name}</span>
                  {/* Row đại diện cả feature nên progress đếm theo WORKFLOW
                      (mỗi vạch một workflow, x/y = workflow xong) — tiến độ
                      từng bước của một workflow nằm trong phần xổ. Server cũ
                      không trả `workflows` → giữ cách đếm theo bước như trước. */}
                  <span className={styles.rowProgress}>
                    {f.workflows?.length ? (
                      <span className={styles.segments}>
                        {f.workflows.map((w) => (
                          <span key={w.id} className={styles.segment} data-state={workflowStatus(w)} />
                        ))}
                      </span>
                    ) : f.total > 0 ? (
                      <span className={styles.segments}>
                        {Array.from({ length: f.total }).map((_, i) => (
                          // eslint-disable-next-line react/no-array-index-key -- fixed-count step segments
                          <span
                            key={i}
                            className={styles.segment}
                            data-state={i < f.done ? 'done' : i < f.done + f.running ? 'running' : 'idle'}
                          />
                        ))}
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.rowCount}>
                    {f.workflows?.length
                      ? `${f.workflows.filter((w) => workflowStatus(w) === 'done').length}/${f.workflows.length} wf`
                      : `${f.done}/${f.total}`}
                  </span>
                  <span className={styles.statusChip} data-status={status}>
                    {statusLabel(status, running)}
                  </span>
                </button>
                {/* "Xem chi tiết" là hành động chính nên đứng NGOÀI kebab —
                    một icon button thấy ngay được, không bắt user mò dropdown. */}
                <button
                  type="button"
                  className={styles.rowDetailBtn}
                  title="Xem chi tiết"
                  aria-label={`Xem chi tiết ${f.name}`}
                  onClick={openFeature}
                >
                  <Icon name="eye" size={15} />
                </button>
                <RowActionsMenu
                  label={`Thao tác với ${f.name}`}
                  actions={[
                    ...(onEditFeature
                      ? [{ key: 'rename', label: 'Đổi tên', icon: 'pencil' as const, onSelect: () => onEditFeature(f) }]
                      : []),
                    ...(onDeleteFeature
                      ? [
                          {
                            key: 'delete',
                            label: 'Xóa',
                            icon: 'trash' as const,
                            danger: true,
                            onSelect: () => onDeleteFeature(f),
                          },
                        ]
                      : []),
                  ]}
                />
                {/* Accordion dùng cặp class canonical của repo (grid-template-rows
                    0fr→1fr) — xem AGENTS.md "UI animation philosophy". Giữ
                    nguyên trong DOM khi đóng để còn thấy transition đóng. */}
                <div
                  id={panelId}
                  className={`accordion-collapsible ${styles.wfPanel}${open ? ' open' : ''}`}
                >
                  <div className="accordion-collapsible-inner">
                    <ul className={styles.wfList}>
                      {(f.workflows ?? []).map((w) => {
                        const wfState = workflowStatus(w);
                        return (
                          <li key={w.id}>
                            {/* Màn 3 (chọn/điều khiển workflow) là nơi làm gì
                                được với một workflow, nên dòng này đi thẳng
                                vào đó — như bấm chính row. */}
                            <button type="button" className={styles.wfRow} onClick={openFeature}>
                              <span className={styles.wfName}>{w.name}</span>
                              <span className={styles.wfProgress}>
                                {w.total > 0 ? (
                                  <span className={styles.segments}>
                                    {Array.from({ length: w.total }).map((_, i) => (
                                      // eslint-disable-next-line react/no-array-index-key -- fixed-count step segments
                                      <span
                                        key={i}
                                        className={styles.segment}
                                        data-state={
                                          i < w.done ? 'done' : i < w.done + w.running ? 'running' : 'idle'
                                        }
                                      />
                                    ))}
                                  </span>
                                ) : null}
                              </span>
                              <span className={styles.rowCount}>
                                {w.done}/{w.total}
                              </span>
                              <span className={styles.statusChip} data-status={wfState}>
                                {wfState === 'running' ? <Icon name="spinner" size={11} /> : null}
                                {statusLabel(wfState)}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
        </div>
      </section>
    </div>
  );
}
