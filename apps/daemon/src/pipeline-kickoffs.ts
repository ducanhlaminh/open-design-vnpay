// Kickoff builders for the remaining pipeline stages' first user message
// ("kickoff"). Mirrors the shape of `docs-review-brief.ts`: an options object
// per stage → `lines.join('\n')` Markdown (`# ` title, one scope line, then
// `## ` sections with bullets), in Vietnamese, with paths/field names/skill
// names/mode names/pixel numbers kept verbatim. Callers in `server.ts` still
// compute the per-branch prose (already translated there); these builders
// only give it a consistent Markdown shape — same division of labor as
// `buildDocsReviewSectionBrief`.

/** `ds-criteria-extract` kickoff — generate a design system's component catalog draft. */
export function buildDsCriteriaExtractKickoff(opts: { designSystemId: string }): string {
  const lines = [
    `# Sinh danh mục component · ${opts.designSystemId}`,
    `Áp skill \`ds-criteria-extract\` cho design system \`${opts.designSystemId}\`.`,
    '',
    '## Phạm vi',
    '- cwd của bạn LÀ thư mục DS.',
    '- Đọc `react/docs/catalog.md` (nguồn chính), `react/STYLE-GUIDE.md` và `DESIGN.md`.',
    '',
    '## Việc cần làm',
    '- Ghi kết quả ra ĐÚNG MỘT file: `criteria/components.md.next`.',
    '',
    '## Ràng buộc',
    '- TUYỆT ĐỐI KHÔNG ghi đè `criteria/components.md` — daemon validate bản nháp trước khi người dùng duyệt.',
    '- KHÔNG đụng `criteria/rules.md` và không sửa bất cứ thứ gì trong `react/` hay `ir/`.',
  ];
  return lines.join('\n');
}

/** `ds-rules-extract` kickoff — generate a design system's review rules draft. */
export function buildDsRulesExtractKickoff(opts: { designSystemId: string }): string {
  const lines = [
    `# Sinh quy tắc review · ${opts.designSystemId}`,
    `Áp skill \`ds-rules-extract\` cho design system \`${opts.designSystemId}\`.`,
    '',
    '## Phạm vi',
    '- cwd của bạn LÀ thư mục DS.',
    '- Đọc `react/showcase/index.html` nếu có, `preview/*.html`, `react/STYLE-GUIDE.md`, `react/docs/catalog.md`, `DESIGN.md`.',
    '- KHÔNG đọc `react/showcase/showcase-data.js`.',
    '',
    '## Việc cần làm',
    '- Ghi đúng một file `criteria/rules.md.next`.',
    '',
    '## Ràng buộc',
    '- Không ghi đè `criteria/rules.md`.',
    '- Không tạo `_meta.json` hay file khác.',
    '- Không đụng `react/` hay `ir/`.',
  ];
  return lines.join('\n');
}

/** `prd-review` fan-out kickoff — text-first PRD requirements review, one page. */
export function buildPrdPageReviewKickoff(opts: {
  projectId: string;
  pageTitle: string;
  mdPath: string;
  slug: string;
}): string {
  const lines = [
    '# Rà soát PRD · một trang',
    `Áp bước rà soát yêu cầu PRD (text-first) cho MỘT trang của feature \`${opts.projectId}\`.`,
    '',
    '## Phạm vi lần này',
    `- Trang: **${opts.pageTitle}** — chỉ rà soát yêu cầu bằng chữ trong \`${opts.mdPath}\`, đối chiếu với văn bản trang đó cộng Customer Journey, UX Research và tiêu chí Design System dùng chung có trong cwd.`,
    '- Mockup/ảnh chụp nhúng trong trang CHỈ mang tính minh hoạ: TUYỆT ĐỐI không mở, chấm điểm, sao chép hoặc dùng chúng làm định hướng thiết kế/wireframe.',
    '- Không rà soát bất kỳ trang nào khác.',
    '',
    '## Việc cần làm',
    `- Ghi kết quả vào \`review/${opts.slug}/report.json\` theo schema tương thích khoá theo attachment; mọi phát hiện phải dựa trên văn bản.`,
    '',
    '## Ràng buộc ghi file',
    '- Không ghi `review/index.json` hoặc `review/summary.md` — pipeline tự tổng hợp từ report của từng trang.',
    '- Đây là stage chỉ ghi file: chỉ tạo file report — không đẩy đi đâu cả.',
  ];
  return lines.join('\n');
}

