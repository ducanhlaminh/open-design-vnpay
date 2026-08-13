// Phân giải đích của push (3 case) + hằng số vùng chờ duyệt.
//
// Vì sao đáng test kỹ: mọi thao tác media của một push chạy trên `destId` —
// kể cả MIRROR-PRUNE, thứ XOÁ file trên store không còn bản local. Trả sai
// destId ở đây nghĩa là một push chưa được duyệt đi liệt kê rồi xoá file của
// dự án THẬT. resolvePushDest được viết thuần chính là để ràng buộc đó test
// được bằng mảng, không cần dựng media.

import { describe, expect, it } from 'vitest';
import type { RemoteProject } from '@open-design/contracts';

import { pendingResolved, resolvePushDest, studioConfigOf } from '../src/kg-sync/push-dest.js';
import {
  DECISIONS_FOLDER,
  PENDING_PREFIX,
  isPending,
  isPendingRequest,
  parsePendingName,
  parseStagingRequest,
  pendingNonce,
  stagedFolderName,
} from '../src/kg-sync/staging.js';
import { parseStagingDecision, writeStagingRequest } from '../src/kg-sync/staging-store.js';

const remoteRow = (projectId: string, isApp = false): RemoteProject => ({
  projectId,
  name: projectId,
  inMedia: true,
  files: 0,
  isApp,
});

const submitter = { id: 'u-1', email: 'a@b.c', name: 'Anh' };

describe('staging naming', () => {
  it('nonce là tất định khi bơm bytes (test không được phụ thuộc ngẫu nhiên)', () => {
    expect(pendingNonce(new Uint8Array([0, 1, 2, 3, 4, 5]))).toBe('abcdef');
    expect(pendingNonce(new Uint8Array([0, 0, 0, 0, 0, 0]))).toBe('aaaaaa');
  });

  it('nonce mặc định dài 6 và nằm trong bảng chữ base36', () => {
    const n = pendingNonce();
    expect(n).toHaveLength(6);
    expect(n).toMatch(/^[a-z0-9]{6}$/);
  });

  it('tên folder chờ = prefix + slug + nonce, và parse ngược lại được', () => {
    const name = stagedFolderName('checkout', 'a1b2c3');
    expect(name).toBe(`${PENDING_PREFIX}checkout--a1b2c3`);
    expect(parsePendingName(name)).toEqual({ desiredId: 'checkout', nonce: 'a1b2c3' });
  });

  it('slug chứa `--` vẫn tách đúng (dấu tách là cụm `--` CUỐI)', () => {
    const name = stagedFolderName('bidv--onboarding', 'zzz999');
    expect(parsePendingName(name)).toEqual({ desiredId: 'bidv--onboarding', nonce: 'zzz999' });
  });

  it('folder biên nhận nằm trong vùng prefix nhưng KHÔNG phải một yêu cầu', () => {
    expect(isPending(DECISIONS_FOLDER)).toBe(true); // → bị lọc khỏi danh sách dự án
    expect(isPendingRequest(DECISIONS_FOLDER)).toBe(false); // → không hiện trong danh sách chờ
    expect(parsePendingName(DECISIONS_FOLDER)).toBeNull();
  });

  it('dự án thường không bị nhận nhầm là yêu cầu chờ', () => {
    expect(isPending('checkout')).toBe(false);
    expect(isPending('app--retail')).toBe(false);
  });
});

describe('resolvePushDest', () => {
  it('case 3 — feature đã có trên studio → ghi đè, destId == projectId', () => {
    const dest = resolvePushDest({
      projectId: 'checkout',
      remote: [remoteRow('checkout')],
      submitter,
    });
    expect(dest).toEqual({ destId: 'checkout', staged: false, case: 3, targetApp: null });
  });

  it('case 3 qua remoteId — dự án local giữ tên cũ sau khi được duyệt dưới tên khác', () => {
    const dest = resolvePushDest({
      projectId: 'checkout',
      metadata: { studioConfig: { remoteId: 'checkout-2' } },
      remote: [remoteRow('checkout-2')],
      submitter,
    });
    expect(dest.case).toBe(3);
    expect(dest.staged).toBe(false);
    expect(dest.destId).toBe('checkout-2');
  });

  it('remoteId trỏ vào dự án đã mất → tạo lại Shared Project bằng id local', () => {
    const dest = resolvePushDest({
      projectId: 'checkout',
      metadata: { studioConfig: { remoteId: 'gone', appId: 'app--retail' } },
      remote: [remoteRow('app--retail', true)],
      submitter,
    });
    expect(dest).toEqual({ destId: 'checkout', staged: false, case: 3, targetApp: null });
  });

  it('Feature mới trong App có sẵn → publish trực tiếp vào Shared Projects', () => {
    const dest = resolvePushDest({
      projectId: 'checkout',
      metadata: { studioConfig: { appId: 'app--retail', appName: 'Retail' } },
      remote: [remoteRow('app--retail', true)],
      submitter,
    });
    expect(dest).toEqual({ destId: 'checkout', staged: false, case: 3, targetApp: null });
  });

  it('Feature và App mới → Feature publish trực tiếp với id local', () => {
    const dest = resolvePushDest({
      projectId: 'checkout',
      projectName: 'Thanh toán',
      metadata: { studioConfig: { appId: 'app--retail', appName: 'Retail' } },
      remote: [],
      submitter,
    });
    expect(dest).toEqual({ destId: 'checkout', staged: false, case: 3, targetApp: null });
  });
});

