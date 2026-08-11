// Pipelines page (docs → output). A per-KGS-app, dependency-gated flow of
// pipelines, rendered as a numbered vertical stepper that mirrors the actual
// DAG of the docs-to-ui workflow: docs → cj → ux → then ONE step with two
// UI-Spec options (ui-html | ui-react) — run either or both.
//
// The "project" here is a KGS app — a project pulled from the central KGS
// (`od kg pull`), whose id is the KGS project_id. Runs happen in the BACKGROUND:
// pressing Run seeds a conversation + starts the agent on the daemon and we stay
// on this page (the daemon already runs async; we just poll status). Each row
// then exposes Status (compact run modal), Open chat (prompt more), and Quick
// result (the stage's output files). A step is locked until its prerequisites
// have succeeded.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

// How long a just-triggered stage may report "running" before the daemon's own
// status is trusted again. Covers the pre-run pull of a slow agent stage.
const PENDING_START_GRACE_MS = 60_000;
import type {
  DesignSystemSummary,
  AuthMeResponse,
  PublishResult,
  PipelineProject,
  PipelineProjectsResponse,
  PipelineRunMode,
  PipelineView,
  PipelinesResponse,
  ProjectSyncStatus,
  PullPlan,
  RunAllConfig,
  RunPipelineResponse,
  TargetPlatform,
  UiTarget,
  Workflow,
  WorkflowsResponse,
} from '@open-design/contracts';
import { UI_TARGETS } from '@open-design/contracts';

import { Icon, type IconName } from './Icon';
import { Toast } from './Toast';
import { UNASSIGNED_APP, navigate, useRoute } from '../router';
import {
  DesignSystemRunModal,
  NewFeatureModal,
  PlatformRunModal,
  RerunScopeModal,
  PullAllModal,
  PushAllModal,
  PipelineResultView,
  PipelineStatusModal,
  RunAllClearConfirmModal,
  RunAllModal,
  RunInputModal,
  UI_TERMINAL_STAGE_IDS,
  type RunAllFocus,
  type RunAllPayload,
  type RunStageOption,
  type RunSourcePayload,
  type ContextTransferSelection,
} from './pipelines/PipelineModals';
import { UploadFilesModal } from './pipelines/UploadFilesModal';
import { fetchDesignSystems, writeProjectTextFileDetailed } from '../providers/registry';
import { applyPendingStarts } from '../runtime/pipeline-pending-starts';
import { PullConflictModal } from './pipelines/PullConflictModal';
import { PlModal } from './pipelines/PlModal';
import { FeedbackHub } from './feedback/FeedbackHub';
import navStyles from './pipelines/PipelineNavViews.module.css';
import { pullApply, pullPlan } from '../providers/pullConflict';
import { useT } from '../i18n';
import { relativeTimeLong } from '../utils/chatTime';
import { publishedDestinationNote, SYNC_COPY } from './pipelines/sync-copy';
import { bindFeatureContext, transferSelectedAppContexts } from './pipelines/context-sync-api';

// Max project cards shown before the picker collapses behind "Show all" —
// keeps the pipeline stepper (the page's real content) above the fold.
const PROJECT_CARD_LIMIT = 7;

const STATUS_LABEL: Record<string, string> = {
  idle: 'Chưa chạy',
  queued: 'Đang chờ',
  running: 'Đang chạy',
  succeeded: 'Xong',
  failed: 'Lỗi',
};

// Per-pipeline presentation: an icon and a one-line "what this step does" blurb.
// Keyed by the daemon pipeline id (apps/daemon/src/pipelines.ts). Pure UI copy.
// Blurbs describe WHAT the step does (not ordering) — the stepper's gating shows
// the DAG, which differs between workflows.
const PIPELINE_META: Record<string, { icon: IconName; blurb: string }> = {
  'jira-ingest': { icon: 'import', blurb: 'Pull Confluence / JIRA sources into clean Markdown docs.' },
  'feature-analysis': { icon: 'search', blurb: 'Extract the feature set and requirements from the ingested docs.' },
  'ux-spec': { icon: 'draw', blurb: 'Generate UX specifications from the features and customer journey.' },
  'docs-map': { icon: 'blocks', blurb: 'Phân loại tài liệu theo app và ghi lại các điểm bàn giao giữa chúng — một hệ thống nhiều app, không phải nhiều sản phẩm rời. Chạy một lần cho cả dự án; sửa tay được ở docs/system-map.json.' },
  'ux-research': { icon: 'search', blurb: 'Desk research từ UX knowledge base (Growth.Design, NN/g, Baymard): tiêu chí UX kèm nguồn + hình minh hoạ, làm chuẩn cho UX Spec.' },
  'ux-review': { icon: 'eye', blurb: 'Heuristic review gate: judge the UX Spec against Nielsen + Norman usability heuristics before any UI is built.' },
  'customer-journey': { icon: 'orbit', blurb: 'Map the end-to-end customer journey from the docs, with key source text per stage.' },
  ui: { icon: 'blocks', blurb: 'Generate the static + interactive UI screens, then preview them.' },
  'ui-html': {
    icon: 'file-code',
    blurb: 'Option A — HTML preview: dựng UI-Spec thành trang HTML/CSS tĩnh xem nhanh, một file tự chứa mỗi màn.',
  },
  'ui-react': {
    icon: 'blocks',
    blurb: 'Option B — Prototype: app Vite + React 19 thật (Docker build) — nền cho mô phỏng thao tác + demo Playwright.',
  },
  'ui-react-ds': {
    icon: 'palette',
    blurb: 'Option C — React DS: app React ghép màn từ đúng bộ design system đã import từ Figma (component + token thật).',
  },
  'dr-docs': { icon: 'import', blurb: 'Nạp tài liệu (Confluence hoặc file .md) riêng cho workflow Review tài liệu.' },
  'dr-review': {
    icon: 'eye',
    blurb: 'Review từng trang theo bộ tiêu chí của bạn (criteria/, tuỳ chọn) và trả về bản sao đã sửa kèm chú giải từng chỗ sửa.',
  },
};

// The merged workflow's stages reuse the upstream skills under short ids; map
// them to the canonical meta so each step gets the right icon + blurb.
const META_ALIAS: Record<string, string> = {
  docs: 'jira-ingest',
  cj: 'customer-journey',
  ux: 'ux-spec',
};

function metaFor(id: string): { icon: IconName; blurb: string } {
  return PIPELINE_META[META_ALIAS[id] ?? id] ?? { icon: 'sparkles', blurb: '' };
}

// `docsDir` (GET /api/workflows) — a contract addition landing alongside this
// UI change (BE task, in parallel): declared locally so this file can code
// against the exact field ahead of/independent from `packages/contracts`
// picking it up; safe to drop once `Workflow` itself carries it.
type WorkflowWithDocsDir = Workflow & { docsDir?: string };

/** Where a workflow's `acceptsUpload` stage(s) actually write docs, relative
 *  to the project root. Most workflows nest under their own id
 *  (`docs-review/docs/`); "root-dir" workflows (docs-to-ui's `docs`,
 *  docs-to-prd's `prd-docs`) write straight to `docs/` — `docsDir` is the
 *  daemon's authoritative answer either way. Falls back to the old
 *  `<workflowId>/docs` guess (this file's ONLY prior behavior) for an older
 *  daemon that doesn't send the field yet — graceful, not a hard error. */
function docsDirOf(workflows: Workflow[], workflowId: string): string {
  const hit = (workflows as WorkflowWithDocsDir[]).find((w) => w.id === workflowId);
  return hit?.docsDir || `${workflowId}/docs`;
}

// Short format label for a UI-Spec terminal option (the picker's card title
// and the merged step's status chips).
function uiSpecOptionLabel(p: { id: string }): string {
  return p.id === 'ui-react' ? 'React' : p.id === 'ui-react-ds' ? 'React DS' : 'HTML';
}

interface ToastState {
  message: string;
  details?: string | null;
  code?: string | null;
}

interface OverflowMenuItem {
  key: string;
  label: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
  /** Hành động sẽ XÓA/GHI ĐÈ kết quả đã có — tô đỏ trong menu (Task 5's
   *  "destructive" meaning, áp dụng ở cấp mục menu vì nút không còn đứng độc
   *  lập nữa mà đã gom vào overflow). */
  danger?: boolean;
}

