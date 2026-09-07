import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EmbedUnavailableError,
  buildDocsEmbedIndex,
  chunkSection,
  resetDocsEmbedProbeCacheForTests,
  searchDocsEmbed,
} from '../src/docs-embed-index.js';
import { collectDocsSections } from '../src/docs-section-index.js';

const ORIGINAL_ENV = { ...process.env };

/** Vector giả lập, deterministic theo nội dung text (KHÔNG gọi mạng thật —
 *  toàn bộ `fetch` bị mock bên dưới). Đủ để test đếm/dedupe; không cần
 *  chính xác ngữ nghĩa (đó là việc của "chạy THẬT" ở bước verify cuối). */
function vectorFor(text: string): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i += 1) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  const dims = 8;
  const vec: number[] = [];
  let s = seed || 1;
  for (let i = 0; i < dims; i += 1) {
    s = (s * 1103515245 + 12345) >>> 0;
    vec.push(((s % 2000) - 1000) / 1000 || 0.001);
  }
  return vec;
}

interface MockState {
  tagsModels: string[];
  embedTexts: string[];
  tagsOk: boolean;
}

function installOllamaMock(state: MockState): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) {
      if (!state.tagsOk) {
        return new Response('service unavailable', { status: 503 });
      }
      return new Response(
        JSON.stringify({ models: state.tagsModels.map((name) => ({ name })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.endsWith('/api/embed')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input: string[] };
      state.embedTexts.push(...body.input);
      const embeddings = body.input.map((t) => vectorFor(t));
      return new Response(JSON.stringify({ embeddings }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('docs-embed-index — chunkSection (pure, hybrid head+window, 0 LLM)', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  it('section ngắn → chỉ 1 head chunk', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-embed-short-'));
    tempRoots.push(root);
    await writeFile(path.join(root, 'a.md'), '# Trang ngắn\n\nNội dung ngắn không cần cắt cửa sổ.');
    const sections = await collectDocsSections(root);
    expect(sections).toHaveLength(1);
    const chunks = chunkSection(sections[0]!);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.kind).toBe('head');
    expect(chunks[0]!.line).toBe(1);
    expect(chunks[0]!.text.startsWith('a.md | Trang ngắn\n')).toBe(true);
  });

  it('section dài (>5000 ký tự) → 1 head + ≥2 window; số dòng của window trỏ đúng dòng thật; có overlap; deterministic', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-embed-long-'));
    tempRoots.push(root);
    const bodyLines: string[] = [];
    for (let i = 1; i <= 70; i += 1) {
      bodyLines.push(
        `Dòng số ${i} của nội dung kiểm thử cắt cửa sổ dài để kiểm tra ranh giới dòng và độ chồng lấn giữa hai cửa sổ liên tiếp nhau.`,
      );
    }
    const content = `# Section dài\n\n${bodyLines.join('\n')}\n`;
    await writeFile(path.join(root, 'long.md'), content);
    const fileLines = content.split(/\r\n|\r|\n/);

    const sections = await collectDocsSections(root);
    expect(sections).toHaveLength(1);
    const section = sections[0]!;
    expect(section.body.length).toBeGreaterThan(5000);

    const chunks1 = chunkSection(section);
    const chunks2 = chunkSection(section);
    expect(chunks1).toEqual(chunks2); // deterministic: cùng input → cùng output

    expect(chunks1[0]!.kind).toBe('head');
    const windowChunks = chunks1.filter((c) => c.kind === 'window');
    expect(windowChunks.length).toBeGreaterThanOrEqual(2);

    // Số dòng của MỖI window phải trỏ đúng dòng THẬT trong file gốc (cái
    // agent mở) — đối chiếu với nội dung dòng đó đọc trực tiếp từ file.
    for (const w of windowChunks) {
      const actualLine = fileLines[w.line - 1];
      const firstTextLine = w.text.split('\n').slice(1)[0]; // bỏ dòng prefix "rel | crumb"
      expect(firstTextLine).toBe(actualLine);
    }

    // Overlap: dòng cuối window[i] phải xuất hiện lại ở đầu window[i+1].
    for (let i = 0; i + 1 < windowChunks.length; i += 1) {
      const currentLines = windowChunks[i]!.text.split('\n').slice(1);
      const nextLines = windowChunks[i + 1]!.text.split('\n').slice(1);
      const lastLineOfCurrent = currentLines[currentLines.length - 1];
      expect(nextLines).toContain(lastLineOfCurrent);
    }
  });
});

describe('docs-embed-index — buildDocsEmbedIndex / searchDocsEmbed (mock Ollama, KHÔNG gọi mạng thật)', () => {
  const tempRoots: string[] = [];
  let state: MockState;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OD_DOCS_EMBED;
    state = { tagsModels: ['bge-m3:latest'], embedTexts: [], tagsOk: true };
    installOllamaMock(state);
    resetDocsEmbedProbeCacheForTests();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env = ORIGINAL_ENV;
    resetDocsEmbedProbeCacheForTests();
    await Promise.all(tempRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  async function makeDocsRoot(): Promise<{ docsDir: string; runtimeDataDir: string }> {
    const docsDir = await mkdtemp(path.join(tmpdir(), 'od-embed-docs-'));
    const runtimeDataDir = await mkdtemp(path.join(tmpdir(), 'od-embed-runtime-'));
    tempRoots.push(docsDir, runtimeDataDir);
    await writeFile(path.join(docsDir, 'a.md'), '# Trang A\n\nNội dung trang A, ngắn gọn, một section duy nhất.');
    const bLines: string[] = [];
    for (let i = 1; i <= 60; i += 1) {
      bLines.push(`Dòng ${i}: nội dung dài của trang B dùng để bắt buộc phải cắt thêm cửa sổ khi build chỉ mục embedding.`);
    }
    await writeFile(path.join(docsDir, 'b.md'), `# Trang B\n\n${bLines.join('\n')}\n`);
    return { docsDir, runtimeDataDir };
  }

  it('build lần đầu: embed toàn bộ chunk, reused = 0', async () => {
    const { docsDir, runtimeDataDir } = await makeDocsRoot();
    const result = await buildDocsEmbedIndex(docsDir, { runtimeDataDir });
    expect(result.chunks).toBeGreaterThan(1);
    expect(result.embedded).toBe(result.chunks);
    expect(result.reused).toBe(0);
  });

  it('cache incremental: build lần 2 sau khi sửa 1 file → embedded chỉ đếm chunk mới, reused > 0', async () => {
    const { docsDir, runtimeDataDir } = await makeDocsRoot();
    const first = await buildDocsEmbedIndex(docsDir, { runtimeDataDir });
    state.embedTexts = [];

    // Chỉ sửa trang A (section nhỏ, 1 chunk) — trang B (nhiều chunk hơn) giữ
    // nguyên nội dung nên chunk text của nó không đổi → phải được tái dùng.
    await writeFile(path.join(docsDir, 'a.md'), '# Trang A\n\nNội dung trang A ĐÃ SỬA, khác hẳn bản gốc.');
    const second = await buildDocsEmbedIndex(docsDir, { runtimeDataDir });

    expect(second.chunks).toBe(first.chunks);
    expect(second.reused).toBeGreaterThan(0);
    expect(second.embedded).toBeLessThan(first.embedded);
    expect(second.embedded).toBeGreaterThan(0); // chunk của a.md vẫn phải được embed lại
  });

  it('đổi OD_EMBED_MODEL → cache bị bỏ, build lại toàn bộ', async () => {
    const { docsDir, runtimeDataDir } = await makeDocsRoot();
    const first = await buildDocsEmbedIndex(docsDir, { runtimeDataDir });

    state.tagsModels = ['bge-m3:latest', 'other-embed-model:latest'];
    process.env.OD_EMBED_MODEL = 'other-embed-model';
    const second = await buildDocsEmbedIndex(docsDir, { runtimeDataDir });

    expect(second.chunks).toBe(first.chunks);
    expect(second.reused).toBe(0);
    expect(second.embedded).toBe(second.chunks);
  });

  it('OD_DOCS_EMBED=0 → buildDocsEmbedIndex no-op; searchDocsEmbed ném EmbedUnavailableError', async () => {
    const { docsDir, runtimeDataDir } = await makeDocsRoot();
    process.env.OD_DOCS_EMBED = '0';
    const result = await buildDocsEmbedIndex(docsDir, { runtimeDataDir });
    expect(result).toEqual({ chunks: 0, embedded: 0, reused: 0, ms: expect.any(Number) });

    await expect(searchDocsEmbed([docsDir], 'câu hỏi bất kỳ', { runtimeDataDir })).rejects.toBeInstanceOf(
      EmbedUnavailableError,
    );
  });

  it('probe fail (backend không có model) → buildDocsEmbedIndex no-op; searchDocsEmbed ném EmbedUnavailableError', async () => {
    const { docsDir, runtimeDataDir } = await makeDocsRoot();
    state.tagsOk = false;
    const result = await buildDocsEmbedIndex(docsDir, { runtimeDataDir });
    expect(result).toEqual({ chunks: 0, embedded: 0, reused: 0, ms: expect.any(Number) });

    await expect(searchDocsEmbed([docsDir], 'câu hỏi bất kỳ', { runtimeDataDir })).rejects.toBeInstanceOf(
      EmbedUnavailableError,
    );
  });

  it('dedupe: 2 chunk cùng file cách nhau 5 dòng → chỉ 1 kết quả', async () => {
    const docsDir = await mkdtemp(path.join(tmpdir(), 'od-embed-dedupe-'));
    const runtimeDataDir = await mkdtemp(path.join(tmpdir(), 'od-embed-dedupe-runtime-'));
    tempRoots.push(docsDir, runtimeDataDir);
    // Hai heading cách nhau 5 dòng, cùng nằm trong một "bucket" (Math.floor(line/40)).
    await writeFile(
      path.join(docsDir, 'close.md'),
      ['# Mục một', '', 'Nội dung mục một.', '', '## Mục hai', '', 'Nội dung mục hai.', ''].join('\n'),
    );
    await buildDocsEmbedIndex(docsDir, { runtimeDataDir });

    const hits = await searchDocsEmbed([docsDir], 'câu hỏi bất kỳ', { runtimeDataDir, limit: 20 });
    const closeMdHits = hits.filter((h) => h.rel === 'close.md');
    expect(closeMdHits).toHaveLength(1);
  });
});
