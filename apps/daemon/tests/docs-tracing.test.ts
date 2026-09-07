import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearDocsTracingLog,
  listDocsTracingStages,
  mergeDocsTracingPayload,
  recordDocsTracingQuery,
  runTracingRegistry,
} from '../src/docs-tracing.js';

let workflowRoot = '';

beforeEach(async () => {
  workflowRoot = await mkdtemp(path.join(tmpdir(), 'od-docs-tracing-'));
});

afterEach(async () => {
  await rm(workflowRoot, { recursive: true, force: true });
});

describe('recordDocsTracingQuery — Gói A (nhật ký daemon tự ghi)', () => {
  it('ghi nối tiếp nhiều truy vấn vào cùng file, giữ nguyên câu hỏi + kết quả', async () => {
    runTracingRegistry.set('run-1', { workflowRoot, stageId: 'dr-flow' });
    await recordDocsTracingQuery({
      runId: 'run-1',
      query: 'Người dùng vào màn tạo hồ sơ từ đâu?',
      scope: 'app',
      limit: 5,
      results: [{ path: 'menu.md', line: 12, crumb: 'Menu › Tạo hồ sơ', score: 0.72, scope: 'app' }],
    });
    await recordDocsTracingQuery({
      runId: 'run-1',
      query: 'Quy tắc xác thực OTP là gì?',
      scope: 'feature',
      limit: 5,
      results: [],
    });
    runTracingRegistry.clear('run-1');

    const target = path.join(workflowRoot, 'tracing', 'dr-flow.json');
    const raw = JSON.parse(await readFile(target, 'utf8'));
    expect(raw.stageId).toBe('dr-flow');
    expect(raw.queries).toHaveLength(2);
    expect(raw.queries[0].query).toBe('Người dùng vào màn tạo hồ sơ từ đâu?');
    expect(raw.queries[0].results[0]).toEqual({
      path: 'menu.md',
      line: 12,
      crumb: 'Menu › Tạo hồ sơ',
      score: 0.72,
      scope: 'app',
    });
    expect(raw.queries[1].query).toBe('Quy tắc xác thực OTP là gì?');
  });

  it('bỏ qua im lặng khi runId chưa đăng ký (chat thường, không thuộc docs-review kickoff)', async () => {
    await recordDocsTracingQuery({
      runId: 'run-khong-dang-ky',
      query: 'câu hỏi bất kỳ',
      scope: 'both',
      limit: 5,
      results: [],
    });
    const target = path.join(workflowRoot, 'tracing', 'dr-flow.json');
    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });

  it('cắt ở 200 truy vấn — vượt ngưỡng thì đánh dấu truncated, không thêm truy vấn mới', async () => {
    runTracingRegistry.set('run-cap', { workflowRoot, stageId: 'dr-review' });
    for (let i = 0; i < 201; i += 1) {
      await recordDocsTracingQuery({
        runId: 'run-cap',
        query: `câu hỏi số ${i}`,
        scope: 'app',
        limit: 5,
        results: [],
      });
    }
    runTracingRegistry.clear('run-cap');
    const target = path.join(workflowRoot, 'tracing', 'dr-review.json');
    const raw = JSON.parse(await readFile(target, 'utf8'));
    expect(raw.queries).toHaveLength(200);
    expect(raw.truncated).toBe(true);
  }, 20_000);

  it('xoá nhật ký cũ khi kickoff lại (clearDocsTracingLog) — lượt chạy mới bắt đầu từ rỗng', async () => {
    runTracingRegistry.set('run-a', { workflowRoot, stageId: 'dr-flow' });
    await recordDocsTracingQuery({ runId: 'run-a', query: 'câu cũ', scope: 'app', limit: 5, results: [] });
    runTracingRegistry.clear('run-a');

    await clearDocsTracingLog(workflowRoot, 'dr-flow');
    const target = path.join(workflowRoot, 'tracing', 'dr-flow.json');
    await expect(readFile(target, 'utf8')).rejects.toThrow();

    runTracingRegistry.set('run-b', { workflowRoot, stageId: 'dr-flow' });
    await recordDocsTracingQuery({ runId: 'run-b', query: 'câu mới', scope: 'app', limit: 5, results: [] });
    runTracingRegistry.clear('run-b');
    const raw = JSON.parse(await readFile(target, 'utf8'));
    expect(raw.queries).toHaveLength(1);
    expect(raw.queries[0].query).toBe('câu mới');
  });

  // Bắt được bằng harness thật (3 truy vấn liên tiếp <50ms/lượt), không phải
  // suy đoán: route gọi hàm này FIRE-AND-FORGET (không await — không được
  // làm chậm response tìm kiếm), nên nhiều lượt gọi gần như đồng thời cho
  // CÙNG runId/stageId có thể chồng lấn đọc-sửa-ghi trên cùng file và làm
  // MẤT một truy vấn (mất update kinh điển) nếu không tuần tự hoá.
  it('nhiều truy vấn bắn gần như đồng thời (không await tuần tự) vẫn ghi đủ, không mất truy vấn nào', async () => {
    runTracingRegistry.set('run-race', { workflowRoot, stageId: 'dr-flow' });
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        recordDocsTracingQuery({ runId: 'run-race', query: `câu số ${i}`, scope: 'app', limit: 5, results: [] }),
      ),
    );
    runTracingRegistry.clear('run-race');
    const target = path.join(workflowRoot, 'tracing', 'dr-flow.json');
    const raw = JSON.parse(await readFile(target, 'utf8'));
    expect(raw.queries).toHaveLength(N);
    const got = new Set(raw.queries.map((q: { query: string }) => q.query));
    for (let i = 0; i < N; i += 1) expect(got.has(`câu số ${i}`)).toBe(true);
  });
});

