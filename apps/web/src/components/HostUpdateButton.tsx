// Header control for the host-runtime self-update. Lives in the entry
// topbar next to the model/CLI switcher chip. Three faces, one button:
//   idle      — accent-filled "Cập nhật vX.Y.Z" (only when an update exists)
//   applying  — disabled, its own background fills left→right with the
//               apply percent and the label reads "Đang cập nhật · 42%"
//   restart   — "Cần khởi động lại" (Windows safe-fallback state)
// No banner, no modal: the button IS the progress indicator. Polling,
// reload-on-success and error toasts stay in UpdateCheck.tsx (headless,
// mounted once in App); state is shared via state/host-update-store.ts.
import { RemixIcon } from './RemixIcon';
import { startHostUpdate } from './UpdateCheck';
import { hostUpdatePercent, useHostUpdateState } from '../state/host-update-store';
import styles from './HostUpdateButton.module.css';

export function hostUpdateButtonLabel(input: {
  applying: boolean;
  percent: number;
  restartRequired: boolean;
  latestVersion: string | null;
}): string {
  if (input.applying) return `Đang cập nhật · ${input.percent}%`;
  if (input.restartRequired) return 'Cần khởi động lại';
  return input.latestVersion ? `Cập nhật v${input.latestVersion}` : 'Cập nhật';
}

export function HostUpdateButton() {
  const { status, applying } = useHostUpdateState();
  const restartRequired = status?.state === 'restart-required';
  if (!status?.updateAvailable && !applying && !restartRequired) return null;

  const percent = applying ? hostUpdatePercent(status) : 0;
  const label = hostUpdateButtonLabel({
    applying,
    percent,
    restartRequired,
    latestVersion: status?.latestVersion ?? null,
  });
  const title = applying
    ? `Đang cập nhật lên v${status?.latestVersion ?? '…'} — ${percent}%${status?.progress ? ` · ${status.progress.label}` : ''}`
    : restartRequired
      ? 'Bản cập nhật đã cài an toàn; đăng xuất/đăng nhập lại để kích hoạt.'
      : `Có bản mới v${status?.latestVersion} (đang chạy v${status?.currentVersion}). Bấm để cập nhật.`;

  return (
    <button
      type="button"
      className={`${styles.button}${applying ? ` ${styles.applying}` : ''}${restartRequired ? ` ${styles.restart}` : ''}`}
      style={{ ['--od-update-percent' as string]: `${percent}%` }}
      disabled={applying || restartRequired}
      onClick={() => void startHostUpdate()}
      title={title}
      aria-label={title}
      aria-busy={applying || undefined}
      data-testid="host-update-button"
      data-percent={applying ? percent : undefined}
    >
      <span className={styles.icon} aria-hidden="true">
        <RemixIcon name={applying ? 'loader-4-line' : restartRequired ? 'restart-line' : 'download-cloud-2-line'} size={14} />
      </span>
      <span className={styles.label}>{label}</span>
    </button>
  );
}
