// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONFLUENCE_IMPORT_BATCH_SIZE, ConfluenceImportBatchError, importConfluenceInBatches } from '../../../src/components/pipelines/ConfluenceTreeImport';

afterEach(() => vi.unstubAllGlobals());

const refs = Array.from({ length: CONFLUENCE_IMPORT_BATCH_SIZE * 3 }, (_, i) => `page-${i}`);
const okBody = (n: number) => new Response(JSON.stringify({ imported: n, updated: 0, pages: [] }), { status: 200 });

describe('importConfluenceInBatches + AbortSignal', () => {
  it('bấm Dừng giữa chừng: lô đang bay bị huỷ, lô sau KHÔNG gửi, ném aborted=true với succeededRefs của các lô đã xong', async () => {
    const controller = new AbortController();
    let call = 0;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      call++;
      if (call === 1) return Promise.resolve(okBody(CONFLUENCE_IMPORT_BATCH_SIZE));
      // Lô 2: treo cho tới khi bị abort → reject như fetch thật.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }));
    const progress: number[] = [];
    const run = importConfluenceInBatches('app', refs, (done) => progress.push(done), [], controller.signal);
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceImportBatchError);
    expect((err as ConfluenceImportBatchError).aborted).toBe(true);
    expect((err as ConfluenceImportBatchError).succeededRefs).toEqual(refs.slice(0, CONFLUENCE_IMPORT_BATCH_SIZE));
    expect(call).toBe(2);
    expect(progress).toEqual([0, CONFLUENCE_IMPORT_BATCH_SIZE]);
  });

  it('không có signal → chạy hết như cũ; lỗi HTTP thường KHÔNG mang aborted', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      call++;
      return Promise.resolve(call === 3 ? new Response(JSON.stringify({ error: 'boom' }), { status: 502 }) : okBody(1));
    }));
    const err = await importConfluenceInBatches('app', refs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfluenceImportBatchError);
    expect((err as ConfluenceImportBatchError).aborted).toBe(false);
    expect((err as ConfluenceImportBatchError).succeededRefs).toHaveLength(CONFLUENCE_IMPORT_BATCH_SIZE * 2);
  });
});
