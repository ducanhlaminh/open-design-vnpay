import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateScreenFlowRecoveryArtifacts } from '../src/pipeline-recovery.js';

let cwd: string;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'od-pipeline-recovery-topology-'));
  await fs.mkdir(path.join(cwd, 'comp', 'screen-flows'), { recursive: true });
});
afterEach(async () => fs.rm(cwd, { recursive: true, force: true }));

function screen(key: string, name = key) {
  return {
    key,
    name,
    origin: 'flow',
    source: 'docs-feature/buy.md',
    line: 1,
    flowIds: ['FLOW-buy'],
    linked: true,
  };
}

function edge(from: string, to: string, kind: 'primary' | 'branch' | 'return' | 'secondary' | 'inferred' = 'primary') {
  return { id: `${from}-${to}-${kind}`, from, to, kind, flowIds: ['FLOW-buy'], evidence: [] };
}

async function writeArtifacts(models: Array<Record<string, unknown>>): Promise<void> {
  const flows = [];
  for (const model of models) {
    const id = String(model.flowId);
    const rel = `comp/screen-flows/${id}.screen-flow.json`;
    await fs.writeFile(path.join(cwd, rel), JSON.stringify(model));
    flows.push({
      id,
      title: String(model.title ?? id),
      sourceMode: 'generated',
      files: { model: rel, drawio: `comp/screen-flows/${id}.drawio` },
      screenCount: (model.screens as unknown[]).length,
      edgeCount: (model.edges as unknown[]).length,
      unlinkedCount: (model.unlinkedScreens as unknown[]).length,
      warnings: [],
    });
  }
  await fs.writeFile(path.join(cwd, 'comp', 'screen-flows', 'index.json'), JSON.stringify({
    schema_version: 1,
    generatedAt: '2026-08-25T00:00:00.000Z',
    flows,
    totalScreens: models.reduce((sum, model) => sum + (model.screens as unknown[]).length, 0),
    warnings: [],
  }));
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    flowId: 'FLOW-buy',
    title: 'Mua SIM',
    sourceMode: 'generated',
    entryScreens: ['A'],
    screens: [screen('A', 'Trang chủ'), screen('B', 'Chi tiết gói')],
    edges: [edge('A', 'B')],
    unlinkedScreens: [],
    warnings: [],
    ...overrides,
  };
}

describe('dr-comp screen-flow recovery gate', () => {
  it('pass topology liên thông bằng primary và trả các flow đã kiểm chứng', async () => {
    await writeArtifacts([model()]);
    await expect(validateScreenFlowRecoveryArtifacts(cwd)).resolves.toEqual({
      ok: true,
      issues: [],
      repaired: ['FLOW-buy'],
      blocking: false,
    });
  });

  it('UNLINKED là CẢNH BÁO (advisory) — không set blocking, vẫn trả đúng từng screen cần hỗ trợ', async () => {
    await writeArtifacts([
      model(),
      model({
        flowId: 'UNLINKED',
        title: 'Chưa xác định điều hướng',
        entryScreens: [],
        screens: [screen('VOUCHER', 'Mã voucher')],
        edges: [],
        unlinkedScreens: ['VOUCHER'],
      }),
    ]);
    const result = await validateScreenFlowRecoveryArtifacts(cwd);
    // ok mirrors "còn issue nào không" (không đổi — chỉ cảnh báo); blocking
    // là cờ mới cho "có chặn stage hay không".
    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(false);
    expect(result.issues.join('\n')).toContain('VOUCHER');
    expect(result.issues.join('\n')).toContain('Mã voucher');
    expect(result.needsHelp).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'VOUCHER', name: 'Mã voucher', flowId: 'UNLINKED', advisory: true }),
    ]));
    expect(result.repaired).toEqual(['FLOW-buy']);
  });

  it('return/secondary không chứng minh reachable (advisory) và nêu screen unreachable cụ thể', async () => {
    await writeArtifacts([model({ edges: [edge('A', 'B', 'secondary')], unlinkedScreens: [] })]);
    const result = await validateScreenFlowRecoveryArtifacts(cwd);
    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(false);
    expect(result.issues.join('\n')).toContain('B');
    expect(result.issues.join('\n')).toContain('Chi tiết gói');
    expect(result.needsHelp).toEqual([
      expect.objectContaining({ key: 'B', flowId: 'FLOW-buy', reason: expect.stringContaining('reachable'), advisory: true }),
    ]);
  });

  it('orphan (screen cô lập, không cạnh nào) là advisory, không blocking', async () => {
    // Không cạnh nào: 'A' (entry) có degree 0 → orphan; 'B' có degree 0 và
    // không reachable từ entry → unreachable (ưu tiên lý do unreachable).
    await writeArtifacts([model({ edges: [], unlinkedScreens: [] })]);
    const result = await validateScreenFlowRecoveryArtifacts(cwd);
    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(false);
    expect(result.needsHelp).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'A', flowId: 'FLOW-buy', reason: expect.stringContaining('orphan'), advisory: true }),
      expect.objectContaining({ key: 'B', flowId: 'FLOW-buy', reason: expect.stringContaining('reachable'), advisory: true }),
    ]));
  });

  it('một screen thuộc ≥2 flow là BLOCKING (multi-flow ownership)', async () => {
    await writeArtifacts([
      model(),
      model({
        flowId: 'FLOW-other',
        title: 'Luồng khác',
        entryScreens: ['A'],
        // 'A' cũng thuộc FLOW-buy ở model() phía trên — trùng ownership.
        screens: [screen('A', 'Trang chủ')],
        edges: [],
        unlinkedScreens: [],
      }),
    ]);
    const result = await validateScreenFlowRecoveryArtifacts(cwd);
    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.needsHelp).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'A', advisory: false, reason: expect.stringContaining('nhiều flow') }),
    ]));
  });

  it('coverage lệch (totalScreens sai so với số screen duy nhất) là BLOCKING', async () => {
    await writeArtifacts([model()]);
    const indexPath = path.join(cwd, 'comp', 'screen-flows', 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    index.totalScreens = 99;
    await fs.writeFile(indexPath, JSON.stringify(index));
    const result = await validateScreenFlowRecoveryArtifacts(cwd);
    expect(result.ok).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.issues.join('\n')).toContain('coverage lệch');
  });

  it('fail-shut khi index/model thiếu hoặc hỏng (BLOCKING)', async () => {
    await expect(validateScreenFlowRecoveryArtifacts(cwd)).resolves.toMatchObject({ ok: false, repaired: [], blocking: true });
    await fs.writeFile(path.join(cwd, 'comp', 'screen-flows', 'index.json'), JSON.stringify({
      schema_version: 1,
      flows: [{ id: 'FLOW-buy', files: { model: 'comp/screen-flows/missing.json' } }],
      totalScreens: 2,
    }));
    const missing = await validateScreenFlowRecoveryArtifacts(cwd);
    expect(missing.ok).toBe(false);
    expect(missing.blocking).toBe(true);
    expect(missing.issues.join('\n')).toContain('missing.json');
  });
});
