import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ScreenInput } from '../src/screen-components.js';
import { decodeMxfile, loadGraph } from '../src/flow-ux/mxfile.js';
import {
  buildScreenFlowArtifacts,
  classifySourceScreenFlow,
  collapseToScreenFlow,
  renderScreenFlowDrawio,
} from '../src/screen-flow.js';
import type { FlowchartDoc } from '../src/flow-ux/to-flowchart.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const screen = (key: string, flowId = 'FLOW-buy', origin: ScreenInput['origin'] = 'flow'): ScreenInput => ({
  key,
  name: key === 'A' ? 'Chọn quốc gia' : key === 'B' ? 'Chọn gói cước' : key,
  order: key === 'A' ? 0 : key === 'B' ? 1 : 2,
  flowId,
  flowTitle: 'Mua SIM',
  source: 'docs-feature/buy.md',
  steps: [],
  navOut: [],
  navIn: [],
  findings: [],
  platformHint: 'mobile',
  origin,
});

const flow = (nodes: FlowchartDoc['nodes'], edges: FlowchartDoc['edges']): FlowchartDoc => ({
  id: 'FLOW-buy',
  title: 'Mua SIM',
  source: 'docs-feature/buy.md',
  nodes,
  edges,
});

describe('screen-flow pure contract', () => {
  it('classifies by graph structure, not filename, and rejects a business flow with repeated steps on one screen', () => {
    const source = flow(
      [
        { id: 's', type: 'start', label: 'Bắt đầu' },
        { id: 'a', type: 'action', label: 'Chọn quốc gia', screen: 'A' },
        { id: 'd', type: 'decision', label: 'Loại SIM?' },
        { id: 'b', type: 'action', label: 'Chọn gói', screen: 'B' },
        { id: 'e', type: 'end', label: 'Xong' },
      ],
      [{ from: 's', to: 'a' }, { from: 'a', to: 'd' }, { from: 'd', to: 'b', label: 'eSIM' }, { from: 'b', to: 'e' }],
    );
    expect(classifySourceScreenFlow(source, new Set(['A', 'B']))).toEqual({ reusable: true, reasons: [] });

    source.nodes.splice(2, 0, { id: 'a2', type: 'action', label: 'Nhập dữ liệu', screen: 'A' });
    source.edges = [{ from: 's', to: 'a' }, { from: 'a', to: 'a2' }, { from: 'a2', to: 'd' }, { from: 'd', to: 'b' }, { from: 'b', to: 'e' }];
    expect(classifySourceScreenFlow(source, new Set(['A', 'B'])).reusable).toBe(false);
  });

  it('collapses branches and cycles without a depth cap, dedupes exact edges, keeps decision conditions, and accepts mapped decisions', () => {
    const middle = Array.from({ length: 7 }, (_, i) => ({ id: `x${i}`, type: 'action' as const, label: `System ${i}` }));
    const source = flow(
      [
        { id: 'a', type: 'action', label: 'Bấm tiếp tục', screen: 'A' },
        ...middle,
        { id: 'pick', type: 'decision', label: 'Chọn loại SIM', screen: 'B' },
        { id: 'loop', type: 'action', label: 'Thử lại' },
      ],
      [
        { from: 'a', to: 'x0' },
        ...middle.slice(0, -1).map((n, i) => ({ from: n.id, to: middle[i + 1]!.id })),
        { from: 'x6', to: 'pick', label: 'eSIM' },
        { from: 'x6', to: 'pick', label: 'eSIM' },
        { from: 'x3', to: 'loop', label: 'Lỗi' },
        { from: 'loop', to: 'x2' },
      ],
    );
    const model = collapseToScreenFlow(source, [screen('A'), screen('B')]);
    expect(model.flowId).toBe('FLOW-buy');
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({ from: 'A', to: 'B', via: 'Bấm tiếp tục', condition: 'eSIM' });
    expect(model.screens.find((s) => s.key === 'B')?.linked).toBe(true);
  });

  it('does not invent a bridge through a removed mapped screen and keeps added/doc-only screens unlinked', () => {
    const source = flow(
      [
        { id: 'a', type: 'action', label: 'A', screen: 'A' },
        { id: 'removed', type: 'action', label: 'Removed', screen: 'REMOVED' },
        { id: 'b', type: 'action', label: 'B', screen: 'B' },
      ],
      [{ from: 'a', to: 'removed' }, { from: 'removed', to: 'b' }],
    );
    const model = collapseToScreenFlow(source, [screen('A'), screen('B'), screen('DOC', '', 'user')]);
    expect(model.edges).toEqual([]);
    expect(model.unlinkedScreens).toEqual(['A', 'B', 'DOC']);
    expect(model.edges.every((e) => model.screens.some((s) => s.key === e.from) && model.screens.some((s) => s.key === e.to))).toBe(true);
  });

  it('renders deterministic one-page draw.io with stable screen metadata and an unlinked group', () => {
    const model = collapseToScreenFlow(
      flow(
        [{ id: 'a', type: 'action', label: 'A', screen: 'A' }, { id: 'b', type: 'action', label: 'B', screen: 'B' }],
        [{ from: 'a', to: 'b' }],
      ),
      [screen('A'), screen('B'), screen('DOC', '', 'doc')],
    );
    const first = renderScreenFlowDrawio(model);
    expect(renderScreenFlowDrawio(model)).toBe(first);
    expect(first.match(/<diagram\b/g)).toHaveLength(1);
    expect(first).toContain('od-screen-key="A"');
    expect(first).toContain('Chưa xác định điều hướng');
  });
});

