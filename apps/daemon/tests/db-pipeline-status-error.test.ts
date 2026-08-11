// setProjectPipelineStatus's `error` field: persists alongside a 'failed'
// patch, and is implicitly CLEARED by any later patch that moves the status
// away from 'failed' — a stale "why did it fail" from an earlier run must
// never survive onto a later succeeded/running/idle status (see the invariant
// note on PipelineRunStateRow.error in db.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  getProjectPipelineState,
  insertProject,
  openDatabase,
  setProjectPipelineStatus,
} from '../src/db.js';

describe('setProjectPipelineStatus error field', () => {
  let tempDir: string;
  let db: any;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-pipeline-status-error-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, {
      id: 'PROJ',
      name: 'PROJ',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'pipeline' },
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists error alongside a failed status', () => {
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'Chưa cấu hình Nguồn tài liệu' });
    const state = getProjectPipelineState(db, 'PROJ');
    expect(state.docs?.status).toBe('failed');
    expect(state.docs?.error).toBe('Chưa cấu hình Nguồn tài liệu');
  });

  it('a later succeeded patch clears a previously-stored error', () => {
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'boom' });
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'succeeded' });
    const state = getProjectPipelineState(db, 'PROJ');
    expect(state.docs?.status).toBe('succeeded');
    expect(state.docs?.error).toBeUndefined();
  });

  it('a later running patch (re-run started) clears a previously-stored error', () => {
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'boom' });
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'running' });
    const state = getProjectPipelineState(db, 'PROJ');
    expect(state.docs?.status).toBe('running');
    expect(state.docs?.error).toBeUndefined();
  });

  it('a later idle patch (downstream reset) clears a previously-stored error', () => {
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'boom' });
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'idle' });
    const state = getProjectPipelineState(db, 'PROJ');
    expect(state.docs?.status).toBe('idle');
    expect(state.docs?.error).toBeUndefined();
  });

  it('a patch with no status change (e.g. only subConversations) preserves the existing error', () => {
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'boom' });
    setProjectPipelineStatus(db, 'PROJ', 'docs', { subConversations: [{ id: 'c1', title: 'x', status: 'failed' }] });
    const state = getProjectPipelineState(db, 'PROJ');
    expect(state.docs?.status).toBe('failed');
    expect(state.docs?.error).toBe('boom');
  });

  it('a later failed patch with its OWN error replaces the previous one', () => {
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'first reason' });
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'second reason' });
    const state = getProjectPipelineState(db, 'PROJ');
    expect(state.docs?.error).toBe('second reason');
  });

  it('a failed patch with NO error keeps a prior error (legacy call sites that never pass one)', () => {
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed', error: 'first reason' });
    setProjectPipelineStatus(db, 'PROJ', 'docs', { status: 'failed' });
    const state = getProjectPipelineState(db, 'PROJ');
    expect(state.docs?.status).toBe('failed');
    expect(state.docs?.error).toBe('first reason');
  });
});