/** `docs-screen-components` kickoff — one options type per mode (EXTRACT /
 * ROLE-MAP / SCREEN). Callers pass already-composed Vietnamese fragments
 * (flowLine, dsLine, sectionLine, navLine, mockupLine, cssLine,
 * figmaDesktopNote) unchanged; this builder only supplies the (translated)
 * scaffolding sentence + Markdown structure around them. */
export type ScreenComponentsKickoffOptions =
  | {
      mode: 'extract';
      projectId: string;
      pages: string[];
      outputFile: string;
    }
  | {
      mode: 'role-map';
      projectId: string;
      flowLine: string;
      dsLine: string;
      platformGuess: string;
      screenInputsFile: string;
      outputFile: string;
    }
  | {
      mode: 'screen';
      projectId: string;
      screenKey: string;
      screenName: string;
      flowTitle: string;
      order: number;
      total: number;
      flowLine: string;
      dsLine: string;
      roleMapFile: string;
      roleMapPlatform: string;
      sectionLine: string;
      /** WP nested-blocks-A (2026-08-25): dòng ngữ cảnh liệt kê khối bổ sung
       *  (`ScreenInput.blocks[]`) của màn RỜI ở chỗ khác trong tài liệu —
       *  server.ts (WP-B) dựng chuỗi sẵn; builder này chỉ render, KHÔNG tự
       *  chế nội dung. Rỗng/không có → không thêm dòng nào (byte-identical
       *  với kickoff cũ). */
      blockLine?: string;
      navLine: string;
      mockupLine: string;
      outRel: string;
      wfRel: string;
      cssLine: string;
      wireframeCssRel: string;
      figmaDesktopNote?: string;
      repairAttempt?: number;
      previousErrors?: string[];
    };

