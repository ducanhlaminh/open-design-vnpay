/**
 * Auto-filing a detected Claude login into the account list.
 *
 * The account list lives in the `od-claude-auth` volume as `accounts/<label>.json`
 * (a copy of the credentials) and, from now on, a `<label>.meta` sidecar naming
 * whose account it is. The identity comes from the volume's `.claude.json`
 * (`oauthAccount`), which is the only place an email/account id exists —
 * `.credentials.json` carries tokens and nothing else.
 *
 * Three traps this covers, all of which produce silently WRONG data rather than
 * an error:
 *
 *   1. `.claude.json` is one file for the whole volume, not one per account, and
 *      the CLI refreshes it on its own schedule. A profile older than the
 *      credentials describes the PREVIOUS account, so trusting it would file a
 *      fresh login under someone else's name.
 *   2. Credentials bytes change on every login, so they cannot be the dedup key:
 *      re-logging into one account would keep adding new entries. `accountUuid`
 *      is stable and is the key.
 *   3. The label becomes a filename interpolated into a shell command, so
 *      deriving it from an email must never widen what the label regex allows.
 */
import { describe, expect, it } from 'vitest';

import {
  SANDBOX_ACCOUNT_LABEL_RE,
  sandboxAccountLabelFromEmail,
} from '@open-design/contracts';
import {
  chooseAutoSaveLabel,
  parseSandboxAccountListing,
  parseSandboxIdentity,
} from '../src/agent-sandbox.js';
import type { SandboxAccount, SandboxAccountIdentity } from '@open-design/contracts';

describe('sandboxAccountLabelFromEmail', () => {
  it('derives a filesystem-safe label from the local part', () => {
    expect(sandboxAccountLabelFromEmail('qlptsp.ptk.1@gmail.com')).toBe('qlptsp-ptk-1');
    expect(sandboxAccountLabelFromEmail('anh.nguyen+work@vnpay.vn')).toBe('anh-nguyen-work');
    expect(sandboxAccountLabelFromEmail('Simple@example.com')).toBe('Simple');
  });

  it('never emits a label the validator would reject', () => {
    const emails = [
      'qlptsp.ptk.1@gmail.com',
      '...leading.dots@x.com',
      'a@b.com',
      'trailing---@x.com',
      'ñoño@x.com',
      `${'x'.repeat(80)}@x.com`,
      'UPPER.Case_99@x.com',
    ];
    for (const email of emails) {
      const label = sandboxAccountLabelFromEmail(email);
      if (label !== null) expect(SANDBOX_ACCOUNT_LABEL_RE.test(label)).toBe(true);
    }
  });

  it('refuses shell metacharacters instead of smuggling them into a filename', () => {
    // The label is interpolated into `cp … "accounts/<label>.json"` inside sh -c.
    for (const email of ['a";rm -rf /;"@x.com', '$(whoami)@x.com', '`id`@x.com']) {
      const label = sandboxAccountLabelFromEmail(email);
      if (label !== null) {
        expect(SANDBOX_ACCOUNT_LABEL_RE.test(label)).toBe(true);
        expect(label).not.toMatch(/[;"'`$\s/\\]/);
      }
    }
  });

  it('returns null when nothing usable survives', () => {
    expect(sandboxAccountLabelFromEmail('...@x.com')).toBeNull();
    expect(sandboxAccountLabelFromEmail('')).toBeNull();
    expect(sandboxAccountLabelFromEmail('@@@')).toBeNull();
  });
});

describe('parseSandboxIdentity', () => {
  const NOW = 1_800_000_000_000;
  const profile = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      oauthAccount: {
        accountUuid: 'ad2c6d0f-1111-2222-3333-444455556666',
        emailAddress: 'someone@gmail.com',
        organizationType: 'claude_max',
        profileFetchedAt: NOW - 30_000, // fetched during the login we just saw
        ...over,
      },
    });

  it('reads identity from a profile fetched moments ago', () => {
    expect(parseSandboxIdentity(profile(), NOW)).toEqual({
      accountUuid: 'ad2c6d0f-1111-2222-3333-444455556666',
      emailAddress: 'someone@gmail.com',
      organizationType: 'claude_max',
    });
  });

  it('refuses a profile predating this login (would mislabel it)', () => {
    // Left over from an earlier session: it still names whoever was signed in
    // before, so naming the new login after it would file it under the wrong
    // account.
    expect(parseSandboxIdentity(profile({ profileFetchedAt: NOW - 6 * 3600_000 }), NOW)).toBeNull();
  });

  it('does not compare against the credentials file clock', () => {
    // Regression guard for the first attempt at this: `profileFetchedAt` moves
    // on login, while `.credentials.json` is rewritten on every token refresh,
    // so a healthy account routinely has a profile far OLDER than its
    // credentials (observed: 04:06 vs 08:41). Requiring profile >= creds
    // rejected the ordinary steady state. Freshness is relative to now only.
    expect(parseSandboxIdentity(profile({ profileFetchedAt: NOW - 60_000 }), NOW)).not.toBeNull();
  });

  it('refuses a profile that was never fetched', () => {
    expect(parseSandboxIdentity(profile({ profileFetchedAt: 0 }), NOW)).toBeNull();
  });

  it('tolerates a missing, empty or malformed profile', () => {
    expect(parseSandboxIdentity('', NOW)).toBeNull();
    expect(parseSandboxIdentity('not json', NOW)).toBeNull();
    expect(parseSandboxIdentity('{"oauthAccount":{}}', NOW)).toBeNull();
  });
});

