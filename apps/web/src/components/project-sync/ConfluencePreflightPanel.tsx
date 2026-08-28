import type { ProjectSyncConfluencePreflight, ProjectSyncConfluencePullOutcome } from '@open-design/contracts';

import { Icon } from '../Icon';
import styles from './ProjectSyncPreview.module.css';

/** Web-side state machine for one preflight call. `idle` means the plan has
 *  no Confluence entry (the endpoint is never called). */
export type ConfluencePreflightState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; preflight: ProjectSyncConfluencePreflight }
  | { status: 'error'; message: string };

/** True while the Pull button must stay blocked: the plan needs Confluence
 *  bytes and this machine is not (yet) known to be able to fetch them. */
export function confluencePreflightBlocksPull(required: boolean, state: ConfluencePreflightState): boolean {
  if (!required) return false;
  return state.status !== 'ready' || !state.preflight.ok;
}

export function formatConfluenceBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const CONFLUENCE_TOKEN_COPY: Record<ProjectSyncConfluencePreflight['token'], string> = {
  ok: 'PAT hợp lệ',
  missing: 'Chưa có PAT Confluence — Settings → Integrations → Confluence',
  invalid: 'PAT không hợp lệ hoặc hết hạn',
  unreachable: 'Không kết nối được wiki',
};

const LIST_LIMIT = 5;

function listPaths(items: Array<{ path: string; reason: string }>): string {
  const shown = items.slice(0, LIST_LIMIT).map((item) => (item.reason ? `${item.path} (${item.reason})` : item.path));
  const rest = items.length - shown.length;
  return `${shown.join(', ')}${rest > 0 ? ` …và ${rest} nữa` : ''}`;
}

/** Human-readable warnings for a pull result. Empty when nothing drifted or
 *  went missing — callers then close the dialog as before. `prefix` names the
 *  Feature in batch pulls. */
export function describeConfluencePullOutcome(
  outcome: ProjectSyncConfluencePullOutcome | undefined,
  prefix?: string,
): string[] {
  if (!outcome) return [];
  const label = prefix ? `${prefix}: ` : '';
  const lines: string[] = [];
  if (outcome.missing.length > 0) {
    lines.push(`${label}${outcome.missing.length} file Confluence không tải được (không ghi vào máy): ${listPaths(outcome.missing)}`);
  }
  if (outcome.drifted.length > 0) {
    lines.push(`${label}${outcome.drifted.length} file Confluence đã đổi trên wiki so với bản đã review, đã lấy bản mới nhất: ${listPaths(outcome.drifted)}`);
  }
  return lines;
}

/** One-line status for the pull progress panel. Files expanded from a
 *  `attachments/_sources.json` ledger are fetched from the wiki, not media,
 *  so the label says so and shows only the file name. */
export function describeSyncProgressPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const segments = path.split('/').filter(Boolean);
  const index = segments.lastIndexOf('attachments');
  if (index >= 0 && index < segments.length - 1) {
    return `Đang tải tài liệu từ wiki: ${segments.slice(index + 1).join('/')}`;
  }
  return `Đang tải: ${path}`;
}

/** Post-apply one-liner from the daemon's Confluence pull outcome. The count
 *  of files skipped because they already existed is not reported by the
 *  daemon (contracts are frozen), so it is deliberately left out. */
export function summarizeConfluencePullOutcome(outcome: ProjectSyncConfluencePullOutcome | undefined): string | null {
  if (!outcome) return null;
  return `Đã tải ${outcome.fetched} file từ wiki · lệch ${outcome.drifted.length} · thiếu ${outcome.missing.length}`;
}

/** Sum several pull outcomes (batch feature pulls) into one summary line;
 *  `null` when no item carried a Confluence outcome. */
export function mergeConfluencePullOutcomes(
  outcomes: ReadonlyArray<ProjectSyncConfluencePullOutcome | undefined>,
): ProjectSyncConfluencePullOutcome | undefined {
  let merged: ProjectSyncConfluencePullOutcome | undefined;
  for (const outcome of outcomes) {
    if (!outcome) continue;
    merged = merged
      ? { fetched: merged.fetched + outcome.fetched, drifted: [...merged.drifted, ...outcome.drifted], missing: [...merged.missing, ...outcome.missing] }
      : { fetched: outcome.fetched, drifted: [...outcome.drifted], missing: [...outcome.missing] };
  }
  return merged;
}

export interface ConfluencePreflightPanelProps {
  files: number;
  bytes: number;
  state: ConfluencePreflightState;
  onRecheck: () => void;
  disabled?: boolean;
}

/** "Tài liệu Confluence" block shown above the Pull button whenever the plan
 *  contains wiki-backed files. Mirrors the daemon preflight verbatim so the
 *  user knows exactly which prerequisite (PAT, base, space right) is missing. */
export function ConfluencePreflightPanel({ files, bytes, state, onRecheck, disabled = false }: ConfluencePreflightPanelProps) {
  const preflight = state.status === 'ready' ? state.preflight : null;
  const base = preflight?.base ?? null;
  const ok = preflight?.ok ?? false;
  const checking = state.status === 'loading';
  return (
    <section className={styles.confluence} aria-label="Tài liệu Confluence" data-ok={ok || undefined} data-checking={checking || undefined}>
      <div className={styles.confluenceHead}>
        <span className={styles.confluenceTitle}><Icon name="info" size={14} />Tài liệu Confluence</span>
        <button type="button" className="pl-btn pl-btn--xs" onClick={onRecheck} disabled={disabled || checking}>
          <Icon name={checking ? 'spinner' : 'refresh'} size={12} />
          {checking ? 'Đang kiểm tra…' : 'Kiểm tra lại'}
        </button>
      </div>
      <ul className={styles.confluenceLines} aria-live="polite">
        <li>{files} file ({formatConfluenceBytes(bytes)}) sẽ tải từ {base ?? 'wiki Confluence'}</li>
        {checking ? <li>Đang kiểm tra PAT và quyền truy cập space…</li> : null}
        {state.status === 'error' ? <li data-bad>Không kiểm tra được: {state.message}</li> : null}
        {preflight && preflight.required ? (
          <>
            <li data-bad={preflight.token !== 'ok' || undefined}>
              {preflight.token === 'ok' && preflight.displayName
                ? `${CONFLUENCE_TOKEN_COPY.ok} · ${preflight.displayName}`
                : CONFLUENCE_TOKEN_COPY[preflight.token]}
            </li>
            {!preflight.baseMatches ? (
              <li data-bad>Máy này trỏ {preflight.credsBase ?? '(chưa cấu hình)'}, dữ liệu cần {preflight.base ?? '(không rõ)'}</li>
            ) : null}
            {preflight.spaces.map((space) => (
              <li key={space.key} data-bad={!space.ok || undefined}>
                Space {space.key}: {space.ok
                  ? 'có quyền ✓'
                  : `không có quyền${space.status !== null ? ` (HTTP ${space.status})` : ''} — cần được cấp quyền space`}
              </li>
            ))}
          </>
        ) : null}
        {preflight && !preflight.required ? <li>Không cần tải file nào từ wiki.</li> : null}
      </ul>
    </section>
  );
}
