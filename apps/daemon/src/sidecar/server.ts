import {
  SIDECAR_ENV,
  SIDECAR_MESSAGES,
  normalizeDaemonSidecarMessage,
  type DaemonStatusSnapshot,
  type SidecarStamp,
} from "@open-design/sidecar-proto";
import {
  createJsonIpcServer,
  type JsonIpcServerHandle,
  type SidecarRuntimeContext,
} from "@open-design/sidecar";

import { startDaemonRuntime, type StartedDaemonRuntime } from "../daemon-startup.js";

const DAEMON_PORT_ENV = SIDECAR_ENV.DAEMON_PORT;
const WEB_PORT_ENV = SIDECAR_ENV.WEB_PORT;
const TOOLS_DEV_PARENT_PID_ENV = SIDECAR_ENV.TOOLS_DEV_PARENT_PID;

export type DaemonSidecarHandle = {
  status(): Promise<DaemonStatusSnapshot>;
  stop(): Promise<void>;
  waitUntilStopped(): Promise<void>;
};

function parsePort(value: string | undefined): number {
  if (value == null || value.trim().length === 0) return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${DAEMON_PORT_ENV} must be an integer between 0 and 65535`);
  }
  return port;
}

function parseOptionalTrustedWebPort(value: string | undefined): number | null {
  const port = parsePort(value);
  return port > 0 ? port : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function attachParentMonitor(stop: () => Promise<void>): void {
  const parentPid = Number(process.env[TOOLS_DEV_PARENT_PID_ENV]);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;

  const timer = setInterval(() => {
    if (isProcessAlive(parentPid)) return;
    clearInterval(timer);
    void stop().finally(() => process.exit(0));
  }, 1000);
  timer.unref();
}

// WP5 (web-first migration): this sidecar used to also forward a
// `desktopPdfExporter` closure into `startDaemonRuntime` (which called out
// over EXPORT_PDF IPC to `apps/desktop`), track a live `desktopAuthGateActive`
// flag overlaid onto every STATUS response via `withCurrentDesktopAuthGate`,
// and handle a REGISTER_DESKTOP_AUTH IPC message that let the desktop main
// process register its per-request HMAC secret. All three existed only to
// support `apps/desktop`, which is gone, so they were removed along with the
// sidecar-proto verbs/fields backing them (EXPORT_PDF,
// REGISTER_DESKTOP_AUTH, `DaemonStatusSnapshot.desktopAuthGateActive`).
export async function startDaemonSidecar(runtime: SidecarRuntimeContext<SidecarStamp>): Promise<DaemonSidecarHandle> {
  const serverHandle: StartedDaemonRuntime = await startDaemonRuntime({
    port: parsePort(process.env[DAEMON_PORT_ENV]),
    runtime,
  });

  const state: DaemonStatusSnapshot = {
    pid: process.pid,
    state: "running",
    trustedWebOriginPort: parseOptionalTrustedWebPort(process.env[WEB_PORT_ENV]),
    updatedAt: new Date().toISOString(),
    url: serverHandle.url,
  };
  let ipcServer: JsonIpcServerHandle | null = null;
  let stopped = false;
  let resolveStopped!: () => void;
  const stoppedPromise = new Promise<void>((resolveStop) => {
    resolveStopped = resolveStop;
  });

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    state.state = "stopped";
    state.updatedAt = new Date().toISOString();
    await ipcServer?.close().catch(() => undefined);
    await serverHandle.stop().catch(() => undefined);
    resolveStopped();
  }

  attachParentMonitor(stop);

  ipcServer = await createJsonIpcServer({
    socketPath: runtime.ipc,
    handler: async (message: unknown) => {
      const request = normalizeDaemonSidecarMessage(message);
      switch (request.type) {
        case SIDECAR_MESSAGES.STATUS:
          return state;
        case SIDECAR_MESSAGES.SHUTDOWN:
          setImmediate(() => {
            void stop().finally(() => process.exit(0));
          });
          return { accepted: true };
      }
    },
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stop().finally(() => process.exit(0));
    });
  }

  return {
    async status() {
      return state;
    },
    stop,
    waitUntilStopped() {
      return stoppedPromise;
    },
  };
}
