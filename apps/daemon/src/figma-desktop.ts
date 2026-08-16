// Figma Desktop Dev Mode MCP client for the dr-comp "get design context"
// drill-down.
//
// The Figma Desktop app ships a local Dev Mode MCP server
// (`http://127.0.0.1:3845/mcp`, Streamable HTTP, no token) whose tools
// (`get_design_context`, `get_metadata`, `get_screenshot`, …) only accept a
// `nodeId` — they always read whichever file is currently *active* in the
// Figma Desktop app. This module owns two things:
//   1. the Streamable HTTP session handshake + `tools/call` plumbing
//      (initialize → `mcp-session-id` header → JSON or SSE responses), and
//   2. "make sure the right file is active" (`ensureActiveFile`), using the
//      `figma://file/<key>` URL scheme to switch files and native
//      window-title probing (`osascript` / `powershell`) to confirm it.
//
// No SDK, no npm dependency — the handshake is small enough to hand-roll and
// much easier to fake in tests than a full MCP client. Every dependency
// (fetch, exec, sleep, clock, platform) is injectable so callers can run the
// whole module against fakes.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const FIGMA_DESKTOP_MCP_URL = 'http://127.0.0.1:3845/mcp';
export const FIGMA_DESKTOP_SWITCH_TIMEOUT_MS = 20_000;

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_INIT_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 1_000;
const UNKNOWN_STATE_GRACE_MS = 3_000;

export type FigmaDesktopErrorKind =
  | 'unavailable' // ECONNREFUSED / timeout khi initialize → Figma Desktop chưa chạy hoặc chưa bật MCP
  | 'switch_timeout' // đã open figma:// nhưng quá timeout vẫn không thấy đúng file
  | 'switch_unsupported' // không có cách chuyển file trên platform này (không phải darwin/win32)
  | 'tool_error' // MCP trả isError=true (vd nodeId không tồn tại trong file đang mở)
  | 'protocol'; // response không parse được / thiếu session

export class FigmaDesktopError extends Error {
  readonly kind: FigmaDesktopErrorKind;
  constructor(kind: FigmaDesktopErrorKind, message: string) {
    super(message);
    this.name = 'FigmaDesktopError';
    this.kind = kind;
  }
}

