import readline from 'node:readline';

type JsonObject = Record<string, unknown>;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

interface McpServerResult {
  exitCode: number;
}

const MAX_OUTPUT_BYTES = 256 * 1024;

const PROJECT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId'],
  properties: { projectId: { type: 'string', minLength: 1 } },
} satisfies JsonObject;

export function createOverviewMcpTools(): McpTool[] {
  return [
    {
      name: 'overview_summary',
      description: 'Read-only lookup of App/Feature progress in the Overview workspace. Returns the complete summary. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" mcp overview`.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      name: 'feature_outputs_list',
      description: 'Read-only lookup of output paths for an App/Feature project in the Overview workspace. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" files list --project <projectId>`.',
      inputSchema: PROJECT_INPUT_SCHEMA,
    },
    {
      name: 'feature_output_read',
      description: 'Read one textual output from an App/Feature project in the Overview workspace; never writes. Binary files, traversal paths, and content over 256 KB are rejected or truncated. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" files read --project <projectId> --path <path>`.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['projectId', 'path'],
        properties: {
          projectId: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1 },
        },
      },
    },
  ];
}

function daemonUrl(): URL {
  const rawUrl = process.env.OD_DAEMON_URL;
  if (!rawUrl) throw new Error('OD_DAEMON_URL is required');
  const url = new URL(rawUrl);
  url.pathname = url.pathname.replace(/\/+$/u, '');
  url.search = '';
  url.hash = '';
  return url;
}

function endpoint(baseUrl: URL, pathname: string): string {
  const url = new URL(baseUrl.toString());
  const [pathPart, searchPart] = pathname.split('?');
  url.pathname = `${url.pathname}${pathPart ?? ''}`.replace(/\/+/gu, '/');
  url.search = searchPart === undefined ? '' : `?${searchPart}`;
  return url.toString();
}

async function request(pathname: string): Promise<Response> {
  const response = await fetch(endpoint(daemonUrl(), pathname), {
    method: 'GET',
    headers: { Accept: 'application/json, text/plain, text/*' },
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`overview endpoint failed with ${response.status}`);
    (error as Error & { details?: string }).details = body;
    throw error;
  }
  return response;
}

function encodedPath(path: string): string {
  if (path.includes('..')) throw new Error('path traversal is not allowed');
  if (path.startsWith('/')) throw new Error('absolute paths are not allowed');
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function isTextualContentType(contentType: string): boolean {
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json') || mime === 'application/xml' || mime.endsWith('+xml') || mime === 'application/javascript' || mime === 'application/typescript';
}

/* Đọc body theo stream và DỪNG TẢI ngay khi vượt cap — `arrayBuffer()` sẽ kéo
   trọn file (một output 500 MB vẫn bị nạp hết vào RAM rồi mới cắt). */
async function readBodyCapped(response: Response, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes: bytes.subarray(0, cap), truncated: bytes.byteLength > cap };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total <= cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
    }
    if (total > cap) truncated = true;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= joined.byteLength) break;
    joined.set(chunk.subarray(0, joined.byteLength - offset), offset);
    offset += chunk.byteLength;
  }
  return { bytes: joined, truncated };
}

async function readTextOutput(projectId: string, path: string): Promise<JsonObject> {
  // Chốt phạm vi TRƯỚC khi chạm route raw: /api/overview/outputs chỉ chấp
  // nhận project feature pipeline (daemon trả 403 cho mọi loại khác) và trả
  // danh sách path hợp lệ — path xin đọc phải nằm trong danh sách đó. Nhờ
  // vậy tool này không thể bị dùng làm cửa đọc file của project chat thường,
  // ds-criteria/ds-rules hay chính project overview.
  const listing = (await (
    await request(`/api/overview/outputs?projectId=${encodeURIComponent(projectId)}`)
  ).json()) as { paths?: unknown };
  const allowed = Array.isArray(listing.paths) ? listing.paths : [];
  if (!allowed.includes(path)) {
    throw new Error('path is not a pipeline output of this feature (see feature_outputs_list)');
  }
  const response = await request(`/api/projects/${encodeURIComponent(projectId)}/raw/${encodedPath(path)}`);
  const contentType = response.headers.get('content-type') ?? '';
  const { bytes, truncated } = await readBodyCapped(response, MAX_OUTPUT_BYTES);
  const sample = bytes.subarray(0, 8192);
  if ((contentType && !isTextualContentType(contentType)) || sample.includes(0)) {
    throw new Error('binary output is not supported');
  }
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Cắt ở cap có thể chém đôi một ký tự đa byte — file text hợp lệ vẫn làm
    // fatal decoder nổ. Khi đã truncated thì decode khoan dung; chỉ file
    // KHÔNG bị cắt mà vẫn lỗi mới đúng là binary.
    if (!truncated) throw new Error('binary output is not supported');
    content = new TextDecoder('utf-8').decode(bytes);
  }
  return { projectId, path, content: truncated ? `${content}\n\n[đã cắt ở 256 KB]` : content, truncated };
}

async function callTool(name: string, args: JsonObject): Promise<unknown> {
  if (name === 'overview_summary') return await (await request('/api/overview/summary')).json();
  if (name === 'feature_outputs_list') {
    const projectId = typeof args.projectId === 'string' ? args.projectId : '';
    if (!projectId) throw new Error('projectId is required');
    return await (await request(`/api/overview/outputs?projectId=${encodeURIComponent(projectId)}`)).json();
  }
  if (name === 'feature_output_read') {
    const projectId = typeof args.projectId === 'string' ? args.projectId : '';
    const path = typeof args.path === 'string' ? args.path : '';
    if (!projectId) throw new Error('projectId is required');
    if (!path) throw new Error('path is required');
    return await readTextOutput(projectId, path);
  }
  throw new Error(`unknown MCP tool: ${name}`);
}

export async function handleOverviewMcpRequest(request: JsonRpcRequest): Promise<JsonObject | undefined> {
  const id = request.id ?? null;
  const method = request.method;
  if (method === 'notifications/initialized') return undefined;
  try {
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'open-design-overview', version: '0.1.0' } } };
    }
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: createOverviewMcpTools() } };
    if (method === 'tools/call') {
      const params = request.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as JsonObject : {};
      const result = await callTool(name, args);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = error && typeof error === 'object' && 'details' in error ? (error as { details?: unknown }).details : undefined;
    return { jsonrpc: '2.0', id, error: { code: -32000, message, ...(details === undefined ? {} : { data: details }) } };
  }
}

export async function runOverviewMcpServer(): Promise<McpServerResult> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      continue;
    }
    const response = await handleOverviewMcpRequest(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  return { exitCode: 0 };
}