describe('runTracingRegistry — set/get/clear', () => {
  it('get trả null khi chưa/không còn đăng ký', () => {
    expect(runTracingRegistry.get('run-x')).toBeNull();
    runTracingRegistry.set('run-x', { workflowRoot: '/tmp/foo', stageId: 'dr-flow' });
    expect(runTracingRegistry.get('run-x')).toEqual({ workflowRoot: '/tmp/foo', stageId: 'dr-flow' });
    runTracingRegistry.clear('run-x');
    expect(runTracingRegistry.get('run-x')).toBeNull();
  });
});

describe('mergeDocsTracingPayload — ghép Gói A (query log) với Gói C (answers agent khai)', () => {
  it('câu hỏi khớp answer (sau trim + gộp khoảng trắng) → answer/citations/usedFor điền đủ', () => {
    const log = {
      stageId: 'dr-flow',
      runId: 'run-1',
      startedAt: '2026-09-04T08:17:50.123Z',
      queries: [
        {
          at: '2026-09-04T08:18:00.000Z',
          query: '  Người dùng   vào màn tạo hồ sơ từ đâu?  ',
          scope: 'app' as const,
          limit: 5,
          results: [{ path: 'menu.md', line: 12, crumb: 'Menu', score: 0.7, scope: 'app' as const }],
        },
      ],
    };
    const answersFile = {
      answers: [
        {
          question: 'Người dùng vào màn tạo hồ sơ từ đâu?',
          answer: 'Từ Trang chủ → menu Hồ sơ → Tạo mới.',
          citations: ['docs-app/menu.md#tao-ho-so'],
          usedFor: 'Bước Luồng màn hình',
        },
      ],
    };
    const items = mergeDocsTracingPayload(log, answersFile);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      question: '  Người dùng   vào màn tạo hồ sơ từ đâu?  ',
      answer: 'Từ Trang chủ → menu Hồ sơ → Tạo mới.',
      citations: ['docs-app/menu.md#tao-ho-so'],
      usedFor: 'Bước Luồng màn hình',
    });
    expect(items[0]?.orphan).toBeUndefined();
  });

  it('câu hỏi KHÔNG có answer khớp → answer: null (UI hiện "agent chưa ghi trả lời")', () => {
    const log = {
      stageId: 'dr-flow',
      runId: 'run-1',
      startedAt: '2026-09-04T08:17:50.123Z',
      queries: [
        { at: 't', query: 'Câu chưa được trả lời', scope: 'app' as const, limit: 5, results: [] },
      ],
    };
    const items = mergeDocsTracingPayload(log, null);
    expect(items).toEqual([
      { question: 'Câu chưa được trả lời', answer: null, citations: [], results: [] },
    ]);
  });

  it('answer thừa không khớp câu hỏi nào → vẫn trả về, đánh dấu orphan: true', () => {
    const log = {
      stageId: 'dr-flow',
      runId: 'run-1',
      startedAt: '2026-09-04T08:17:50.123Z',
      queries: [{ at: 't', query: 'Câu đã hỏi', scope: 'app' as const, limit: 5, results: [] }],
    };
    const answersFile = {
      answers: [
        { question: 'Câu đã hỏi', answer: 'Trả lời khớp', citations: [] },
        { question: 'Câu KHÔNG có trong nhật ký truy vấn', answer: 'Trả lời mồ côi', citations: [] },
      ],
    };
    const items = mergeDocsTracingPayload(log, answersFile);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ question: 'Câu đã hỏi', answer: 'Trả lời khớp' });
    expect(items[0]?.orphan).toBeUndefined();
    expect(items[1]).toMatchObject({
      question: 'Câu KHÔNG có trong nhật ký truy vấn',
      answer: 'Trả lời mồ côi',
      orphan: true,
    });
  });
});

