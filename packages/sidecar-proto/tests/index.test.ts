import { describe, expect, it } from "vitest";

import {
  APP_KEYS,
  normalizeDaemonSidecarMessage,
  normalizeDesktopSidecarMessage,
  normalizeNamespace,
  normalizeSidecarStamp,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_MESSAGES,
  SIDECAR_SOURCES,
  SIDECAR_STAMP_FIELDS,
  STAMP_APP_FLAG,
  STAMP_IPC_FLAG,
  STAMP_MODE_FLAG,
  STAMP_NAMESPACE_FLAG,
  STAMP_SOURCE_FLAG,
  type DaemonStatusSnapshot,
} from "../src/index.js";

const validStamp = {
  app: APP_KEYS.WEB,
  ipc: "/tmp/open-design/ipc/contract-check/web.sock",
  mode: "dev" as const,
  namespace: "contract-check",
  source: SIDECAR_SOURCES.TOOLS_DEV,
};

describe("open-design sidecar contract", () => {
  it("exports the canonical five-field stamp descriptor", () => {
    expect(SIDECAR_STAMP_FIELDS).toEqual(["app", "mode", "namespace", "ipc", "source"]);
    expect(OPEN_DESIGN_SIDECAR_CONTRACT.stampFlags).toEqual({
      app: STAMP_APP_FLAG,
      ipc: STAMP_IPC_FLAG,
      mode: STAMP_MODE_FLAG,
      namespace: STAMP_NAMESPACE_FLAG,
      source: STAMP_SOURCE_FLAG,
    });
  });

  // WP5 (web-first migration): `SIDECAR_MESSAGES` used to also carry
  // CLICK/CONSOLE/EVAL/EXPORT_PDF/REGISTER_DESKTOP_AUTH/SCREENSHOT/UPDATE —
  // all desktop-app-only IPC verbs (`apps/desktop`, removed). STATUS and
  // SHUTDOWN are the only verbs left; daemon, web, and the still-supported
  // AppImage lifecycle in `tools/pack/src/linux.ts` all use them.
  it("exposes only the STATUS and SHUTDOWN sidecar messages", () => {
    expect(SIDECAR_MESSAGES).toEqual({ SHUTDOWN: "shutdown", STATUS: "status" });
  });

  it("accepts the explicit namespace contract", () => {
    expect(normalizeNamespace("contract-check_1.alpha")).toBe("contract-check_1.alpha");
  });

  it("rejects path-like or whitespace namespaces", () => {
    expect(() => normalizeNamespace("../other")).toThrow();
    expect(() => normalizeNamespace(" contract-check")).toThrow();
    expect(() => normalizeNamespace("contract check")).toThrow();
  });

  it("accepts exactly app, mode, namespace, ipc, and source", () => {
    expect(normalizeSidecarStamp(validStamp)).toEqual(validStamp);
  });

  it("rejects legacy or extra stamp fields", () => {
    expect(() => normalizeSidecarStamp({ ...validStamp, runtimeToken: "legacy" })).toThrow();
    expect(() => normalizeSidecarStamp({ ...validStamp, role: "web-sidecar" })).toThrow();
  });

  it("rejects non-contract sidecar sources", () => {
    expect(() => normalizeSidecarStamp({ ...validStamp, source: "custom-script" })).toThrow();
  });

  it("validates daemon IPC messages", () => {
    expect(normalizeDaemonSidecarMessage({ type: SIDECAR_MESSAGES.STATUS })).toEqual({ type: "status" });
    expect(normalizeDaemonSidecarMessage({ type: SIDECAR_MESSAGES.SHUTDOWN })).toEqual({ type: "shutdown" });
    expect(() => normalizeDaemonSidecarMessage({ input: {}, type: "eval" })).toThrow();
  });

  it("rejects unknown daemon/web/desktop message types", () => {
    expect(() => normalizeDaemonSidecarMessage({ type: "register-desktop-auth" })).toThrow();
    expect(() => normalizeDesktopSidecarMessage({ type: "eval" })).toThrow();
    expect(() => normalizeDesktopSidecarMessage({ input: {}, type: "export-pdf" })).toThrow();
  });

  it("validates desktop IPC status/shutdown messages", () => {
    expect(normalizeDesktopSidecarMessage({ type: SIDECAR_MESSAGES.STATUS })).toEqual({ type: "status" });
    expect(normalizeDesktopSidecarMessage({ type: SIDECAR_MESSAGES.SHUTDOWN })).toEqual({ type: "shutdown" });
    expect(() => normalizeDesktopSidecarMessage({ extra: true, type: SIDECAR_MESSAGES.STATUS })).toThrow();
  });

  it("no longer carries desktopAuthGateActive on DaemonStatusSnapshot", () => {
    // WP5 (web-first migration): `desktopAuthGateActive` gated
    // `/api/import/folder` on a secret registered by the (now removed)
    // desktop main process over REGISTER_DESKTOP_AUTH. With no desktop app
    // left to register it, the field was removed from the type entirely —
    // this test pins that DaemonStatusSnapshot compiles without it.
    const snapshot: DaemonStatusSnapshot = {
      state: "running",
      url: "http://127.0.0.1:7456",
    };
    expect(snapshot.url).toBe("http://127.0.0.1:7456");
  });
});
