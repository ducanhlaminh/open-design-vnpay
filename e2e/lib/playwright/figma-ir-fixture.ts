// Rounded-down copy of the minimal foundation+ui-lib IR pair in
// apps/daemon/tests/figma-ds-import.test.ts — copied, not imported: e2e/AGENTS.md
// forbids treating another app's tests/ as a shared helper, and `e2e/lib/**`
// must stay TypeScript-only (scripts/guard.ts), so the fixture payloads live
// here as typed objects instead of raw .ir.json files.
//
// Two files mirror the real-world Fig Pipeline export split: a foundation
// export owning the token, and a UI-lib export whose component binds it.
// Natural filename order (01-, 02-) matches the daemon's merge order
// (apps/daemon/src/static-resource-routes.ts "NATURAL FILENAME ORDER").

const foundationIr = {
  meta: { file: '[E2E Fixture] Foundation' },
  collections: [{ name: 'Mode', modes: ['Light', 'Dark'], defaultMode: 'Light' }],
  variables: [
    {
      name: 'color/bg',
      type: 'COLOR',
      collection: 'Mode',
      values: { Light: { value: '#ffffff' }, Dark: { value: '#111111' } },
    },
  ],
  componentSets: [],
  components: [],
  icons: [],
};

const uiLibIr = {
  meta: { file: '[E2E Fixture] UI Lib' },
  componentSets: [
    {
      name: 'Badge',
      id: '1:1',
      props: {},
      variants: [
        {
          props: {},
          tree: {
            name: 'Badge',
            type: 'FRAME',
            w: 24,
            h: 24,
            fills: [{ type: 'solid', color: '#ffffff', var: 'color/bg' }],
          },
        },
      ],
    },
  ],
  variables: [],
  components: [],
  icons: [],
};

export interface FigmaIrFixtureFile {
  filename: string;
  content: string;
}

/** The minimal two-file IR pair `importFigmaIrFixture` uploads by default. */
export function defaultFigmaIrFixtureFiles(): FigmaIrFixtureFile[] {
  return [
    { filename: '01-foundation.ir.json', content: JSON.stringify(foundationIr) },
    { filename: '02-ui-lib.ir.json', content: JSON.stringify(uiLibIr) },
  ];
}
