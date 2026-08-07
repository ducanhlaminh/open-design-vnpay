// Phân giải đích của push (3 case) + hằng số vùng chờ duyệt.
//
// Vì sao đáng test kỹ: mọi thao tác media của một push chạy trên `destId` —
// kể cả MIRROR-PRUNE, thứ XOÁ file trên store không còn bản local. Trả sai
// destId ở đây nghĩa là một push chưa được duyệt đi liệt kê rồi xoá file của
// dự án THẬT. resolvePushDest được viết thuần chính là để ràng buộc đó test
// được bằng mảng, không cần dựng KGS/media.

import { describe, expect, it } from 'vitest';
import type { RemoteProject } from '@open-design/contracts';

import {
  StagingBlockedError,
  pendingResolved,
  resolvePushDest,
  studioConfigOf,
} from '../src/kg-sync/push-dest.js';
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

const remoteRow = (projectId: string, isApp = false): RemoteProject => ({
  projectId,
  name: projectId,
  inKgs: true,
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

  it('case 3 KHÔNG được kích hoạt bởi remoteId trỏ vào thứ đã biến mất', () => {
    // Bản gốc bị xoá bên studio: rơi lại về vùng chờ, không phải ghi đè mù.
    const dest = resolvePushDest({
      projectId: 'checkout',
      metadata: { studioConfig: { remoteId: 'gone', appId: 'app--retail' } },
      remote: [remoteRow('app--retail', true)],
      submitter,
    });
    expect(dest.staged).toBe(true);
    expect(dest.case).toBe(1);
  });

  it('case 1 — App đã có, feature chưa → chờ duyệt, giữ App làm đích', () => {
    const dest = resolvePushDest({
      projectId: 'checkout',
      metadata: { studioConfig: { appId: 'app--retail', appName: 'Retail' } },
      remote: [remoteRow('app--retail', true)],
      submitter,
      nonce: 'a1b2c3',
    });
    expect(dest.staged).toBe(true);
    expect(dest.case).toBe(1);
    expect(dest.destId).toBe('pending--checkout--a1b2c3');
    expect(dest.targetApp).toEqual({ mode: 'existing', id: 'app--retail', name: 'Retail' });
    expect(dest.request?.status).toBe('pending');
    expect(dest.request?.feature).toMatchObject({ desiredId: 'checkout', localId: 'checkout' });
  });

  it('case 2 — chưa có gì → chờ duyệt, App cũng phải tạo khi duyệt', () => {
    const dest = resolvePushDest({
      projectId: 'checkout',
      projectName: 'Thanh toán',
      metadata: { studioConfig: { appId: 'app--retail', appName: 'Retail' } },
      remote: [],
      submitter,
      nonce: 'a1b2c3',
    });
    expect(dest.case).toBe(2);
    expect(dest.targetApp).toEqual({
      mode: 'create',
      desiredId: 'app--retail',
      displayName: 'Retail',
    });
    expect(dest.request?.feature.displayName).toBe('Thanh toán');
  });

  it('chặn push chờ duyệt khi chưa đăng nhập — không có ai để làm owner sau khi duyệt', () => {
    expect(() =>
      resolvePushDest({ projectId: 'checkout', remote: [], submitter: null }),
    ).toThrow(StagingBlockedError);
  });

  it('máy chưa đăng nhập VẪN push được lên dự án đã có (case 3 không cần submitter)', () => {
    const dest = resolvePushDest({
      projectId: 'checkout',
      remote: [remoteRow('checkout')],
      submitter: null,
    });
    expect(dest.case).toBe(3);
  });

  it('re-push tái dùng đúng folder chờ cũ thay vì đẻ thêm cái thứ hai', () => {
    const dest = resolvePushDest({
      projectId: 'checkout',
      metadata: { studioConfig: { pendingId: 'pending--checkout--old111' } },
      remote: [remoteRow('pending--checkout--old111')],
      submitter,
      nonce: 'new222',
    });
    expect(dest.destId).toBe('pending--checkout--old111');
    expect(dest.reusedPending).toBe(true);
  });

  it('folder chờ cũ đã biến mất → tạo folder mới, không bơm file vào chỗ không còn tồn tại', () => {
    const dest = resolvePushDest({
      projectId: 'checkout',
      metadata: { studioConfig: { pendingId: 'pending--checkout--old111' } },
      remote: [],
      submitter,
      nonce: 'new222',
    });
    expect(dest.destId).toBe('pending--checkout--new222');
    expect(dest.reusedPending).toBe(false);
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
});