// Overflow ("⋯") dùng chung cho mọi hàng bước + toolbar đầu trang: MỘT nút kích
// hoạt + một <ul role="menu"> định vị tuyệt đối. Tự viết thay vì thêm dependency
// (theo yêu cầu): đóng khi click ra ngoài / Escape, trả focus về nút bấm khi
// đóng, di chuyển được bằng phím mũi tên giữa các mục còn bật.
function OverflowMenu({ items, label = 'Thêm thao tác' }: { items: OverflowMenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [activeIdx, setActiveIdx] = useState(-1);

  const enabledIdxs = useMemo(
    () => items.reduce<number[]>((acc, it, i) => (it.disabled ? acc : [...acc, i]), []),
    [items],
  );

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActiveIdx(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Click ngoài menu → đóng (không cần trả focus, người dùng đã chủ động click
  // sang chỗ khác). Escape → đóng VÀ trả focus về nút bấm.
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (ev: MouseEvent) => {
      if (rootRef.current?.contains(ev.target as Node)) return;
      close(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        close(true);
      }
    };
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Mở menu → focus mục đầu tiên còn bật ngay, để phím mũi tên dùng được luôn.
  useEffect(() => {
    if (open) setActiveIdx(enabledIdxs[0] ?? -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || activeIdx < 0) return;
    const el = rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[activeIdx];
    el?.focus();
  }, [open, activeIdx]);

  const moveActive = (dir: 1 | -1) => {
    if (enabledIdxs.length === 0) return;
    const curPos = enabledIdxs.indexOf(activeIdx);
    const nextPos =
      curPos === -1 ? (dir === 1 ? 0 : enabledIdxs.length - 1) : (curPos + dir + enabledIdxs.length) % enabledIdxs.length;
    setActiveIdx(enabledIdxs[nextPos]!);
  };

  if (items.length === 0) return null;

  return (
    <div className="pl-menu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="pl-btn pl-btn--icon pl-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <Icon name="more-horizontal" size={14} />
      </button>
      {open ? (
        <ul
          role="menu"
          className="pl-menu__list"
          aria-label={label}
          onKeyDown={(ev) => {
            if (ev.key === 'ArrowDown') {
              ev.preventDefault();
              moveActive(1);
            } else if (ev.key === 'ArrowUp') {
              ev.preventDefault();
              moveActive(-1);
            } else if (ev.key === 'Home') {
              ev.preventDefault();
              setActiveIdx(enabledIdxs[0] ?? -1);
            } else if (ev.key === 'End') {
              ev.preventDefault();
              setActiveIdx(enabledIdxs[enabledIdxs.length - 1] ?? -1);
            }
          }}
        >
          {items.map((it) => (
            <li key={it.key} role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`pl-menu__item${it.danger ? ' pl-menu__item--danger' : ''}`}
                disabled={it.disabled}
                onClick={() => {
                  close(true);
                  it.onClick();
                }}
              >
                <Icon name={it.icon} size={13} />
                <span>{it.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Quyết định chạy MỘT bước bằng cấu hình đã lưu ở panel phải.
 *
 *  Tách thành hàm THUẦN để test được trực tiếp: nhánh quyết định ở đây là thứ
 *  quyết định lượt chạy dùng giá trị nào, mà `PipelinesView` thì phải mount cả
 *  màn hình mới chạm tới được — test qua đó sẽ đo nhầm sang mọi thứ khác.
 *
 *  Trả `ok:false` kèm TÊN phần còn thiếu (theo thứ tự nguồn → design system →
 *  platform, chỉ nêu thứ đầu tiên) thay vì mở modal hỏi lại: panel phải đã là
 *  nơi khai những giá trị đó, hỏi lần hai ở một chỗ khác chỉ tạo ra hai câu trả
 *  lời cho cùng một câu hỏi. */
export type StageRunDecision =
  | { ok: true; payload?: RunSourcePayload; designSystemId?: string | null; platform?: TargetPlatform }
  | { ok: false; missing: string };

export function resolveStageRunConfig(
  p: Pick<PipelineView, 'inputPlaceholder' | 'acceptsDesignSystem' | 'acceptsPlatform'>,
  cfg: RunAllConfig | undefined,
): StageRunDecision {
  if (p.inputPlaceholder) {
    const uploading = cfg?.docsFromUpload === true;
    const appPoolPaths = !uploading ? (cfg?.appPool?.paths ?? []) : [];
    const usingAppPool = !uploading && appPoolPaths.length > 0;
    const pages = cfg?.confluencePages ?? [];
    if (!uploading && !usingAppPool && pages.length === 0) return { ok: false, missing: 'Nguồn tài liệu' };
    if (usingAppPool) {
      return {
        ok: true,
        payload: { source: { kind: 'app-pool', appId: cfg!.appPool!.appId, paths: appPoolPaths } },
      };
    }
    const input = uploading
      ? ''
      : pages
          .map((page) => page.url ?? page.id)
          .filter((x): x is string => Boolean(x))
          .join('\n');
    return {
      ok: true,
      // KHÔNG gửi `confluencePages`: `RunSourcePayload` không có trường đó và
      // `startRun` cũng không đọc — bước docs nhận danh sách trang qua `input`
      // (mỗi dòng một URL), đúng như modal cũ vẫn làm. Gửi thêm chỉ tạo ảo giác
      // là dữ liệu có tới nơi.
      payload: {
        ...(input ? { input } : {}),
        ...(cfg?.followLinks === false ? { followLinks: false } : {}),
        ...(cfg?.includeDescendants ? { includeDescendants: true } : {}),
      },
    };
  }
  if (p.acceptsDesignSystem) {
    // `null` = người dùng đã chọn "Không dùng" — đó LÀ một lựa chọn hợp lệ; chỉ
    // `undefined` mới nghĩa là chưa cấu hình bao giờ.
    if (cfg?.designSystemId === undefined) return { ok: false, missing: 'Design system' };
    return { ok: true, designSystemId: cfg.designSystemId };
  }
  if (p.acceptsPlatform) {
    const target = cfg?.targets?.[0];
    const platform = target ? UI_TARGETS[target].platform : cfg?.platform;
    if (!platform) return { ok: false, missing: 'Sản phẩm cần build' };
    return { ok: true, platform };
  }
  return { ok: true };
}

/** Which stage ids a run-all `payload` will actually execute right now —
 *  the same "what does this payload run" question `stagesLosingOutputForRunAll`
 *  below answers as its first step, factored out so `staleInputsForRunAll`
 *  (further below) can ask it too without re-deriving the two daemon
 *  decisions it mirrors. */
function willRunStageIdsForRunAll(
  pipelines: Pick<PipelineView, 'id' | 'status' | 'skipped'>[],
  payload: Pick<RunAllPayload, 'stageIds' | 'terminal' | 'skipSucceeded'>,
): string[] {
  const manualIds = (payload.stageIds ?? []).filter((id) => pipelines.some((p) => p.id === id));
  if (manualIds.length > 0) return manualIds;
  const wanted = new Set(payload.terminal === 'both' ? ['ui-html', 'ui-react'] : [payload.terminal]);
  return pipelines
    .filter((p) => p.skipped !== true)
    .filter((p) => !UI_TERMINAL_STAGE_IDS.has(p.id) || wanted.has(p.id))
    .filter((p) => !payload.skipSucceeded || p.status !== 'succeeded')
    .map((p) => p.id);
}

/** Human NAMES of every stage that will lose its existing result if `payload`
 *  runs right now — the run-all pre-flight confirm dialog's only question.
 *  Tách thành hàm THUẦN (cùng lý do `resolveStageRunConfig` ở trên): mount cả
 *  `PipelinesView` chỉ để test một biểu thức là đo nhầm sang mọi thứ khác.
 *
 *  Mirrors two daemon decisions closely enough to answer "what will this
 *  clear?" without a round-trip — the daemon (`runWorkflowAll` +
 *  `resetScopeForRunAllStage`, `apps/daemon/src/server.ts`) remains the
 *  actual source of truth for what gets deleted:
 *
 *   1. Which stages this run actually executes: `payload.stageIds` verbatim
 *      when the user hand-ticked a set (mirrors `manualStages`), else every
 *      non-`skipped` (lean-dropped) stage, narrowed to the chosen UI
 *      terminal(s), minus anything `skipSucceeded` would drop.
 *   2. A fresh FULL automatic run (no hand-tick, not `skipSucceeded`) resets
 *      its first stage with `'downstream'`, which cascades through the WHOLE
 *      dependency graph — including a stage this pass itself won't re-run
 *      (e.g. an unchosen terminal) — so those succeeded stages are added too.
 *
 *  A stage only "loses" something it actually HAS: the intersection with
 *  `status === 'succeeded'` is what makes an empty result here mean "run
 *  straight through, nothing to warn about" (see `must_not`: never ask when
 *  there is nothing to lose). */
export function stagesLosingOutputForRunAll(
  pipelines: Pick<PipelineView, 'id' | 'name' | 'status' | 'dependsOn' | 'skipped'>[],
  payload: Pick<RunAllPayload, 'stageIds' | 'terminal' | 'skipSucceeded'>,
): string[] {
  const manualIds = (payload.stageIds ?? []).filter((id) => pipelines.some((p) => p.id === id));
  const manual = manualIds.length > 0;
  const willRunIds = willRunStageIdsForRunAll(pipelines, payload);
  const byId = new Map(pipelines.map((p) => [p.id, p]));
  const lost = new Set<string>();
  for (const id of willRunIds) {
    if (byId.get(id)?.status === 'succeeded') lost.add(id);
  }
  if (!manual && !payload.skipSucceeded && willRunIds[0]) {
    const downstream = new Set<string>([willRunIds[0]]);
    for (;;) {
      let grew = false;
      for (const p of pipelines) {
        if (downstream.has(p.id)) continue;
        if (p.dependsOn.some((d) => downstream.has(d))) {
          downstream.add(p.id);
          grew = true;
        }
      }
      if (!grew) break;
    }
    for (const id of downstream) {
      if (id !== willRunIds[0] && byId.get(id)?.status === 'succeeded') lost.add(id);
    }
  }
  return pipelines.filter((p) => lost.has(p.id)).map((p) => p.name);
}

/** Every about-to-run stage `S` whose primary input still traces back — via
 *  `dependsOn` — to an ancestor this run-all will NOT refresh: an ancestor the
 *  project's run mode dropped (`skipped: true`) that already `succeeded`
 *  sometime before. The rail already marks that ancestor "· ngoài chế độ";
 *  this is what lets the run-all confirm say so too, BEFORE `S` quietly reads
 *  a result that may no longer match what was just re-ingested upstream (the
 *  spec's worked case: `docs` just reloaded, `cj` is skipped-and-35m-stale,
 *  `ux` is about to build its spec on that stale journey).
 *
 *  Walks `dependsOn` upward from each `S` in `stageIdsToRun`, depth-first,
 *  with a per-`S` `seen` set against cycles:
 *   - an ancestor `A` that is ALSO in `stageIdsToRun` stops that branch — it
 *     will be re-run by this same pass, so nothing past it can be stale
 *     through this path;
 *   - the first `A` outside the run with `status === 'succeeded'` AND
 *     `skipped === true` IS the stale source: record `{ stage: S, source: A,
 *     updatedAt: A.updatedAt }` and stop climbing that branch — a further
 *     ancestor would only be noise once the nearest stale input is found;
 *   - any other `A` (not yet run, or ran without being `skipped`) is not
 *     itself a source of staleness, so the walk continues past it to ITS
 *     ancestors.
 *
 *  Pure and warning-only — this only FINDS stale input chains, it never
 *  decides whether that should block anything (see the spec's `must_not`).
 *  Deduped by `(stage, source)`; result content does not depend on the order
 *  of `stageIdsToRun`. */
export function staleInputsForRunAll(
  pipelines: Pick<PipelineView, 'id' | 'dependsOn' | 'status' | 'skipped' | 'updatedAt'>[],
  stageIdsToRun: string[],
): Array<{ stage: string; source: string; updatedAt: number }> {
  const byId = new Map(pipelines.map((p) => [p.id, p]));
  const willRun = new Set(stageIdsToRun);
  const out: Array<{ stage: string; source: string; updatedAt: number }> = [];
  const seenPairs = new Set<string>();
  const addIfNew = (stage: string, source: string, updatedAt: number) => {
    const key = `${stage}::${source}`;
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    out.push({ stage, source, updatedAt });
  };
  for (const stageId of stageIdsToRun) {
    const seen = new Set<string>([stageId]);
    const walk = (ancestorId: string) => {
      if (seen.has(ancestorId)) return;
      seen.add(ancestorId);
      if (willRun.has(ancestorId)) return; // will be refreshed this run
      const ancestor = byId.get(ancestorId);
      if (ancestor?.status === 'succeeded' && ancestor.skipped === true) {
        addIfNew(stageId, ancestorId, ancestor.updatedAt ?? 0);
        return; // nearest stale source on this branch — climbing further is noise
      }
      for (const next of ancestor?.dependsOn ?? []) walk(next);
    };
    for (const dep of byId.get(stageId)?.dependsOn ?? []) walk(dep);
  }
  return out;
}

export function PipelinesView() {
  const t = useT();
  const [runAllOpen, setRunAllOpen] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowId, setWorkflowId] = useState<string>('');
  // Pull all / Push all are scoped to the ACTIVE workflow tab — their modals
  // only offer (and only sync) this workflow's pipelines. Fallback to all
  // while the workflow list is still loading.
  const activeWorkflows = useMemo(() => {
    const hit = workflows.filter((w) => w.id === workflowId);
    return hit.length > 0 ? hit : workflows;
  }, [workflows, workflowId]);
  const [projects, setProjects] = useState<PipelineProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectId, setProjectId] = useState<string>('');
  const [pipelines, setPipelines] = useState<PipelineView[]>([]);
  // Chế độ chạy của DỰ ÁN (lưu từ lần Run-all gần nhất). Quyết định bước nào bị
  // bỏ qua, nên nó phải hiện trên stepper — nếu không, người dùng nhìn một bước
  // xám mà không hiểu vì sao (lựa chọn nằm trong modal đã đóng từ lâu).
  const [runMode, setRunMode] = useState<PipelineRunMode>('full');
  // Multi-target (targets.json): các target của dự án + trạng thái từng bước
  // THEO TARGET (suy từ file outputs dưới <wf>/<target>/). `activeTarget` là
  // target đang thao tác: chạy stage lẻ / Build / Demo / Capture Figma đều gửi
  // nó xuống daemon để chạy vào đúng cây <wf>/<target>/.
  const [projTargets, setProjTargets] = useState<UiTarget[]>([]);
  const [statusByTarget, setStatusByTarget] = useState<
    NonNullable<PipelinesResponse['statusByTarget']>
  >({});
  const [activeTarget, setActiveTarget] = useState<UiTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [syncBusy, setSyncBusy] = useState<null | 'pull' | 'push'>(null);
  const [syncAccess, setSyncAccess] = useState<Pick<AuthMeResponse, 'syncReady' | 'syncIssue'> | null>(null);
  const refreshSyncAccess = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/me');
      const body = (await response.json().catch(() => ({}))) as Partial<AuthMeResponse>;
      setSyncAccess({ syncReady: response.ok && body.syncReady === true, syncIssue: body.syncIssue ?? null });
    } catch {
      setSyncAccess({ syncReady: false, syncIssue: 'identity_unavailable' });
    }
  }, []);
  useEffect(() => { void refreshSyncAccess(); }, [refreshSyncAccess]);
  const reconnectSync = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.reload();
  }, []);
  // Project history (version hóa output), scoped per PIPELINE CARD: the card's
  // Lịch sử button opens a panel listing the store versions whose snapshot
  // contains THAT stage's outputs (v.stages) + this machine's commits for the
  // same pipeline. Restore from a card only rewinds that stage's files.
  const [historyForId, setHistoryForId] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyData, setHistoryData] = useState<{
    versions: Array<{ verId: string; at: string; by: { email?: string; name?: string } | null; files: number; gitCommit?: string; stages?: string[] }>;
    commits: Array<{ commit: string; at: string; kind: string; pipelineId?: string; status?: string; by?: { email?: string } | null; filesChanged?: number; note?: string }>;
  } | null>(null);
  const [restoreBusy, setRestoreBusy] = useState<string | null>(null);
  const [buildBusy, setBuildBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [figmaCaptureBusy, setFigmaCaptureBusy] = useState(false);
  const [figmaAuditBusy, setFigmaAuditBusy] = useState(false);
  // Project picker controls — with many KGS projects the raw card grid became
  // a wall pushing the actual pipeline flow below the fold.
  const [projectSearch, setProjectSearch] = useState('');
  const [showAllProjects, setShowAllProjects] = useState(false);
  // Which stage's "run info" panel is expanded (input/source of the last run).
  const [infoForId, setInfoForId] = useState<string | null>(null);

  // ── Rail cấu hình (Task 2) ─────────────────────────────────────────────────
  // Danh sách design system chỉ để LẤY TÊN cho nhãn "Design system" trên rail —
  // các modal đổi cấu hình (RunAllModal, DesignSystemRunModal…) tự fetch lại
  // danh sách của riêng chúng, đây không thay chúng.
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await fetchDesignSystems();
        if (!cancelled) setDesignSystems(all);
      } catch {
        if (!cancelled) setDesignSystems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  // Tóm tắt "≠ remote" cho dự án đang chọn — cùng endpoint POST /api/kg/sync-status
  // mà Pull all / Push all đã dùng (per-stage), thu gọn thành một dòng cho rail.
  const [syncStatus, setSyncStatus] = useState<ProjectSyncStatus | null>(null);
  const [syncStatusLoading, setSyncStatusLoading] = useState(false);
  useEffect(() => {
    if (!projectId) {
      setSyncStatus(null);
      return;
    }
    let cancelled = false;
    setSyncStatusLoading(true);
    void (async () => {
      try {
        const res = await fetch('/api/kg/sync-status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectIds: [projectId] }),
        });
        const j = await res.json().catch(() => ({}));
        if (!cancelled) setSyncStatus(res.ok ? ((j?.data?.results?.[0] as ProjectSyncStatus | undefined) ?? null) : null);
      } catch {
        if (!cancelled) setSyncStatus(null);
      } finally {
        if (!cancelled) setSyncStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  // Dưới 1100px rail không đủ chỗ đứng cạnh stepper — sập thành nút "Cấu hình"
  // mở cùng nội dung trong drawer (dùng lại PlModal, không phải editor mới).
  const [railNarrow, setRailNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1100px)');
    setRailNarrow(mq.matches);
    const onChange = () => setRailNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);
  const [runAllBusy, setRunAllBusy] = useState(false);
  // "Chạy pipeline" đang chờ xác nhận vì lần chạy này sẽ xoá kết quả có sẵn
  // của (những) bước trong `stageNames`, HOẶC (những) bước sắp chạy sẽ đọc
  // đầu vào từ một bước cũ ngoài lượt (`staleInputs`) — payload đã dựng sẵn,
  // chỉ chờ người dùng bấm nút xác nhận ở RunAllClearConfirmModal. `null` =
  // không có gì đang chờ (đường chạy thẳng, không hỏi, vẫn là mặc định).
  const [runAllClearConfirmFor, setRunAllClearConfirmFor] = useState<{
    payload: RunAllPayload;
    stageNames: string[];
    staleInputs: Array<{ stageName: string; sourceName: string; updatedAt: number }>;
  } | null>(null);

  // Đổi project → đóng panel lịch sử của card cũ; dữ liệu cũ không còn đúng.
  useEffect(() => {
    setHistoryForId(null);
    setHistoryData(null);
  }, [projectId]);

  // Relevance order for the picker: the selected project is pinned first, then
  // anything currently running, then in-progress work, then untouched, and
  // finished projects last — alphabetical inside each band. With no search the
  // grid shows the first PROJECT_CARD_LIMIT cards; searching always shows every
  // match (a filtered result set is small by construction).
  const { visibleProjects, hiddenProjectCount } = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    const matches = q
      ? projects.filter(
          (pr) => pr.name.toLowerCase().includes(q) || pr.id.toLowerCase().includes(q),
        )
      : projects;
    const band = (pr: PipelineProject): number => {
      if (pr.id === projectId) return 0;
      if (pr.running > 0) return 1;
      if (pr.done > 0 && pr.done < pr.total) return 2;
      if (pr.total === 0 || pr.done === 0) return 3;
      return 4; // complete
    };
    const sorted = matches
      .slice()
      .sort((a, b) => band(a) - band(b) || a.name.localeCompare(b.name));
    if (q || showAllProjects || sorted.length <= PROJECT_CARD_LIMIT) {
      return { visibleProjects: sorted, hiddenProjectCount: 0 };
    }
    return {
      visibleProjects: sorted.slice(0, PROJECT_CARD_LIMIT),
      hiddenProjectCount: sorted.length - PROJECT_CARD_LIMIT,
    };
  }, [projects, projectSearch, showAllProjects, projectId]);
  // Nhóm card theo App (Studio: feature link vào app qua project.json.appId,
  // daemon mirror về `pr.app` lúc pull). Nhóm xuất hiện theo thứ tự relevance
  // của feature đầu tiên trong nhóm; feature chưa gán app dồn vào nhóm cuối.
  // Không có app nào → render lưới phẳng như cũ (không header thừa).
  const projectGroups = useMemo(() => {
    const order: string[] = [];
    const byKey = new Map<string, { key: string; name: string; projects: PipelineProject[] }>();
    for (const pr of visibleProjects) {
      const key = pr.app?.id ?? '';
      let g = byKey.get(key);
      if (!g) {
        g = { key, name: key ? pr.app?.name || pr.app!.id : 'Chưa gán app', projects: [] };
        byKey.set(key, g);
        order.push(key);
      }
      g.projects.push(pr);
    }
    const groups = order.map((k) => byKey.get(k)!);
    const loose = groups.findIndex((g) => g.key === '');
    if (loose >= 0 && groups.length > 1) groups.push(...groups.splice(loose, 1));
    return groups;
  }, [visibleProjects]);
  const groupedByApp = projectGroups.some((g) => g.key !== '');
  // App groups đóng/mở được — mặc định mở hết; trạng thái theo app id.
  const [collapsedApps, setCollapsedApps] = useState<Set<string>>(new Set());
  const toggleAppGroup = (key: string) =>
    setCollapsedApps((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const [pullPlanState, setPullPlanState] = useState<PullPlan | null>(null);

  const [toast, setToast] = useState<ToastState | null>(null);
  // "Pull all"/"Push all" open pick-projects/pipelines modals instead of
  // moving everything blindly. (Tạo dự án đã chuyển hẳn sang Pipeline Studio.)
  const [pullAllOpen, setPullAllOpen] = useState(false);
  const [pushAllOpen, setPushAllOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // Nút "Đổi" của một dòng trên rail cấu hình mở CÙNG modal nhưng chỉ hiện đúng
  // section đó. undefined = modal đầy đủ (mọi section). Modal CHỈ lưu cấu hình ở
  // cả hai chế độ — chạy full workflow là nút "Chạy pipeline" ngoài modal.
  const [runAllFocus, setRunAllFocus] = useState<RunAllFocus | undefined>(undefined);
  // Mở modal cấu hình: focus = dòng rail vừa bấm "Đổi"; bỏ trống = mọi section.
  const openRunAll = (focus?: RunAllFocus) => {
    setRunAllFocus(focus);
    setRunAllOpen(true);
    // Màn hẹp: rail nằm trong drawer-modal — đóng nó lại để không xếp hai modal.
    setConfigDrawerOpen(false);
  };
  const [runInputFor, setRunInputFor] = useState<PipelineView | null>(null);
  const [designSystemFor, setDesignSystemFor] = useState<PipelineView | null>(null);
  const [platformFor, setPlatformFor] = useState<PipelineView | null>(null);
  // Separate from the run-flow modal state above on purpose — "Tải file lên"
  // is its own button (p.acceptsUpload), never dispatched through proceedRun.
  const [uploadFor, setUploadFor] = useState<PipelineView | null>(null);
  const [resetScopeFor, setResetScopeFor] = useState<PipelineView | null>(null);
  // Chosen re-run clear scope, threaded from the scope modal through the normal
  // run flow (input/design-system/platform modals all end at startRun). A ref so
  // it survives the intermediate modals without re-render churn; consumed once.
  const pendingResetScopeRef = useRef<'stage' | 'downstream' | undefined>(undefined);
  const [statusFor, setStatusFor] = useState<PipelineView | null>(null);
  // Quick result is now a full-page route (/pipelines/:projectId/result/:pipelineId)
  // instead of an xl modal — read it from the URL so back/forward + deep links work.
  const route = useRoute();

  const pushToast = useCallback((t: ToastState) => setToast(t), []);

  // Deep-link into a Quick result: align the selected project with the routed
  // one so `load` fetches the pipeline list that owns route.pipelineId.
  useEffect(() => {
    if (route.kind === 'pipeline-result' && route.projectId && route.projectId !== projectId) {
      setProjectId(route.projectId);
    }
  }, [route, projectId]);

  // Màn Chạy (cấp 4 của drill-down): feature + pipeline nằm trong URL, không
  // phải trong state của component. Chọn app/feature/pipeline giờ là việc của
  // ba màn trước, nên ở đây chỉ đồng bộ xuống — không có bộ chọn nào nữa.
  useEffect(() => {
    if (route.kind !== 'pipelines-run') return;
    if (route.featureId && route.featureId !== projectId) setProjectId(route.featureId);
    if (route.pipelineId && route.pipelineId !== workflowId) setWorkflowId(route.pipelineId);
  }, [route, projectId, workflowId]);

  /** Đang ở màn Chạy → giấu mọi thứ thuộc về ba màn trước (mồi 3 bước, tab
   *  workflow, lưới thẻ dự án). Để lại chúng ở đây là dựng lại đúng cái màn
   *  phẳng mà drill-down sinh ra để thay thế. */
  const inRunScreen = route.kind === 'pipelines-run';

  // Load the available workflows once; default-select the first.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/workflows');
        if (!res.ok) return;
        const data = (await res.json()) as WorkflowsResponse;
        setWorkflows(data.workflows ?? []);
        setWorkflowId((cur) => cur || data.defaultWorkflowId);
      } catch {
        /* workflows are optional chrome; ignore */
      }
    })();
  }, []);

  // The selectable "projects" are KGS apps pulled from KGS, not chat workspaces.
  // Progress badges are scoped to the active workflow, so refetch on switch.
  const loadProjects = useCallback(async () => {
    if (!workflowId) return;
    try {
      const res = await fetch(`/api/pipelines/projects?workflowId=${encodeURIComponent(workflowId)}`);
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      const data = (await res.json()) as PipelineProjectsResponse;
      const list = data.projects ?? [];
      setProjects(list);
      const first = list[0];
      if (first) setProjectId((cur) => cur || first.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProjectsLoaded(true);
    }
  }, [workflowId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Stages this device just asked to run → deadline. See applyPendingStarts.
  const pendingStartsRef = useRef<Map<string, number>>(new Map());
  const markPendingStart = useCallback((pipelineId: string) => {
    pendingStartsRef.current.set(pipelineId, Date.now() + PENDING_START_GRACE_MS);
  }, []);

  const load = useCallback(async (pid: string, opts?: { background?: boolean }) => {
    if (!pid || !workflowId) {
      setPipelines([]);
      return;
    }
    // Background refreshes (the 2.5s in-flight poll + post-action reloads)
    // must NOT flip `loading`: that swaps the whole stepper for the skeleton
    // on every tick — a constant visible flicker while a pipeline runs. The
    // skeleton is for the FIRST load / project switch only, when there is
    // nothing on screen yet.
    const background = opts?.background === true;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await fetch(`/api/pipelines?projectId=${encodeURIComponent(pid)}&workflowId=${encodeURIComponent(workflowId)}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `load failed: ${res.status}`);
      }
      const data = (await res.json()) as PipelinesResponse;
      setPipelines(applyPendingStarts(data.pipelines ?? [], pendingStartsRef.current, Date.now()));
      setRunMode(data.runMode ?? 'full');
      const nextTargets = data.targets ?? [];
      setProjTargets(nextTargets);
      setStatusByTarget(data.statusByTarget ?? {});
      // Giữ lựa chọn còn hợp lệ; dự án đổi cấu hình → về target đầu tiên.
      setActiveTarget((cur) => (cur && nextTargets.includes(cur) ? cur : nextTargets[0] ?? null));
      if (background) setError(null);
    } catch (err) {
      // A transient poll hiccup must not wipe the stepper mid-run — keep the
      // last known state on background failures; the next tick self-heals.
      if (!background) {
        setError(err instanceof Error ? err.message : String(err));
        setPipelines([]);
      }
    } finally {
      if (!background) setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void load(projectId);
  }, [projectId, load]);

  // Background polling: while any pipeline for the selected project is in flight,
  // refresh its status until everything settles. When the last run finishes,
  // refresh the project cards too so their done/total badge updates.
  const anyRunning = pipelines.some((p) => p.status === 'running' || p.status === 'queued');
  const prevRunningRef = useRef(false);

  // Dừng cả pipeline = hủy MỌI bước đang chạy của nó. Endpoint cancel là theo
  // từng bước (`/:projectId/:pipelineId/cancel`, đã dùng trong modal Status),
  // nên ở đây gọi song song cho tất cả bước đang chạy — bước fan-out tự dừng
  // cả pool bên trong.
  //
  // Best-effort từng bước: một bước không hủy được (đã kết thúc giữa chừng)
  // không được chặn các bước còn lại, nếu không người dùng bấm Dừng mà pipeline
  // vẫn chạy tiếp.
  const [stopping, setStopping] = useState(false);
  const stopPipeline = useCallback(async () => {
    if (!projectId || stopping) return;
    const live = pipelines.filter((p) => p.status === 'running' || p.status === 'queued');
    if (live.length === 0) return;
    setStopping(true);
    try {
      await Promise.all(
        live.map((p) =>
          fetch(
            `/api/pipelines/${encodeURIComponent(projectId)}/${encodeURIComponent(p.id)}/cancel`,
            { method: 'POST' },
          ).catch(() => null),
        ),
      );
      pushToast({ message: `Đã dừng ${live.length} bước đang chạy` });
      await load(projectId, { background: true });
    } finally {
      setStopping(false);
    }
  }, [projectId, pipelines, stopping, load, pushToast]);
  useEffect(() => {
    if (!anyRunning || !projectId) return;
    const id = window.setInterval(() => {
      void load(projectId, { background: true });
    }, 2500);
    return () => window.clearInterval(id);
  }, [anyRunning, projectId, load]);
  useEffect(() => {
    if (prevRunningRef.current && !anyRunning) void loadProjects();
    prevRunningRef.current = anyRunning;
  }, [anyRunning, loadProjects]);

  // Keep the project-list running spinners live: while ANY project (not just the
  // selected one) has a pipeline in flight, re-poll the list so a run started or
  // finished on another project shows / clears its spinner without a manual
  // refresh. The initial fetch already carries `running`, so entering the route
  // shows the spinners immediately.
  const anyProjectRunning = projects.some((p) => p.running > 0);
  useEffect(() => {
    if (!anyProjectRunning) return;
    const id = window.setInterval(() => {
      void loadProjects();
    }, 3500);
    return () => window.clearInterval(id);
  }, [anyProjectRunning, loadProjects]);

  // Pull/push ALL KGS apps at once (not per-project). Pull refreshes the app list.
  // `projectIds` narrows to the projects chosen in the Pull all / Push all modal;
  // `stages` narrows which pipelines' OUTPUT FILES travel (graph stays whole-
  // project). Either omitted → legacy everything.
  const syncAll = async (kind: 'pull' | 'push', selection?: ContextTransferSelection, stages?: string[]) => {
    setSyncBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/kg/${kind}-all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(selection?.projectIds.length ? { projectIds: selection.projectIds } : {}),
          ...(selection?.appIds.length ? { appIds: selection.appIds } : {}),
          ...(selection?.contextConflictResolutions
            ? { contextConflictResolutions: selection.contextConflictResolutions }
            : {}),
          ...(stages?.length ? { stages } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `${kind}-all failed: ${res.status}`);
      if (kind === 'pull') {
        await loadProjects();
        if (projectId) void load(projectId, { background: true });
      }
      // push-all/pull-all now round-trip output files too (graph + files); show
      // the file count so the user can see the artifacts moved, not just nodes.
      const results = (j?.data?.results ?? []) as PublishResult[];
      const projectCount = results.length;
      const fileCount = results.reduce(
        (sum, r) => sum + (kind === 'pull' ? Number((r as Record<string, unknown>).files ?? 0) : 'filesUploaded' in r ? r.filesUploaded : 0),
        0,
      );
      // Every push lands directly in Shared Projects. Keep the result notes so
      // older daemon responses still display a useful migration message.
      const notes = kind === 'push'
        ? results.map((result) => publishedDestinationNote(result as unknown as Record<string, unknown>)).filter((note): note is string => !!note)
        : [];
      const blocked = results.filter((result) => result.status === 'auth_required');
      pushToast({
        message:
          kind === 'pull'
            ? SYNC_COPY.downloadSuccess(projectCount, fileCount)
            : SYNC_COPY.shareSuccess(projectCount, fileCount),
        ...(notes.length ? { details: notes.join(' · ') } : {}),
        ...(blocked.length ? { code: 'error' as const } : {}),
      });
      return true;
    } catch (err) {
      pushToast({
        message: kind === 'pull' ? SYNC_COPY.downloadError : SYNC_COPY.shareError,
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
      return false;
    } finally {
      setSyncBusy(null);
    }
  };

  // Changelog của project: published versions (store `_v/`) + local commits.
  const loadHistory = async (pid: string) => {
    setHistoryBusy(true);
    try {
      const res = await fetch(`/api/pipelines/history?projectId=${encodeURIComponent(pid)}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `history failed: ${res.status}`);
      setHistoryData({ versions: j.versions ?? [], commits: j.commits ?? [] });
    } catch (err) {
      setHistoryData(null);
      pushToast({
        message: 'Không tải được lịch sử',
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setHistoryBusy(false);
    }
  };

  // Restore: rewind outputs về một bản đã push (store) hoặc một commit local.
  // `stage` giới hạn version-restore vào output của đúng pipeline đó (nút
  // Khôi phục trong card). Trạng thái hiện tại được daemon chốt vào
  // .odhistory trước — luôn undo được.
  const restoreHistory = async (opts: { verId?: string; commit?: string; stage?: string }) => {
    if (!projectId) return;
    const label = opts.verId ?? opts.commit?.slice(0, 10) ?? '';
    const scope = opts.stage ? `output của bước "${opts.stage}"` : 'output';
    if (!window.confirm(`Khôi phục ${scope} về bản ${label}? Trạng thái hiện tại sẽ được lưu vào lịch sử trước khi ghi đè.`)) {
      return;
    }
    setRestoreBusy(label);
    try {
      const res = await fetch('/api/pipelines/history/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, ...opts }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `restore failed: ${res.status}`);
      pushToast({ message: `Đã khôi phục ${j.files ?? 0} file về bản ${label}` });
      void load(projectId, { background: true });
      void loadHistory(projectId);
    } catch (err) {
      pushToast({
        message: 'Khôi phục thất bại',
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setRestoreBusy(null);
    }
  };

  // Build/rebuild the ui-react app from synced sources. dist/ never
  // syncs (PipelineDef.syncExclude), so after "Pull project" this is what
  // makes the app previewable again. 422 carries the tsc/vite error tail.
  const buildReactApp = async () => {
    if (!projectId) return;
    setBuildBusy(true);
    try {
      const res = await fetch('/api/pipelines/react-build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, ...(activeTarget ? { target: activeTarget } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `build failed: ${res.status}`);
      void load(projectId, { background: true });
      pushToast({ message: `Built React app for “${projectId}” → react/dist/` });
    } catch (err) {
      pushToast({
        message: "Couldn't build the React app",
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setBuildBusy(false);
    }
  };

  // Prototype auto-demo: Playwright drives the BUILT react app through its
  // flow.json use cases (video + per-step screenshots → react/prototype-demo/).
  const buildReactDemoRun = async () => {
    if (!projectId) return;
    setDemoBusy(true);
    try {
      const res = await fetch('/api/pipelines/react-demo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, ...(activeTarget ? { target: activeTarget } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `demo failed: ${res.status}`);
      pushToast({
        message: `Đã quay ${j.cases ?? 0} kịch bản demo → react/prototype-demo/`,
        details: 'Đẩy kết quả lên để studio phát video trong tab Mô phỏng.',
      });
    } catch (err) {
      pushToast({
        message: 'Không dựng được demo',
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setDemoBusy(false);
    }
  };

  // Capture the BUILT React-DS app into Figma screen JSON (figma-h2d IR with
  // component-instance markers) — the file the Fig Pipeline plugin's
  // "Screen JSON → Figma" tab rebuilds with real component instances.
  // Lớp 1 audit "Preview ↔ Figma": chạy trên capture đã có, báo trước những gì
  // sẽ hỏng khi dán vào Figma (icon unmatched / variant fallback / layer tràn).
  const runFigmaAuditFe = async () => {
    if (!projectId) return;
    setFigmaAuditBusy(true);
    try {
      const res = await fetch('/api/pipelines/figma-audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, ...(activeTarget ? { target: activeTarget } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `figma-audit failed: ${res.status}`);
      const findings = (j.findings ?? []) as Array<{
        level: string;
        rule: string;
        comp?: string;
        screens?: string[];
        detail: string;
        fix: string;
      }>;
      const errors = findings.filter((f) => f.level === 'error').length;
      const summaryText = Object.entries((j.summary ?? {}) as Record<string, number>)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ');
      pushToast({
        message:
          findings.length === 0
            ? `Audit sạch — ${j.screens} frame, ${j.markers} instance marker: dán vào Figma sẽ khớp preview.`
            : `Audit ${j.screens} frame: ${findings.length} component/vấn đề (${errors} error) — ${summaryText}`,
        details:
          findings.length === 0
            ? undefined
            : `${findings
                .slice(0, 6)
                .map(
                  (f) =>
                    `[${f.level}] ${f.comp ?? f.rule}${
                      (f.screens?.length ?? 0) > 1 ? ` (${f.screens!.length} màn/state)` : ''
                    } — ${f.fix}`,
                )
                .join('\n')}${findings.length > 6 ? `\n… đầy đủ trong ${j.rawPath}` : `\nBáo cáo: ${j.rawPath}`}`,
        ...(errors > 0 ? { code: 'error' as const } : {}),
      });
      void load(projectId, { background: true });
    } catch (err) {
      pushToast({
        message: 'Không audit được',
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setFigmaAuditBusy(false);
    }
  };

  const runFigmaCapture = async () => {
    if (!projectId) return;
    setFigmaCaptureBusy(true);
    try {
      const res = await fetch('/api/pipelines/figma-capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, ...(activeTarget ? { target: activeTarget } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `figma-capture failed: ${res.status}`);
      // Download the merged screens.json as a file (the deliverable also
      // stays in the stage outputs at react-ds/figma-screens/).
      const fileName = (typeof j.screensJson === 'string' && j.screensJson.split('/').pop()) || 'screens.json';
      if (typeof j.rawPath === 'string' && j.rawPath) {
        const rawUrl = `/api/projects/${encodeURIComponent(projectId)}/raw/${j.rawPath
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`;
        const a = document.createElement('a');
        a.href = rawUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      pushToast({
        message: `Đã capture ${j.screens ?? 0} màn (${j.markers ?? 0} instance) — đã tải ${fileName}`,
        details:
          'Mở file UI Lib trong Figma → plugin Fig Pipeline → tab "Screen JSON → Figma" → dán nội dung file vừa tải. File cũng nằm trong outputs của stage (react-ds/figma-screens/).',
      });
    } catch (err) {
      pushToast({
        message: 'Không capture được Figma screens',
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setFigmaCaptureBusy(false);
    }
  };

  // Conflict-aware pull of ONE project's files (PLAN → RESOLVE → APPLY).
  // 0 conflicts → apply straight through (keep-local default, no modal); else open
  // PullConflictModal so the user resolves each differing file. Reached from the
  // Pull modal when exactly one locally-mirrored project is selected — bulk pulls
  // take the blind-overwrite path instead (pre-pull .odhistory snapshot).
  const pullProject = async (pid: string) => {
    try {
      const plan = await pullPlan(pid);
      if (plan.conflicts.length === 0) {
        const result = await pullApply({
          projectId: pid,
          planId: plan.planId,
          resolutions: {},
          onConflictDefault: 'local',
        });
        void load(pid, { background: true });
        pushToast({
          message: `Đã cập nhật “${pid}” trên máy · ${result.downloaded} tệp mới`,
          ...(result.stale.length ? { details: `${result.stale.length} tệp chưa cập nhật vì bản chia sẻ đã thay đổi`, code: 'warn' } : {}),
        });
      } else {
        setPullPlanState(plan);
      }
    } catch (err) {
      pushToast({
        message: SYNC_COPY.downloadError,
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    }
  };

  // Start a pipeline run in the BACKGROUND: POST the run, optimistically flip the
  // row to "running" (the poller takes over), and DON'T navigate away. Throws on
  // failure so callers (incl. the input modal) can surface it.
  const startRun = async (
    pipelineId: string,
    payload?: RunSourcePayload,
    // Per-run design system for UI stages: a string id, or `null` for explicit
    // "None". `undefined` (the common case) omits the field → daemon default.
    designSystemId?: string | null,
    // Target platform for the UX stage (`acceptsPlatform`). `undefined` omits
    // the field → the skill's default (mobile).
    platform?: TargetPlatform,
  ) => {
    if (!projectId) return;
    const body: Record<string, unknown> = { projectId };
    if (payload?.source) body.source = payload.source;
    else if (payload?.input && payload.input.trim()) body.input = payload.input.trim();
    if (payload?.followLinks === false) body.followLinks = false;
    if (payload?.includeDescendants) body.includeDescendants = true;
    // docs-to-ui docs step: chosen UI targets → daemon writes targets.json.
    if (payload?.targets && payload.targets.length) body.targets = payload.targets;
    if (designSystemId !== undefined) body.designSystemId = designSystemId;
    if (platform !== undefined) body.platform = platform;
    // Multi-target: chạy stage lẻ vào target đang chọn. Stage shared (docs,
    // system-map) daemon tự bỏ qua field này nên gửi luôn không hại.
    if (activeTarget) body.target = activeTarget;
    // Re-run clear scope chosen in the scope modal (default 'stage' when absent —
    // still clears this stage's own outputs so the agent regenerates).
    if (pendingResetScopeRef.current) body.resetScope = pendingResetScopeRef.current;
    pendingResetScopeRef.current = undefined;
    const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 202) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `run failed: ${res.status}`);
    }
    const j = (await res.json().catch(() => null)) as RunPipelineResponse | null;
    markPendingStart(pipelineId);
    setPipelines((prev) =>
      prev.map((p) =>
        p.id === pipelineId
          ? {
              ...p,
              status: 'running',
              ...(j?.agentRunId ? { lastRunId: j.agentRunId } : {}),
              ...(j?.conversationId ? { lastConversationId: j.conversationId } : {}),
            }
          : p,
      ),
    );
  };

  // Kick the WHOLE workflow (POST /api/pipelines/run-all): the daemon chains
  // every stage automatically — no per-stage review. We optimistically flip the
  // first planned stage to running; the poller tracks the rest of the chain.
  const startRunAll = async (payload: RunAllPayload) => {
    if (!projectId) return;
    const res = await fetch('/api/pipelines/run-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        ...(workflowId ? { workflowId } : {}),
        ...(payload.input ? { input: payload.input } : {}),
        ...(payload.confluencePages?.length ? { confluencePages: payload.confluencePages } : {}),
        ...(payload.appPool?.paths?.length ? { appPool: payload.appPool } : {}),
        terminal: payload.terminal,
        platform: payload.platform,
        ...(payload.targets?.length ? { targets: payload.targets } : {}),
        designSystemId: payload.designSystemId,
        ...(payload.designSystemByTarget ? { designSystemByTarget: payload.designSystemByTarget } : {}),
        ...(payload.stageIds?.length ? { stageIds: payload.stageIds } : {}),
        ...(payload.skipSucceeded ? { skipSucceeded: true } : {}),
        ...(payload.lean ? { lean: true } : {}),
        ...(payload.followLinks === false ? { followLinks: false } : {}),
        ...(payload.includeDescendants ? { includeDescendants: true } : {}),
        ...(payload.docsFromUpload ? { docsFromUpload: true } : {}),
      }),
    });
    if (!res.ok && res.status !== 202) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `run-all failed: ${res.status}`);
    }
    const j = (await res.json().catch(() => null)) as { stages?: string[] } | null;
    const first = j?.stages?.[0];
    if (first) {
      markPendingStart(first);
      setPipelines((prev) => prev.map((p) => (p.id === first ? { ...p, status: 'running' } : p)));
    }
    // NO immediate reload here — same as startRun. The daemon kicks the chain
    // off fire-and-forget and answers 202 before any stage is marked running, so
    // a reload fired now races it and almost always wins: the fetched (still
    // idle) rows replace the optimistic "running" one, `anyRunning` goes false,
    // and the 2.5s poller therefore never starts — the board sits frozen until
    // something else forces a load, e.g. leaving the route and coming back.
    // Worst with "skip succeeded", where the first stage is an agent stage whose
    // pre-run pull delays the status flip by seconds.
    // The optimistic flip alone starts the poller, which owns the rest.
    pushToast({
      message: `Đã khởi động full workflow — ${j?.stages?.length ?? 0} bước chạy nối tiếp trong nền`,
      details: (j?.stages ?? []).join(' → '),
    });
  };

  // Dựng RunAllPayload từ cấu hình đã lưu của dự án (savedRunAll ?? config) —
  // ĐÂY là đường chạy duy nhất: modal chỉ ghi cấu hình, nút "Chạy pipeline"
  // ngoài modal đọc lại đúng cấu hình đó (cũng là giá trị rail đang hiển thị) và
  // POST run-all.
  const buildRunAllPayloadFromConfig = (cfg: RunAllConfig | undefined): RunAllPayload => {
    const hasPlatformStage = pipelines.some((p) => p.acceptsPlatform);
    const targets = hasPlatformStage ? (cfg?.targets?.length ? cfg.targets : (['mobile'] as UiTarget[])) : undefined;
    const uploading = cfg?.docsFromUpload === true;
    const usingAppPool = !uploading && (cfg?.appPool?.paths?.length ?? 0) > 0;
    const knownStageIds = new Set(pipelines.map((p) => p.id));
    const stageIdsForRun = (cfg?.stageIds ?? []).filter((id) => knownStageIds.has(id));
    const input =
      uploading || usingAppPool
        ? ''
        : (cfg?.confluencePages ?? [])
            .map((p) => p.url ?? p.id)
            .filter((x): x is string => Boolean(x))
            .join('\n');
    return {
      ...(input ? { input } : {}),
      ...(!uploading && !usingAppPool && cfg?.confluencePages?.length ? { confluencePages: cfg.confluencePages } : {}),
      ...(usingAppPool ? { appPool: cfg!.appPool! } : {}),
      terminal: cfg?.terminal ?? 'ui-html',
      platform: targets?.[0] ? UI_TARGETS[targets[0]].platform : (cfg?.platform ?? 'mobile'),
      ...(targets ? { targets } : {}),
      designSystemId: cfg?.designSystemId === undefined ? null : cfg.designSystemId,
      ...(cfg?.designSystemByTarget ? { designSystemByTarget: cfg.designSystemByTarget } : {}),
      skipSucceeded: cfg?.skipSucceeded ?? false,
      // Danh sách bước người dùng tự tick — lọc còn đúng các bước workflow ĐANG
      // mở có thật: cấu hình được lưu ở cấp project, nên id của workflow khác
      // (đã lưu từ tab bên cạnh) không được lọt vào payload.
      ...(stageIdsForRun.length ? { stageIds: stageIdsForRun } : {}),
      ...(cfg?.lean ? { lean: true } : {}),
      ...(cfg?.followLinks === false ? { followLinks: false } : {}),
      ...(!uploading && !usingAppPool && cfg?.includeDescendants ? { includeDescendants: true } : {}),
      ...(uploading ? { docsFromUpload: true } : {}),
    };
  };

  // Nút "Chạy pipeline" của toolbar — hành động CHẠY duy nhất, nằm ngoài modal:
  // dựng payload từ cấu hình đã lưu (rail đang hiển thị đúng nó) rồi POST
  // run-all. CHƯA có nguồn tài liệu thì không có gì để chạy → mở modal cấu hình
  // đầy đủ kèm một dòng nhắc; người dùng bấm Lưu xong rồi bấm Chạy lại.
  const runAllWithSavedConfig = async () => {
    const proj = projects.find((pr) => pr.id === projectId);
    const cfg = proj?.savedRunAll ?? proj?.config;
    // Cùng điều kiện modal vẫn validate: có nguồn tài liệu, HOẶC "chỉ chạy bước
    // còn thiếu" khi bước Docs đã xong từ trước (chạy lẻ) nên không cần nguồn.
    const usingAppPool = cfg?.docsFromUpload !== true && (cfg?.appPool?.paths?.length ?? 0) > 0;
    const hasSource = Boolean(cfg?.confluencePages?.length || cfg?.docsFromUpload || usingAppPool);
    // …HOẶC lựa chọn bước đã lưu KHÔNG có bước nạp tài liệu nào. Nguồn tài liệu
    // là input của đúng bước ingest; một lựa chọn kiểu "chỉ chạy lại ux + ui"
    // không đọc tới nó, nên đòi cấu hình nguồn ở đây chỉ dựng lên một cánh cửa
    // khoá trước một lần chạy hoàn toàn hợp lệ.
    const savedStageIds = cfg?.stageIds ?? [];
    const runsIngestStage =
      savedStageIds.length === 0 ||
      pipelines.some(
        (p) => savedStageIds.includes(p.id) && (p.inputPlaceholder || p.acceptsUpload),
      );
    const canRun =
      hasSource ||
      !runsIngestStage ||
      (cfg?.skipSucceeded === true && pipelines.some((p) => p.status === 'succeeded'));
    if (!canRun) {
      openRunAll();
      pushToast({ message: 'Cấu hình nguồn tài liệu trước khi chạy' });
      return;
    }
    const payload = buildRunAllPayloadFromConfig(cfg);
    // Lần chạy này sẽ xoá kết quả có sẵn của bước nào (mất kết quả), VÀ/HOẶC
    // sẽ có bước sắp chạy đọc đầu vào từ một bước cũ ngoài lượt (đầu vào cũ —
    // xem `staleInputsForRunAll`). Cả hai rỗng → chạy thẳng (không hỏi gì khi
    // không có gì để cảnh báo — must_not). Có ít nhất một loại → hỏi trước,
    // nêu đích danh, rồi mới POST run-all.
    const stageNames = stagesLosingOutputForRunAll(pipelines, payload);
    const byId = new Map(pipelines.map((p) => [p.id, p]));
    const staleInputs = staleInputsForRunAll(pipelines, willRunStageIdsForRunAll(pipelines, payload)).map(
      (row) => ({
        stageName: byId.get(row.stage)?.name ?? row.stage,
        sourceName: byId.get(row.source)?.name ?? row.source,
        updatedAt: row.updatedAt,
      }),
    );
    if (stageNames.length > 0 || staleInputs.length > 0) {
      setRunAllClearConfirmFor({ payload, stageNames, staleInputs });
      return;
    }
    await runAllNow(payload);
  };

  // Phần CHẠY thật của "Chạy pipeline" — tách khỏi runAllWithSavedConfig ở
  // trên để cả đường chạy thẳng (không có gì để mất) lẫn đường xác nhận qua
  // RunAllClearConfirmModal cùng gọi đúng một chỗ.
  const runAllNow = async (payload: RunAllPayload) => {
    setRunAllBusy(true);
    try {
      await startRunAll(payload);
    } catch (err) {
      pushToast({
        message: 'Không khởi động được full workflow',
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setRunAllBusy(false);
    }
  };

  // Nút "Lưu" của modal cấu hình (cả chế độ focus lẫn đầy đủ): ghi các field
  // modal vừa sửa vào cấu hình dự án, KHÔNG chạy workflow. Daemon merge shallow
  // vào metadata.runAllConfig nên field không gửi giữ nguyên. Xong thì load lại
  // danh sách project để rail hiển thị giá trị mới.
  const saveRunConfig = async (patch: Partial<RunAllConfig>) => {
    if (!projectId) throw new Error('Chưa chọn dự án');
    const res = await fetch(`/api/pipelines/projects/${encodeURIComponent(projectId)}/run-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `Lưu cấu hình thất bại: ${res.status}`);
    }
    await loadProjects();
    // Chế độ chạy đổi thì stepper phải vẽ lại (bước nào bị bỏ qua đọc từ daemon).
    await load(projectId, { background: true });
    pushToast({ message: 'Đã lưu cấu hình' });
  };

  // Nhánh nguồn "Tải file lên" của modal cấu hình: ghi các file `.md` đã chọn
  // vào docsDir của workflow đang mở (docsDirOf — không còn giả định
  // `<workflowId>/docs/`, một số workflow ghi thẳng `docs/` ở gốc dự án) ngay
  // khi bấm Lưu. Same route and reasoning as UploadFilesModal — the JSON
  // write endpoint keeps a multi-segment name verbatim, while the multipart
  // one strips every `/` and would flatten the file to the project root.
  // Throws on the first failure so RunAllModal can surface it instead of
  // saving a source that points at a half-written folder.
  const uploadRunAllDocs = async (files: File[]) => {
    if (!projectId || !workflowId) throw new Error('Chưa chọn dự án/workflow');
    const dir = docsDirOf(workflows, workflowId);
    for (const file of files) {
      const content = await file.text();
      const result = await writeProjectTextFileDetailed(projectId, `${dir}/${file.name}`, content);
      if (!result.ok) throw new Error(`${file.name}: ${result.message}`);
    }
  };

  const runDirect = async (
    p: PipelineView,
    payload?: RunSourcePayload,
    designSystemId?: string | null,
    platform?: TargetPlatform,
  ) => {
    setBusyId(p.id);
    try {
      await startRun(p.id, payload, designSystemId, platform);
      pushToast({ message: `Đã bắt đầu chạy “${p.name}” — đang chạy nền` });
    } catch (err) {
      pushToast({
        message: `Couldn't start “${p.name}”`,
        details: err instanceof Error ? err.message : String(err),
        code: 'error',
      });
    } finally {
      setBusyId(null);
    }
  };

  // Transitive downstream of a stage (every pipeline whose dependsOn chain
  // reaches it) — drives whether the re-run scope choice is meaningful.
  const downstreamOf = useCallback(
    (id: string): PipelineView[] => {
      const set = new Set<string>([id]);
      for (;;) {
        let grew = false;
        for (const p of pipelines) {
          if (set.has(p.id)) continue;
          if (p.dependsOn.some((d) => set.has(d))) {
            set.add(p.id);
            grew = true;
          }
        }
        if (!grew) break;
      }
      return pipelines.filter((p) => p.id !== id && set.has(p.id));
    },
    [pipelines],
  );

  // The normal run flow: stages with an input/design-system/platform choice open
  // their modal first; the rest start immediately.
  /** Nút "Chạy" của MỘT bước: chạy bằng CẤU HÌNH ĐANG HIỂN THỊ Ở PANEL PHẢI,
   *  không hỏi lại.
   *
   *  Vì sao đổi: trước đây bước nào cần nguồn tài liệu / design system /
   *  platform thì Chạy đều mở một modal hỏi lại — trong khi panel phải ĐÃ có
   *  sẵn đúng những giá trị đó. Hỏi hai lần cùng một câu hỏi đã phiền, nhưng
   *  hại hơn là câu trả lời trong modal có thể khác thứ panel đang hiển thị,
   *  nên màn hình nói một đằng còn lượt chạy làm một nẻo.
   *
   *  Thiếu cấu hình thì KHÔNG mở modal — chỉ báo đích danh phần cần cấu hình và
   *  để người dùng sửa ở panel (rail nằm ngay cạnh, có nút "Đổi" của riêng nó).
   *  Thiếu nhiều thứ thì báo thứ ĐẦU TIÊN theo thứ tự dưới đây; cấu hình xong
   *  cái đó rồi bấm lại sẽ được nhắc cái kế tiếp. */
  const proceedRun = (p: PipelineView) => {
    const proj = projects.find((pr) => pr.id === projectId);
    const decision = resolveStageRunConfig(p, proj?.savedRunAll ?? proj?.config);
    if (!decision.ok) {
      pushToast({
        message: `Bước “${p.name}” cần ${decision.missing}`,
        details: `Cấu hình ${decision.missing} ở panel bên phải rồi bấm Chạy lại.`,
        code: 'error',
      });
      return;
    }
    void runDirect(p, decision.payload, decision.designSystemId, decision.platform);
  };

  // Run click: a RE-RUN (already succeeded) of a stage that has downstream first
  // asks the clear scope (this stage only vs also the stale downstream); then the
  // normal flow proceeds. A first run — or a terminal with no downstream — skips
  // straight to it (a re-run there still clears its own output daemon-side).
  const onRunClick = (p: PipelineView) => {
    if (p.status === 'succeeded' && downstreamOf(p.id).length > 0) setResetScopeFor(p);
    else proceedRun(p);
  };

  const openChat = (p: PipelineView) => {
    if (!p.lastConversationId) return;
    navigate({ kind: 'project', projectId, conversationId: p.lastConversationId, fileName: null });
  };

  const hasProjects = projects.length > 0;

  // UI-Spec option picker (the merged terminal step's Run): choose HTML or
  // React, then hand off to the normal per-pipeline run flow.
  const [uiSpecPickerOpen, setUiSpecPickerOpen] = useState(false);

  // Group the flat pipeline list into stepper entries. The UI-Spec terminals
  // (ui-html | ui-react) are alternative OPTIONS of one step — they render as
  // ONE card whose Run opens an option-picker modal, so the flow never reads
  // as "HTML first, React after". Membership is by EXPLICIT id (mirror of the
  // daemon's UI_TERMINAL_IDS), NOT by comparing dependsOn: dependsOn identity
  // is server-derived data, and a daemon reporting mode-adjusted lists once
  // fused cj/ux-research/ux into a phantom three-badge "UI-Spec" card. Ids
  // cannot drift per mode, so this grouping is stable no matter what the
  // daemon reports. Same list the run-config modal groups its final step by
  // (`UI_TERMINAL_STAGE_IDS`) — one declaration, so the stepper and the modal
  // can never disagree about which stages are alternatives.
  const stepEntries: PipelineView[][] = [];
  for (const p of pipelines) {
    const last = stepEntries[stepEntries.length - 1];
    const sibling =
      !!last && UI_TERMINAL_STAGE_IDS.has(p.id) && UI_TERMINAL_STAGE_IDS.has(last[0]!.id);
    if (sibling) last!.push(p);
    else stepEntries.push([p]);
  }
  // A step is done when any of its options succeeded (either UI-Spec output
  // completes the step).
  const doneCount = stepEntries.filter((opts) => opts.some((p) => p.status === 'succeeded')).length;
  // Bước ĐANG CHỜ NGƯỜI DÙNG: bước đầu tiên THEO THỨ TỰ WORKFLOW mà chưa xong,
  // chưa chạy, và không bị chế độ hiện tại bỏ qua (`skipped`). KHÔNG còn tính
  // theo `active` — cổng phụ thuộc theo bước đã bỏ (spec
  // g2-ui-suggestion-not-gate), nên `active` giờ chỉ còn nghĩa "chưa có tài
  // liệu"; "bước tiếp theo" vẫn phải đúng ngay cả khi mọi thẻ đều mở khoá.
  // -1 = không còn gì để làm (xong hết, hoặc mọi bước còn lại đều bị bỏ qua).
  const nextStepIdx = stepEntries.findIndex((opts) => {
    const done = opts.some(
      (p) => p.status === 'succeeded' || p.status === 'running' || p.status === 'queued',
    );
    if (done) return false;
    return !opts.every((p) => p.skipped === true);
  });
  // Bước 1 (tài liệu nạp) — điều kiện DUY NHẤT còn lại sau khi cổng phụ thuộc
  // theo bước bị bỏ. Nhận diện bằng `dependsOn` rỗng, không phải vị trí trong
  // mảng: cả ba workflow (docs-to-ui/docs-to-prd/docs-review) đặt nó ở đầu,
  // nhưng không có gì bắt buộc thứ tự đó ngoài quy ước của daemon registry.
  const ingestStage = pipelines.find((p) => p.dependsOn.length === 0);
  /**
   * Chú thích dưới một thẻ bước, GỢI Ý không phải MỆNH LỆNH.
   *
   * `!active` giờ chỉ còn một nghĩa (sau lô daemon bỏ cổng phụ thuộc theo
   * bước): "chưa có tài liệu" — nên lý do khoá luôn trỏ về BƯỚC 1, không phải
   * `effectiveDependsOn`/`dependsOn` (một bước trung gian như "Bản đồ hệ
   * thống"), vì bước trung gian không còn là điều kiện thật. Khi `active`
   * (đã có tài liệu, nút Chạy hiện/bấm được), phụ thuộc tĩnh CHƯA `succeeded`
   * chỉ còn là một gợi ý thứ tự thường dùng — không chặn gì cả.
   */
  const dependencyNote = (
    active: boolean,
    anyDone: boolean,
    deps: string[],
  ): { kind: 'lock' | 'stale' | 'hint'; text: string } | null => {
    if (!active) {
      if (!ingestStage) return null;
      return anyDone
        ? { kind: 'stale', text: t('pipelines.rail.staleNeedsDocs', { stage: ingestStage.name }) }
        : { kind: 'lock', text: t('pipelines.rail.needsDocs', { stage: ingestStage.name }) };
    }
    const unmet = deps.filter((id) => {
      const dep = pipelines.find((x) => x.id === id);
      return dep !== undefined && dep.status !== 'succeeded';
    });
    if (unmet.length === 0) return null;
    const names = unmet.map((id) => pipelines.find((x) => x.id === id)?.name ?? id).join(', ');
    return { kind: 'hint', text: t('pipelines.rail.usuallyAfter', { stages: names }) };
  };
  // ── Rail cấu hình (Task 2) ────────────────────────────────────────────────
  // Cấu hình đã lưu của dự án đang chọn — CÙNG nguồn RunAllModal đọc để điền
  // sẵn (savedRunAll của lần chạy full workflow gần nhất, hoặc config từ
  // Pipeline Studio khi chưa từng chạy).
  const railProject = projects.find((pr) => pr.id === projectId);
  const railCfg: RunAllConfig | undefined = railProject?.savedRunAll ?? railProject?.config;
  const railSourceSummary = railCfg?.appPool?.paths?.length
    ? `Tài liệu dự án · ${railCfg.appPool.paths.length} trang`
    : railCfg?.confluencePages?.length
      ? railCfg.confluencePages.length === 1
        ? (railCfg.confluencePages[0]!.title ?? railCfg.confluencePages[0]!.url ?? railCfg.confluencePages[0]!.id ?? 'Confluence')
        : `${railCfg.confluencePages.length} trang Confluence`
      : railCfg?.docsFromUpload
        ? 'File tải lên'
        : railCfg?.basDocumentTitle || railCfg?.basDocumentId
          ? `BAS · ${railCfg.basDocumentTitle ?? railCfg.basDocumentId}`
          : 'Chưa cấu hình';
  const railDsLabel =
    railCfg?.designSystemId === undefined
      ? 'Mặc định'
      : railCfg.designSystemId === null
        ? 'Không dùng'
        : (designSystems?.find((s) => s.id === railCfg.designSystemId)?.title ?? railCfg.designSystemId);
  // `projTargets` đọc từ `<workflow>/targets.json`, file CHỈ được ghi khi một lần
  // chạy khởi động — nên rail ưu tiên targets trong cấu hình đã lưu (đúng cái mà
  // lần chạy tới sẽ dùng), và chỉ fallback về file khi config chưa có.
  const railTargets = railCfg?.targets?.length ? railCfg.targets : projTargets;
  const railTargetsSummary =
    railTargets.length > 0 ? railTargets.map((t) => UI_TARGETS[t].label).join(', ') : 'Chưa cấu hình';
  // Bước của workflow đang mở, ĐÚNG thứ tự stepper — nguồn duy nhất cho cả dòng
  // rail "Các bước sẽ chạy" lẫn section cùng tên trong modal.
  const runStageOptions: RunStageOption[] = pipelines.map((p) => ({
    id: p.id,
    name: p.name,
    dependsOn: p.dependsOn,
    status: p.status,
    ...(p.skipped === true ? { skipped: true } : {}),
  }));
  // Rail nói ĐÚNG cái nút "Chạy pipeline" sẽ chạy, không phải cái modal sẽ tick
  // sẵn khi mở: chưa lưu `stageIds` lần nào thì lần chạy tới vẫn theo đường cũ
  // (cả chuỗi, trừ các bước chế độ hiện tại bỏ). Modal mới là chỗ mặc định tick
  // "các bước chưa xong" — một gợi ý, chưa phải cấu hình đã lưu.
  const railSavedStageIds = (railCfg?.stageIds ?? []).filter((id) =>
    runStageOptions.some((s) => s.id === id),
  );
  const railStageIds = new Set(
    railSavedStageIds.length > 0
      ? railSavedStageIds
      : runStageOptions.filter((s) => s.skipped !== true).map((s) => s.id),
  );
  const railStagesTitle =
    runStageOptions.length === 0
      ? 'Workflow này chưa có bước nào'
      : `${railSavedStageIds.length > 0 ? 'Sẽ chạy' : 'Chưa chọn bước nào — lần chạy tới đi cả chuỗi'}: ${runStageOptions
          .filter((s) => railStageIds.has(s.id))
          .map((s) => s.name)
          .join(' → ')}`;
  const railStagesSummary =
    runStageOptions.length === 0
      ? 'Chưa có bước nào'
      : railStageIds.size === runStageOptions.length
        ? 'Tất cả'
        : `${railStageIds.size}/${runStageOptions.length} bước`;
  const railDiffStages = syncStatus?.stages.filter((s) => s.differs).length ?? 0;
  const railSyncSummary = syncStatusLoading
    ? 'Đang kiểm tra thay đổi…'
    : syncStatus
      ? railDiffStages > 0
        ? `${railDiffStages} bước có thay đổi`
        : 'Kết quả đã cập nhật'
      : 'Chưa có dữ liệu';

  // Panel co giãn theo WORKFLOW đang mở: workflow không có input nào thì hàng
  // đó biến mất hẳn — không render một nút "Đổi" chỉ để mở modal báo "workflow
  // này không có lựa chọn đó". Cùng nguồn cờ với RunAllModal bên dưới.
  const railHasDesignSystem = pipelines.some((p) => p.acceptsDesignSystem);
  const railHasTargets = pipelines.some((p) => p.acceptsPlatform);

  // Nội dung dùng chung cho cả hai chỗ hiển thị (aside cạnh stepper ở màn
  // rộng, PlModal-drawer ở màn hẹp) — một nguồn duy nhất, không có editor mới:
  // "Đổi" chỉ mở lại đúng modal đã sở hữu field đó từ trước.
  const configRailContent = (
    <>
      <div className="pl-rail-row">
        <span className="pl-rail-row__label">Nguồn tài liệu</span>
        <span className="pl-rail-row__value">{railSourceSummary}</span>
        <button type="button" className="pl-rail-row__change" onClick={() => openRunAll('source')}>
          Đổi
        </button>
      </div>
      {railHasDesignSystem ? (
        <div className="pl-rail-row">
          <span className="pl-rail-row__label">Design system</span>
          <span className="pl-rail-row__value">{railDsLabel}</span>
          <button type="button" className="pl-rail-row__change" onClick={() => openRunAll('designSystem')}>
            Đổi
          </button>
        </div>
      ) : null}
      {railHasTargets ? (
        <div className="pl-rail-row">
          <span className="pl-rail-row__label">Sản phẩm cần build</span>
          <span className="pl-rail-row__value">{railTargetsSummary}</span>
          <button type="button" className="pl-rail-row__change" onClick={() => openRunAll('targets')}>
            Đổi
          </button>
        </div>
      ) : null}
      {/* KHÔNG gate theo railSupportsLean như dòng "Chế độ chạy" cũ: chọn bước
          là khái niệm chung của mọi workflow, còn "Tiết kiệm" mới là thứ chỉ
          docs-to-ui có (giờ là một preset bên trong section này).
          Dòng "Kết quả UI-Spec" cũ cũng đã gộp vào đây: đầu ra UI-Spec là BƯỚC
          CUỐI của chuỗi, nên nó thuộc về danh sách bước — để riêng một dòng là
          hỏi cùng một câu ở hai chỗ, và hai chỗ đó ghi vào hai field khác nhau. */}
      <div className="pl-rail-row">
        <span className="pl-rail-row__label">Các bước sẽ chạy</span>
        <span className="pl-rail-row__value" title={railStagesTitle}>
          {railStagesSummary}
        </span>
        <button type="button" className="pl-rail-row__change" onClick={() => openRunAll('stages')}>
          Đổi
        </button>
      </div>
      <div className="pl-rail-row pl-rail-row--sync">
        <span className="pl-rail-row__label">Chia sẻ</span>
        <span className="pl-rail-row__value">{railSyncSummary}</span>
        <div className="pl-rail-row__sync-actions">
          <button
            type="button"
            className="pl-btn pl-btn--xs"
            onClick={() => setPullAllOpen(true)}
            disabled={syncBusy !== null || syncAccess?.syncReady !== true}
            title={syncAccess?.syncReady === false ? SYNC_COPY.reconnectHint : 'Chọn dự án và kết quả cần lấy về máy'}
          >
            <Icon name={syncBusy === 'pull' ? 'spinner' : 'download'} size={13} />
            <span>{syncBusy === 'pull' ? 'Đang lấy về…' : 'Lấy dự án về máy'}</span>
          </button>
          <button
            type="button"
            className="pl-btn pl-btn--xs"
            onClick={() => setPushAllOpen(true)}
            disabled={syncBusy !== null || syncAccess?.syncReady !== true}
            title={syncAccess?.syncReady === false ? SYNC_COPY.reconnectHint : 'Chọn dự án và kết quả cần chia sẻ'}
          >
            <Icon name={syncBusy === 'push' ? 'spinner' : 'upload'} size={13} />
            <span>{syncBusy === 'push' ? 'Đang chia sẻ…' : 'Chia sẻ kết quả'}</span>
          </button>
        </div>
        {syncAccess?.syncReady === false ? (
          <button type="button" className="pl-rail-row__change" onClick={() => void reconnectSync()}>
            {SYNC_COPY.reconnect}
          </button>
        ) : null}
      </div>
    </>
  );

  // Full-page Quick result route: swap the whole stepper for the output preview
  // so it owns the viewport (the old modal was too cramped). The pipeline comes
  // from the already-loaded list; `back` returns to the stepper.
  if (route.kind === 'pipeline-result') {
    const target = pipelines.find((p) => p.id === route.pipelineId);
    // Back lùi ĐÚNG MỘT cấp — về màn Chạy (stepper) của chính feature/workflow
    // này, không văng ra màn Apps ngoài cùng. appId tra từ danh sách project
    // (feature chưa gán app rơi vào rổ UNASSIGNED); danh sách chưa tải xong thì
    // đành về trang pipelines gốc thay vì dựng một route thiếu appId.
    // LƯU Ý đặt tên dễ lừa: segment `pipelineId` của route pipelines-run là
    // WORKFLOW id (effect đồng bộ nó vào setWorkflowId) — truyền stage id vào
    // đây sẽ đầu độc workflowId và làm Quick result lọc rỗng ở lần mở sau.
    const backProject = projects.find((pr) => pr.id === route.projectId);
    const backToStepper = () =>
      projectsLoaded && workflowId
        ? navigate({
            kind: 'pipelines-run',
            appId: backProject?.app?.id?.trim() || UNASSIGNED_APP,
            featureId: route.projectId,
            pipelineId: workflowId,
          })
        : navigate({ kind: 'home', view: 'pipelines' });
    if (target) {
      return (
        <PipelineResultView
          projectId={route.projectId}
          projectKind="other"
          pipeline={target}
          workflowId={workflowId}
          onBack={backToStepper}
          onViewFile={(fileName) =>
            navigate({ kind: 'project', projectId: route.projectId, conversationId: null, fileName })
          }
        />
      );
    }
    return (
      <section className="pl-result-page pl-result-page--gate" aria-label="Xem kết quả">
        <header className="pl-result-page__header">
          <button type="button" className="pl-btn pl-result-page__back" onClick={backToStepper}>
            <Icon name="arrow-left" size={14} />
            <span>Pipeline</span>
          </button>
        </header>
        <div className="pl-result-page__body">
          <p className="pl-modal-empty">
            {loading || !projectsLoaded ? 'Đang tải kết quả…' : 'Không tìm thấy pipeline này.'}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="pipelines-page" aria-labelledby="pipelines-title" data-testid="pipelines-view">
      {inRunScreen && route.kind === 'pipelines-run' ? (
        <div className={navStyles.header}>
          <div className={navStyles.headerCopy}>
            <h1 className={navStyles.title}>Pipelines</h1>
            <p className={navStyles.lede}>Chạy và theo dõi từng bước của quy trình.</p>
          </div>
        </div>
      ) : null}
      {inRunScreen && route.kind === 'pipelines-run' ? (
        <nav className={navStyles.breadcrumb} aria-label="Đường dẫn">
          <button
            type="button"
            className={navStyles.backBtn}
            onClick={() =>
              navigate({
                kind: 'pipelines-feature',
                appId: route.appId,
                featureId: route.featureId,
              })
            }
            aria-label="Quay lại"
            title="Quay lại"
          >
            <Icon name="arrow-left" size={14} />
          </button>
          <button
            type="button"
            className={navStyles.breadcrumbLink}
            onClick={() => navigate({ kind: 'home', view: 'pipelines' })}
          >
            Dự án
          </button>
          <span className={navStyles.breadcrumbSep}>›</span>
          <button
            type="button"
            className={navStyles.breadcrumbLink}
            onClick={() => navigate({ kind: 'pipelines-app', appId: route.appId })}
          >
            {projects.find((p) => p.id === projectId)?.app?.name || 'Dự án'}
          </button>
          <span className={navStyles.breadcrumbSep}>›</span>
          <button
            type="button"
            className={navStyles.breadcrumbLink}
            onClick={() =>
              navigate({
                kind: 'pipelines-feature',
                appId: route.appId,
                featureId: route.featureId,
              })
            }
          >
            {projects.find((p) => p.id === projectId)?.name || route.featureId}
          </button>
          <span className={navStyles.breadcrumbSep}>›</span>
          <span className={navStyles.breadcrumbCurrent}>
            {workflows.find((w) => w.id === workflowId)?.name || workflowId}
          </span>
        </nav>
      ) : null}

      {/* KHÔNG dùng thuộc tính `hidden` ở đây: `.pipelines-page__hero` và
          `.pipelines-projects` đều đặt `display: flex`, và một selector class
          trong stylesheet của app luôn thắng luật `[hidden] { display: none }`
          của trình duyệt — khối vẫn hiện nguyên. Ở màn Chạy thì App/Feature đã
          chọn xong từ ba màn trước, nên bỏ hẳn khỏi DOM. */}
      {inRunScreen ? null : (
      <header className="pipelines-page__hero">
        <div className="pipelines-page__copy">
          <span className="pipelines-page__eyebrow">
            <Icon name="pipeline" size={13} />
            Docs → UI
          </span>
          <h1 id="pipelines-title" className="pipelines-page__title">
            Pipelines
          </h1>
          <p className="pipelines-page__lede">Chạy và theo dõi từng bước của quy trình.</p>
          {/* Mồi 3 bước CHỈ hiện khi máy chưa có dự án nào. Trước đây nó hiện
              vĩnh viễn: người đã quen phải cuộn qua nó mỗi lần vào, mà stepper
              — nội dung thật của trang — thì bị đẩy xuống dưới màn hình. */}
          {!hasProjects ? (
            <ol className="pipelines-page__steps">
              <li>
                <span>
                  <strong>Có một dự án</strong> — tạo mới ngay tại đây, hoặc{' '}
                  <strong>Tải dự án về…</strong> nếu đã có trên studio.
                </span>
              </li>
              <li>
                <span>
                  <strong>Chạy lần lượt các bước</strong> — bước sau mở khi bước trước xong.
                </span>
              </li>
              <li>
                <span>
                  <strong>Đẩy kết quả lên…</strong> để studio và máy khác cùng thấy.
                </span>
              </li>
            </ol>
          ) : null}
        </div>
        {hasProjects && pipelines.length > 0 ? (
          <div className="pipelines-progress" aria-label="Pipeline progress">
            <span className="pipelines-progress__count">
              {doneCount}
              <span className="pipelines-progress__total">/{stepEntries.length}</span>
            </span>
            <span className="pipelines-progress__label">bước xong</span>
          </div>
        ) : null}
      </header>
      )}

      {/* Workflow selector — each workflow is its own docs→output flow.
          Mô tả chỉ hiện cho tab ĐANG CHỌN, một dòng dưới hàng tab: ba đoạn mô
          tả xếp cạnh nhau chiếm gần hết màn hình đầu tiên, mà hai trong ba là
          của luồng người dùng không chọn. */}
      {workflows.length > 1 && !inRunScreen ? (
        <div className="pl-workflow-picker">
          <div className="pl-workflow-tabs" role="tablist" aria-label="Workflow">
            {workflows.map((w) => (
              <button
                key={w.id}
                type="button"
                role="tab"
                aria-selected={w.id === workflowId}
                className={`pl-workflow-tab${w.id === workflowId ? ' is-active' : ''}`}
                onClick={() => setWorkflowId(w.id)}
                {...(w.description ? { title: w.description } : {})}
              >
                <span className="pl-workflow-tab__name">{w.name}</span>
              </button>
            ))}
          </div>
          {/* Bám đúng tab đang sáng (không dùng activeWorkflows — nó fallback
              về CẢ danh sách khi workflowId còn rỗng, sẽ hiện mô tả của một tab
              không có tab nào sáng). */}
          {workflows.find((w) => w.id === workflowId)?.description ? (
            <p className="pl-workflow-picker__desc">
              {workflows.find((w) => w.id === workflowId)?.description}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Toolbar CHỈ còn "Chạy" — cặp Pull/Push (nhóm "Đồng bộ" cũ) đã dời
          xuống rail cấu hình bên cạnh stepper (Task 2), vì đó là nơi người
          dùng đã thấy sẵn tình trạng đồng bộ của dự án. "Chạy pipeline" là hành
          động CHẠY duy nhất và chạy THẲNG bằng cấu hình đã lưu (rail hiển thị
          đúng giá trị này); modal chỉ để CẤU HÌNH — mở từ "Đổi" trên rail, hoặc
          tự mở khi bấm Chạy mà chưa có nguồn tài liệu. */}
      {/* Req 1 + 2: KGS project selection cards + New project card.
          UX for many projects: search + smart order (selected → running →
          in-progress → untouched → complete) + collapsed grid (first
          PROJECT_CARD_LIMIT cards) with an explicit "Show all" toggle. */}
      {inRunScreen ? null : (
      <section className="pipelines-projects" aria-label="Tính năng">
        <div className="pl-proj-toolbar">
          <span className="pl-field__label">
            Tính năng
            {projects.length > 0 ? (
              <span className="pl-proj-count"> · {projects.length}</span>
            ) : null}
          </span>
          {projects.length > PROJECT_CARD_LIMIT ? (
            <input
              type="search"
              className="pl-proj-search"
              placeholder="Tìm tính năng…"
              value={projectSearch}
              onChange={(ev) => setProjectSearch(ev.target.value)}
              aria-label="Tìm tính năng"
            />
          ) : null}
          {/* Dự án khai sinh được ngay tại đây trở lại: đích trên Pipeline
              Studio chỉ được chọn lúc Push, nên thử một pipeline mới không còn
              phải sang studio tạo rồi pull về. */}
          <button
            type="button"
            className="pl-btn pl-btn--xs"
            onClick={() => setNewProjectOpen(true)}
            title="Tạo một tính năng mới ngay tại đây; chọn nơi chia sẻ khi hoàn tất"
          >
            <Icon name="plus" size={13} />
            <span>Tính năng mới</span>
          </button>
        </div>
        {(() => {
          const projectCard = (pr: PipelineProject) => {
            const complete = pr.total > 0 && pr.done >= pr.total;
            return (
              <button
                key={pr.id}
                type="button"
                className={`pl-proj-card${pr.id === projectId ? ' is-selected' : ''}`}
                onClick={() => setProjectId(pr.id)}
                aria-pressed={pr.id === projectId}
              >
                <span className="pl-proj-card__top">
                  <Icon name="folder" size={15} />
                  <span className="pl-proj-card__name">{pr.name}</span>
                  {pr.running > 0 ? (
                    <span
                      className="pl-proj-card__running"
                      aria-label={`${pr.running} pipeline running`}
                      title={`${pr.running} pipeline running`}
                    >
                      <Icon name="spinner" size={13} />
                    </span>
                  ) : null}
                  {pr.id === projectId ? (
                    <span className="pl-proj-card__check" aria-hidden="true">
                      <Icon name="check" size={13} />
                    </span>
                  ) : null}
                </span>
                <span className="pl-proj-card__progress">
                  <span
                    className="pl-proj-card__dot"
                    data-complete={complete ? 'yes' : 'no'}
                    aria-hidden="true"
                  />
                  {pr.done}/{pr.total} done
                  {pr.running > 0 ? ` · ${pr.running} running` : ''}
                </span>
              </button>
            );
          };
          const moreCards = (
            <>
              {hiddenProjectCount > 0 ? (
                <button
                  type="button"
                  className="pl-proj-card pl-proj-card--more"
                  onClick={() => setShowAllProjects(true)}
                  title="Xem tất cả tính năng"
                >
                  <span className="pl-proj-more__count">+{hiddenProjectCount}</span>
                  <span>Xem tất cả</span>
                </button>
              ) : null}
              {showAllProjects && projects.length > PROJECT_CARD_LIMIT ? (
                <button
                  type="button"
                  className="pl-proj-card pl-proj-card--more"
                  onClick={() => setShowAllProjects(false)}
                  title="Thu gọn về các tính năng liên quan nhất"
                >
                  <span className="pl-proj-more__chevron">
                    <Icon name="chevron-down" size={16} />
                  </span>
                  <span>Thu gọn</span>
                </button>
              ) : null}
            </>
          );
          // Chưa gán app nào → lưới phẳng như cũ. Có app → mỗi app một nhóm
          // đóng/mở được, feature lẻ dồn xuống nhóm "Chưa gán app" cuối cùng.
          if (!groupedByApp) {
            return (
              <div className="pl-card-grid">
                {visibleProjects.map(projectCard)}
                {moreCards}
              </div>
            );
          }
          const hasMoreCards =
            hiddenProjectCount > 0 || (showAllProjects && projects.length > PROJECT_CARD_LIMIT);
          return (
            <>
              {projectGroups.map((g) => {
                const collapsed = collapsedApps.has(g.key);
                const done = g.projects.reduce((n, p) => n + p.done, 0);
                const total = g.projects.reduce((n, p) => n + p.total, 0);
                const running = g.projects.reduce((n, p) => n + p.running, 0);
                return (
                  <div key={g.key || '(no-app)'} className="pl-app-group">
                    <button
                      type="button"
                      className="pl-app-group__head"
                      onClick={() => toggleAppGroup(g.key)}
                      aria-expanded={!collapsed}
                    >
                      <span className={`pl-app-group__chevron${collapsed ? '' : ' is-open'}`} aria-hidden="true">
                        <Icon name="chevron-right" size={14} />
                      </span>
                      <Icon name={g.key ? 'blocks' : 'folder'} size={14} />
                      <span className="pl-app-group__name">{g.name}</span>
                      <span className="pl-app-group__meta">
                        {g.projects.length} tính năng · {done}/{total} hoàn thành
                        {running > 0 ? ` · ${running} đang chạy` : ''}
                      </span>
                    </button>
                    {!collapsed ? <div className="pl-card-grid">{g.projects.map(projectCard)}</div> : null}
                  </div>
                );
              })}
              {hasMoreCards ? <div className="pl-card-grid">{moreCards}</div> : null}
            </>
          );
        })()}
        {projectSearch && visibleProjects.length === 0 ? (
          <div className="pl-proj-noresult">Không có tính năng nào khớp “{projectSearch}”.</div>
        ) : null}
      </section>
      )}

      {error ? (
        <div className="pipelines-error" role="alert">
          <Icon name="info" size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      {/* The stepper flow for the selected project */}
      {projectsLoaded && !hasProjects ? (
        <div className="pipelines-empty">
          <span className="pipelines-empty__icon" aria-hidden="true">
            <Icon name="pipeline" size={22} />
          </span>
          <div className="pipelines-empty__body">
            <strong>Chưa có tính năng nào trên máy này</strong>
            <p>
              Bấm <strong>Tính năng mới</strong> ở trên để tạo một tính năng ngay tại đây và chạy thử —
              khi chia sẻ, tính năng sẽ được đưa thẳng vào <strong>Dự án đã chia sẻ</strong>.
            </p>
            <p>
              Tính năng đã có sẵn trên <strong>Pipeline Studio</strong> thì nhờ quản lý thêm bạn vào,
              rồi bấm <strong>Tải dự án về…</strong> để kéo về máy.
            </p>
          </div>
        </div>
      ) : loading || !projectsLoaded ? (
        <div className="pipelines-flow pipelines-flow--loading" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="pl-step pl-step--skeleton">
              <div className="pl-step__spine">
                <span className="pl-step__node" />
              </div>
              <div className="pl-step__card" />
            </div>
          ))}
        </div>
      ) : (
        <div className="pl-run-layout">
        {/* Rail cấu hình (Task 2): thay modal Run-all 9 câu hỏi khỏi đường mặc
            định — hiển thị SẴN giá trị đang dùng, "Đổi" mới mở lại modal đó.
            Dưới 1100px không đủ chỗ đứng cạnh stepper → sập thành nút mở cùng
            nội dung trong drawer (PlModal có sẵn, không phải editor mới). */}
        {railNarrow ? (
          <button
            type="button"
            className="pl-btn pl-config-trigger"
            onClick={() => setConfigDrawerOpen(true)}
          >
            <Icon name="sliders" size={14} />
            <span>Cấu hình</span>
          </button>
        ) : null}
        <ol className="pipelines-flow">
          {stepEntries.map((opts, idx) => {
            const isLast = idx === stepEntries.length - 1;
            const isNext = idx === nextStepIdx;
            // Option-group step (the UI-Spec terminals): ONE card whose Run
            // opens the HTML-vs-React picker modal — the options are
            // alternatives, not consecutive steps.
            if (opts.length > 1) {
              const anyRunning = opts.some((o) => o.status === 'running' || o.status === 'queued');
              const anyDone = opts.some((o) => o.status === 'succeeded');
              const active = opts.some((o) => o.active);
              const groupStatus = anyRunning ? 'running' : anyDone ? 'succeeded' : 'idle';
              return (
                <li
                  key={opts.map((o) => o.id).join('+')}
                  className="pl-step"
                  data-status={groupStatus}
                  data-active={active ? 'yes' : 'no'}
                  data-next={isNext ? 'yes' : 'no'}
                >
                  <div className="pl-step__spine" aria-hidden="true">
                    <span className="pl-step__node">
                      {anyDone ? (
                        <Icon name="check" size={14} />
                      ) : anyRunning ? (
                        <Icon name="spinner" size={14} />
                      ) : !active ? (
                        <Icon name="eye-off" size={13} />
                      ) : (
                        <span className="pl-step__num">{idx + 1}</span>
                      )}
                    </span>
                    {!isLast ? <span className="pl-step__connector" /> : null}
                  </div>

                  <div className="pl-step__card">
                    <span className="pl-step__icon" aria-hidden="true">
                      <Icon name="blocks" size={18} />
                    </span>
                    <div className="pl-step__body">
                      <div className="pl-step__heading">
                        <span className="pl-step__name">UI-Spec</span>
                        {isNext ? <span className="pl-step__next">Bước tiếp theo</span> : null}
                        {opts.map((o) => (
                          <span key={o.id} className={`pl-status pl-status--${o.status}`}>
                            {uiSpecOptionLabel(o)}: {STATUS_LABEL[o.status] ?? o.status}
                          </span>
                        ))}
                      </div>
                      <p className="pl-step__desc">
                        Bước cuối — sinh UI-Spec từ UX Spec. Bấm Run để chọn định dạng: HTML
                        prototype hoặc React app (chạy một hoặc cả hai).
                      </p>
                      {/* Cổng phụ thuộc theo bước đã bỏ — `!active` giờ chỉ còn
                          nghĩa "chưa có tài liệu" (dependencyNote trỏ về bước 1,
                          không phải một bước trung gian). `active` mà phụ thuộc
                          tĩnh chưa `succeeded` chỉ còn là GỢI Ý thứ tự thường
                          dùng, không chặn nút Chạy bên dưới. */}
                      {(() => {
                        const note = dependencyNote(
                          active,
                          anyDone,
                          opts[0]!.effectiveDependsOn ?? opts[0]!.dependsOn,
                        );
                        if (!note) return null;
                        return (
                          <p
                            className={
                              note.kind === 'stale'
                                ? 'pl-step__stale'
                                : note.kind === 'lock'
                                  ? 'pl-step__lock'
                                  : 'pl-step__hint'
                            }
                          >
                            <Icon name={note.kind === 'lock' ? 'eye-off' : 'info'} size={12} />
                            {note.text}
                          </p>
                        );
                      })()}
                    </div>

                    <div className="pl-step__actions">
                      <button
                        type="button"
                        className="pl-btn pl-btn--run"
                        onClick={() => setUiSpecPickerOpen(true)}
                        disabled={!active}
                        title="Chọn định dạng UI-Spec (HTML / React) rồi chạy"
                      >
                        <Icon name={anyRunning ? 'spinner' : 'play'} size={14} />
                        <span>{anyRunning ? 'Đang chạy…' : anyDone ? 'Chạy / kết quả' : 'Chạy'}</span>
                      </button>
                    </div>
                  </div>
                </li>
              );
            }
            const p = opts[0]!;
            const isBusy = busyId === p.id;
            const isRunning = p.status === 'running' || p.status === 'queued';
            const meta = metaFor(p.id);
            const canChat = !!p.lastConversationId;
            const hasRunInfo = Boolean(p.updatedAt || p.lastInput || p.lastSource || p.lastRunId);
            const infoOpen = infoForId === p.id;
            const histOpen = historyForId === p.id;
            // BỎ QUA ≠ BỊ KHÓA: chế độ Tiết kiệm không chạy bước này, nhưng nó
            // không chặn ai cả và vẫn bấm chạy lẻ được. Chỉ tính là "bỏ qua"
            // khi bước CHƯA có kết quả — đã có output (từ lần chạy Đầy đủ
            // trước) thì vẫn là Done, không bao giờ giấu kết quả thật.
            const isSkipped = p.skipped === true && p.status !== 'succeeded' && !isRunning;

            // Task 1: MỘT nút chính (theo trạng thái) + MỘT nút ⋯ gom phần còn
            // lại, thay cho 5 nút phẳng cùng kiểu (Quick result/Open chat/Run
            // again/Lịch sử + toggle (i)) trước đây. Bước bị khóa (!p.active,
            // giờ chỉ còn nghĩa "chưa có tài liệu") không render nút nào —
            // dòng chú thích (dependencyNote) đã đủ nói lý do, nút xám trước
            // đây là điểm bấm chết.
            const historyItem: OverflowMenuItem = {
              key: 'history',
              label: 'Lịch sử',
              icon: historyBusy && histOpen ? 'spinner' : 'history',
              onClick: () => {
                const next = histOpen ? null : p.id;
                setHistoryForId(next);
                if (next && projectId) void loadHistory(projectId);
              },
            };
            const chatItem: OverflowMenuItem | null = canChat
              ? { key: 'chat', label: 'Mở hội thoại', icon: 'comment', onClick: () => openChat(p) }
              : null;
            // "Tải file lên" — deliberately separate from Run: proceedRun's
            // dispatch is a mutually-exclusive if/else keyed on
            // inputPlaceholder/acceptsDesignSystem/acceptsPlatform, and dr-docs
            // already sets inputPlaceholder, so folding upload into that chain
            // would make it unreachable.
            const uploadItem: OverflowMenuItem | null = p.acceptsUpload
              ? { key: 'upload', label: 'Tải file lên', icon: 'upload', onClick: () => setUploadFor(p) }
              : null;
            const infoItem: OverflowMenuItem | null = hasRunInfo
              ? {
                  key: 'info',
                  label: 'Thông tin lần chạy',
                  icon: 'info',
                  onClick: () => setInfoForId(infoOpen ? null : p.id),
                }
              : null;
            const baseOverflow: OverflowMenuItem[] = [chatItem, historyItem, uploadItem, infoItem].filter(
              (x): x is OverflowMenuItem => x !== null,
            );

            let primaryNode: ReactNode = null;
            let overflowItems: OverflowMenuItem[] = [];
            if (isRunning) {
              primaryNode = (
                <button type="button" className="pl-btn pl-btn--run" onClick={() => setStatusFor(p)}>
                  <Icon name="spinner" size={14} />
                  <span>Xem tiến trình</span>
                </button>
              );
              overflowItems = baseOverflow;
            } else if (p.status === 'succeeded') {
              primaryNode = (
                <button
                  type="button"
                  className="pl-btn pl-btn--run"
                  onClick={() => navigate({ kind: 'pipeline-result', projectId, pipelineId: p.id })}
                >
                  <Icon name="file-code" size={14} />
                  <span>Xem kết quả</span>
                </button>
              );
              overflowItems = [
                ...(chatItem ? [chatItem] : []),
                {
                  key: 'rerun',
                  label: 'Chạy lại',
                  icon: isBusy ? 'spinner' : 'refresh',
                  onClick: () => onRunClick(p),
                  disabled: isBusy,
                  // Task 5: đỏ khi việc này THỰC SỰ phá dữ liệu — có bước sau
                  // phụ thuộc thì chạy lại sẽ mở RerunScopeModal cảnh báo xóa
                  // luôn output của các bước đó (onRunClick, giữ nguyên).
                  danger: downstreamOf(p.id).length > 0,
                },
                historyItem,
                ...(uploadItem ? [uploadItem] : []),
                ...(infoItem ? [infoItem] : []),
              ];
            } else if (p.status === 'failed') {
              primaryNode = (
                // Task 5: "Xem lỗi" chỉ ĐỌC (mở modal Status ở chế độ lỗi) —
                // không phá gì, nên không còn tô đỏ như trước.
                <button type="button" className="pl-btn" onClick={() => setStatusFor(p)}>
                  <Icon name="info" size={14} />
                  <span>Xem lỗi</span>
                </button>
              );
              overflowItems = [
                ...(chatItem ? [chatItem] : []),
                {
                  key: 'retry',
                  label: 'Thử lại',
                  icon: isBusy ? 'spinner' : 'refresh',
                  onClick: () => onRunClick(p),
                  disabled: isBusy,
                },
                historyItem,
                ...(uploadItem ? [uploadItem] : []),
                ...(infoItem ? [infoItem] : []),
              ];
            } else if (p.active) {
              primaryNode = (
                <button
                  type="button"
                  className={isSkipped ? 'pl-btn' : 'pl-btn pl-btn--run'}
                  onClick={() => onRunClick(p)}
                  disabled={isBusy}
                  title={
                    isSkipped
                      ? 'Chạy riêng bước này dù chế độ Tiết kiệm bỏ qua nó'
                      : 'Chạy bước này trong nền'
                  }
                >
                  <Icon name={isBusy ? 'spinner' : 'play'} size={14} />
                  <span>{isBusy ? 'Đang khởi động…' : isSkipped ? 'Chạy bổ sung' : 'Chạy'}</span>
                </button>
              );
              overflowItems = baseOverflow;
            }

            return (
              <li
                key={p.id}
                className="pl-step"
                data-status={p.status}
                data-active={p.active ? 'yes' : 'no'}
                data-skipped={isSkipped ? 'yes' : 'no'}
                data-next={isNext ? 'yes' : 'no'}
              >
                <div className="pl-step__spine" aria-hidden="true">
                  <span className="pl-step__node">
                    {p.status === 'succeeded' ? (
                      <Icon name="check" size={14} />
                    ) : isRunning ? (
                      <Icon name="spinner" size={14} />
                    ) : isSkipped ? (
                      <Icon name="minus" size={13} />
                    ) : !p.active ? (
                      <Icon name="eye-off" size={13} />
                    ) : (
                      <span className="pl-step__num">{idx + 1}</span>
                    )}
                  </span>
                  {!isLast ? <span className="pl-step__connector" /> : null}
                </div>

                <div className="pl-step__card">
                  <span className="pl-step__icon" aria-hidden="true">
                    <Icon name={meta.icon} size={18} />
                  </span>
                  <div className="pl-step__body">
                    <div className="pl-step__heading">
                      <span className="pl-step__name">{p.name}</span>
                      <span className={`pl-status pl-status--${isSkipped ? 'skipped' : p.status}`}>
                        {isSkipped ? 'Bỏ qua' : (STATUS_LABEL[p.status] ?? p.status)}
                      </span>
                      {isNext ? <span className="pl-step__next">Bước tiếp theo</span> : null}
                      {/* Multi-target: chấm trạng thái THEO TARGET của riêng
                          bước này (suy từ file outputs dưới <wf>/<target>/).
                          Bước shared (docs, bản đồ hệ thống) không có entry
                          target nào → không hiện chấm. */}
                      {projTargets.length >= 2 &&
                      projTargets.some((t) => statusByTarget[t]?.[p.id] !== undefined) ? (
                        <span className="pl-target-dots" aria-label="Trạng thái theo target">
                          {projTargets.map((t) => {
                            const st = statusByTarget[t]?.[p.id];
                            return (
                              <span
                                key={t}
                                className={`pl-target-dot${st === 'succeeded' ? ' pl-target-dot--done' : ''}`}
                                title={`${UI_TARGETS[t].label}: ${st === 'succeeded' ? 'đã có output' : 'chưa có output'}`}
                              >
                                {UI_TARGETS[t].label.charAt(0)}
                              </span>
                            );
                          })}
                        </span>
                      ) : null}
                      {p.skipped && p.status === 'succeeded' ? (
                        <span className="pl-status pl-status--offmode" title="Bước này không nằm trong chế độ Tiết kiệm — kết quả còn lại từ lần chạy trước">
                          ngoài chế độ
                        </span>
                      ) : null}
                    </div>
                    {meta.blurb ? <p className="pl-step__desc">{meta.blurb}</p> : null}
                    {/* `updatedAt` là dấu thời gian của LẦN GHI STATE gần nhất,
                        không phải lần chạy: reset downstream lúc bắt đầu
                        run-all cũng đóng dấu nó — và vì reset MERGE metadata
                        (db giữ nguyên lastRunId cũ), lastRunId không chứng minh
                        được gì. Chỉ status mới đáng tin: idle (kể cả "Bỏ qua")
                        thì không có dòng "Last run" — nếu không sẽ ra "Bỏ qua ·
                        Last run: 35m ago", tự mâu thuẫn. Chi tiết lần chạy cũ
                        vẫn xem được ở nút (i) và Lịch sử. */}
                    {p.updatedAt && (isRunning || p.status === 'succeeded' || p.status === 'failed') ? (
                      <p className="pl-step__lastrun">Lần chạy gần nhất: {relativeTimeLong(p.updatedAt, t)}</p>
                    ) : null}
                    {infoOpen ? (
                      <dl className="pl-step__info">
                        {p.updatedAt ? (
                          <div className="pl-step__info-row">
                            <dt>Thời gian</dt>
                            <dd>
                              {new Date(p.updatedAt).toLocaleString()} (
                              {relativeTimeLong(p.updatedAt, t)})
                            </dd>
                          </div>
                        ) : null}
                        {p.lastInput ? (
                          <div className="pl-step__info-row">
                            <dt>Đầu vào</dt>
                            <dd>
                              {/^https?:\/\//i.test(p.lastInput.trim()) ? (
                                <a href={p.lastInput.trim()} target="_blank" rel="noreferrer">
                                  {p.lastInput.trim()}
                                </a>
                              ) : (
                                <code>{p.lastInput}</code>
                              )}
                            </dd>
                          </div>
                        ) : null}
                        {p.lastSource?.kind === 'confluence' ? (
                          <div className="pl-step__info-row">
                            <dt>Nguồn</dt>
                            <dd>
                              Confluence —{' '}
                              {/^https?:\/\//i.test(p.lastSource.ref.trim()) ? (
                                <a href={p.lastSource.ref.trim()} target="_blank" rel="noreferrer">
                                  {p.lastSource.ref.trim()}
                                </a>
                              ) : (
                                <code>{p.lastSource.ref}</code>
                              )}
                            </dd>
                          </div>
                        ) : p.lastSource?.kind === 'bas' ? (
                          <div className="pl-step__info-row">
                            <dt>Nguồn</dt>
                            <dd>
                              BAS document <code>{p.lastSource.documentId}</code>
                              {p.lastSource.featureIds?.length
                                ? ` · ${p.lastSource.featureIds.length} feature: ${p.lastSource.featureIds.join(', ')}`
                                : ' · toàn bộ tài liệu'}
                            </dd>
                          </div>
                        ) : null}
                        {canChat ? (
                          <div className="pl-step__info-row">
                            <dt>Hội thoại</dt>
                            <dd>
                              <button
                                type="button"
                                className="pl-step__info-link"
                                onClick={() => openChat(p)}
                              >
                                Mở hội thoại của lần chạy →
                              </button>
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    ) : null}
                    {/* Bước bỏ qua mà đầu vào của nó CHƯA xong thì vẫn chưa chạy
                        được — lúc đó nói lý do thật (thiếu đầu vào) thay vì mời
                        chạy bổ sung một thứ đang bấm không được. */}
                    {isSkipped && p.active ? (
                      <p className="pl-step__skipnote">
                        <Icon name="minus" size={12} />
                        Bỏ qua ở chế độ Tiết kiệm — không chặn bước nào; chạy bổ sung nếu cần bàn
                        giao.
                      </p>
                    ) : (() => {
                      const note = dependencyNote(
                        p.active,
                        p.status === 'succeeded',
                        p.effectiveDependsOn ?? p.dependsOn,
                      );
                      if (!note) return null;
                      return (
                        <p
                          className={
                            note.kind === 'stale'
                              ? 'pl-step__stale'
                              : note.kind === 'lock'
                                ? 'pl-step__lock'
                                : 'pl-step__hint'
                          }
                        >
                          <Icon name={note.kind === 'lock' ? 'eye-off' : 'info'} size={12} />
                          {note.text}
                        </p>
                      );
                    })()}

                  </div>

                  <div className="pl-step__actions">
                    {/* Bước khóa (!p.active — giờ chỉ còn nghĩa "chưa có tài
                        liệu") không render gì ở đây — chú thích bên trên đã
                        đủ; nút xám trước đây là điểm bấm chết. */}
                    {p.active ? (
                      <>
                        {primaryNode}
                        <OverflowMenu items={overflowItems} label={`Thao tác khác — ${p.name}`} />
                      </>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
          {/* Thẻ "Đánh giá chất lượng pipeline" — bước cuối workflow, hệ
              feedback MỚI (form builder + đính kèm + thống kê /feedback) mặc vỏ
              thẻ evaluation cũ. Thẻ PipelineEvaluationStep cũ đã gỡ khỏi
              stepper (endpoint cũ /api/pipelines/feedback giữ nguyên cho dữ
              liệu lịch sử). Nằm TRONG <ol> — con trực tiếp của .pl-run-layout
              sẽ chiếm một ô lưới và phá cột. */}
          {projectId ? (
            <FeedbackHub projectId={projectId} workflowId={workflowId} pipelines={pipelines} />
          ) : null}
        </ol>
        {!railNarrow ? (
          <div>
          <aside className="pl-config-rail" aria-label="Cấu hình">
            {configRailContent}
             <div className="pipelines-toolbar">
        <div className="pipelines-toolbar__group pipelines-toolbar__group--actions">
          {/* Một nút, hai trạng thái. Trước đây chỉ có Chạy: đang chạy thì nút
              xám đi và cách duy nhất để dừng là mở modal Status của ĐÚNG bước
              đang chạy rồi bấm Cancel run — người dùng phải đoán bước nào. */}
          {anyRunning ? (
            <button
              type="button"
              className="pl-btn pl-btn--danger"
              onClick={() => void stopPipeline()}
              disabled={stopping}
              title="Hủy mọi bước đang chạy của pipeline này. Kết quả của bước đang dở sẽ bị bỏ; các bước đã xong giữ nguyên."
            >
              <Icon name={stopping ? 'spinner' : 'stop'} size={14} />
              <span>{stopping ? 'Đang dừng…' : 'Dừng'}</span>
            </button>
          ) : (
            <button
              type="button"
              className="pl-btn pl-btn--run"
              onClick={() => void runAllWithSavedConfig()}
              disabled={!projectId || pipelines.length === 0 || runAllBusy}
              title="Chạy full luồng từ các bước đã chọn ở rail bên cạnh và XOÁ kết quả cũ của những bước đó (đã lưu vào lịch sử trước khi xoá) — đổi cấu hình trước bằng nút Đổi nếu cần khác đi"
            >
              <Icon name={runAllBusy ? 'spinner' : 'play'} size={14} />
              <span>{runAllBusy ? 'Đang khởi động…' : 'Chạy full luồng'}</span>
            </button>
          )}
          {/* Chế độ đang lưu của dự án. Chỉ hiện khi Tiết kiệm — ở chế độ Đầy
              đủ không có bước nào bị bỏ nên không có gì phải giải thích. Bấm
              vào mở đúng modal đã chọn ra nó. */}
          {runMode === 'lean' && pipelines.some((p) => p.skipped) ? (
            <button
              type="button"
              className="pl-mode-chip"
              onClick={() => openRunAll('mode')}
              title="Dự án đang chạy ở chế độ Tiết kiệm — các bước phân tích bị bỏ qua. Bấm để đổi chế độ chạy."
            >
              <Icon name="file-code" size={12} />
              <span>Tiết kiệm</span>
              <span className="pl-mode-chip__count">
                bỏ {pipelines.filter((p) => p.skipped).length} bước
              </span>
            </button>
          ) : null}
          {/* Multi-target: chọn target đang thao tác. Mọi lần chạy stage lẻ /
              Build / Demo / Capture Figma đều đi vào cây <wf>/<target>/ của
              chip đang bật; số ✓ = số bước target đó đã có output. */}
          {projTargets.length >= 2 ? (
            <div className="pl-target-switch" role="group" aria-label="Build target">
              {projTargets.map((t) => {
                const st = statusByTarget[t] ?? {};
                const done = Object.values(st).filter((s) => s === 'succeeded').length;
                const on = activeTarget === t;
                return (
                  <button
                    key={t}
                    type="button"
                    className={`pl-target-chip${on ? ' pl-target-chip--on' : ''}`}
                    onClick={() => setActiveTarget(t)}
                    title={`Thao tác theo target này — outputs ở ${workflowId}/${UI_TARGETS[t].dir}/ (${done} bước có output)`}
                  >
                    <span>{UI_TARGETS[t].label}</span>
                    <span className="pl-target-chip__count">{done}✓</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
          </aside>
          
          </div>
        ) : null}
        </div>
      )}
      {railNarrow && configDrawerOpen ? (
        <PlModal
          title="Cấu hình"
          icon="sliders"
          size="md"
          onClose={() => setConfigDrawerOpen(false)}
        >
          <div className="pl-config-rail pl-config-rail--drawer">{configRailContent}</div>
        </PlModal>
      ) : null}

      {/* ── Modals ── */}
      {historyForId
        ? (() => {
            const stageId = historyForId;
            const stageName = pipelines.find((x) => x.id === stageId)?.name ?? stageId;
            // Store versions whose frozen snapshot carries THIS stage's outputs
            // + this machine's .odhistory commits for the same pipeline.
            const vers = (historyData?.versions ?? []).filter((v) => v.stages?.includes(stageId));
            const cms = (historyData?.commits ?? []).filter((c) => c.pipelineId === stageId);
            return (
              <PlModal
                title={`Lịch sử — ${stageName}`}
                icon="history"
                size="md"
                busy={restoreBusy !== null}
                onClose={() => setHistoryForId(null)}
              >
                <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>
                  Bản đã chia sẻ có kết quả bước này ({vers.length})
                </div>
                {historyBusy && !historyData ? (
                  <div style={{ fontSize: 12, opacity: 0.6 }}>Đang tải…</div>
                ) : null}
                {vers.map((v, i) => (
                  <div
                    key={v.verId}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12.5 }}
                  >
                    <code style={{ fontWeight: 700 }}>{v.verId}</code>
                    <span
                      style={{ opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
                    >
                      {v.by?.name || v.by?.email || 'không rõ'} · {new Date(v.at).toLocaleString('vi-VN')}
                      {i === 0 ? ' · mới nhất' : ''}
                    </span>
                    <button
                      type="button"
                      className="pl-btn"
                      disabled={restoreBusy !== null}
                      onClick={() => void restoreHistory({ verId: v.verId, stage: stageId })}
                      title={`Khôi phục CHỈ output của bước "${stageName}" về bản ${v.verId}`}
                    >
                      {restoreBusy === v.verId ? 'Đang khôi phục…' : 'Khôi phục'}
                    </button>
                  </div>
                ))}
                {historyData && vers.length === 0 ? (
                  <div style={{ fontSize: 12, opacity: 0.6 }}>
                    Chưa có bản chia sẻ nào chứa kết quả bước này — chạy bước rồi chia sẻ để tạo.
                  </div>
                ) : null}
                {cms.length > 0 ? (
                  <>
                    <div style={{ fontSize: 12.5, fontWeight: 700, margin: '12px 0 4px' }}>
                      Trên máy này ({cms.length})
                    </div>
                    {cms.slice(0, 10).map((c) => (
                      <div
                        key={c.commit}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12 }}
                      >
                        <code style={{ opacity: 0.6 }}>{c.commit.slice(0, 8)}</code>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {c.kind}
                          {c.status ? ` [${c.status}]` : ''}
                          {typeof c.filesChanged === 'number' ? ` · ${c.filesChanged} file` : ''}
                          {' · '}
                          {new Date(c.at).toLocaleString('vi-VN')}
                        </span>
                        <button
                          type="button"
                          className="pl-btn"
                          disabled={restoreBusy !== null}
                          onClick={() => void restoreHistory({ commit: c.commit })}
                          title="Rewind TOÀN BỘ project về commit này (mọi file, không chỉ bước này)"
                        >
                          {restoreBusy === c.commit.slice(0, 10) ? '…' : 'Khôi phục'}
                        </button>
                      </div>
                    ))}
                  </>
                ) : null}
              </PlModal>
            );
          })()
        : null}
      {uiSpecPickerOpen
        ? (() => {
            // Live options from the current pipeline list (statuses keep
            // refreshing while the modal is open). Matched by terminal id, not
            // "any multi-entry group" — this modal is specifically the
            // HTML-vs-React picker.
            const options = stepEntries.find(
              (e) => e.length > 1 && e.every((o) => UI_TERMINAL_STAGE_IDS.has(o.id)),
            );
            if (!options) return null;
            return (
              <PlModal
                title="UI-Spec — chọn định dạng"
                icon="blocks"
                size="md"
                onClose={() => setUiSpecPickerOpen(false)}
              >
                <p style={{ fontSize: 12.5, opacity: 0.75, margin: '0 0 12px' }}>
                  Hai lựa chọn là NGANG HÀNG — cùng sinh UI-Spec từ UX Spec. Chạy một định dạng,
                  hoặc cả hai nếu cần so sánh.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {options.map((o) => {
                    const oRunning = o.status === 'running' || o.status === 'queued';
                    const oCanChat = !!o.lastConversationId;
                    return (
                      <div
                        key={o.id}
                        style={{
                          border: '1px solid var(--border, rgba(127,127,127,.3))',
                          borderRadius: 10,
                          padding: '14px 14px 12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Icon name={o.id === 'ui-react' ? 'blocks' : o.id === 'ui-react-ds' ? 'palette' : 'file-code'} size={18} />
                          <span style={{ fontWeight: 700, fontSize: 13.5 }}>
                            {uiSpecOptionLabel(o)}
                          </span>
                          <span className={`pl-status pl-status--${o.status}`}>
                            {STATUS_LABEL[o.status] ?? o.status}
                          </span>
                        </div>
                        <p style={{ fontSize: 12, opacity: 0.75, margin: 0, flex: 1 }}>
                          {o.id === 'ui-react'
                            ? 'App Vite + React 19 + Tailwind v4 thật, build trong Docker — preview như app chạy thật, có luồng điều hướng.'
                            : o.id === 'ui-react-ds'
                              ? 'App React ghép màn từ bộ design system đã import từ Figma — component + token thật, cần chọn DS dạng đó.'
                              : 'HTML/CSS prototype tương tác — mỗi màn một file tự chứa, mở xem ngay không cần build.'}
                        </p>
                        {/* Cùng luật với card trên stepper: idle không có "Last
                            run" — updatedAt của bước idle là dấu reset, không
                            phải dấu lần chạy. */}
                        {o.updatedAt && (oRunning || o.status === 'succeeded' || o.status === 'failed') ? (
                          <p style={{ fontSize: 11.5, opacity: 0.6, margin: 0 }}>
                            Lần chạy gần nhất: {relativeTimeLong(o.updatedAt, t)}
                          </p>
                        ) : null}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {oRunning ? (
                            <button
                              type="button"
                              className="pl-btn pl-btn--run"
                              onClick={() => {
                                setUiSpecPickerOpen(false);
                                setStatusFor(o);
                              }}
                            >
                              <Icon name="spinner" size={14} />
                              <span>Xem tiến trình</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="pl-btn pl-btn--run"
                              disabled={busyId === o.id || !o.active}
                              onClick={() => {
                                setUiSpecPickerOpen(false);
                                onRunClick(o);
                              }}
                            >
                              <Icon
                                name={o.status === 'failed' || o.status === 'succeeded' ? 'refresh' : 'play'}
                                size={14}
                              />
                              <span>
                                {o.status === 'succeeded'
                                  ? 'Chạy lại'
                                  : o.status === 'failed'
                                    ? 'Thử lại'
                                    : 'Chạy'}
                              </span>
                            </button>
                          )}
                          {o.status === 'succeeded' ? (
                            <button
                              type="button"
                              className="pl-btn"
                              onClick={() => {
                                setUiSpecPickerOpen(false);
                                navigate({ kind: 'pipeline-result', projectId, pipelineId: o.id });
                              }}
                            >
                              <Icon name="file-code" size={14} />
                              <span>Xem kết quả</span>
                            </button>
                          ) : null}
                          {o.status === 'failed' ? (
                            // Task 5: chỉ đọc — không phá dữ liệu — nên không tô đỏ.
                            <button
                              type="button"
                              className="pl-btn"
                              onClick={() => {
                                setUiSpecPickerOpen(false);
                                setStatusFor(o);
                              }}
                            >
                              <Icon name="info" size={14} />
                              <span>Xem lỗi</span>
                            </button>
                          ) : null}
                          {oCanChat ? (
                            <button
                              type="button"
                              className="pl-btn"
                              onClick={() => openChat(o)}
                            >
                              <Icon name="comment" size={14} />
                              <span>Mở hội thoại</span>
                            </button>
                          ) : null}
                          {(o.id === 'ui-react' || o.id === 'ui-react-ds') && o.status === 'succeeded' ? (
                            <button
                              type="button"
                              className="pl-btn"
                              onClick={() => void buildReactApp()}
                              disabled={buildBusy || demoBusy || !projectId}
                              title="Build lại app từ source — sau khi lấy dự án về máy cần build lại để preview. Cần Docker trên máy này."
                            >
                              <Icon name={buildBusy ? 'spinner' : 'play'} size={14} />
                              <span>{buildBusy ? 'Đang build…' : 'Build app'}</span>
                            </button>
                          ) : null}
                          {(o.id === 'ui-react' || o.id === 'ui-react-ds') && o.status === 'succeeded' ? (
                            <button
                              type="button"
                              className="pl-btn"
                              onClick={() => void buildReactDemoRun()}
                              disabled={demoBusy || buildBusy || !projectId}
                              title="Prototype tự chạy: Playwright bấm xuyên các kịch bản flow.json trên app đã build, ghi video + screenshot từng bước vào react/prototype-demo/ (không dùng agent). Lần đầu sẽ cài Playwright + Chromium (một lần)."
                            >
                              <Icon name={demoBusy ? 'spinner' : 'present'} size={14} />
                              <span>{demoBusy ? 'Đang quay…' : 'Dựng demo'}</span>
                            </button>
                          ) : null}
                          {o.id === 'ui-react-ds' && o.status === 'succeeded' ? (
                            <button
                              type="button"
                              className="pl-btn"
                              onClick={() => void runFigmaCapture()}
                              disabled={figmaCaptureBusy || buildBusy || demoBusy || !projectId}
                              title="Capture app đã build thành Figma screen JSON (instance component thật + token). Kết quả vào react-ds/figma-screens/ — dán screens.json vào plugin Fig Pipeline tab 'Screen JSON → Figma' (mở đúng file UI Lib). Lần đầu sẽ cài Playwright + Chromium (một lần)."
                            >
                              <Icon name={figmaCaptureBusy ? 'spinner' : 'share'} size={14} />
                              <span>{figmaCaptureBusy ? 'Đang capture…' : 'Capture Figma'}</span>
                            </button>
                          ) : null}
                          {o.id === 'ui-react-ds' && o.status === 'succeeded' ? (
                            <button
                              type="button"
                              className="pl-btn"
                              onClick={() => void runFigmaAuditFe()}
                              disabled={figmaAuditBusy || figmaCaptureBusy || !projectId}
                              title="Audit 'Preview ↔ Figma' (Lớp 1): soi tĩnh các file capture đối chiếu bộ DS — báo trước icon sẽ unmatched, variant sẽ fallback, layer tràn khung TRƯỚC khi dán vào Figma. Kết quả: react-ds/figma-screens/audit.json."
                            >
                              <Icon name={figmaAuditBusy ? 'spinner' : 'info'} size={14} />
                              <span>{figmaAuditBusy ? 'Đang audit…' : 'Audit Figma'}</span>
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="pl-btn"
                            onClick={() => {
                              setUiSpecPickerOpen(false);
                              setHistoryForId(o.id);
                              if (projectId) void loadHistory(projectId);
                            }}
                            title="Các bản đã chia sẻ có chứa kết quả của định dạng này"
                          >
                            <Icon name="history" size={14} />
                            <span>Lịch sử</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </PlModal>
            );
          })()
        : null}
      {pullAllOpen ? (
        <PullAllModal
          localIds={new Set(projects.map((pr) => pr.id))}
          workflows={activeWorkflows}
          scopeName={activeWorkflows[0]?.name}
          initialSelectedIds={projectId ? [projectId] : undefined}
          syncReady={syncAccess?.syncReady === true}
          onReconnect={() => void reconnectSync()}
          onClose={() => setPullAllOpen(false)}
          onConfirm={async (selection, stages) => {
            const appResults = await transferSelectedAppContexts('pull', selection);
            // Exactly ONE locally-mirrored project + full stage scope → the
            // conflict-aware path (PLAN → RESOLVE → APPLY), so local edits are
            // never overwritten silently. Anything broader takes the bulk
            // endpoint (blind overwrite behind a pre-pull .odhistory snapshot).
            const allStages = activeWorkflows[0]?.pipelineIds.length ?? 0;
            const pid = selection.projectIds.length === 1 ? selection.projectIds[0]! : null;
            if (pid && selection.appIds.length === 0 && projects.some((pr) => pr.id === pid) && stages.length >= allStages) {
              setProjectId(pid);
              await pullProject(pid);
              return;
            }
            if (selection.projectIds.length > 0) {
              const ok = await syncAll('pull', { ...selection, appIds: [] }, stages);
              if (!ok) throw new Error('Không thể lấy dự án về máy. Xem thông báo để biết chi tiết.');
            } else {
              pushToast({ message: `Đã lấy ${appResults.length} bộ tài liệu chung về máy. Liên kết của tính năng được giữ nguyên.` });
              await loadProjects();
            }
          }}
        />
      ) : null}
      {newProjectOpen ? (
        <NewFeatureModal
          onClose={() => setNewProjectOpen(false)}
          onCreated={async (id) => {
            await loadProjects();
            setProjectId(id);
          }}
        />
      ) : null}
      {pushAllOpen ? (
        <PushAllModal
          projects={projects.map((pr) => ({
            id: pr.id,
            name: pr.name,
            ...(pr.app ? { app: pr.app } : {}),
            appContextBinding: pr.appContextBinding,
          }))}
          workflows={activeWorkflows}
          scopeName={activeWorkflows[0]?.name}
          initialSelectedIds={projectId ? [projectId] : undefined}
          syncReady={syncAccess?.syncReady === true}
          onReconnect={() => void reconnectSync()}
          onClose={() => setPushAllOpen(false)}
          onConfirm={async (selection, stages) => {
            const appResults = await transferSelectedAppContexts('push', selection);
            if (selection.projectIds.length > 0) {
              const ok = await syncAll('push', { ...selection, appIds: [] }, stages);
              if (!ok) throw new Error('Không thể chia sẻ kết quả. Xem thông báo để biết chi tiết.');
            } else {
              pushToast({ message: `Đã xử lý ${appResults.length} bộ tài liệu chung.` });
            }
          }}
          onUpgradeFeatureContext={async (featureId, appId, contextVersion, contentDigest) => {
            await bindFeatureContext({ featureId, appId, contextVersion, contentDigest });
            pushToast({ message: `Tính năng sẽ dùng bản tài liệu chung ${contextVersion} ở lần chạy tiếp theo.` });
            await loadProjects();
          }}
        />
      ) : null}
      {runAllOpen ? (() => {
        const runAllProject = projects.find((pr) => pr.id === projectId);
        // Saved run-all config (this device's last save/trigger) wins; a project
        // that has never been configured yet has no `savedRunAll`, so this falls
        // back to Pipeline Studio's config — exactly "defaults from Studio, mọi
        // lần sau nhớ đúng cấu hình đã lưu".
        const runAllDefaults = runAllProject?.savedRunAll ?? runAllProject?.config;
        return (
          <RunAllModal
            workflowName={workflows.find((w) => w.id === workflowId)?.name ?? 'Docs → UI-Spec'}
            defaultConfluencePages={runAllDefaults?.confluencePages}
            defaultDesignSystemId={runAllDefaults?.designSystemId}
            defaultDesignSystemByTarget={runAllDefaults?.designSystemByTarget}
            defaultTerminal={runAllDefaults?.terminal}
            defaultPlatform={runAllDefaults?.platform}
            defaultTargets={runAllDefaults?.targets}
            defaultFollowLinks={runAllDefaults?.followLinks}
            // Mọi chế độ đều là SỬA cấu hình đã lưu, nên prefill đầy đủ — bỏ
            // trống sẽ âm thầm tắt lựa chọn cũ khi bấm Lưu.
            defaultIncludeDescendants={runAllDefaults?.includeDescendants}
            defaultDocsFromUpload={runAllDefaults?.docsFromUpload}
            defaultAppPool={runAllDefaults?.appPool}
            defaultSkipSucceeded={runAllDefaults?.skipSucceeded}
            defaultLean={runAllDefaults?.lean}
            // Bước của workflow đang mở + lựa chọn đã lưu — cùng dữ liệu dòng
            // rail "Các bước sẽ chạy" đang hiển thị, nên mở modal ra không thấy
            // một tập khác với cái vừa đọc trên rail.
            stages={runStageOptions}
            defaultStageIds={runAllDefaults?.stageIds}
            // Only show a picker when the active workflow HAS a stage using it —
            // Docs → PRD Review has no UX/UI/design-system stage, so it shows
            // just the Confluence source + scan toggles. Section bị ẩn cũng nằm
            // ngoài patch khi Lưu (modal không ghi đè field nó không hiện).
            hasPlatform={pipelines.some((p) => p.acceptsPlatform)}
            hasTerminal={pipelines.some((p) => p.id === 'ui-html' || p.id === 'ui-react')}
            hasDesignSystem={pipelines.some((p) => p.acceptsDesignSystem)}
            // Ingest step nhận file tay (Docs → Review tài liệu) → modal mở thêm
            // nhánh nguồn "Tải file .md lên" thay vì khóa cứng Confluence.
            hasUpload={pipelines.some((p) => p.acceptsUpload)}
            // App sở hữu dự án — modal tự fetch pool của App này và chỉ hiện
            // thẻ "Tài liệu App" khi pool không rỗng (docs/app-docs-pool-spec.md §WP-6).
            appId={runAllProject?.app?.id}
            // Lean chỉ là khái niệm của docs-to-ui — các workflow khác (Docs →
            // PRD Review) chạy đủ chuỗi, ẩn hẳn section "Chế độ chạy".
            supportsLean={workflowId === 'docs-to-ui'}
            anySucceeded={pipelines.some((p) => p.status === 'succeeded')}
            focus={runAllFocus}
            onClose={() => setRunAllOpen(false)}
            onSaveConfig={saveRunConfig}
            onUploadDocs={uploadRunAllDocs}
          />
        );
      })() : null}
      {runAllClearConfirmFor ? (
        <RunAllClearConfirmModal
          stageNames={runAllClearConfirmFor.stageNames}
          staleInputs={runAllClearConfirmFor.staleInputs}
          onClose={() => setRunAllClearConfirmFor(null)}
          onConfirm={async () => {
            const { payload } = runAllClearConfirmFor;
            setRunAllClearConfirmFor(null);
            await runAllNow(payload);
          }}
        />
      ) : null}
      {runInputFor ? (() => {
        const runInputProject = projects.find((pr) => pr.id === projectId);
        const runInputDefaults = runInputProject?.savedRunAll ?? runInputProject?.config;
        return (
        <RunInputModal
          pipelineName={runInputFor.name}
          placeholder={runInputFor.inputPlaceholder ?? ''}
          defaultConfluencePages={runInputProject?.config?.confluencePages}
          defaultBasDocumentId={runInputProject?.config?.basDocumentId}
          // Docs step of docs-to-ui: offer the UI-target picker so targets.json
          // is written from the docs run (Docs → PRD Review has no such stage).
          showTargets={pipelines.some((p) => p.acceptsPlatform)}
          defaultTargets={runInputDefaults?.targets}
          onClose={() => setRunInputFor(null)}
          onRun={async (payload) => {
            await startRun(runInputFor.id, payload);
            pushToast({ message: `Đã bắt đầu chạy “${runInputFor.name}” — đang chạy nền` });
          }}
        />
        );
      })() : null}
      {designSystemFor ? (
        <DesignSystemRunModal
          pipelineName={designSystemFor.name}
          requireReactBundle={designSystemFor.id === 'ui-react-ds'}
          defaultId={projects.find((pr) => pr.id === projectId)?.config?.designSystemId ?? undefined}
          onClose={() => setDesignSystemFor(null)}
          onRun={async (designSystemId) => {
            await startRun(designSystemFor.id, undefined, designSystemId);
            pushToast({ message: `Đã bắt đầu chạy “${designSystemFor.name}” — đang chạy nền` });
          }}
        />
      ) : null}
      {platformFor ? (
        <PlatformRunModal
          pipelineName={platformFor.name}
          onClose={() => setPlatformFor(null)}
          onRun={async (platform) => {
            await startRun(platformFor.id, undefined, undefined, platform);
            pushToast({ message: `Đã bắt đầu chạy “${platformFor.name}” — đang chạy nền` });
          }}
        />
      ) : null}
      {uploadFor ? (
        <UploadFilesModal
          projectId={projectId}
          workflowId={workflowId}
          docsDir={docsDirOf(workflows, workflowId)}
          pipelineName={uploadFor.name}
          onClose={() => setUploadFor(null)}
          onUploaded={() => {
            if (projectId) void load(projectId, { background: true });
          }}
        />
      ) : null}
      {resetScopeFor ? (
        <RerunScopeModal
          pipelineName={resetScopeFor.name}
          downstreamNames={downstreamOf(resetScopeFor.id).map((d) => d.name)}
          onClose={() => setResetScopeFor(null)}
          onChoose={async (scope) => {
            // Remember the choice, then continue into the stage's normal run
            // flow (which may open the platform/design-system/input modal).
            pendingResetScopeRef.current = scope;
            const p = resetScopeFor;
            setResetScopeFor(null);
            proceedRun(p);
          }}
        />
      ) : null}
      {statusFor ? (
        <PipelineStatusModal
          // Fresh copy from the polled list so the fan-out task list updates live.
          pipeline={pipelines.find((p) => p.id === statusFor.id) ?? statusFor}
          projectId={projectId ?? ''}
          onClose={() => setStatusFor(null)}
          onOpenTask={(conversationId) => {
            navigate({ kind: 'project', projectId, conversationId, fileName: null });
            setStatusFor(null);
          }}
          onOpenChat={
            statusFor.lastConversationId
              ? () => {
                  openChat(statusFor);
                  setStatusFor(null);
                }
              : null
          }
          onRefresh={() => {
            if (projectId) void load(projectId, { background: true });
          }}
        />
      ) : null}
      {pullPlanState ? (
        <PullConflictModal
          projectId={projectId}
          plan={pullPlanState}
          onClose={() => setPullPlanState(null)}
          onApplied={(result) => {
            void load(projectId, { background: true });
            pushToast({
              message: `Pulled “${projectId}” — ${result.downloaded} downloaded, ${result.keptLocal} kept local`,
              ...(result.stale.length
                ? { details: `${result.stale.length} skipped (remote changed)`, code: 'warn' }
                : {}),
            });
          }}
        />
      ) : null}

      {toast ? (
        <Toast
          message={toast.message}
          details={toast.details ?? null}
          code={toast.code ?? null}
          role={toast.code ? 'alert' : 'status'}
          onDismiss={() => setToast(null)}
        />
      ) : null}
    </section>
  );
}
