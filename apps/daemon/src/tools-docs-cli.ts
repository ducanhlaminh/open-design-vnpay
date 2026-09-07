// `od tools docs search` — CLI wrapper around `POST /api/docs/search` (see
// `docs-embed-routes.ts`). Mirrors `tools-figma-cli.ts`'s shape; helpers
// below are deliberately copied rather than imported so this file and that
// one stay independently ownable.
type JsonObject = Record<string, unknown>;

interface ToolCliResult {
  exitCode: number;
}

type DocsSearchScope = 'feature' | 'app' | 'both';

interface ParsedOptions {
  command: string | undefined;
  query?: string;
  scope: DocsSearchScope;
  limit: number;
  project?: string;
  help: boolean;
}

/** Mặc định 5 — vì luật là ĐỌC HẾT danh sách trả về. Đo trên pool thật: chênh
 *  điểm giữa hạng 1 và hạng 5 chỉ 0.019–0.047 (trong khi "đúng chủ đề" vs "lạc
 *  chủ đề" cách nhau ~0.2), nên thứ hạng trong nhóm đầu là nhiễu. Để 8 thì
 *  "đọc hết" thành khẩu hiệu suông, agent tự bỏ bớt theo điểm. */
export const DOCS_SEARCH_DEFAULT_LIMIT = 5;
const DEFAULT_LIMIT = DOCS_SEARCH_DEFAULT_LIMIT;
const HTTP_TIMEOUT_MS = 300_000;

export const DOCS_TOOLS_USAGE = `Usage:
  od tools docs search "<câu hỏi>" [--scope feature|app|both] [--limit 5] [--project <id>]

Tìm tài liệu docs-review THEO NGỮ NGHĨA (embedding local qua Ollama). Hỏi
bằng câu tiếng Việt đầy đủ; lệnh trả về các dòng
  <path>:<line> | <breadcrumb> | <score> | <scope>
xếp theo độ liên quan — MỞ đúng dòng đó và đọc nguyên văn trước khi dùng.
ĐỌC CẢ danh sách, đừng chỉ lấy dòng đầu: chênh điểm giữa hạng 1 và hạng cuối
chỉ ~0.02 nên thứ hạng trong nhóm đầu KHÔNG đáng tin, và điểm KHÔNG nói lên
đúng/sai (đã gặp câu sai 0.694 và câu đúng 0.604). Căn cứ là đoạn đã đọc:
không đoạn nào nói điều bạn cần → ghi "chưa xác định được", đừng suy từ tên
trang hay từ điểm. Hỏi bằng CÂU ĐẦY ĐỦ, đừng ghép chuỗi từ khoá kiểu tên tài
liệu (câu từ khoá bị chấm điểm thấp giả).
Chạy lệnh này TRƯỚC rg/grep khi cần thông tin ngoài trang đang đọc: nó bắt
được cả cách diễn đạt khác (đồng nghĩa, không dấu) mà grep trượt.
Chưa bật tìm ngữ nghĩa (Ollama tắt) thì lệnh in hướng dẫn grep _sections.md
thay thế và thoát mã 0 (không chặn stage).

Environment:
  OD_NODE_BIN     Node-compatible runtime for agent wrapper invocations
  OD_BIN          Open Design CLI script for agent wrapper invocations
  OD_DAEMON_URL   Daemon base URL injected into agent runs
  OD_TOOL_TOKEN   Bearer token injected into agent runs
  OD_PROJECT_ID   Project id injected into agent runs (default for --project)

Agent runtime invocation:
  "$OD_NODE_BIN" "$OD_BIN" tools docs search "khách hàng quên mã PIN soft OTP thì làm gì"
`;

function writeJson(value: unknown, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string, details?: unknown): ToolCliResult {
  writeJson({ ok: false, error: { message, ...(details === undefined ? {} : { details }) } }, process.stderr);
  return { exitCode: 1 };
}

function parseOptions(args: string[]): ParsedOptions | { error: string } {
  const [command, ...rest] = args;
  const options: ParsedOptions = {
    command: command === '-h' || command === '--help' ? undefined : command,
    scope: 'both',
    limit: DEFAULT_LIMIT,
    help: command === '-h' || command === '--help',
  };

  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--scope') {
      const value = rest[++index];
      if (value !== 'feature' && value !== 'app' && value !== 'both') {
        return { error: '--scope must be feature, app, or both' };
      }
      options.scope = value;
    } else if (arg === '--limit') {
      const value = rest[++index];
      const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) return { error: '--limit must be a positive integer' };
      options.limit = Math.min(parsed, 20);
    } else if (arg === '--project') {
      const value = rest[++index];
      if (!value) return { error: '--project requires a project id' };
      options.project = value;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg?.startsWith('--')) {
      return { error: `unknown option: ${arg}` };
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }

  if (positionals.length > 0) options.query = positionals.join(' ');
  return options;
}