export function buildScreenComponentsKickoff(opts: ScreenComponentsKickoffOptions): string {
  if (opts.mode === 'extract') {
    const pagesList = opts.pages.map((p) => `\`${p}\``).join(', ');
    const lines = [
      '# Trích màn từ tài liệu (format lạ) · EXTRACT',
      `Chạy skill \`docs-screen-components\` ở chế độ EXTRACT cho feature \`${opts.projectId}\` (lượt chẩn đoán coverage — lớp 1 chưa gắn được màn nào cho các trang này).`,
      '',
      '## Trang cần đọc',
      `- Đọc TỪNG trang, tìm MỌI màn hình tài liệu khai, bất kể cách trình bày — heading, dòng in đậm, hàng bảng…: ${pagesList}.`,
      '',
      '## Quy tắc `anchorText`',
      '- `anchorText` của MỖI màn PHẢI là NGUYÊN VĂN CẢ MỘT DÒNG của trang, DUY NHẤT trong trang (khớp y nguyên sau khi trim khoảng trắng đầu/cuối) — daemon đối chiếu tất định: không tìm thấy, xuất hiện hơn một lần, hoặc chỉ nằm trong code fence → màn đó bị loại kèm lý do, KHÔNG suy diễn hộ, đừng diễn giải lại câu chữ.',
      '- KHÔNG khai mục tài liệu (danh sách/mô tả/luồng màn hình) làm màn.',
      '',
      '## Việc cần làm',
      `- Ghi ĐÚNG MỘT file \`${opts.outputFile}\` theo schema mục "Chế độ EXTRACT" của skill.`,
      '',
      '## Ràng buộc',
      '- KHÔNG ghi file nào khác, KHÔNG sửa trang.',
      '- Đây là stage chỉ ghi file — không đẩy đi đâu cả.',
    ];
    return lines.join('\n');
  }

  if (opts.mode === 'role-map') {
    const lines = [
      '# Bảng vai trò → component DS · ROLE-MAP',
      `Chạy skill \`docs-screen-components\` ở chế độ ROLE-MAP cho feature \`${opts.projectId}\` (lượt 0 của bước Màn hình → Component).`,
      '',
      '## Ngữ cảnh',
      `- ${opts.flowLine.trim()}`,
      `- ${opts.dsLine.trim()}`,
      `- Nền tảng đoán từ tài liệu: \`${opts.platformGuess}\` — tự xác nhận lại theo tài liệu.`,
      '',
      '## Việc cần làm',
      `- Đọc \`${opts.screenInputsFile}\` (mọi màn: tên, bước, mục tài liệu) và Design System.`,
      `- Ghi ĐÚNG MỘT file \`${opts.outputFile}\`: bảng map VAI TRÒ giao diện (app bar, list item, CTA đáy, input, select, bottom sheet, badge, empty state, error state, tab, card, table…) → component DS (tên + anchor + biến thể mặc định + khi nào dùng), phủ đủ mọi vai trò mà các màn trong feature này sẽ cần; DS không có vai trò nào thì \`"component": null\` kèm \`"fallback"\`.`,
      '- Schema và luật nằm trong skill (mục "Chế độ ROLE-MAP").',
      '',
      '## Ràng buộc',
      '- KHÔNG ghi file nào khác, KHÔNG vẽ wireframe ở lượt này.',
      '- Đây là stage chỉ ghi file — không đẩy đi đâu cả.',
    ];
    return lines.join('\n');
  }

  // mode === 'screen'
  const lines = [
    `# Dựng màn · SCREEN — ${opts.screenName}`,
    `Chạy skill \`docs-screen-components\` ở chế độ SCREEN cho MỘT màn của feature \`${opts.projectId}\`: SCREEN-KEY \`${opts.screenKey}\` — "${opts.screenName}" (luồng "${opts.flowTitle}", thứ tự ${opts.order}/${opts.total}).`,
    '',
    '## Ngữ cảnh',
    `- ${opts.flowLine.trim()}`,
    `- ${opts.dsLine.trim()}`,
    `- Bảng map vai trò → component DS của feature đã chốt ở \`${opts.roleMapFile}\` (nền tảng: ${opts.roleMapPlatform}) — BẮT BUỘC dùng đúng bảng đó; lệch phải ghi "why".`,
    `- ${opts.sectionLine.trim()}`,
    ...(opts.blockLine?.trim() ? [`- ${opts.blockLine.trim()}`] : []),
    `- ${opts.navLine.trim()}`,
    `- ${opts.mockupLine.trim()}`,
    '',
    '## Việc cần làm',
    '- Ghi ĐÚNG HAI file:',
    `  1. \`${opts.outRel}\` theo schema "Chế độ SCREEN" trong skill (mọi element có "id" ổn định, "role", "ds" {component, anchor, variant?} hoặc null, "confidence", "provenance" text|flow|table|ds, "docType" nếu bảng tài liệu có khai, "why" khi cần; "nav": [{el, to}] cho các lối đi kể trên; "platform" = "${opts.roleMapPlatform}").`,
    `  2. \`${opts.wfRel}\` — wireframe HTML tự chứa kiểu ux-spec: "<!doctype html>", ${opts.cssLine.trim()}không <script>/<link>/ảnh; <body data-screen="${opts.screenKey}" data-layout="${opts.roleMapPlatform}">; DOM là bố cục THẬT của màn (header–thân–chân, hàng/cột, card lồng nhau theo criteria/examples.md), MỖI element trong JSON là một block mang data-el="<id>" (bắt buộc) + data-comp="<anchor>" khi có ds + data-nav="<SCREEN-KEY đích>" đúng như "nav"; text trong block = nhãn thật của element; không màu thương hiệu, không icon, không nội dung mẫu dài.`,
    '',
    '## Ràng buộc',
    `- Không ghi file nào khác (không sửa flows/, docs/, criteria/, \`${opts.wireframeCssRel}\`, không tự ghi comp/index.json).`,
    '- Đây là stage chỉ ghi file — không đẩy đi đâu cả.',
  ];
  if (opts.figmaDesktopNote?.trim()) lines.push(`- ${opts.figmaDesktopNote.trim()}`);
  if ((opts.repairAttempt ?? 0) > 0) {
    lines.push(
      '',
      '## Repair duy nhất',
      `Lượt trước bị daemon từ chối vì: ${(opts.previousErrors ?? []).join(' | ')}`,
      '- Đọc lại hai file output hiện tại nếu còn, sửa đúng các lỗi trên và ghi đè ĐÚNG hai file được yêu cầu. Không mở rộng phạm vi.',
    );
  }
  return lines.join('\n');
}