describe('buildScreenFlowArtifacts', () => {
  it('reuses a structural Draw.io screen-flow, converts reusable Mermaid, generates business flow, and writes UNLINKED for doc-only screens', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-screen-flow-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'flows/FLOW-buy'), { recursive: true });
    fs.mkdirSync(path.join(root, 'flows/FLOW-mermaid'), { recursive: true });
    fs.mkdirSync(path.join(root, 'flows/FLOW-business'), { recursive: true });

    const reusable = flow(
      [
        { id: 'a', type: 'action', label: 'A', screen: 'A' },
        { id: 'd', type: 'decision', label: 'Loại SIM?' },
        { id: 'b', type: 'action', label: 'B', screen: 'B' },
      ],
      [{ from: 'a', to: 'd' }, { from: 'd', to: 'b', label: 'eSIM' }],
    );
    const mermaid = {
      ...reusable,
      id: 'FLOW-mermaid',
      nodes: reusable.nodes.map((n) => ({ ...n, ...(n.screen ? { screen: n.screen === 'A' ? 'M1' : 'M2' } : {}) })),
    };
    const business = {
      ...reusable,
      id: 'FLOW-business',
      nodes: [
        { id: 'a', type: 'action' as const, label: 'A', screen: 'C1' },
        { id: 'sys', type: 'action' as const, label: 'Billing xử lý' },
        { id: 'b', type: 'action' as const, label: 'B', screen: 'C2' },
      ],
      edges: [{ from: 'a', to: 'sys' }, { from: 'sys', to: 'b' }],
    };
    for (const doc of [reusable, mermaid, business]) fs.writeFileSync(path.join(root, `flows/${doc.id}.flowchart.json`), JSON.stringify(doc));
    fs.writeFileSync(path.join(root, 'flows/FLOW-buy/as-is.drawio'), '<mxfile><diagram id="p" name="Hiện trạng"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="A" vertex="1" parent="1"/><mxCell id="d" value="Loại SIM?" style="rhombus" vertex="1" parent="1"/><mxCell id="b" value="B" vertex="1" parent="1"/><mxCell id="e1" edge="1" source="a" target="d" parent="1"/><mxCell id="e2" value="eSIM" edge="1" source="d" target="b" parent="1"/></root></mxGraphModel></diagram></mxfile>');
    fs.writeFileSync(path.join(root, 'flows/FLOW-mermaid/as-is.mmd'), 'flowchart TD\n a[A] --> b[B]\n');
    fs.writeFileSync(path.join(root, 'flows/FLOW-business/as-is.drawio'), '<mxfile><diagram id="p"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>');
    fs.writeFileSync(path.join(root, 'flows/index.json'), JSON.stringify([
      { id: 'FLOW-buy', title: 'Buy', kind: 'drawio', screens: [{ key: 'A', name: 'A' }, { key: 'B', name: 'B' }], files: { asIs: 'flows/FLOW-buy/as-is.drawio', flowchart: 'flows/FLOW-buy.flowchart.json' } },
      { id: 'FLOW-mermaid', title: 'Mermaid', kind: 'mermaid', screens: [{ key: 'M1', name: 'M1' }, { key: 'M2', name: 'M2' }], files: { asIs: 'flows/FLOW-mermaid/as-is.mmd', flowchart: 'flows/FLOW-mermaid.flowchart.json' } },
      { id: 'FLOW-business', title: 'Business', kind: 'drawio', screens: [{ key: 'C1', name: 'C1' }, { key: 'C2', name: 'C2' }], files: { asIs: 'flows/FLOW-business/as-is.drawio', flowchart: 'flows/FLOW-business.flowchart.json' } },
    ]));

    const result = await buildScreenFlowArtifacts(root, [
      screen('A'), screen('B'), screen('M1', 'FLOW-mermaid'), screen('M2', 'FLOW-mermaid'),
      screen('C1', 'FLOW-business'), screen('C2', 'FLOW-business'), screen('DOC', '', 'doc'),
    ]);
    expect(result.flows.map((f) => [f.id, f.sourceMode])).toEqual([
      ['FLOW-buy', 'reused'], ['FLOW-mermaid', 'reused'], ['FLOW-business', 'generated'], ['UNLINKED', 'generated'],
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'comp/screen-flows/UNLINKED.screen-flow.json'), 'utf8')).unlinkedScreens).toEqual(['DOC']);
    const reusedXml = fs.readFileSync(path.join(root, 'comp/screen-flows/FLOW-buy.drawio'), 'utf8');
    expect(reusedXml).toContain('id="a"');
    expect(reusedXml).toContain('od-screen-key="A"');
    const graph = loadGraph(decodeMxfile(reusedXml)[0]!.graphXml);
    expect(graph('mxCell[id="a"]').attr('od-screen-key')).toBe('A');
    expect(graph('mxCell[id="d"]').attr('style')).toContain('rhombus');

    fs.writeFileSync(path.join(root, 'screens-overrides.json'), JSON.stringify({ schema_version: 1, overrides: [{ action: 'rename', key: 'A', name: 'Quốc gia mới' }] }));
    const renamed = { ...screen('A'), name: 'Quốc gia mới' };
    const renamedResult = await buildScreenFlowArtifacts(root, [renamed, screen('B'), screen('M1', 'FLOW-mermaid'), screen('M2', 'FLOW-mermaid'), screen('C1', 'FLOW-business'), screen('C2', 'FLOW-business')]);
    expect(renamedResult.flows[0]?.sourceMode).toBe('reused');
    expect(loadGraph(decodeMxfile(fs.readFileSync(path.join(root, 'comp/screen-flows/FLOW-buy.drawio'), 'utf8'))[0]!.graphXml)('mxCell[id="a"]').attr('value')).toBe('Quốc gia mới');

    fs.writeFileSync(path.join(root, 'screens-overrides.json'), JSON.stringify({ schema_version: 1, overrides: [{ action: 'add', source: 'docs-feature/buy.md', code: 'NEW', name: 'Mới' }] }));
    const addedResult = await buildScreenFlowArtifacts(root, [renamed, screen('B'), screen('M1', 'FLOW-mermaid'), screen('M2', 'FLOW-mermaid'), screen('C1', 'FLOW-business'), screen('C2', 'FLOW-business'), screen('NEW', '', 'user')]);
    expect(addedResult.flows[0]?.sourceMode).toBe('generated');

    fs.writeFileSync(path.join(root, 'screens-overrides.json'), JSON.stringify({ schema_version: 1, overrides: [{ action: 'remove', key: 'B' }] }));
    const removedResult = await buildScreenFlowArtifacts(root, [renamed, screen('M1', 'FLOW-mermaid'), screen('M2', 'FLOW-mermaid'), screen('C1', 'FLOW-business'), screen('C2', 'FLOW-business')]);
    expect(removedResult.flows.find((entry) => entry.id === 'FLOW-buy')).toMatchObject({ sourceMode: 'generated', edgeCount: 0, unlinkedCount: 1 });
  });

  it('is fail-soft for malformed inputs and produces deterministic model bytes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-screen-flow-bad-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'flows'), { recursive: true });
    fs.writeFileSync(path.join(root, 'flows/index.json'), '[{"id":"BROKEN","title":"Broken","kind":"drawio","screens":[],"files":{"flowchart":"flows/BROKEN.flowchart.json"}}]');
    fs.writeFileSync(path.join(root, 'flows/BROKEN.flowchart.json'), '{oops');
    const first = await buildScreenFlowArtifacts(root, [screen('DOC', '', 'doc')], { generatedAt: 'fixed' });
    const bytes = fs.readFileSync(path.join(root, 'comp/screen-flows/UNLINKED.screen-flow.json'), 'utf8');
    const second = await buildScreenFlowArtifacts(root, [screen('DOC', '', 'doc')], { generatedAt: 'fixed' });
    expect(fs.readFileSync(path.join(root, 'comp/screen-flows/UNLINKED.screen-flow.json'), 'utf8')).toBe(bytes);
    expect(first.warnings.length).toBeGreaterThan(0);
    expect(second.totalScreens).toBe(1);
  });
});