function daemonUrl(): URL | { error: string } {
  const rawUrl = process.env.OD_DAEMON_URL;
  if (!rawUrl) return { error: 'OD_DAEMON_URL is required' };
  try {
    const url = new URL(rawUrl);
    url.pathname = url.pathname.replace(/\/+$/u, '');
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return { error: 'OD_DAEMON_URL must be a valid URL' };
  }
}

function toolToken(): string | { error: string } {
  const token = process.env.OD_TOOL_TOKEN;
  if (!token) return { error: 'OD_TOOL_TOKEN is required' };
  return token;
}

function endpoint(baseUrl: URL, pathname: string): string {
  const url = new URL(baseUrl.toString());
  url.pathname = `${url.pathname}${pathname}`.replace(/\/+/gu, '/');
  return url.toString();
}

async function requestJson(baseUrl: URL, token: string, pathname: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(endpoint(baseUrl, pathname), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { message: text };
    }
  }
  return { status: response.status, body };
}

function normalizeCliError(body: unknown): JsonObject {
  const rawError = body && typeof body === 'object' && 'error' in body ? (body as JsonObject).error : body;
  if (typeof rawError === 'string') return { message: rawError };
  if (!rawError || typeof rawError !== 'object') return { message: String(rawError ?? 'request failed') };
  const error = rawError as JsonObject;
  return {
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    message: typeof error.message === 'string' ? error.message : String(error.error ?? 'request failed'),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

/** Format một dòng kết quả khớp khuôn `_sections.md` — agent quen mắt:
 *  `<path>:<line> | <breadcrumb> | <score 3 chữ số> | <scope>`. */
function formatResultLine(result: JsonObject): string {
  const p = typeof result.path === 'string' ? result.path : '';
  const line = typeof result.line === 'number' ? result.line : '';
  const crumb = typeof result.crumb === 'string' ? result.crumb : '';
  const score = typeof result.score === 'number' ? result.score.toFixed(3) : '';
  const scope = typeof result.scope === 'string' ? result.scope : '';
  return `${p}:${line} | ${crumb} | ${score} | ${scope}`;
}

async function printSearchResult(response: { status: number; body: unknown }): Promise<ToolCliResult> {
  if (response.status === 503) {
    // Chưa bật tìm ngữ nghĩa — báo + hướng dẫn grep, KHÔNG được chặn stage.
    process.stdout.write('Tìm ngữ nghĩa chưa sẵn sàng (Ollama chưa bật hoặc chưa có model).\n');
    process.stdout.write('Dùng thay: grep -i "<không dấu>" docs-feature/_sections.md\n');
    return { exitCode: 0 };
  }
  if (response.status < 200 || response.status >= 300) {
    writeJson({ ok: false, status: response.status, error: normalizeCliError(response.body) }, process.stderr);
    return { exitCode: 1 };
  }

  const body = response.body && typeof response.body === 'object' ? (response.body as JsonObject) : {};
  const results = Array.isArray(body.results) ? (body.results as JsonObject[]) : [];
  if (results.length === 0) {
    process.stdout.write('(không có kết quả)\n');
    return { exitCode: 0 };
  }
  for (const result of results) {
    process.stdout.write(`${formatResultLine(result)}\n`);
  }
  return { exitCode: 0 };
}

export async function runDocsToolCli(args: string[]): Promise<ToolCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error);
  if (options.help || !options.command) {
    process.stdout.write(DOCS_TOOLS_USAGE);
    return { exitCode: options.command ? 0 : 1 };
  }

  if (options.command !== 'search') {
    return fail(`unknown docs command: ${options.command}`);
  }

  const baseUrl = daemonUrl();
  if ('error' in baseUrl) return fail(baseUrl.error);
  const token = toolToken();
  if (typeof token !== 'string') return fail(token.error);

  if (!options.query) return fail('search requires "<câu hỏi>"');
  const projectId = options.project || process.env.OD_PROJECT_ID;
  if (!projectId) {
    return fail('project id required. Pass --project <id> or set OD_PROJECT_ID. The daemon injects this when it spawns the code agent.');
  }

  return printSearchResult(
    await requestJson(baseUrl, token, '/api/docs/search', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        scope: options.scope,
        query: options.query,
        limit: options.limit,
      }),
    }),
  );
}
