import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  insertConversation,
  insertProject,
  openDatabase,
  upsertMessage,
} from '../src/db.js';
import {
  buildFeedbackRecords,
  pullMergedFeedback,
  type FeedbackRecord,
} from '../src/feedback.js';
import type { MediaClient } from '../src/kg-sync/media-client.js';

describe('feedback collection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-feedback-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('buildFeedbackRecords keeps only genuine user prompts', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, { id: 'conv-1', projectId: 'proj-1', title: 'c', createdAt: now, updatedAt: now });

    // trigger prompt — excluded
    upsertMessage(db, 'conv-1', { id: 'pipeline-user-x', role: 'user', content: 'KICKOFF' });
    // assistant reply — excluded (not a user role)
    upsertMessage(db, 'conv-1', { id: 'assistant-1', role: 'assistant', content: 'done' });
    // genuine feedback prompt — kept
    upsertMessage(db, 'conv-1', {
      id: 'real-uuid-1',
      role: 'user',
      content: 'sửa lại layout cho gọn',
      preTurnFileNames: ['docs-to-html/screen.html'],
    });
    // the skill's own invocation — excluded
    upsertMessage(db, 'conv-1', { id: 'real-uuid-2', role: 'user', content: 'chạy summary-feedback đi' });

    const records = buildFeedbackRecords(db, 'proj-1', 'anh');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      user: 'anh',
      project: 'proj-1',
      prompt: 'sửa lại layout cho gọn',
      conversationId: 'conv-1',
      outputUserSaw: ['docs-to-html/screen.html'],
    });
  });

  it('pullMergedFeedback merges every install file and ignores non-feedback paths', async () => {
    const rec = (user: string, prompt: string, ts: number): FeedbackRecord => ({
      user, project: 'proj-1', prompt, ts, conversationId: 'c', outputUserSaw: [],
    });
    const files: Record<string, FeedbackRecord[]> = {
      'feedback/anh.jsonl': [rec('anh', 'a1', 30), rec('anh', 'a2', 10)],
      'feedback/bob.jsonl': [rec('bob', 'b1', 20)],
      'docs/output.html': [],
    };
    const fakeClient = {
      listFiles: async () => Object.keys(files).map((p) => ({ path: p })),
      downloadFile: async (_p: string, fp: string) =>
        Buffer.from((files[fp] ?? []).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'),
    } as unknown as MediaClient;

    const out = await pullMergedFeedback('proj-1', tempDir, { client: fakeClient });
    expect(out.files).toBe(2); // only the two feedback/*.jsonl, not docs/output.html
    expect(out.records).toBe(3);

    const lines = readFileSync(out.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l) as FeedbackRecord);
    // merged across installs and sorted by ts ascending
    expect(parsed.map((p) => p.prompt)).toEqual(['a2', 'b1', 'a1']);
    expect(new Set(parsed.map((p) => p.user))).toEqual(new Set(['anh', 'bob']));
  });
});
