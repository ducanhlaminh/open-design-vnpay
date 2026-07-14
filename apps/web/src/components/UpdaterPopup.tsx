import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OpenDesignHostUpdaterStatusSnapshot } from '@open-design/host';

import { Icon } from './Icon';
import {
  checkForUpdaterUpdate,
  deriveUpdaterModel,
  openUpdaterInstaller,
  quitAfterUpdaterInstallerOpen,
  readUpdaterStatus,
  subscribeToUpdaterStatus,
  type UpdaterModel,
} from '../lib/updater';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { useAnalytics, useAppVersion } from '../analytics/provider';
import {
  trackUpdateIndicatorClick,
  trackUpdateIndicatorSurfaceView,
  trackUpdateInstallResult,
  trackUpdatePromptSurfaceView,
} from '../analytics/events';

const INSTALL_HANDOFF_WATCHDOG_MS = 10_000;

type InstallState = 'idle' | 'opening' | 'handoff' | 'recoverable';
// Terminal outcome of a user-triggered manual check. Live host progress
// (checking/downloading) is read from the model; this only records what to
// show once a check settles without producing an installable update.
type CheckPhase = 'idle' | 'checking' | 'uptodate' | 'error';
type Translator = (key: keyof Dict, vars?: Record<string, string | number>) => string;

function versionText(t: Translator, model: UpdaterModel): string {
  const version = model.availableVersion;
  return version == null ? t('updater.readyGeneric') : t('updater.readyVersion', { version });
}

function channelLabelFor(channel: string | null | undefined): string | null {
  switch (channel) {
    case 'beta':
      return 'Beta channel';
    case 'nightly':
      return 'Nightly channel';
    case 'preview':
      return 'Preview channel';
    case 'stable':
      return 'Stable channel';
    default:
      return null;
  }
}

function updateVersionProps(model: UpdaterModel, appVersionBefore: string | null) {
  return {
    ...(appVersionBefore ? { app_version_before: appVersionBefore } : {}),
    ...(model.availableVersion ? { app_version_after: model.availableVersion } : {}),
  };
}

function updaterErrorCode(model: UpdaterModel): string | undefined {
  return model.status?.error?.code;
}