/** Section fan-out kickoff (`customer-journey-spec` / `ux-research` /
 * `ux-spec`), one module. `kbDirective`/`platformDirective`/`dsCriteriaDirective`
 * are already-translated fragments computed by the caller; passed through as
 * an extra bullet when non-empty. */
export type ModuleSpecKickoffOptions =
  | {
      skill: 'customer-journey-spec';
      projectId: string;
      moduleTitle: string;
      pagesList: string;
      outRel: string;
    }
  | {
      skill: 'ux-research';
      projectId: string;
      moduleTitle: string;
      pagesList: string;
      outRel: string;
      kbDirective?: string;
    }
  | {
      skill: 'ux-spec';
      projectId: string;
      moduleKey: string;
      moduleTitle: string;
      pagesList: string;
      outRel: string;
      platformDirective?: string;
      dsCriteriaDirective?: string;
    };

export function buildModuleSpecKickoff(opts: ModuleSpecKickoffOptions): string {
  if (opts.skill === 'customer-journey-spec') {
    const lines = [
      `# Customer Journey · module ${opts.moduleTitle}`,
      `Chạy skill \`customer-journey-spec\` cho MỘT MODULE của feature \`${opts.projectId}\`.`,
      '',
      '## Phạm vi',
      `- Chỉ phủ module này — các trang: ${opts.pagesList} (module: ${opts.moduleTitle}).`,
      '- Không phủ module khác — daemon tự gộp lát cắt của từng module.',
      '',
      '## Việc cần làm',
      `- Ghi kết quả vào \`${opts.outRel}\` (persona + journey CHO RIÊNG module này).`,
      '',
      '## Ràng buộc',
      '- Không ghi bất kỳ file `-customer-journey.json` gốc nào.',
      '- Đây là stage chỉ ghi file: không đẩy đi đâu cả.',
    ];
    return lines.join('\n');
  }

  if (opts.skill === 'ux-research') {
    const lines = [
      `# UX Research · module ${opts.moduleTitle}`,
      `Chạy skill \`ux-research\` cho MỘT MODULE của feature \`${opts.projectId}\`.`,
      '',
      '## Phạm vi',
      `- Chỉ rút tiêu chí UX cho module này — các trang: ${opts.pagesList} (module: ${opts.moduleTitle}), cộng customer journey của module có sẵn trong cwd.`,
      '- Không phủ module khác — daemon tự gộp lát cắt của từng module.',
      '',
      '## Việc cần làm',
      `- Ghi kết quả vào \`${opts.outRel}\` (tiêu chí + tham chiếu CHO RIÊNG module này).`,
    ];
    if (opts.kbDirective?.trim()) lines.push(`- ${opts.kbDirective.trim()}`);
    lines.push(
      '',
      '## Ràng buộc',
      '- Không ghi `ux-research/report.json` (cấp cao nhất).',
      '- Đây là stage chỉ ghi file: không đẩy đi đâu cả.',
    );
    return lines.join('\n');
  }

  // skill === 'ux-spec'
  const lines = [
    `# UX Spec · module ${opts.moduleTitle}`,
    `Chạy skill \`ux-spec\` cho MỘT MODULE của feature \`${opts.projectId}\`.`,
    '',
    '## Phạm vi',
    `- Chỉ soạn màn UX Spec cho module này — các trang: ${opts.pagesList} (module: ${opts.moduleTitle}), dựa theo customer journey + UX research của module có sẵn trong cwd.`,
    '- Không soạn màn của module khác — daemon tự gộp màn của từng module.',
    '',
    '## Việc cần làm',
    `- MỌI screen id PHẢI bắt đầu bằng \`${opts.moduleKey}__\` để id (và file \`wireframes/<id>.html\` mà chúng đặt tên) không bao giờ đụng module khác.`,
    `- Ghi các màn của module vào \`${opts.outRel}\` VÀ mỗi màn ghi \`wireframes/<screen-id>.html\` + mỗi luồng ghi \`flows/<flow-id>.flow.json\` vào thư mục \`wireframes/\` và \`flows/\` DÙNG CHUNG.`,
  ];
  if (opts.platformDirective?.trim()) lines.push(`- ${opts.platformDirective.trim()}`);
  if (opts.dsCriteriaDirective?.trim()) lines.push(`- ${opts.dsCriteriaDirective.trim()}`);
  lines.push(
    '',
    '## Ràng buộc',
    '- Không ghi file `-ux-spec.json` gốc.',
    '- Đây là stage chỉ ghi file: không đẩy đi đâu cả.',
  );
  return lines.join('\n');
}

