// Header control for the host-runtime self-update. Lives in the entry
// topbar next to the model/CLI switcher chip. Four faces, one slot:
//   check     — quiet "Kiểm tra cập nhật" (no update known): asks the daemon
//               for a LIVE GitHub check (?refresh=1) and briefly reports
//               "Đã là bản mới nhất · vX" / "Không kiểm tra được"
//   idle      — accent-filled "Cập nhật vX.Y.Z" (only when an update exists)
//   applying  — disabled, its own background fills left→right with the
//               apply percent and the label reads "Đang cập nhật · 42%"
//   restart   — "Cần khởi động lại" (Windows safe-fallback state)
// No banner, no modal: the button IS the progress indicator. Polling,
// reload-on-success and error toasts stay in UpdateCheck.tsx (headless,
// mounted once in App); state is shared via state/host-update-store.ts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { RemixIcon } from './RemixIcon';
import { checkHostUpdateStatus, startHostUpdate } from './UpdateCheck';
import { hostUpdatePercent, useHostUpdateState } from '../state/host-update-store';
import styles from './HostUpdateButton.module.css';

type CheckFace = 'idle' | 'checking' | 'latest' | 'error';
// How long the "Đã là bản mới nhất" / "Không kiểm tra được" answer stays on
// the button before it returns to the quiet "Kiểm tra cập nhật" face.
const CHECK_RESULT_TTL_MS = 4000;

export function hostUpdateCheckLabel(face: CheckFace, currentVersion: string | null): string {
  if (face === 'checking') return 'Đang kiểm tra…';
  if (face === 'latest') return currentVersion ? `Đã là bản mới nhất · v${currentVersion}` : 'Đã là bản mới nhất';
  if (face === 'error') return 'Không kiểm tra được';
  return 'Kiểm tra cập nhật';
}

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

  const [checkFace, setCheckFace] = useState<CheckFace>('idle');
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
  }, []);
  const runCheck = useCallback(async () => {
    if (checkFace === 'checking') return;
    if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
    setCheckFace('checking');
    setCheckMessage(null);
    const outcome = await checkHostUpdateStatus({ refresh: true });
    if (outcome.kind === 'update') {
      // The store now carries updateAvailable → this component re-renders
      // as the accent "Cập nhật vX" CTA; nothing else to show here.
      setCheckFace('idle');
      return;
    }
    setCheckFace(outcome.kind === 'latest' ? 'latest' : 'error');
    setCheckMessage(outcome.kind === 'error' ? outcome.message : null);
    resetTimerRef.current = window.setTimeout(() => {
      setCheckFace('idle');
      setCheckMessage(null);
      resetTimerRef.current = null;
    }, CHECK_RESULT_TTL_MS);
  }, [checkFace]);

  if (!status?.updateAvailable && !applying && !restartRequired) {
    // Nothing pending: offer an explicit check in the same slot, so the
    // user never has to wait for the 7-minute background poll (or reload)
    // to learn whether a release they were told about is visible yet.
    const label = hostUpdateCheckLabel(checkFace, status?.currentVersion ?? null);
    const title =
      checkFace === 'error'
        ? checkMessage ?? 'Không kiểm tra được bản mới — kiểm tra kết nối mạng rồi thử lại.'
        : checkFace === 'latest'
          ? `Đang chạy bản mới nhất v${status?.currentVersion ?? '…'}${status?.checkedAt ? ` (kiểm tra lúc ${new Date(status.checkedAt).toLocaleTimeString()})` : ''}.`
          : `Đang chạy v${status?.currentVersion ?? '…'}. Bấm để kiểm tra ngay xem có bản mới không.`;
    return (
      <button
        type="button"
        className={`${styles.button} ${styles.check}${checkFace === 'checking' ? ` ${styles.checking}` : ''}${checkFace === 'error' ? ` ${styles.checkError}` : ''}${checkFace === 'latest' ? ` ${styles.checkLatest}` : ''}`}
        disabled={checkFace === 'checking'}
        onClick={() => void runCheck()}
        title={title}
        aria-label={title}
        aria-busy={checkFace === 'checking' || undefined}
        data-testid="host-update-check-button"
        data-face={checkFace}
      >
        <span className={styles.icon} aria-hidden="true">
          <RemixIcon
            name={checkFace === 'latest' ? 'checkbox-circle-line' : checkFace === 'error' ? 'error-warning-line' : 'refresh-line'}
            size={14}
          />
        </span>
        <span className={styles.label}>{label}</span>
      </button>
    );
  }

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
      : `Có bản mới v${status?.latestVersion} (đang chạy v${status?.currentVersion}). Bấm để cập nhật: cài bản mới, khởi động lại, gỡ bản cũ — tự động.`;

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
