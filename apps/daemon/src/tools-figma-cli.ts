// `od tools figma <design-context|screenshot|variable-defs|metadata>` — CLI
// wrapper around `/api/tools/figma/*` (see `figma-desktop-tool-routes.ts`).
// Mirrors `tools-design-systems-cli.ts`'s shape; helpers below are
// deliberately copied rather than imported so this file and that one stay
// independently ownable.
type JsonObject = Record<string, unknown>;

interface ToolCliResult {
  exitCode: number;
}

type FigmaToolCommand = 'design-context' | 'screenshot' | 'variable-defs' | 'metadata';

const FIGMA_TOOL_COMMANDS: readonly FigmaToolCommand[] = ['design-context', 'screenshot', 'variable-defs', 'metadata'];

interface ParsedOptions {
  command: string | undefined;
  file?: string;
  node?: string;
  languages?: string;
  frameworks?: string;
  json: boolean;
  help: boolean;
}

export const FIGMA_TOOLS_USAGE = `Usage:
  od tools figma design-context --file <fileKey> --node <nodeId> [--languages <csv>] [--frameworks <csv>] [--json]
  od tools figma screenshot --file <fileKey> --node <nodeId> [--json]
  od tools figma variable-defs --file <fileKey> --node <nodeId> [--languages <csv>] [--frameworks <csv>] [--json]
  od tools figma metadata --file <fileKey> --node <nodeId> [--languages <csv>] [--frameworks <csv>] [--json]

Reads one component from the Figma file the App declared, through Figma
Desktop Dev Mode MCP (daemon-proxied — Figma Desktop must be running and
open the linked file locally, no token involved).

Environment:
  OD_NODE_BIN     Node-compatible runtime for agent wrapper invocations
  OD_BIN          Open Design CLI script for agent wrapper invocations
  OD_DAEMON_URL   Daemon base URL injected into agent runs
  OD_TOOL_TOKEN   Bearer token injected into agent runs

Agent runtime invocation:
  "$OD_NODE_BIN" "$OD_BIN" tools figma design-context --file kvQYEli6ij2mZ65mSywnFp --node 10:1
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
    json: false,
    help: command === '-h' || command === '--help',
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--file') {
      const value = rest[++index];
      if (!value) return { error: '--file requires a Figma file key' };
      options.file = value;
    } else if (arg === '--node') {
      const value = rest[++index];
      if (!value) return { error: '--node requires a Figma node id' };
      options.node = value;
    } else if (arg === '--languages') {
      const value = rest[++index];
      if (!value) return { error: '--languages requires a comma-separated list' };
      options.languages = value;
    } else if (arg === '--frameworks') {
      const value = rest[++index];
      if (!value) return { error: '--frameworks requires a comma-separated list' };
      options.frameworks = value;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      return { error: `unknown option: ${arg}` };
    }
  }

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

function isFigmaToolCommand(value: string | undefined): value is FigmaToolCommand {
  return value !== undefined && (FIGMA_TOOL_COMMANDS as readonly string[]).includes(value);
}

async function printFigmaResult(
  response: { status: number; body: unknown },
  options: { json: boolean; command: FigmaToolCommand },
): Promise<ToolCliResult> {
  if (response.status < 200 || response.status >= 300) {
    writeJson({ ok: false, status: response.status, error: normalizeCliError(response.body) }, process.stderr);
    return { exitCode: 1 };
  }

  if (options.json) {
    writeJson(response.body);
    return { exitCode: 0 };
  }

  const body = response.body && typeof response.body === 'object' ? (response.body as JsonObject) : {};
  const plain = options.command === 'screenshot' ? body.path : body.text;
  process.stdout.write(`${typeof plain === 'string' ? plain : ''}\n`);
  return { exitCode: 0 };
}

export async function runFigmaToolCli(args: string[]): Promise<ToolCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error);
  if (options.help || !options.command) {
    process.stdout.write(FIGMA_TOOLS_USAGE);
    return { exitCode: options.command ? 0 : 1 };
  }

  if (!isFigmaToolCommand(options.command)) {
    return fail(`unknown figma command: ${options.command}`);
  }

  const baseUrl = daemonUrl();
  if ('error' in baseUrl) return fail(baseUrl.error);
  const token = toolToken();
  if (typeof token !== 'string') return fail(token.error);

  if (!options.file) return fail(`${options.command} requires --file <fileKey>`);
  if (!options.node) return fail(`${options.command} requires --node <nodeId>`);

  return printFigmaResult(
    await requestJson(baseUrl, token, `/api/tools/figma/${options.command}`, {
      method: 'POST',
      body: JSON.stringify({
        fileKey: options.file,
        nodeId: options.node,
        ...(options.languages ? { clientLanguages: options.languages } : {}),
        ...(options.frameworks ? { clientFrameworks: options.frameworks } : {}),
      }),
    }),
    { json: options.json, command: options.command },
  );
}