/** Screen fan-out kickoff (`heuristic-eval` review / `html-interactive-prototype`
 * render), one screen. `uiTargetDirective` is the already-translated multi-target
 * viewport fragment, passed through when non-empty. */
export type ScreenRunKickoffOptions =
  | {
      kind: 'heuristic';
      projectId: string;
      screenId: string;
      screenName: string;
      slug: string;
    }
  | {
      kind: 'prototype';
      projectId: string;
      screenId: string;
      screenName: string;
      slug: string;
      uiTargetDirective?: string;
    };

export function buildScreenRunKickoff(opts: ScreenRunKickoffOptions): string {
  if (opts.kind === 'heuristic') {
    const lines = [
      `# Đánh giá heuristic · ${opts.screenName}`,
      `Chạy đánh giá \`heuristic-eval\` cho MỘT màn của feature \`${opts.projectId}\`.`,
      '',
      '## Phạm vi',
      `- Chỉ đánh giá màn id \`${opts.screenId}\` (${opts.screenName}) — wireframe \`wireframes/${opts.screenId}.html\` và spec của nó trong UX Spec, đối chiếu với usability heuristics + tiêu chí UX Research có trong cwd.`,
      '- Không đánh giá màn nào khác.',
      '',
      '## Việc cần làm',
      `- Ghi kết quả vào \`heuristic-review/${opts.slug}/report.json\` (schema report theo từng màn, "screens[]" chỉ chứa đúng một màn này, screen id GIỮ NGUYÊN VĂN).`,
      '',
      '## Ràng buộc',
      '- Không ghi `heuristic-review/report.json` hoặc `summary.md` — pipeline tự gộp.',
      '- FILE-ONLY: không đẩy đi đâu cả.',
    ];
    return lines.join('\n');
  }

  // kind === 'prototype'
  const lines = [
    `# Dựng prototype · ${opts.screenName}`,
    `Chạy render \`html-interactive-prototype\` cho MỘT màn của feature \`${opts.projectId}\`.`,
    '',
    '## Phạm vi',
    `- Chỉ dựng màn id \`${opts.screenId}\` (${opts.screenName}) từ UX Spec + wireframe của nó thành file tự chứa \`prototype/${opts.slug}.html\` (kèm \`prototype/${opts.slug}.states.json\` nếu nhiều bước).`,
    '- Link điều hướng sang màn khác dùng tên file `<target-slug>.html` của màn đó.',
    '',
    '## Ràng buộc',
    '- Không dựng màn nào khác, không ghi `prototype/index.html` — pipeline tự dựng trang hub.',
    '- FILE-ONLY: không đẩy đi đâu cả.',
  ];
  if (opts.uiTargetDirective?.trim()) lines.push(`- ${opts.uiTargetDirective.trim()}`);
  return lines.join('\n');
}

