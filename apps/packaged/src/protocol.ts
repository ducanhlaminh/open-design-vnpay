import { protocol } from "electron";

const OD_SCHEME = "od";
const OD_ENTRY_URL = `${OD_SCHEME}://app/`;
const SESSION_COOKIE_NAME = "od_session";

/**
 * Electron's custom `od://` scheme does not reliably persist a Set-Cookie
 * returned by a proxied localhost response. Keep the HttpOnly session cookie
 * in the main process for this desktop session and attach it to later API
 * requests. This is deliberately in-memory: closing the desktop app still
 * requires a fresh Google sign-in when Chromium has not retained the cookie.
 */
export interface OdProtocolSession {
  cookie: string | null;
}

protocol.registerSchemesAsPrivileged([
  {
    privileges: {
      corsEnabled: true,
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true,
    },
    scheme: OD_SCHEME,
  },
]);

function toWebRuntimeUrl(webRuntimeUrl: string, requestUrl: string): string {
  const incoming = new URL(requestUrl);
  const target = new URL(webRuntimeUrl);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  target.hash = incoming.hash;
  return target.toString();
}

function buildProxyErrorResponse(error: unknown, target: string): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string"
      ? (error as NodeJS.ErrnoException).code
      : null;
  return new Response(
    JSON.stringify({
      error: "OD_PROTOCOL_PROXY_FAILED",
      message,
      ...(code === null ? {} : { code }),
      target,
    }),
    {
      status: 502,
      headers: { "content-type": "application/json" },
    },
  );
}

function sessionCookieFromResponse(response: Response): string | null | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
  for (const value of values) {
    const match = new RegExp(`^${SESSION_COOKIE_NAME}=([^;]*)`, 'i').exec(value.trim());
    if (!match) continue;
    if (/(?:^|;)\s*Max-Age=0(?:;|$)/i.test(value)) return null;
    return `${SESSION_COOKIE_NAME}=${match[1]}`;
  }
  return undefined;
}

function requestWithSessionCookie(request: Request, target: string, session?: OdProtocolSession): Request {
  const proxied = new Request(target, request);
  if (!session?.cookie) return proxied;

  const headers = new Headers(proxied.headers);
  const current = headers.get('cookie');
  const otherCookies = (current ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.toLowerCase().startsWith(`${SESSION_COOKIE_NAME}=`));
  headers.set('cookie', [...otherCookies, session.cookie].join('; '));
  return new Request(proxied, { headers });
}

/**
 * Inner request handler for the `od://` Electron protocol — every
 * renderer fetch flows through here and gets proxied to the local web
 * sidecar via Node's global `fetch` (which is undici under the hood).
 *
 * Pulled out as a named export so unit tests can drive it with a stub
 * `fetchImpl` without spinning up Electron, and so the try/catch
 * stays auditable from one place.
 *
 * Why the try/catch matters: undici can throw `setTypeOfService
 * EINVAL` from socket internals on certain macOS / VPN configurations
 * (issue #895). Without the catch, the rejection bubbles all the way
 * up to the Electron main process and surfaces as a native
 * "JavaScript error in main process" dialog the next time the user
 * does anything that triggers a renderer-to-sidecar fetch (e.g.
 * Settings → Pets → Community). Returning a 502 instead lets the
 * renderer see a normal failure and keeps the process alive.
 */
export async function handleOdRequest(
  request: Request,
  webRuntimeUrl: string,
  fetchImpl: typeof fetch = fetch,
  session?: OdProtocolSession,
): Promise<Response> {
  const target = toWebRuntimeUrl(webRuntimeUrl, request.url);
  try {
    const response = await fetchImpl(requestWithSessionCookie(request, target, session));
    const nextCookie = sessionCookieFromResponse(response);
    if (session && nextCookie !== undefined) session.cookie = nextCookie;
    return response;
  } catch (error) {
    return buildProxyErrorResponse(error, target);
  }
}

export function packagedEntryUrl(): string {
  return OD_ENTRY_URL;
}

export function registerOdProtocol(webRuntimeUrl: string): void {
  const session: OdProtocolSession = { cookie: null };
  protocol.handle(OD_SCHEME, async (request) => {
    return await handleOdRequest(request, webRuntimeUrl, fetch, session);
  });
}
