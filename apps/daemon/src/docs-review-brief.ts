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
      '- Ảnh chỉ là minh hoạ: KHÔNG mở ảnh và KHÔNG suy diễn từ ảnh về flow, gap, component hay layout; nhóm component chỉ đọc kết quả `comp/<SCREEN-KEY>.screen.json` của bước dr-comp.',
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
    '- CHỈ ĐỌC tài liệu rồi khai ĐỀ XUẤT — bạn không sửa bất kỳ file tài liệu nào; đề xuất không được áp vào tài liệu, web hiển thị chúng bằng highlight + modal.',
    '- Đối chiếu `criteria/` khi thư mục tồn tại; nếu thiếu thì dùng criteria mặc định của skill.',
    `- Ghi mọi đề xuất Thêm/Sửa/Xóa vào \`${opts.changesPath}\` dưới dạng JSON array các DocChange.`,
    `- Ghi finding không diễn đạt được bằng một cặp before/quote vào \`${opts.notesPath}\` dưới dạng JSON array các DocNote.`,
    '- COPY nguyên văn `before`/`anchor`/`doc_refs` từ lát cắt, đừng gõ lại — daemon đối chiếu từng chữ, trích sai là section bị loại.',
    '',
    '## Ràng buộc ghi file',
    `- Tuyệt đối không sửa \`${opts.slicePath}\` lẫn \`${opts.reviewPath}\` — không Edit, không Write, không shell (echo/cat, heredoc, Set-Content); lát cắt là nguồn chỉ-đọc để trích nguyên văn, daemon ghép trang từ các lát baseline sau khi mọi section hoàn tất.`,
    '- Không chèn “[Rà soát …]” hay chú giải review trực tiếp vào slice; finding phải nằm trong notes JSON.',
    '- Không ghi `review/index.json` hoặc `review/summary.md`; pipeline tự tổng hợp.',
    `- Hai file duy nhất bạn được ghi: \`${opts.changesPath}\` và \`${opts.notesPath}\`. Không commit hoặc push.`,
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
