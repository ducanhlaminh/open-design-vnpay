import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

describe('dr-comp screen-flow layout routes', () => {
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

  const projectId = `screen-flow-layout-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  async function putFile(name: string, content: unknown): Promise<void> {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, content: JSON.stringify(content) }),
    });
    expect(response.status).toBe(200);
  }

  async function putLayout(body: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/docs-review/screen-flow-layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  it('persists valid positions, drops stale keys, rejects malformed updates, and resets', async () => {
    const modelPath = 'comp/screen-flows/FLOW-A.screen-flow.json';
    await putFile('docs-review/comp/screen-flows/index.json', {
      schema_version: 1,
      generatedAt: '2026-08-25T00:00:00.000Z',
      flows: [{
        id: 'FLOW-A', title: 'Flow A', sourceMode: 'generated',
        files: { model: modelPath, drawio: 'comp/screen-flows/FLOW-A.drawio' },
        screenCount: 2, edgeCount: 1, unlinkedCount: 0, warnings: [],
      }],
      totalScreens: 2,
      warnings: [],
    });
    await putFile(`docs-review/${modelPath}`, {
      schema_version: 1,
      flowId: 'FLOW-A',
      title: 'Flow A',
      sourceMode: 'generated',
      entryScreens: ['A'],
      screens: [
        { key: 'A', name: 'A', origin: 'flow', source: null, line: null, flowIds: [], linked: true },
        { key: 'B', name: 'B', origin: 'flow', source: null, line: null, flowIds: [], linked: true },
      ],
      edges: [{ id: 'A-B', from: 'A', to: 'B', flowIds: [], evidence: [] }],
      unlinkedScreens: [],
      warnings: [],
    });

    const saved = await putLayout({
      flowId: 'FLOW-A',
      positions: { A: { x: 10, y: 20 }, B: { x: 30, y: 40 }, STALE: { x: 50, y: 60 } },
      locked: true,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.layout.flows['FLOW-A'].positions).toEqual({
      A: { x: 10, y: 20 },
      B: { x: 30, y: 40 },
    });

    const read = await fetch(`${baseUrl}/api/projects/${projectId}/docs-review/screen-flow-layout`);
    expect(read.status).toBe(200);
    expect((await read.json()).flows['FLOW-A']).toMatchObject({ locked: true });

    const malformed = await putLayout({ flowId: 'FLOW-A', positions: { A: { x: 'bad', y: 2 } } });
    expect(malformed.status).toBe(400);
    const afterMalformed = await fetch(`${baseUrl}/api/projects/${projectId}/docs-review/screen-flow-layout`);
    expect((await afterMalformed.json()).flows['FLOW-A'].positions.A).toEqual({ x: 10, y: 20 });

    const reset = await putLayout({ flowId: 'FLOW-A', reset: true });
    expect(reset.status).toBe(200);
    expect(reset.body.layout.flows).toEqual({});
  });
});
