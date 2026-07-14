import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { test } from 'vitest';

import { generateProjectExports } from '../src/pipeline-exports.js';
import { isExportArtifact, stagesForOutput } from '../src/pipelines.js';

function projectCwd(): string {
  return mkdtempSync(join(tmpdir(), 'od-exports-'));
}

const CJ = {
  personas: [{ name: 'Chị Lan', occupation: 'Kế toán', goals: ['Chuyển tiền nhanh'] }],
  journeys: [
    {
      name: 'Chuyển tiền nội bộ',
      goal: 'Hoàn tất chuyển tiền',
      stages: [
        { name: 'Đăng nhập', user_actions: ['Nhập OTP'], pain_points: ['OTP chậm'] },
        { name: 'Xác nhận', system_responses: ['Hiển thị kết quả'] },
      ],
    },
  ],
};

const UX = {
  screens: [
    {
      id: 'scr-login',
      name: 'Đăng nhập',
      navigation_group: 'Auth',
      screen_intent: 'Xác thực người dùng',
      components: [{ component_type: 'input', label: 'Số điện thoại', required: true }],
    },
  ],
};

test('generateProjectExports renders cj/ux/ui-react MD into exports/ and skips absent docs', async () => {
  const cwd = projectCwd();
  const wf = join(cwd, 'docs-to-ui');
  mkdirSync(join(wf, 'react', 'src', 'screens'), { recursive: true });
  mkdirSync(join(wf, 'react', 'src', 'components', 'app'), { recursive: true });
  mkdirSync(join(wf, 'react', 'src', 'components', 'ui'), { recursive: true });
  mkdirSync(join(wf, 'react', 'src', 'lib'), { recursive: true });
  writeFileSync(join(wf, 'app-cj.json'), JSON.stringify(CJ));
  writeFileSync(join(wf, 'app-ux-spec.json'), JSON.stringify(UX));
  writeFileSync(join(wf, 'react', 'flow.json'), JSON.stringify([
    { from: 'home', to: 'transfer', type: 'navigate', label: 'Chuyển tiền' },
  ]));
  // Source: blank-line runs + a ``` inside code stress the verbatim guarantee.
  writeFileSync(join(wf, 'react', 'src', 'App.tsx'), 'export default function App() {\n\n\n  return null; // ```\n}\n');
  writeFileSync(join(wf, 'react', 'src', 'screens', 'home.tsx'), 'export const Home = () => <div>Trang chủ</div>;\n');
  writeFileSync(join(wf, 'react', 'src', 'components', 'app', 'AccountRow.tsx'), 'export const AccountRow = () => null;\n');
  // Template scaffold — must NOT be exported.
  writeFileSync(join(wf, 'react', 'src', 'components', 'ui', 'button.tsx'), 'export const Button = () => null;\n');
  writeFileSync(join(wf, 'react', 'src', 'lib', 'utils.ts'), 'export const cn = () => "";\n');

  const written = await generateProjectExports(cwd, 'DEMO');
  assert.deepEqual(
    written.sort(),
    ['exports/customer-journey.md', 'exports/ui-react.zip', 'exports/ux-spec.md'],
  );
  // No prototype/ pages → no ui-html.md (and no pandoc needed).
  assert.equal(existsSync(join(cwd, 'exports', 'ui-html.md')), false);

  const cj = readFileSync(join(cwd, 'exports', 'customer-journey.md'), 'utf8');
  assert.match(cj, /# Customer Journey — DEMO/);
  assert.match(cj, /Chuyển tiền nội bộ/);
  assert.match(cj, /```mermaid/);

  const ux = readFileSync(join(cwd, 'exports', 'ux-spec.md'), 'utf8');
  assert.match(ux, /# UX Spec — DEMO/);
  assert.match(ux, /Đăng nhập/);
  assert.match(ux, /Số điện thoại/);

  // ui-react.zip = one MD per source file, mirroring the tree, + _index.md.
  const zip = await JSZip.loadAsync(readFileSync(join(cwd, 'exports', 'ui-react.zip')));
  const entries = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir).sort();
  assert.deepEqual(entries, [
    '_index.md',
    'flow.json.md',
    'src/App.tsx.md',
    'src/components/app/AccountRow.tsx.md',
    'src/screens/home.tsx.md',
  ]);
  const index = await zip.files['_index.md']!.async('string');
  assert.match(index, /# UI-SPEC \(ReactJS\) — DEMO/);
  assert.match(index, /`src\/screens\/home\.tsx\.md`/);
  assert.doesNotMatch(index, /Sơ đồ điều hướng/);

  const app = await zip.files['src/App.tsx.md']!.async('string');
  assert.match(app, /^# `src\/App\.tsx`/);
  // Verbatim: blank-line runs survive, and the ``` inside code stays fenced
  // (the file's fence must be longer than 3 backticks).
  assert.match(app, /App\(\) \{\n\n\n  return null; \/\/ ```/);
  assert.match(app, /````tsx\nexport default function App/);
  // Template scaffold stays out.
  assert.equal(entries.some((n) => /button\.tsx|lib\/utils\.ts/.test(n)), false);
});

test('ui-react.zip is byte-stable across regenerations (content-hash push stays a no-op)', async () => {
  const cwd = projectCwd();
  const wf = join(cwd, 'docs-to-ui');
  mkdirSync(join(wf, 'react', 'src'), { recursive: true });
  writeFileSync(join(wf, 'react', 'src', 'App.tsx'), 'export default () => null;\n');

  await generateProjectExports(cwd, 'DEMO');
  const first = readFileSync(join(cwd, 'exports', 'ui-react.zip'));
  await generateProjectExports(cwd, 'DEMO');
  const second = readFileSync(join(cwd, 'exports', 'ui-react.zip'));
  assert.ok(first.equals(second), 'zip bytes must be identical for identical sources');
});

test('generateProjectExports starts from an empty exports/ — stale MD never survives a re-push', async () => {
  const cwd = projectCwd();
  const wf = join(cwd, 'docs-to-ui');
  mkdirSync(wf, { recursive: true });
  mkdirSync(join(cwd, 'exports'), { recursive: true });
  writeFileSync(join(cwd, 'exports', 'ui-react.md'), 'STALE');
  writeFileSync(join(wf, 'app-cj.json'), JSON.stringify(CJ));

  const written = await generateProjectExports(cwd, 'DEMO');
  assert.deepEqual(written, ['exports/customer-journey.md']);
  // The react source is gone → its stale export is gone too.
  assert.equal(existsSync(join(cwd, 'exports', 'ui-react.md')), false);
});

test('generateProjectExports reads sources from RETIRED workflow folders too', async () => {
  const cwd = projectCwd();
  const wf = join(cwd, 'docs-to-html');
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, 'app-ux-spec.json'), JSON.stringify(UX));

  const written = await generateProjectExports(cwd, 'LEGACY');
  assert.deepEqual(written, ['exports/ux-spec.md']);
});

test('ui-html.md is rendered from prototype pages via pandoc', async () => {
  // pandoc is a machine prerequisite for od (installed in setup) — this test
  // exercises the real binary end-to-end.
  const cwd = projectCwd();
  const wf = join(cwd, 'docs-to-ui');
  mkdirSync(join(wf, 'prototype'), { recursive: true });
  writeFileSync(
    join(wf, 'prototype', 'home.html'),
    '<html><body><main><h1>Trang chủ</h1><p>Nội dung demo.</p></main></body></html>',
  );

  const written = await generateProjectExports(cwd, 'DEMO');
  assert.deepEqual(written, ['exports/ui-html.md']);
  const md = readFileSync(join(cwd, 'exports', 'ui-html.md'), 'utf8');
  assert.match(md, /# UI-SPEC HTML — DEMO/);
  assert.match(md, /Nội dung demo/);
  // The page's own h1 is demoted under the numbered screen section.
  assert.match(md, /### Trang chủ/);
});

test('exports/ paths are derived artifacts: never attribute to a stage, flagged by isExportArtifact', () => {
  assert.equal(isExportArtifact('exports/customer-journey.md'), true);
  assert.equal(isExportArtifact('exports'), true);
  assert.equal(isExportArtifact('docs-to-ui/exports/x.md'), false);
  // MD names echo output-ish names — they must not light stages.
  assert.deepEqual(stagesForOutput('exports/customer-journey.md'), []);
  assert.deepEqual(stagesForOutput('exports/ux-spec.md'), []);
  assert.deepEqual(stagesForOutput('exports/ui-html.md'), []);
});