/** Generic single-agent pipeline stage kickoff (`runPipeline`'s main path).
 * `directives` values are already-translated fragments computed by the
 * caller (skill/source/platform/audience/ui/rerun/kb/appCtx/appDocs/
 * dsCriteria/reactDs/graph); this builder only trims and lists the non-empty
 * ones as bullets, in the same order the legacy kickoff concatenated them. */
export interface PipelineKickoffDirectives {
  skill?: string;
  source?: string;
  platform?: string;
  audience?: string;
  ui?: string;
  rerun?: string;
  kb?: string;
  appCtx?: string;
  appDocs?: string;
  dsCriteria?: string;
  reactDs?: string;
  graph?: string;
}

export interface PipelineKickoffOptions {
  name: string;
  featureScope: string;
  directives: PipelineKickoffDirectives;
}

const PIPELINE_DIRECTIVE_ORDER: Array<keyof PipelineKickoffDirectives> = [
  'skill',
  'source',
  'platform',
  'audience',
  'ui',
  'rerun',
  'kb',
  'appCtx',
  'appDocs',
  'dsCriteria',
  'reactDs',
  'graph',
];

export function buildPipelineKickoff(opts: PipelineKickoffOptions): string {
  const lines = [`# Chạy pipeline "${opts.name}"`, `Chạy pipeline "${opts.name}" cho ${opts.featureScope}.`];
  const bullets = PIPELINE_DIRECTIVE_ORDER.map((key) => opts.directives[key])
    .filter((value): value is string => !!value && value.trim().length > 0)
    .map((value) => `- ${value.trim()}`);
  if (bullets.length > 0) lines.push('', '## Chỉ dẫn', ...bullets);
  return lines.join('\n');
}

/** `docs-flow-ux` RECOVERY kickoff — recover screen coverage for flows the
 * first dr-flow finalize pass could not diagnose. */
export function buildFlowUxRecoveryKickoff(opts: {
  projectId: string;
  missingFlowTopology: boolean;
  recoveryTargetIds: string[];
  totalFlowCount: number;
  pageMdPaths: string[];
  recoveryFile: string;
}): string {
  const pagesList = opts.pageMdPaths.length > 0 ? opts.pageMdPaths.map((p) => `\`${p}\``).join(', ') : '(không có)';
  const statusLine = opts.missingFlowTopology
    ? 'Lượt finalize dr-flow đầu tiên KHÔNG tạo được flow topology nào. Chẩn đoán tài liệu và tạo một hoặc nhiều thư mục flow canonical dạng text-only gồm `as-is.mmd`, `screens.json` và `ux-review.json`.'
    : `Lượt finalize dr-flow đầu tiên để lại ${opts.recoveryTargetIds.length}/${opts.totalFlowCount} flow chưa có màn hợp lệ: ${opts.recoveryTargetIds.map((id) => `"${id}"`).join(', ')}.`;
  const constraintLine = opts.missingFlowTopology
    ? 'Không được bịa bằng chứng; khi topology có cơ sở, chỉ ghi các file thư mục flow canonical mô tả ở trên. Ngược lại không tạo artifact nào.'
    : `Chỉ khôi phục các flow id chưa phủ được liệt kê ở trên. Ghi ĐÚNG file \`${opts.recoveryFile}\` theo schema RECOVERY v1. Không sửa file nào khác; trả "candidates": [] khi bằng chứng không đủ.`;
  const lines = [
    '# Khôi phục màn hình từ format tài liệu lạ · RECOVERY',
    `Chạy skill \`docs-flow-ux\` ở chế độ RECOVERY cho feature \`${opts.projectId}\`.`,
    '',
    '## Tình trạng',
    `- ${statusLine}`,
    '',
    '## Việc cần làm',
    `- Đọc mọi trang được liệt kê: ${pagesList}, cộng \`flows/_inputs.json\` và từng file as-is diagram/cells.`,
    '- Chẩn đoán MỌI màn hình người dùng nhìn thấy, bất kể tài liệu dùng heading, chữ in đậm, bảng, danh sách, ảnh hay văn xuôi.',
    '',
    '## Ràng buộc',
    `- ${constraintLine}`,
  ];
  return lines.join('\n');
}