/** Thông điệp tiếng Việt cho từng kind — WP2 dùng để trả về agent/UI. */
export function describeFigmaDesktopError(err: unknown): string {
  if (err instanceof FigmaDesktopError) {
    switch (err.kind) {
      case 'unavailable':
        return 'Figma Desktop chưa chạy hoặc chưa bật Dev Mode MCP server (Figma → Preferences → Enable Dev Mode MCP server).';
      case 'switch_timeout':
        return err.message;
      case 'switch_unsupported':
        return 'Không tự chuyển file Figma được trên hệ điều hành này — hãy mở file trong Figma Desktop rồi thử lại.';
      case 'tool_error':
      case 'protocol':
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export interface FigmaDesktopDeps {
  fetch?: typeof fetch;
  baseUrl?: string; // default FIGMA_DESKTOP_MCP_URL
  requestTimeoutMs?: number; // default 30_000 cho tools/call, 3_000 cho probe/initialize
  /** chạy lệnh ngoài (open/osascript/cmd). Default: child_process.execFile promisified. */
  exec?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  platform?: NodeJS.Platform; // default process.platform
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface FigmaDesktopToolResult {
  text: string; // ghép mọi content[].type==='text' bằng '\n'
  images: Array<{ mimeType: string; data: string }>; // content[].type==='image' (base64)
}

export interface FigmaDesktopFileExpectation {
  fileKey: string;
  name?: string; // tên file (từ catalog REST) — gate chính bằng tên cửa sổ
  probeNodeId?: string; // nodeId có thật trong file (vd component đầu tiên của catalog)
  probeName?: string; // tên node đó — gate phụ khi không đọc được tên cửa sổ
}

/** Internal-only signal: the current MCP session id is no longer valid on
 *  the server (Figma Desktop restarted, session expired, …). Caught by
 *  `callTool`, which re-initializes exactly once — never surfaced to callers. */
class SessionExpiredSignal extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const execFileAsync = promisify(execFile);

async function defaultExec(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, { windowsHide: true, encoding: 'utf8' });
  return { stdout, stderr };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** So khớp tên cửa sổ với tên file: trim, bỏ khoảng trắng thừa, so sánh không
 *  phân biệt hoa thường; cửa sổ có thể có hậu tố/tiền tố (vd " – Figma") nên
 *  dùng includes hai chiều. */
export function windowTitleMatchesFile(
  title: string | null | undefined,
  name: string | null | undefined,
): boolean {
  const normalize = (value: string | null | undefined): string =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
  const normalizedTitle = normalize(title);
  const normalizedName = normalize(name);
  if (!normalizedTitle || !normalizedName) return false;
  return normalizedTitle.includes(normalizedName) || normalizedName.includes(normalizedTitle);
}

export class FigmaDesktopClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly execFn: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly callTimeoutMs: number;
  private readonly initTimeoutMs: number;

  private sessionId: string | null = null;
  private idCounter = 0;

  constructor(deps: FigmaDesktopDeps = {}) {
    this.baseUrl = deps.baseUrl ?? FIGMA_DESKTOP_MCP_URL;
    this.doFetch = deps.fetch ?? fetch;
    this.execFn = deps.exec ?? defaultExec;
    this.sleepFn = deps.sleep ?? defaultSleep;
    this.nowFn = deps.now ?? Date.now;
    this.platform = deps.platform ?? process.platform;
    this.callTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.initTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private toUnavailable(err: unknown): FigmaDesktopError {
    if (err instanceof FigmaDesktopError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new FigmaDesktopError('unavailable', `Không kết nối được tới Figma Desktop MCP: ${message}`);
  }

  private async postJson(body: unknown, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    try {
      return await this.doFetch(this.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async initializeSession(): Promise<void> {
    const id = this.nextId();
    let res: Response;
    try {
      res = await this.postJson(
        {
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'open-design', version: '1' },
          },
        },
        this.initTimeoutMs,
      );
    } catch (err) {
      throw this.toUnavailable(err);
    }
    if (!res.ok) {
      throw new FigmaDesktopError('protocol', `Figma Desktop MCP trả lỗi khi khởi tạo phiên (HTTP ${res.status}).`);
    }
    const sessionId = res.headers.get('mcp-session-id');
    if (!sessionId) {
      throw new FigmaDesktopError('protocol', 'Không nhận được mcp-session-id từ Figma Desktop MCP.');
    }
    this.sessionId = sessionId;
    // Notification (no `id`) — fire-and-forget, ignore the outcome entirely.
    this.postJson({ jsonrpc: '2.0', method: 'notifications/initialized' }, this.initTimeoutMs).catch(() => {});
  }

  private parseSse(text: string, id: number): unknown {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const jsonPart = trimmed.slice('data:'.length).trim();
      if (!jsonPart) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonPart);
      } catch {
        continue;
      }
      if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).id === id) {
        return parsed;
      }
    }
    throw new FigmaDesktopError('protocol', 'Không tìm thấy phản hồi khớp id trong luồng SSE của Figma Desktop MCP.');
  }

  private async parseResponse(res: Response, id: number): Promise<unknown> {
    if (res.status === 404 || res.status === 400) {
      const text = await res.text().catch(() => '');
      if (/session/i.test(text)) throw new SessionExpiredSignal(text);
      throw new FigmaDesktopError('protocol', `HTTP ${res.status}: ${text.slice(0, 300) || 'lỗi không rõ'}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new FigmaDesktopError('protocol', `HTTP ${res.status}: ${text.slice(0, 300) || 'lỗi không rõ'}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    let message: unknown;
    try {
      message = contentType.includes('text/event-stream') ? this.parseSse(raw, id) : JSON.parse(raw);
    } catch (err) {
      if (err instanceof FigmaDesktopError) throw err;
      throw new FigmaDesktopError('protocol', 'Không đọc được phản hồi từ Figma Desktop MCP.');
    }
    const msg = record(message);
    if (!msg) throw new FigmaDesktopError('protocol', 'Không đọc được phản hồi từ Figma Desktop MCP.');
    const errorField = record(msg.error);
    if (errorField) {
      throw new FigmaDesktopError(
        'protocol',
        typeof errorField.message === 'string' ? errorField.message : 'Figma Desktop MCP trả lỗi.',
      );
    }
    return msg.result;
  }

  private async call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.sessionId) await this.initializeSession();
    const id = this.nextId();
    let res: Response;
    try {
      res = await this.postJson({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    } catch (err) {
      throw this.toUnavailable(err);
    }
    return this.parseResponse(res, id);
  }

  /** initialize (+ notifications/initialized) + tools/list. Không ném; ok=false kèm detail VN. */
  async probe(): Promise<{ ok: boolean; detail?: string; tools?: string[] }> {
    try {
      const result = record(await this.call('tools/list', {}, this.initTimeoutMs));
      const toolsField = result ? result.tools : undefined;
      const rawTools = Array.isArray(toolsField) ? toolsField : [];
      const tools = rawTools
        .map((entry) => record(entry)?.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
      return { ok: true, tools };
    } catch (err) {
      return { ok: false, detail: describeFigmaDesktopError(err) };
    }
  }

  private toToolResult(result: unknown): FigmaDesktopToolResult {
    const body = record(result) ?? {};
    const items = Array.isArray(body.content) ? body.content : [];
    const texts: string[] = [];
    const images: Array<{ mimeType: string; data: string }> = [];
    for (const raw of items) {
      const item = record(raw);
      if (!item) continue;
      if (item.type === 'text' && typeof item.text === 'string') {
        texts.push(item.text);
      } else if (item.type === 'image' && typeof item.data === 'string') {
        images.push({ mimeType: typeof item.mimeType === 'string' ? item.mimeType : 'image/png', data: item.data });
      }
    }
    if (body.isError === true) {
      throw new FigmaDesktopError('tool_error', texts[0] || 'Figma trả lỗi');
    }
    return { text: texts.join('\n'), images };
  }

  /** tools/call. Tự initialize khi chưa có session; nếu server trả 404/400 "session" thì
   *  re-initialize đúng 1 lần rồi gọi lại. Ném FigmaDesktopError. */
  async callTool(name: string, args: Record<string, unknown>): Promise<FigmaDesktopToolResult> {
    const invoke = () => this.call('tools/call', { name, arguments: args }, this.callTimeoutMs);
    let result: unknown;
    try {
      result = await invoke();
    } catch (err) {
      if (!(err instanceof SessionExpiredSignal)) throw err;
      this.sessionId = null;
      await this.initializeSession();
      try {
        result = await invoke();
      } catch (err2) {
        if (err2 instanceof SessionExpiredSignal) {
          throw new FigmaDesktopError('protocol', 'Figma Desktop MCP liên tục báo mất phiên làm việc.');
        }
        throw err2;
      }
    }
    return this.toToolResult(result);
  }

  /** Tên cửa sổ Figma đang active. darwin: osascript System Events (lấy phần tử đầu);
   *  win32: `powershell -NoProfile -Command "(Get-Process Figma | ? MainWindowTitle | select -First 1).MainWindowTitle"`;
   *  khác / lỗi / không có quyền → null (KHÔNG ném). */
  async activeFileTitle(): Promise<string | null> {
    try {
      if (this.platform === 'darwin') {
        const { stdout } = await this.execFn('osascript', [
          '-e',
          'tell application "System Events" to get name of every window of process "Figma"',
        ]);
        const first = stdout.split(',')[0]?.trim();
        return first ? first : null;
      }
      if (this.platform === 'win32') {
        const { stdout } = await this.execFn('powershell', [
          '-NoProfile',
          '-Command',
          '(Get-Process Figma | ? MainWindowTitle | select -First 1).MainWindowTitle',
        ]);
        const trimmed = stdout.trim();
        return trimmed ? trimmed : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async checkActive(
    expect: FigmaDesktopFileExpectation,
  ): Promise<{ state: boolean | 'unknown'; title: string | null }> {
    if (expect.name) {
      const title = await this.activeFileTitle();
      if (title !== null) {
        return { state: windowTitleMatchesFile(title, expect.name), title };
      }
    }
    if (expect.probeNodeId) {
      try {
        const result = await this.callTool('get_metadata', {
          nodeId: expect.probeNodeId,
          clientLanguages: 'unknown',
          clientFrameworks: 'unknown',
        });
        if (!expect.probeName) return { state: true, title: null };
        const unescaped = result.text.replace(/&quot;/g, '"');
        return { state: unescaped.includes(`name="${expect.probeName}"`), title: null };
      } catch (err) {
        if (err instanceof FigmaDesktopError && err.kind === 'tool_error') {
          return { state: false, title: null };
        }
        throw err;
      }
    }
    return { state: 'unknown', title: null };
  }

  /** Đảm bảo Figma Desktop đang active đúng file. Trả 'already' | 'switched'.
   *  Ném FigmaDesktopError('switch_timeout' | 'switch_unsupported' | 'unavailable'). */
  async ensureActiveFile(
    expect: FigmaDesktopFileExpectation,
    timeoutMs = FIGMA_DESKTOP_SWITCH_TIMEOUT_MS,
  ): Promise<'already' | 'switched'> {
    const first = await this.checkActive(expect);
    if (first.state === true) return 'already';

    if (this.platform === 'darwin') {
      await this.execFn('open', [`figma://file/${expect.fileKey}`]);
    } else if (this.platform === 'win32') {
      await this.execFn('cmd', ['/c', 'start', '', `figma://file/${expect.fileKey}`]);
    } else {
      throw new FigmaDesktopError(
        'switch_unsupported',
        'Không tự chuyển file Figma được trên hệ điều hành này — hãy mở file trong Figma Desktop rồi thử lại.',
      );
    }

    if (first.state === 'unknown') {
      // Neither a window title nor a probe node to check against — best
      // effort: give Figma Desktop a moment to switch and call it done.
      await this.sleepFn(UNKNOWN_STATE_GRACE_MS);
      return 'switched';
    }

    const start = this.nowFn();
    let lastTitle = first.title;
    while (this.nowFn() - start < timeoutMs) {
      await this.sleepFn(POLL_INTERVAL_MS);
      const check = await this.checkActive(expect);
      if (check.title !== null) lastTitle = check.title;
      if (check.state === true) return 'switched';
    }
    const expectedLabel = expect.name ?? expect.fileKey;
    const seenLabel = lastTitle ? `"${lastTitle}"` : 'không xác định được';
    throw new FigmaDesktopError(
      'switch_timeout',
      `Hết thời gian chờ Figma Desktop mở file "${expectedLabel}" (fileKey ${expect.fileKey}) — cửa sổ hiện đang thấy: ${seenLabel}.`,
    );
  }
}