describe('pendingResolved', () => {
  it('báo yêu cầu đã được quyết khi folder chờ không còn trên store', () => {
    expect(
      pendingResolved({
        metadata: { studioConfig: { pendingId: 'pending--checkout--a1' } },
        remote: [],
      }),
    ).toBe('pending--checkout--a1');
  });

  it('im lặng khi folder chờ vẫn còn (yêu cầu đang treo)', () => {
    expect(
      pendingResolved({
        metadata: { studioConfig: { pendingId: 'pending--checkout--a1' } },
        remote: [remoteRow('pending--checkout--a1')],
      }),
    ).toBeNull();
  });

  it('im lặng khi dự án chưa từng đi qua vùng chờ', () => {
    expect(pendingResolved({ metadata: {}, remote: [] })).toBeNull();
  });
});

describe('studioConfigOf', () => {
  it('bỏ qua metadata rác thay vì ném (metadata do máy khác ghi)', () => {
    expect(studioConfigOf(null)).toEqual({});
    expect(studioConfigOf('nope')).toEqual({});
    expect(studioConfigOf({ studioConfig: [1, 2] })).toEqual({});
    expect(studioConfigOf({ studioConfig: { appId: 42 } })).toEqual({});
  });

  it('tolerantly reads a persisted local-to-approved mapping', () => {
    const approvedMapping = {
      localProjectId: 'checkout-local',
      approvedProjectId: 'checkout-v2',
      approvedAppId: 'app--retail',
      pendingId: 'pending--checkout-local--abc123',
      decidedAt: '2026-08-10T00:00:00.000Z',
    };
    expect(studioConfigOf({ studioConfig: { approvedMapping } }).approvedMapping).toEqual(approvedMapping);
    expect(studioConfigOf({ studioConfig: { approvedMapping: { approvedProjectId: 'missing-fields' } } })).toEqual({});
  });
});

describe('parseStagingRequest', () => {
  it('từ chối phiếu thiếu thứ để nhận dạng (feature/submitter)', () => {
    expect(parseStagingRequest(null)).toBeNull();
    expect(parseStagingRequest({ feature: { desiredId: 'x' } })).toBeNull(); // không submitter
    expect(parseStagingRequest({ submitter: { id: 'u' } })).toBeNull(); // không feature
  });

  it('một phiếu lệch field không được làm hỏng cả danh sách chờ', () => {
    const parsed = parseStagingRequest({
      feature: { desiredId: 'checkout' },
      submitter: { id: 'u-1' },
      status: 'weird',
      history: [{ at: '2026-01-01', event: 'pushed' }, 'rác'],
    });
    expect(parsed).toMatchObject({
      status: 'pending', // status lạ → coi như chờ, không phải đã duyệt
      feature: { desiredId: 'checkout', displayName: 'checkout', localId: 'checkout' },
    });
    expect(parsed?.history).toHaveLength(1);
  });

  it('đọc schema 2 publish summary nhưng vẫn chấp nhận phiếu schema 1', () => {
    const v2 = parseStagingRequest({
      schema: 2,
      feature: { desiredId: 'checkout' },
      submitter: { id: '65edc73c-56a4-4c48-8651-d7cb07a5e10d' },
      publish: { stages: ['ux-spec', 42], outputTypes: ['json', null] },
    });
    expect(v2).toMatchObject({
      schema: 2,
      publish: { stages: ['ux-spec'], outputTypes: ['json'] },
    });
    expect(parseStagingRequest({
      feature: { desiredId: 'legacy' },
      submitter: { id: '65edc73c-56a4-4c48-8651-d7cb07a5e10d' },
    })?.schema).toBe(1);
  });
});

describe('parseStagingDecision', () => {
  it('reads legacy v1 receipts and preserves the approved destination', () => {
    expect(parseStagingDecision({
      pendingId: 'pending--checkout--abc123',
      status: 'approved',
      finalId: 'checkout-v2',
      decidedAt: '2026-08-10T00:00:00.000Z',
    })).toEqual({
      schema: 1,
      pendingId: 'pending--checkout--abc123',
      status: 'approved',
      finalId: 'checkout-v2',
      decidedAt: '2026-08-10T00:00:00.000Z',
    });
  });

  it('rejects malformed approval receipts rather than guessing an id', () => {
    expect(parseStagingDecision({
      schema: 2,
      pendingId: 'pending--checkout--abc123',
      status: 'approved',
      decidedAt: '2026-08-10T00:00:00.000Z',
    })).toBeNull();
  });
});

describe('staging publish summary contract', () => {
  it('persists the final v2 stages and output types in the ticket Studio reads', async () => {
    let uploaded: Buffer | undefined;
    const media = {
      uploadFile: async (_folder: string, _stage: string, path: string, _mime: string, body: Buffer) => {
        expect(path).toBe('request.json');
        uploaded = body;
      },
    };
    await writeStagingRequest(media as never, 'pending--checkout--abc123', {
      schema: 2,
      status: 'pending',
      case: 2,
      submittedAt: '2026-08-10T00:00:00.000Z',
      submitter,
      feature: { desiredId: 'checkout', displayName: 'Checkout', localId: 'checkout' },
      app: { mode: 'create', desiredId: 'app--retail', displayName: 'Retail' },
      publish: { stages: ['docs', 'ux-spec'], outputTypes: ['json', 'md'] },
      history: [{ at: '2026-08-10T00:00:00.000Z', event: 'pushed' }],
    });
    expect(uploaded).toBeDefined();
    expect(parseStagingRequest(JSON.parse(uploaded!.toString('utf8')))).toMatchObject({
      schema: 2,
      publish: { stages: ['docs', 'ux-spec'], outputTypes: ['json', 'md'] },
    });
  });
});
