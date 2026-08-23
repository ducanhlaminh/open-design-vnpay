// ds-lab / lab-brief — khuôn Markdown DÙNG CHUNG cho 3 brief kickoff của
// workflow "DS → Màn hình sáng tạo (Lab)" (lab-kit-plan/lab-kit/lab-compose).
//
// Nguyên tắc chốt (.tmp/pipeline/wp-lab-clean.yaml): SKILL.md là NGUỒN DUY
// NHẤT của luật/recipe — nội dung đó đã nhúng sẵn vào system prompt của
// agent. Brief dựng bởi module này CHỈ đưa dữ liệu của LẦN CHẠY này (docs/
// tokens/slots có hay không, danh sách đã duyệt, tên kit/pattern, định
// hướng người dùng…) cộng nhắc TỐI ĐA 3 luật hay vi phạm nhất bằng SỐ luật
// trỏ về skill — KHÔNG chép lại nguyên văn luật/recipe (agent đã có sẵn ở
// system prompt, chép lại chỉ tổ dài dòng và dễ lệch bản gốc theo thời
// gian). Module THUẦN — không fs/network, chỉ ráp chuỗi Markdown nhiều
// dòng (không bao giờ join(' ') một đoạn).
//
// 3 builder dùng chung khuôn này (buildKitPlanBrief/buildKitBrief trong
// lab-kit.ts, buildComposeBrief trong lab-compose.ts) tự ráp các dòng riêng
// của mình (input/task/reminder/ending) rồi gọi `renderLabBrief` — hàm này
// chỉ lo đúng MỘT việc: thứ tự heading + ngắt dòng đúng khuôn.

/** '✓' khi có, '✗' khi không — dùng cho các dòng "Nguyên liệu"/"Tool thêm"
 *  để đánh dấu trạng thái của lần chạy này (thay cho câu văn dài dòng). */
export function checkMark(present: boolean): string {
  return present ? '✓' : '✗';
}

export interface LabBriefSections {
  /** `# <Tên bước> · <appFeature>` — heading H1 duy nhất của brief. */
  title: string;
  /** id skill đã nhúng system prompt — chỉ để dòng mở đầu trỏ tới, KHÔNG
   *  lặp lại nội dung skill. */
  skillId: string;
  /** Các gạch đầu dòng của "## Đầu vào lần này" — dữ liệu động của lần
   *  chạy (docs/nguyên liệu/nguồn riêng từng bước/Figma/tool thêm/định
   *  hướng người dùng). */
  inputLines: readonly string[];
  /** Các gạch đầu dòng của "## Việc cần làm" — 2-4 dòng, động từ mệnh
   *  lệnh, KHÔNG lặp luật (luật đã ở skill). */
  taskLines: readonly string[];
  /** Gạch đầu dòng của "## Nhắc luật hay vi phạm nhất" — CHỈ lấy tối đa 3
   *  dòng đầu (dòng thứ 4 trở đi bị cắt, xem `.slice(0, 3)` bên dưới); mỗi
   *  dòng nên ghi số luật trỏ về skill thay vì chép nguyên văn luật. */
  reminderLines: readonly string[];
  /** Các gạch đầu dòng của "## Kết thúc — ghi đúng file". */
  endingLines: readonly string[];
}

/** Ráp khuôn Markdown chung cho một brief kickoff — xem mục A của
 *  `.tmp/pipeline/wp-lab-clean.yaml` cho khuôn đầy đủ. Luôn trả về Markdown
 *  NHIỀU DÒNG (`join('\n')`) — không bao giờ gộp một đoạn `join(' ')`. */
export function renderLabBrief(sections: LabBriefSections): string {
  const lines: string[] = [
    sections.title,
    `Áp skill \`${sections.skillId}\` — luật, recipe và hợp đồng cứng đã nằm trong system prompt của bạn; brief này chỉ đưa dữ liệu của lần chạy.`,
    '',
    '## Đầu vào lần này',
    ...sections.inputLines,
    '',
    '## Việc cần làm',
    ...sections.taskLines,
    '',
    '## Nhắc luật hay vi phạm nhất (chi tiết trong skill)',
    ...sections.reminderLines.slice(0, 3),
    '',
    '## Kết thúc — ghi đúng file',
    ...sections.endingLines,
  ];
  return lines.join('\n');
}
