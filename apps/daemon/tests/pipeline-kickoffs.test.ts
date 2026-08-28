import { describe, expect, it } from 'vitest';

import {
  buildDsCriteriaExtractKickoff,
  buildDsRulesExtractKickoff,
  buildModuleSpecKickoff,
  buildPipelineKickoff,
  buildPrdPageReviewKickoff,
  buildScreenComponentsKickoff,
  buildScreenRunKickoff,
} from '../src/pipeline-kickoffs.js';

describe('buildDsCriteriaExtractKickoff', () => {
  it('has a Markdown heading and keeps verbatim paths/skill name, in Vietnamese', () => {
    const brief = buildDsCriteriaExtractKickoff({ designSystemId: 'user:vnpay' });
    expect(brief).toMatch(/^# /);
    expect(brief).toContain('`ds-criteria-extract`');
    expect(brief).toContain('user:vnpay');
    expect(brief).toContain('`react/docs/catalog.md`');
    expect(brief).toContain('`react/STYLE-GUIDE.md`');
    expect(brief).toContain('`DESIGN.md`');
    expect(brief).toContain('`criteria/components.md.next`');
    expect(brief).toContain('`criteria/components.md`');
    expect(brief).toContain('`criteria/rules.md`');
    expect(brief).toContain('`react/`');
    expect(brief).toContain('`ir/`');
    // Vietnamese prose, not the legacy English one-liner.
    expect(brief).toContain('Áp skill');
    expect(brief).not.toContain('Apply skill');
  });
});

describe('buildDsRulesExtractKickoff', () => {
  it('has a Markdown heading and keeps verbatim paths/skill name, in Vietnamese', () => {
    const brief = buildDsRulesExtractKickoff({ designSystemId: 'user:vnpay' });
    expect(brief).toMatch(/^# /);
    expect(brief).toContain('`ds-rules-extract`');
    expect(brief).toContain('`react/showcase/index.html`');
    expect(brief).toContain('`preview/*.html`');
    expect(brief).toContain('`react/showcase/showcase-data.js`');
    expect(brief).toContain('`criteria/rules.md.next`');
    expect(brief).toContain('`criteria/rules.md`');
    expect(brief).toContain('`_meta.json`');
    expect(brief).toContain('Áp skill');
  });
});

describe('buildPrdPageReviewKickoff', () => {
  it('translates the legacy English scaffolding and keeps verbatim paths', () => {
    const brief = buildPrdPageReviewKickoff({
      projectId: 'sim-tourism',
      pageTitle: 'Mua SIM du lịch',
      mdPath: 'docs/confluence/mua-sim.md',
      slug: 'mua-sim',
    });
    expect(brief).toMatch(/^# /);
    expect(brief).toContain('`docs/confluence/mua-sim.md`');
    expect(brief).toContain('review/mua-sim/report.json');
    expect(brief).toContain('review/index.json');
    expect(brief).toContain('review/summary.md');
    expect(brief).toContain('Mua SIM du lịch');
    expect(brief).toContain('stage chỉ ghi file');
    expect(brief).not.toContain('Run the text-first PRD requirements review');
    expect(brief).not.toContain('Embedded mockups/screenshots');
  });
});

describe('buildScreenComponentsKickoff', () => {
  it('EXTRACT mode: heading, mode name, anchorText rule, empty pages produce no bullet', () => {
    const brief = buildScreenComponentsKickoff({
      mode: 'extract',
      projectId: 'feat-1',
      pages: ['docs/a.md', 'docs/b.md'],
      outputFile: 'comp/_doc-screens.json',
    });
    expect(brief).toMatch(/^# /);
    expect(brief).toContain('EXTRACT');
    expect(brief).toContain('`docs-screen-components`');
    expect(brief).toContain('`docs/a.md`');
    expect(brief).toContain('`docs/b.md`');
    expect(brief).toContain('`anchorText`');
    expect(brief).toContain('`comp/_doc-screens.json`');
    expect(brief).toContain('chẩn đoán coverage');
  });

  it('ROLE-MAP mode: heading, mode name, includes flowLine/dsLine/platformGuess verbatim', () => {
    const brief = buildScreenComponentsKickoff({
      mode: 'role-map',
      projectId: 'feat-1',
      flowLine: 'Danh sách màn hình nằm ở "comp/_inputs.json".',
      dsLine: 'Design System: danh mục component hợp lệ tại "criteria/components.md".',
      platformGuess: 'mobile',
      screenInputsFile: 'comp/_inputs.json',
      outputFile: 'comp/_role-map.json',
    });
    expect(brief).toMatch(/^# /);
    expect(brief).toContain('ROLE-MAP');
    expect(brief).toContain('`docs-screen-components`');
    expect(brief).toContain('Danh sách màn hình nằm ở "comp/_inputs.json".');
    expect(brief).toContain('Design System: danh mục component hợp lệ tại "criteria/components.md".');
    expect(brief).toContain('`mobile`');
    expect(brief).toContain('`comp/_role-map.json`');
  });

  it('SCREEN mode: heading, mode name, both output files, repair block only when repairAttempt > 0', () => {
    const base = {
      mode: 'screen' as const,
      projectId: 'feat-1',
      screenKey: 'login',
      screenName: 'Đăng nhập',
      flowTitle: 'Đăng nhập',
      order: 1,
      total: 3,
      flowLine: 'flowLine text.',
      dsLine: 'dsLine text.',
      roleMapFile: 'comp/_role-map.json',
      roleMapPlatform: 'mobile',
      sectionLine: 'sectionLine text.',
      navLine: 'navLine text.',
      mockupLine: 'mockupLine text.',
      outRel: 'comp/login.screen.json',
      wfRel: 'wireframes/login.html',
      cssLine: 'cssLine ',
      wireframeCssRel: 'wireframes/_wireframe.css',
    };
    const noRepair = buildScreenComponentsKickoff(base);
    expect(noRepair).toMatch(/^# /);
    expect(noRepair).toContain('SCREEN');
    expect(noRepair).toContain('`docs-screen-components`');
    expect(noRepair).toContain('`comp/login.screen.json`');
    expect(noRepair).toContain('`wireframes/login.html`');
    expect(noRepair).toContain('`wireframes/_wireframe.css`');
    expect(noRepair).not.toContain('Repair duy nhất');

    const withRepair = buildScreenComponentsKickoff({
      ...base,
      figmaDesktopNote: 'Figma Desktop đang chạy trên máy này.',
      repairAttempt: 1,
      previousErrors: ['lỗi A', 'lỗi B'],
    });
    expect(withRepair).toContain('Repair duy nhất');
    expect(withRepair).toContain('lỗi A | lỗi B');
    expect(withRepair).toContain('Figma Desktop đang chạy trên máy này.');
  });
});

describe('buildModuleSpecKickoff', () => {
  it('customer-journey-spec: heading, pagesList, outRel, no directive bullets', () => {
    const brief = buildModuleSpecKickoff({
      skill: 'customer-journey-spec',
      projectId: 'feat-1',
      moduleTitle: 'Thanh toán',
      pagesList: '"docs/a.md", "docs/b.md"',
      outRel: 'cj/payments/journey.json',
    });
    expect(brief).toMatch(/^# /);
    expect(brief).toContain('`customer-journey-spec`');
    expect(brief).toContain('"docs/a.md", "docs/b.md"');
    expect(brief).toContain('`cj/payments/journey.json`');
  });

  it('ux-research: kbDirective only appears when non-empty', () => {
    const withoutKb = buildModuleSpecKickoff({
      skill: 'ux-research',
      projectId: 'feat-1',
      moduleTitle: 'Thanh toán',
      pagesList: '"docs/a.md"',
      outRel: 'ux-research/payments/report.json',
    });
    expect(withoutKb).toContain('`ux-research`');
    expect(withoutKb).not.toContain('.ux-kb');

    const withKb = buildModuleSpecKickoff({
      skill: 'ux-research',
      projectId: 'feat-1',
      moduleTitle: 'Thanh toán',
      pagesList: '"docs/a.md"',
      outRel: 'ux-research/payments/report.json',
      kbDirective: 'UX knowledge base có mặt tại "./.ux-kb".',
    });
    expect(withKb).toContain('UX knowledge base có mặt tại "./.ux-kb".');
  });

  it('ux-spec: moduleKey prefix rule, platformDirective/dsCriteriaDirective only when non-empty', () => {
    const bare = buildModuleSpecKickoff({
      skill: 'ux-spec',
      projectId: 'feat-1',
      moduleKey: 'payments',
      moduleTitle: 'Thanh toán',
      pagesList: '"docs/a.md"',
      outRel: 'ux/payments/ux-spec.json',
    });
    expect(bare).toContain('`payments__`');
    expect(bare).not.toContain('RESPONSIVE');
    expect(bare).not.toContain('criteria/rules.md');

    const full = buildModuleSpecKickoff({
      skill: 'ux-spec',
      projectId: 'feat-1',
      moduleKey: 'payments',
      moduleTitle: 'Thanh toán',
      pagesList: '"docs/a.md"',
      outRel: 'ux/payments/ux-spec.json',
      platformDirective: 'Nền tảng đích: WEBSITE — RESPONSIVE.',
      dsCriteriaDirective: 'Đọc "./criteria/rules.md".',
    });
    expect(full).toContain('Nền tảng đích: WEBSITE — RESPONSIVE.');
    expect(full).toContain('Đọc "./criteria/rules.md".');
  });
});

describe('buildScreenRunKickoff', () => {
  it('heuristic: heading, screen id verbatim, report path', () => {
    const brief = buildScreenRunKickoff({
      kind: 'heuristic',
      projectId: 'feat-1',
      screenId: 'login',
      screenName: 'Đăng nhập',
      slug: 'login',
    });
    expect(brief).toMatch(/^# /);
    expect(brief).toContain('`heuristic-eval`');
    expect(brief).toContain('`login`');
    expect(brief).toContain('heuristic-review/login/report.json');
    expect(brief).not.toContain('Run the heuristic-eval review');
  });

  it('prototype: heading, uiTargetDirective only when non-empty', () => {
    const bare = buildScreenRunKickoff({
      kind: 'prototype',
      projectId: 'feat-1',
      screenId: 'login',
      screenName: 'Đăng nhập',
      slug: 'login',
    });
    expect(bare).toContain('`html-interactive-prototype`');
    expect(bare).toContain('prototype/login.html');
    expect(bare).not.toContain('390px');

    const withTarget = buildScreenRunKickoff({
      kind: 'prototype',
      projectId: 'feat-1',
      screenId: 'login',
      screenName: 'Đăng nhập',
      slug: 'login',
      uiTargetDirective: 'Dựng target "App di động": viewport 390px.',
    });
    expect(withTarget).toContain('390px');
  });
});

describe('buildPipelineKickoff', () => {
  it('lists only non-empty directives, in the legacy concatenation order', () => {
    const brief = buildPipelineKickoff({
      name: 'Docs → UI',
      featureScope: 'feature "sim-tourism"',
      directives: {
        skill: 'Làm theo đúng quy trình của skill đang bật.',
        source: '',
        platform: undefined,
        graph: 'Đây là stage chỉ ghi file: không đẩy đi đâu cả.',
      },
    });
    expect(brief).toMatch(/^# /);
    expect(brief).toContain('Docs → UI');
    expect(brief).toContain('sim-tourism');
    expect(brief).toContain('Làm theo đúng quy trình của skill đang bật.');
    expect(brief).toContain('Đây là stage chỉ ghi file: không đẩy đi đâu cả.');
    const skillIdx = brief.indexOf('Làm theo đúng quy trình');
    const graphIdx = brief.indexOf('Đây là stage chỉ ghi file');
    expect(skillIdx).toBeGreaterThan(-1);
    expect(graphIdx).toBeGreaterThan(skillIdx);
  });

  it('produces no "## Chỉ dẫn" section when every directive is empty', () => {
    const brief = buildPipelineKickoff({
      name: 'Docs → UI',
      featureScope: 'feature "sim-tourism"',
      directives: {},
    });
    expect(brief).not.toContain('## Chỉ dẫn');
  });
});

