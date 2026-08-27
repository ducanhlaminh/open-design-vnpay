// WP dr-flow-improve (2026-08-27): route chọn bản chạy tiếp của SCREEN-FLOW
//   GET /api/projects/:id/docs-review/screen-flow/selection
//        → { variant, source, hasProposal, edited }
//   PUT /api/projects/:id/docs-review/screen-flow/selection { variant }
//        → { ok, variant, screens, downstreamStale } | 400
// Qua HTTP thật (khuôn tests/dr-comp-screens-routes.test.ts) — logic sống
// trong server.ts. Fixture dựng bằng route upload file chung.
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

const vertex = (id: string, label: string, x: number, y: number, w = 200, h = 60) =>
  `<mxCell id="${id}" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" /></mxCell>`;
const edge = (id: string, from: string, to: string, label: string, anchors = 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;') =>
  `<mxCell id="${id}" value="${label}" style="edgeStyle=orthogonalEdgeStyle;html=1;${anchors}" edge="1" parent="1" source="${from}" target="${to}"><mxGeometry relative="1" as="geometry" /></mxCell>`;
const model = (cells: string) =>
  `<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />${cells}</root></mxGraphModel>`;
const AS_IS = model([vertex('od-a', 'A', 0, 0), vertex('od-b', 'B', 300, 0), edge('od-e1', 'od-a', 'od-b', 'đi')].join(''));
const PROPOSED = model([vertex('od-a', 'A', 0, 0), vertex('od-b', 'B', 300, 0), vertex('od-n1', 'N (đề xuất)', 300, 200), edge('od-e1', 'od-a', 'od-n1', 'đi'), edge('od-ne1', 'od-n1', 'od-b', 'tiếp')].join(''));
const mxfile = (pages: Array<[string, string]>) =>
  `<mxfile host="test">${pages.map(([name, g], i) => `<diagram id="p${i}" name="${name}">${g}</diagram>`).join('')}</mxfile>`;

describe('docs-review/screen-flow/selection routes', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as { url: string; server: http.Server };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const projectId = `sf-selection-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  async function putFile(name: string, content: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, content }),
    });
    expect(res.status).toBe(200);
  }
  async function getSel(): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/docs-review/screen-flow/selection`);
    return { status: res.status, body: await res.json() };
  }
  async function putSel(body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/docs-review/screen-flow/selection`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('GET mặc định original/default; PUT sai body → 400; PUT improved khi chưa có proposed → 400; PUT original/improved đổi index + downstreamStale', async () => {
    await putFile('docs-review/docs-feature/prd.md', '# PRD\n\n## A\n\n## B\n');
    await putFile('docs-review/flows/_inputs.json', JSON.stringify({ flows: [{ id: 'SCREEN-FLOW', title: 'Luồng màn hình — X', kind: 'drawio', source: 'docs-feature/prd.md', diagram: 'flows/SCREEN-FLOW/as-is.drawio', files: { asIs: 'flows/SCREEN-FLOW/as-is.drawio' }, counts: { nodes: 2, edges: 1 } }] }));
    await putFile('docs-review/flows/SCREEN-FLOW/as-is.drawio', mxfile([['Luồng', AS_IS]]));
    await putFile(
      'docs-review/flows/SCREEN-FLOW/screens.json',
      JSON.stringify({
        title: 'Luồng màn hình — X',
        source: 'docs-feature/prd.md',
        cells: { 'od-a': 'prd__A', 'od-b': 'prd__B' },
        names: { prd__A: 'A', prd__B: 'B' },
        screens: [
          { key: 'prd__A', code: 'A', name: 'A', anchorText: '## A', cell: 'od-a' },
          { key: 'prd__B', code: 'B', name: 'B', anchorText: '## B', cell: 'od-b' },
        ],
        excluded: [],
      }),
    );

    const initial = await getSel();
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ variant: 'original', source: 'default', hasProposal: false, edited: false });

    expect((await putSel({ variant: 'xxx' })).status).toBe(400);
    const noProposal = await putSel({ variant: 'improved' });
    expect(noProposal.status).toBe(400);
    expect(String(noProposal.body.error)).toContain('proposed.drawio');

    // Có bản cải thiện (proposed.drawio 2 trang + screens.improved.json) → chọn được.
    await putFile('docs-review/flows/SCREEN-FLOW/proposed.drawio', mxfile([['Nguyên bản', AS_IS], ['Cải thiện', PROPOSED]]));
    await putFile('docs-review/flows/SCREEN-FLOW/proposed.edited.json', JSON.stringify({ at: 't' }));
    await putFile(
      'docs-review/flows/SCREEN-FLOW/screens.improved.json',
      JSON.stringify({ schema_version: 1, generatedAt: 't', screens: [
        { key: 'prd__A', name: 'A', cell: 'od-a', provenance: 'document' },
        { key: 'prd__B', name: 'B', cell: 'od-b', provenance: 'document' },
        { key: 'prd__NEW-n', name: 'N', cell: 'od-n1', provenance: 'proposed', why: 'Đề xuất cải thiện UX-01' },
      ] }),
    );
    const improved = await putSel({ variant: 'improved' });
    expect(improved.status).toBe(200);
    expect(improved.body.ok).toBe(true);
    expect(improved.body.variant).toBe('improved');
    expect(improved.body.downstreamStale).toBe(false);
    expect(improved.body.screens.map((s: { key: string }) => s.key).sort()).toEqual(['prd__A', 'prd__B', 'prd__NEW-n']);
    expect(improved.body.screens.find((s: { key: string }) => s.key === 'prd__NEW-n').provenance).toBe('proposed');

    const afterImproved = await getSel();
    expect(afterImproved.body).toMatchObject({ variant: 'improved', source: 'user', hasProposal: true, edited: true });

    // index.json + flowchart theo trang 1; discovery có màn đề xuất trong comp/_screens.json.
    const index = await fetch(`${baseUrl}/api/projects/${projectId}/files/docs-review/flows/index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (Array.isArray(index)) {
      expect(index[0].variant).toBe('improved');
      expect(index[0].selection).toEqual({ variant: 'improved', source: 'user' });
    }
    const screensRes = await fetch(`${baseUrl}/api/projects/${projectId}/docs-review/screens`).then((r) => r.json());
    expect(screensRes.manifest.screens.map((s: { key: string }) => s.key)).toContain('prd__NEW-n');

    // dr-comp đã chạy (comp/index.json) → downstreamStale.
    await putFile('docs-review/comp/index.json', JSON.stringify({ screens: [] }));
    const back = await putSel({ variant: 'original' });
    expect(back.status).toBe(200);
    expect(back.body.variant).toBe('original');
    expect(back.body.downstreamStale).toBe(true);
    expect(back.body.screens.map((s: { key: string }) => s.key).sort()).toEqual(['prd__A', 'prd__B']);
    const screensAfter = await fetch(`${baseUrl}/api/projects/${projectId}/docs-review/screens`).then((r) => r.json());
    expect(screensAfter.manifest.screens.map((s: { key: string }) => s.key)).not.toContain('prd__NEW-n');
  });
});