describe('chooseAutoSaveLabel', () => {
  const identity = (over: Partial<SandboxAccountIdentity> = {}): SandboxAccountIdentity => ({
    accountUuid: 'uuid-a',
    emailAddress: 'anh.nguyen@vnpay.vn',
    organizationType: 'claude_max',
    ...over,
  });
  const account = (over: Partial<SandboxAccount>): SandboxAccount => ({
    label: 'x',
    active: false,
    identity: null,
    auto: false,
    ...over,
  });

  it('files a first login under its email slug', () => {
    expect(chooseAutoSaveLabel([], identity())).toEqual({ label: 'anh-nguyen', reused: false });
  });

  it('reuses the existing entry when the SAME account signs in again', () => {
    // The whole point of keying on accountUuid: a re-login mints new tokens, so
    // the credentials bytes differ and a byte-based check would keep adding
    // "anh-nguyen-2", "anh-nguyen-3", … forever.
    const existing = [account({ label: 'anh-nguyen', identity: identity(), auto: true })];
    expect(chooseAutoSaveLabel(existing, identity())).toEqual({
      label: 'anh-nguyen',
      reused: true,
    });
  });

  it('keeps a name the user renamed the account to', () => {
    const existing = [account({ label: 'Work', identity: identity(), auto: false })];
    expect(chooseAutoSaveLabel(existing, identity())).toEqual({ label: 'Work', reused: true });
  });

  it('does not overwrite a different account whose email slugifies the same', () => {
    // anh.nguyen@vnpay.vn and anh.nguyen@gmail.com both slugify to "anh-nguyen".
    const existing = [
      account({ label: 'anh-nguyen', identity: identity({ accountUuid: 'uuid-OTHER' }) }),
    ];
    expect(chooseAutoSaveLabel(existing, identity())).toEqual({
      label: 'anh-nguyen-2',
      reused: false,
    });
  });

  it('does not collide with a legacy label that has no identity', () => {
    const existing = [account({ label: 'anh-nguyen', identity: null })];
    expect(chooseAutoSaveLabel(existing, identity())).toEqual({
      label: 'anh-nguyen-2',
      reused: false,
    });
  });

  it('gives up rather than inventing a name it cannot derive', () => {
    expect(chooseAutoSaveLabel([], identity({ emailAddress: '...@x.com' }))).toEqual({
      label: null,
      reason: 'no-label',
    });
  });
});

describe('parseSandboxAccountListing', () => {
  it('attaches identity from the sidecar and marks the active account', () => {
    const meta = JSON.stringify({
      accountUuid: 'uuid-a',
      emailAddress: 'a@x.com',
      organizationType: 'claude_max',
      auto: true,
    });
    const listing = parseSandboxAccountListing(
      ['LOGGEDIN:1', 'ACTIVE:work', 'ACC:work', `META:work:${meta}`, 'ACC:legacy'].join('\n'),
    );

    expect(listing.loggedIn).toBe(true);
    expect(listing.activeUnsaved).toBe(false);
    expect(listing.accounts).toEqual([
      {
        label: 'work',
        active: true,
        auto: true,
        identity: { accountUuid: 'uuid-a', emailAddress: 'a@x.com', organizationType: 'claude_max' },
      },
      // Saved before auto-save existed: still listed, just without identity.
      { label: 'legacy', active: false, auto: false, identity: null },
    ]);
  });

  it('does not mistake a sidecar for an account of its own', () => {
    // `accounts/*.json` is the account glob, which is exactly why sidecars use
    // the `.meta` extension. A ".meta" entry here would mean that broke.
    const listing = parseSandboxAccountListing(
      ['LOGGEDIN:1', 'ACTIVE:work', 'ACC:work', 'META:work:{"accountUuid":"u","emailAddress":"a@x.com"}'].join('\n'),
    );
    expect(listing.accounts.map((a) => a.label)).toEqual(['work']);
  });

  it('reports an unsaved login when nothing matches the active credentials', () => {
    const listing = parseSandboxAccountListing(['LOGGEDIN:1', 'ACTIVE:'].join('\n'));
    expect(listing).toMatchObject({ loggedIn: true, activeUnsaved: true, accounts: [] });
  });

  it('survives a corrupt sidecar without losing the account', () => {
    const listing = parseSandboxAccountListing(
      ['LOGGEDIN:1', 'ACTIVE:work', 'ACC:work', 'META:work:{broken'].join('\n'),
    );
    expect(listing.accounts).toEqual([
      { label: 'work', active: true, auto: false, identity: null },
    ]);
  });
});