export function UpdaterPopup() {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const actionInFlightRef = useRef(false);
  const checkInFlightRef = useRef(false);
  const handoffWatchdogRef = useRef<number | null>(null);
  const [model, setModel] = useState<UpdaterModel>(() => deriveUpdaterModel(null));
  const [panelOpen, setPanelOpen] = useState(false);
  const [installState, setInstallState] = useState<InstallState>('idle');
  const [checkPhase, setCheckPhase] = useState<CheckPhase>('idle');

  const clearHandoffWatchdog = useCallback(() => {
    if (handoffWatchdogRef.current == null) return;
    window.clearTimeout(handoffWatchdogRef.current);
    handoffWatchdogRef.current = null;
  }, []);

  const recoverFromInstallerHandoff = useCallback(() => {
    handoffWatchdogRef.current = null;
    actionInFlightRef.current = false;
    setInstallState('recoverable');
    setPanelOpen(true);
  }, []);

  const startHandoffWatchdog = useCallback(() => {
    clearHandoffWatchdog();
    // The quit IPC can resolve before Electron has actually torn down the
    // renderer. Keep the handoff UI up, but do not leave it stuck forever.
    handoffWatchdogRef.current = window.setTimeout(recoverFromInstallerHandoff, INSTALL_HANDOFF_WATCHDOG_MS);
  }, [clearHandoffWatchdog, recoverFromInstallerHandoff]);

  useEffect(() => clearHandoffWatchdog, [clearHandoffWatchdog]);

  useEffect(() => {
    let mounted = true;
    const applyStatus = (status: OpenDesignHostUpdaterStatusSnapshot) => {
      if (!mounted) return;
      setModel(deriveUpdaterModel(status, { hostAvailable: true }));
    };
    const unsubscribe = subscribeToUpdaterStatus(applyStatus);
    void readUpdaterStatus({ payload: { source: 'updater-indicator:mount' } }).then((result) => {
      if (!mounted) return;
      if (result.ok) {
        setModel(result.model);
      } else {
        setModel(deriveUpdaterModel(null, { hostAvailable: false }));
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const isDesktop = model.environment === 'desktop';
  const ready = isDesktop && model.shouldShowControl;
  const installBusy = installState === 'opening' || installState === 'handoff';
  const hostBusy = model.busy;
  const canStartInstall = ready || installState === 'recoverable';
  // Show the nav-rail control whenever the desktop updater is usable (so the
  // user can manually check), plus during an in-flight install handoff.
  const canShow = isDesktop && (model.enabled || ready || installState !== 'idle');
  const channelLabel = channelLabelFor(model.status?.channel);
  const analytics = useAnalytics();
  const appVersionBefore = useAppVersion();
  const versionProps = useMemo(
    () => updateVersionProps(model, appVersionBefore),
    [appVersionBefore, model.availableVersion],
  );

  // Once an installable update is ready, the ready UI takes over from any
  // lingering manual-check outcome.
  useEffect(() => {
    if (ready) setCheckPhase('idle');
  }, [ready]);

  const indicatorSurfaceKey = `${model.currentVersion ?? 'unknown'}->${model.availableVersion ?? 'unknown'}:${model.status?.downloadPath ?? 'unknown'}`;
  const lastIndicatorSurfaceKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) {
      lastIndicatorSurfaceKeyRef.current = null;
      return;
    }
    if (lastIndicatorSurfaceKeyRef.current === indicatorSurfaceKey) return;
    lastIndicatorSurfaceKeyRef.current = indicatorSurfaceKey;
    trackUpdateIndicatorSurfaceView(analytics.track, {
      page_name: 'home',
      area: 'update_indicator',
      ...versionProps,
    });
  }, [analytics.track, indicatorSurfaceKey, ready, versionProps]);

  const promptSurfaceKey = panelOpen ? indicatorSurfaceKey : null;
  const lastPromptSurfaceKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (promptSurfaceKey == null) {
      lastPromptSurfaceKeyRef.current = null;
      return;
    }
    if (lastPromptSurfaceKeyRef.current === promptSurfaceKey) return;
    lastPromptSurfaceKeyRef.current = promptSurfaceKey;
    trackUpdatePromptSurfaceView(analytics.track, {
      page_name: 'home',
      area: 'update_prompt',
      ...versionProps,
    });
  }, [analytics.track, promptSurfaceKey, versionProps]);

  const close = useCallback(() => {
    if (installBusy) return;
    trackUpdateIndicatorClick(analytics.track, {
      page_name: 'home',
      area: 'update_prompt',
      element: 'later',
      action: 'dismiss',
      ...versionProps,
    });
    setPanelOpen(false);
    setCheckPhase('idle');
  }, [analytics.track, installBusy, versionProps]);

  useEffect(() => {
    if (!panelOpen) return;
    const onDocClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!wrapRef.current?.contains(target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [close, panelOpen]);

  const runCheck = useCallback(async () => {
    if (checkInFlightRef.current || !model.canCheck) return;
    checkInFlightRef.current = true;
    setCheckPhase('checking');
    try {
      const result = await checkForUpdaterUpdate({ payload: { source: 'updater-check-button' } });
      if (!result.ok) {
        setCheckPhase('error');
        return;
      }
      setModel(result.model);
      // An installable update flips the ready effect; otherwise report the
      // terminal outcome so the popup can say "you're up to date".
      setCheckPhase(result.model.upToDate && !result.model.hasDownloadedInstaller ? 'uptodate' : 'idle');
    } catch {
      setCheckPhase('error');
    } finally {
      checkInFlightRef.current = false;
    }
  }, [model.canCheck]);

  const installAndQuit = async () => {
    if (actionInFlightRef.current || !canStartInstall) return;
    actionInFlightRef.current = true;
    clearHandoffWatchdog();
    setInstallState('opening');
    setPanelOpen(true);
    trackUpdateIndicatorClick(analytics.track, {
      page_name: 'home',
      area: 'update_prompt',
      element: 'install_update',
      action: 'install',
      ...versionProps,
    });
    try {
      const result = await openUpdaterInstaller({ payload: { source: 'updater-prompt' } });
      if (!result.ok) {
        actionInFlightRef.current = false;
        setInstallState('idle');
        trackUpdateInstallResult(analytics.track, {
          page_name: 'home',
          area: 'update_prompt',
          result: 'failed',
          error_code: result.reason,
          ...versionProps,
        });
        return;
      }
      if (result.model.errorMessage != null) {
        actionInFlightRef.current = false;
        setInstallState('idle');
        trackUpdateInstallResult(analytics.track, {
          page_name: 'home',
          area: 'update_prompt',
          result: 'failed',
          ...(updaterErrorCode(result.model) ? { error_code: updaterErrorCode(result.model) } : {}),
          ...versionProps,
        });
        return;
      }
      setModel(result.model);
      setInstallState('handoff');
      startHandoffWatchdog();
      trackUpdateInstallResult(analytics.track, {
        page_name: 'home',
        area: 'update_prompt',
        result: 'success',
        ...versionProps,
      });
      const quitResult = await quitAfterUpdaterInstallerOpen({ payload: { source: 'updater-prompt' } });
      if (!quitResult.ok) {
        clearHandoffWatchdog();
        actionInFlightRef.current = false;
        setInstallState('recoverable');
        setPanelOpen(true);
      }
    } catch (error) {
      clearHandoffWatchdog();
      actionInFlightRef.current = false;
      setInstallState('idle');
      trackUpdateInstallResult(analytics.track, {
        page_name: 'home',
        area: 'update_prompt',
        result: 'failed',
        error_code: error instanceof Error ? error.name : 'unknown',
        ...versionProps,
      });
    }
  };

  if (!canShow) return null;

  const downloadPercent = model.downloadProgress?.percent ?? null;
  const busyText =
    downloadPercent != null ? t('updater.downloadingPercent', { percent: downloadPercent }) : t('updater.checking');

  // Keep the install UI up through the whole install/handoff/recover cycle,
  // even after `installerOpened` flips `ready` false.
  const showInstallUi = ready || installState !== 'idle';

  // A single smart primary button: Check → (auto-download) → Install.
  let primaryLabel: string;
  let primaryDisabled: boolean;
  let primaryTestId: string;
  let primaryOnClick: (() => void) | undefined;
  if (showInstallUi) {
    primaryLabel = installBusy ? t('updater.opening') : t('updater.openInstaller');
    primaryDisabled = installBusy;
    primaryTestId = 'updater-install-button';
    primaryOnClick = () => {
      void installAndQuit();
    };
  } else if (hostBusy || checkPhase === 'checking') {
    primaryLabel = busyText;
    primaryDisabled = true;
    primaryTestId = 'updater-check-button';
    primaryOnClick = undefined;
  } else {
    primaryLabel = t('updater.checkForUpdates');
    primaryDisabled = !model.canCheck;
    primaryTestId = 'updater-check-button';
    primaryOnClick = () => {
      void runCheck();
    };
  }

  const popupTitle = showInstallUi ? t('updater.ready') : t('updater.checkForUpdates');
  let bodyText: string;
  if (showInstallUi) {
    bodyText = versionText(t, model);
  } else if (hostBusy || checkPhase === 'checking') {
    bodyText = busyText;
  } else if (checkPhase === 'uptodate') {
    bodyText = t('updater.upToDate');
  } else if (checkPhase === 'error') {
    bodyText = model.errorMessage ?? t('updater.failed');
  } else {
    bodyText = model.currentVersion ? `v${model.currentVersion}` : t('updater.checkForUpdates');
  }

  const controlLabel = showInstallUi ? t('updater.openInstaller') : t('updater.checkForUpdates');

  return (
    <div className="entry-updater-menu" ref={wrapRef}>
      <button
        aria-disabled={installBusy ? 'true' : undefined}
        aria-expanded={panelOpen}
        aria-label={controlLabel}
        className={`entry-nav-rail__btn entry-updater-menu__button${showInstallUi ? ' is-ready' : ''}${panelOpen ? ' is-active' : ''}${installBusy ? ' is-disabled' : ''}`}
        data-testid="entry-nav-updater"
        data-tooltip={controlLabel}
        title={controlLabel}
        type="button"
        onClick={() => {
          if (installBusy) return;
          if (panelOpen) {
            setPanelOpen(false);
            return;
          }
          if (showInstallUi) {
            trackUpdateIndicatorClick(analytics.track, {
              page_name: 'home',
              area: 'update_indicator',
              element: 'ready_indicator',
              action: 'open_prompt',
              ...versionProps,
            });
          }
          setPanelOpen(true);
        }}
      >
        <span className="entry-updater-menu__glyph">
          <Icon name="arrow-up" size={18} strokeWidth={2.25} />
        </span>
      </button>
      {panelOpen ? (
        <section
          aria-labelledby="updater-popup-title"
          className={`updater-popup${showInstallUi ? ' is-ready' : ''}`}
          data-testid="updater-popup"
          role="dialog"
        >
          <div className="updater-popup__icon">
            <Icon name="arrow-up" size={20} strokeWidth={2.2} />
          </div>
          <div className="updater-popup__body">
            <h2 id="updater-popup-title">{popupTitle}</h2>
            <p>{bodyText}</p>
            {channelLabel != null ? <span className="updater-popup__badge">{channelLabel}</span> : null}
          </div>
          <div className="updater-popup__actions">
            <button className="updater-popup__button" disabled={installBusy} type="button" onClick={close}>
              {t('updater.later')}
            </button>
            <button
              className="updater-popup__button updater-popup__button--primary"
              data-testid={primaryTestId}
              disabled={primaryDisabled}
              type="button"
              onClick={() => {
                primaryOnClick?.();
              }}
            >
              {primaryLabel}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
