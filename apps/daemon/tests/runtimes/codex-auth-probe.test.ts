/**
 * Coverage for the Codex CLI login probe.
 *
 * Codex has no non-interactive online status check exposed as a stable API
 * either, so the probe reads the same local state the CLI itself consults:
 * `<CODEX_HOME or ~/.codex>/auth.json`, which carries either an OAuth
 * `tokens.access_token` or a bare `OPENAI_API_KEY` fallback field.
 *
 * Same load-bearing invariant as the Claude probe: an unanswerable probe
 * degrades to `unknown`, never to `missing` — a false "chưa đăng nhập" is
 * worse than admitting we could not tell.
 */
import { describe, expect, it } from 'vitest';

import { extractCodexAccountEmail, probeCodexAuthStatus } from '../../src/runtimes/auth.js';

const HOME = '/home/tester';
const enoent = (): never => {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
};

function linuxIO(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    homedir: () => HOME,
    readFile: async (filePath: string): Promise<string> => {
      const found = files[filePath];
      return found === undefined ? enoent() : found;
    },
    ...extra,
  };
}

/** Builds a fake (unsigned — the probe never verifies the signature) OIDC
 *  id_token carrying the given claims, matching the shape ChatGPT OAuth
 *  issues in `~/.codex/auth.json`'s `tokens.id_token`. */
function fakeIdToken(claims: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
}

describe('probeCodexAuthStatus', () => {
  it('reports ok when auth.json carries an OAuth access token', async () => {
    const io = linuxIO({
      [`${HOME}/.codex/auth.json`]: '{"tokens":{"access_token":"oat-abc","refresh_token":"r"}}',
    });
    expect(await probeCodexAuthStatus({}, io)).toEqual({ status: 'ok' });
  });

  it('reports ok when auth.json carries a bare OPENAI_API_KEY fallback', async () => {
    const io = linuxIO({
      [`${HOME}/.codex/auth.json`]: '{"OPENAI_API_KEY":"sk-proj-abc"}',
    });
    expect(await probeCodexAuthStatus({}, io)).toEqual({ status: 'ok' });
  });

  it('reports missing when no credential state exists at all', async () => {
    const result = await probeCodexAuthStatus({}, linuxIO({}));
    expect(result.status).toBe('missing');
    expect(result.message).toMatch(/codex login/);
  });

  it('treats a hollow auth.json (aborted login) as missing', async () => {
    const io = linuxIO({
      [`${HOME}/.codex/auth.json`]: '{"tokens":{"access_token":""}}',
    });
    expect((await probeCodexAuthStatus({}, io)).status).toBe('missing');
  });

  it('honours CODEX_HOME over the default ~/.codex', async () => {
    const io = linuxIO({
      '/profiles/work/auth.json': '{"tokens":{"access_token":"oat-x"}}',
      // The default profile is logged OUT — picking it would flip the verdict.
      [`${HOME}/.codex/auth.json`]: '{}',
    });
    expect(await probeCodexAuthStatus({ CODEX_HOME: '/profiles/work' }, io)).toEqual({
      status: 'ok',
    });
  });

  it('counts an explicit OPENAI_API_KEY env var as logged in', async () => {
    const io = linuxIO({});
    expect(await probeCodexAuthStatus({ OPENAI_API_KEY: 'sk-proj-x' }, io)).toEqual({
      status: 'ok',
    });
  });

  it('degrades to unknown — not missing — when the probe cannot answer', async () => {
    const eacces = () => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    const unreadable = await probeCodexAuthStatus({}, {
      homedir: () => HOME,
      readFile: async () => eacces(),
    });
    expect(unreadable.status).toBe('unknown');
  });

  it('attaches the id_token email claim when the OAuth access token carries one', async () => {
    const idToken = fakeIdToken({ email: 'test@example.com', sub: 'abc-123' });
    const io = linuxIO({
      [`${HOME}/.codex/auth.json`]: JSON.stringify({
        tokens: { access_token: 'oat-abc', id_token: idToken },
      }),
    });
    expect(await probeCodexAuthStatus({}, io)).toEqual({
      status: 'ok',
      account: { email: 'test@example.com' },
    });
  });

  it('stays status ok with account undefined when id_token is missing or has no email', async () => {
    // No id_token field at all.
    const noIdToken = linuxIO({
      [`${HOME}/.codex/auth.json`]: '{"tokens":{"access_token":"oat-abc"}}',
    });
    expect(await probeCodexAuthStatus({}, noIdToken)).toEqual({ status: 'ok' });

    // id_token present but not a well-formed JWT (no dot-separated payload segment).
    const malformedJwt = linuxIO({
      [`${HOME}/.codex/auth.json`]: JSON.stringify({
        tokens: { access_token: 'oat-abc', id_token: 'not-a-jwt' },
      }),
    });
    expect(await probeCodexAuthStatus({}, malformedJwt)).toEqual({ status: 'ok' });

    // Well-formed JWT whose payload segment decodes to JSON with no email claim.
    const noEmailClaim = linuxIO({
      [`${HOME}/.codex/auth.json`]: JSON.stringify({
        tokens: { access_token: 'oat-abc', id_token: fakeIdToken({ sub: 'abc-123' }) },
      }),
    });
    expect(await probeCodexAuthStatus({}, noEmailClaim)).toEqual({ status: 'ok' });
  });
});

describe('extractCodexAccountEmail', () => {
  it('decodes the email claim from a realistic id_token, regardless of base64url padding length', () => {
    for (const email of ['a@example.com', 'test@example.com', 'longer.email.address@example.com']) {
      const raw = JSON.stringify({ tokens: { id_token: fakeIdToken({ email }) } });
      expect(extractCodexAccountEmail(raw)).toBe(email);
    }
  });

  it('returns undefined — never throws — for malformed JSON', () => {
    expect(extractCodexAccountEmail('{not valid json')).toBeUndefined();
  });

  it('returns undefined when tokens.id_token is missing or malformed', () => {
    expect(extractCodexAccountEmail('{}')).toBeUndefined();
    expect(extractCodexAccountEmail('{"tokens":{}}')).toBeUndefined();
    expect(extractCodexAccountEmail('{"tokens":{"id_token":""}}')).toBeUndefined();
    expect(extractCodexAccountEmail('{"tokens":{"id_token":"not-a-jwt"}}')).toBeUndefined();
    expect(extractCodexAccountEmail('{"tokens":{"id_token":"a.b"}}')).toBeUndefined();
    // Payload segment decodes but is not valid JSON.
    const badPayload = `${Buffer.from('{}').toString('base64url')}.notjson.sig`;
    expect(extractCodexAccountEmail(`{"tokens":{"id_token":"${badPayload}"}}`)).toBeUndefined();
  });
});