describe('listDocsTracingStages — route GET .../docs-review/tracing đọc + gộp', () => {
  it('thư mục tracing/ chưa tồn tại → mảng rỗng, KHÔNG lỗi', async () => {
    const stages = await listDocsTracingStages(workflowRoot);
    expect(stages).toEqual([]);
  });

  it('file query log HỎNG (JSON lỗi) → bỏ qua stage đó, KHÔNG làm sập route', async () => {
    const dir = path.join(workflowRoot, 'tracing');
    await import('node:fs/promises').then((fsp) => fsp.mkdir(dir, { recursive: true }));
    await writeFile(path.join(dir, 'dr-broken.json'), '{ not valid json', 'utf8');
    await writeFile(
      path.join(dir, 'dr-ok.json'),
      JSON.stringify({
        stageId: 'dr-ok',
        runId: 'r',
        startedAt: '2026-09-04T08:00:00.000Z',
        queries: [{ at: 't', query: 'q', scope: 'app', limit: 5, results: [] }],
      }),
      'utf8',
    );
    const stages = await listDocsTracingStages(workflowRoot);
    expect(stages.map((s) => s.stageId)).toEqual(['dr-ok']);
  });

  it('file answers.json HỎNG → items vẫn trả về với answer: null (bỏ qua answers, không sập)', async () => {
    const dir = path.join(workflowRoot, 'tracing');
    await import('node:fs/promises').then((fsp) => fsp.mkdir(dir, { recursive: true }));
    await writeFile(
      path.join(dir, 'dr-flow.json'),
      JSON.stringify({
        stageId: 'dr-flow',
        runId: 'r',
        startedAt: '2026-09-04T08:00:00.000Z',
        queries: [{ at: 't', query: 'câu hỏi', scope: 'app', limit: 5, results: [] }],
      }),
      'utf8',
    );
    await writeFile(path.join(dir, 'dr-flow.answers.json'), 'khong-phai-json', 'utf8');
    const stages = await listDocsTracingStages(workflowRoot);
    expect(stages).toHaveLength(1);
    expect(stages[0]?.items).toEqual([{ question: 'câu hỏi', answer: null, citations: [], results: [] }]);
  });

  it('sắp theo startedAt, gộp cả truncated', async () => {
    const dir = path.join(workflowRoot, 'tracing');
    await import('node:fs/promises').then((fsp) => fsp.mkdir(dir, { recursive: true }));
    await writeFile(
      path.join(dir, 'dr-mockup.json'),
      JSON.stringify({ stageId: 'dr-mockup', runId: 'r2', startedAt: '2026-09-04T09:00:00.000Z', queries: [] }),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'dr-flow.json'),
      JSON.stringify({
        stageId: 'dr-flow',
        runId: 'r1',
        startedAt: '2026-09-04T08:00:00.000Z',
        queries: [],
        truncated: true,
      }),
      'utf8',
    );
    const stages = await listDocsTracingStages(workflowRoot);
    expect(stages.map((s) => s.stageId)).toEqual(['dr-flow', 'dr-mockup']);
    expect(stages[0]?.truncated).toBe(true);
    expect(stages[1]?.truncated).toBeUndefined();
  });
});
