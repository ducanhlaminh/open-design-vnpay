export interface DocsReviewSectionBriefOptions {
  projectId: string;
  pageTitle: string;
  originalPath: string;
  sectionHeading: string;
  startLine: number;
  endLine: number;
  bodyLines: number;
  parentHeading: boolean;
  imageRefs: string[];
  slicePath: string;
  outlinePath: string;
  reviewPath: string;
  changesPath: string;
  notesPath: string;
  enrichContext?: string;
  repairErrors?: string[];
}

/** Structured user-message brief for one dr-review section. The skill owns
 * review rules; this message only scopes the run, names inputs/outputs and
 * repeats the few file-safety constraints that the daemon must enforce. */
export function buildDocsReviewSectionBrief(opts: DocsReviewSectionBriefOptions): string {
  const heading = opts.sectionHeading || '(phần mở đầu, trước heading đầu tiên)';
  const lines = [
    `# Review một section · ${heading}`,
    `Áp skill \`docs-spec-review\` cho project \`${opts.projectId}\`; luật review và contract nằm trong system prompt.`,
    '',
    '## Phạm vi lần này',
    `- Trang: **${opts.pageTitle}**`,
    `- Section: **${heading}** · dòng ${opts.startLine}-${opts.endLine} của tài liệu gốc.`,
    `- Tài liệu gốc: \`${opts.originalPath}\` — chỉ đọc, tuyệt đối không sửa.`,
    '- Không sửa bất kỳ file nào dưới `docs/`.',
    '- Chỉ review section này; không review trang hoặc section khác.',
    '',
    '## Tệp cần đọc',
    `- Đọc trọn lát cắt \`${opts.slicePath}\` — đây là nội dung đúng và đủ của section.`,
    `- Đọc mục lục \`${opts.outlinePath}\` để biết cấu trúc trang và khoảng dòng các section.`,
    `- Không đọc toàn bộ \`${opts.originalPath}\` hoặc \`${opts.reviewPath}\`. Khi thật sự cần ngữ cảnh ngoài section, chỉ đọc offset/limit theo mục lục, tối đa vài lần.`,
  ];

  if (opts.imageRefs.length > 0) {
    lines.push(
      `- Section có ${opts.imageRefs.length} ảnh: ${opts.imageRefs.map((ref) => `\`${ref}\``).join(', ')}.`,
      '- Bắt buộc mở từng ảnh bằng Read trước khi kết luận về component, biến thể, trạng thái hoặc layout; chưa mở ảnh thì không tạo change/note nhóm component.',
    );
  } else {
    lines.push('- Section không nhúng ảnh.');
  }

  if (opts.bodyLines === 0) {
    lines.push(
      opts.parentHeading
        ? '- Heading này là mục cha; nội dung nằm ở các mục con. Không coi là gap và không ghi note “heading rỗng”.'
        : `- Heading này không có nội dung: ghi một note mức major vào \`${opts.notesPath}\`; không tự bịa nội dung hoặc sơ đồ.`,
    );
  }

  lines.push(
    '',
    '## Việc cần làm',
    `- Chỉ Edit \`${opts.slicePath}\`; mỗi thay đổi dùng một targeted edit, không Write đè toàn file.`,
    '- Đối chiếu `criteria/` khi thư mục tồn tại; nếu thiếu thì dùng criteria mặc định của skill.',
    `- Ghi mọi thay đổi thực tế vào \`${opts.changesPath}\` dưới dạng JSON array các DocChange.`,
    `- Ghi finding không thể sửa bằng chữ vào \`${opts.notesPath}\` dưới dạng JSON array các DocNote.`,
    '',
    '## Ràng buộc ghi file',
    `- Tuyệt đối không sửa \`${opts.reviewPath}\`; daemon sẽ ghép các slice sau khi mọi section hoàn tất.`,
    '- Không ghi slice bằng shell, heredoc, echo/cat hoặc Set-Content; không dán output của tool vào tài liệu.',
    '- Không chèn “[Rà soát …]” hay chú giải review trực tiếp vào slice; finding phải nằm trong notes JSON.',
    '- Không ghi `review/index.json` hoặc `review/summary.md`; pipeline tự tổng hợp.',
    '- Đây là stage chỉ ghi file; không commit hoặc push.',
  );

  if (opts.enrichContext?.trim()) {
    lines.push('', '## Ngữ cảnh daemon đã chuẩn bị', opts.enrichContext.trim());
  }
  const repairErrors = opts.repairErrors ?? [];
  if (repairErrors.length > 0) {
    lines.push(
      '',
      '## Repair duy nhất',
      `Lượt trước bị validator từ chối: ${repairErrors.join(' | ')}`,
      '- Chỉ sửa lại slice và hai JSON của section này để giải quyết đúng các lỗi trên; không mở rộng phạm vi.',
    );
  }
  return lines.join('\n');
}
