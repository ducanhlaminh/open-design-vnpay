// WP14 (mục C) — 2 route HTTP cho ScreenListManager.tsx (apps/web, WP13b đã
// code UI theo ĐÚNG contract này, đóng — không đổi path/shape):
//   GET  /api/projects/:projectId/docs-review/screens
//        → 200 { manifest: ScreensManifest | null, overrides: ScreensOverrides | null }
//   PUT  /api/projects/:projectId/docs-review/screens-overrides
//        body = ScreensOverrides → 200 { ok: true } | 400 { error, warnings }
//
// Test qua HTTP thật (khuôn tests/pipeline-ingest-fail-fast.test.ts,
// tests/memory-config-route.test.ts — startServer thật, KHÔNG harness
// express giả) vì logic 2 route này sống trực tiếp trong server.ts (touches
// wp14.yaml chỉ cho phép sửa server.ts + 2 route, không tách file mới).
// comp/_screens.json (manifest) không có route ghi riêng — dr-comp thật mới
// ghi ra nó — nên test dùng route upload file chung (POST
// /api/projects/:id/files, đã dùng trong pipeline-ingest-fail-fast.test.ts)
// để dựng fixture trực tiếp dưới docs-review/comp/_screens.json.
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';
import type { ScreensManifest, ScreensOverrides } from '@open-design/contracts';

describe('dr-comp: GET/PUT docs-review/screens (WP14 mục C)', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function uniqueId(label: string): string {
    return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function putProjectFile(projectId: string, name: string, content: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, content }),
    });
    expect(res.status).toBe(200);
  }

  async function getScreens(projectId: string): Promise<{ status: number; body: { manifest: ScreensManifest | null; overrides: ScreensOverrides | null } }> {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/docs-review/screens`);
    const body = (await res.json()) as { manifest: ScreensManifest | null; overrides: ScreensOverrides | null };
    return { status: res.status, body };
  }

  async function putOverrides(projectId: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/docs-review/screens-overrides`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('GET trước khi có gì → 200 { manifest: null, overrides: null }', async () => {
    const projectId = uniqueId('screens-empty');
    const { status, body } = await getScreens(projectId);
    expect(status).toBe(200);
    expect(body).toEqual({ manifest: null, overrides: null });
  });

  it('GET đọc đúng comp/_screens.json (manifest) + screens-overrides.json đã có sẵn', async () => {
    const projectId = uniqueId('screens-seeded');
    const manifest: ScreensManifest = {
      schema_version: 1,
      screens: [{ key: 'prd__SCR-001', code: 'SCR-001', name: 'Chọn quốc gia', source: 'docs/prd.md', origin: 'flow', line: 3, hasSection: true }],
    };
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'rename', key: 'prd__SCR-001', name: 'Chọn quốc gia (đã sửa)' }],
    };
    await putProjectFile(projectId, 'docs-review/comp/_screens.json', JSON.stringify(manifest));
    await putProjectFile(projectId, 'docs-review/screens-overrides.json', JSON.stringify(overrides));

    const { status, body } = await getScreens(projectId);
    expect(status).toBe(200);
    expect(body.manifest).toEqual(manifest);
    expect(body.overrides).toEqual(overrides);
  });

  it('PUT overrides hợp lệ → 200 { ok: true }, GET lại thấy đúng nội dung vừa lưu (ghi đè toàn bộ)', async () => {
    const projectId = uniqueId('screens-put-ok');
    const overrides: ScreensOverrides = {
      schema_version: 1,
      overrides: [
        { action: 'add', source: 'docs/prd.md', code: 'SCR-003', name: 'Xác nhận thanh toán' },
        { action: 'remove', key: 'prd__SCR-002' },
      ],
    };
    const put = await putOverrides(projectId, overrides);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true });

    const { body } = await getScreens(projectId);
    expect(body.overrides).toEqual(overrides);

    // PUT lần 2 GHI ĐÈ TOÀN BỘ (không PATCH) — mảng rỗng phải xoá sạch
    // overrides cũ, không phải hợp nhất.
    const empty: ScreensOverrides = { schema_version: 1, overrides: [] };
    const put2 = await putOverrides(projectId, empty);
    expect(put2.status).toBe(200);
    const after = await getScreens(projectId);
    expect(after.body.overrides).toEqual(empty);
  });

  it('PUT có entry hỏng (action lạ) → 400 kèm warnings, KHÔNG ghi gì (giữ nguyên file cũ)', async () => {
    const projectId = uniqueId('screens-put-bad');
    const good: ScreensOverrides = {
      schema_version: 1,
      overrides: [{ action: 'rename', key: 'prd__SCR-001', name: 'Bản gốc hợp lệ' }],
    };
    // Ghi một bản hợp lệ trước qua chính route PUT, để chứng minh PUT hỏng
    // sau đó KHÔNG đè mất bản này.
    const seed = await putOverrides(projectId, good);
    expect(seed.status).toBe(200);

    const bad = {
      schema_version: 1,
      overrides: [
        { action: 'rename', key: 'prd__SCR-002', name: 'Sẽ không được lưu' },
        { action: 'bogus-action', key: 'x' },
      ],
    };
    const put = await putOverrides(projectId, bad);
    expect(put.status).toBe(400);
    expect(typeof put.body.error).toBe('string');
    expect(Array.isArray(put.body.warnings)).toBe(true);
    expect(put.body.warnings.length).toBeGreaterThan(0);

    // File trên đĩa vẫn là bản GOOD trước đó — PUT hỏng không được phép làm
    // rơi overrides đã lưu (fail-closed, xem comment ở route PUT).
    const after = await getScreens(projectId);
    expect(after.body.overrides).toEqual(good);
  });

  it('PUT anchorText toàn khoảng trắng (add) → parseScreensOverrides tự trim/drop field, KHÔNG phải lỗi 400 (do.0 bất biến)', async () => {
    const projectId = uniqueId('screens-put-blank-anchor');
    const body = {
      schema_version: 1,
      overrides: [{ action: 'add', source: 'docs/prd.md', code: 'SCR-009', name: 'Màn mới', anchorText: '   ' }],
    };
    const put = await putOverrides(projectId, body);
    expect(put.status).toBe(200);

    const { body: after } = await getScreens(projectId);
    const entry = after.overrides!.overrides[0] as { action: string; anchorText?: string };
    expect(entry.action).toBe('add');
    // anchorText toàn khoảng trắng bị str() trim về rỗng → KHÔNG được ghi vào
    // entry (đúng luật parseScreensOverrides — route PUT luôn đi qua nó
    // trước khi ghi, xem do.0 review note trong wp14.yaml).
    expect(entry.anchorText).toBeUndefined();
  });
});
