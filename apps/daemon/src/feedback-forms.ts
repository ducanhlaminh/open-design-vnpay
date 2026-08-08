import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';
import type {
  FeedbackFormDef,
  FeedbackFormSection,
  FeedbackFormsResponse,
  FeedbackQuestion,
} from '@open-design/contracts';

const FORMS_DIR = 'feedback/forms';
const FORM_PATH_RE = /^feedback\/forms\/v(\d+)\.json$/;
const QUESTION_TYPES = new Set(['radio', 'checkbox', 'text', 'scale']);
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
type FormStoreClient = Pick<MediaClient, 'listFiles' | 'downloadFile' | 'uploadFile'>;

const section = (id: string, title: string, repeatForQuestionId?: string): FeedbackFormSection => ({
  id, title, ...(repeatForQuestionId ? { repeatForQuestionId } : {}),
});
const radio = (id: string, label: string, options: string[], extra: Partial<FeedbackQuestion> = {}): FeedbackQuestion => ({ id, label, type: 'radio', options, ...extra });
const checkbox = (id: string, label: string, options: string[] | undefined, extra: Partial<FeedbackQuestion> = {}): FeedbackQuestion => ({ id, label, type: 'checkbox', ...(options ? { options } : {}), ...extra });
const scale = (id: string, label: string, extra: Partial<FeedbackQuestion> = {}): FeedbackQuestion => ({ id, label, type: 'scale', scaleMax: 5, ...extra });
const text = (id: string, label: string, extra: Partial<FeedbackQuestion> = {}): FeedbackQuestion => ({ id, label, type: 'text', ...extra });
const s = (sectionId: string, question: FeedbackQuestion): FeedbackQuestion => ({ ...question, sectionId });

export const DEFAULT_FEEDBACK_FORM: FeedbackFormDef = {
  version: 1,
  title: 'Đánh giá chất lượng pipeline',
  createdAt: 0,
  sections: [
    section('info', 'Thông tin'), section('per-step', 'Từng pipeline', 'steps-used'), section('ux-output', 'Đầu ra UX'),
    section('figma', 'Figma'), section('ai-design', 'Thiết kế AI'), section('app-exp', 'Trải nghiệm app'),
    section('speed-cost', 'Tốc độ & chi phí'), section('overall', 'Tổng thể'),
  ],
  questions: [
    s('info', radio('role', 'Vai trò của bạn', ['UX Designer', 'UI Designer', 'BA', 'Developer', 'PM/PO'], { required: true, allowOther: true })),
    s('info', text('project', 'Dự án đã dùng pipeline', { required: true, prefill: 'project-id' })),
    s('info', radio('use-frequency', 'Mức độ sử dụng', ['Dùng hằng ngày', 'Vài lần/tuần', 'Vài lần tổng cộng', 'Mới thử 1 lần'], { required: true })),
    s('info', scale('ai-familiarity', 'Mức quen với công cụ AI')),
    s('info', checkbox('steps-used', 'Bạn đã dùng những phần nào?', undefined, { required: true, optionsSource: 'workflow-steps', prefill: 'completed-steps' })),

    s('per-step', radio('step-stability', 'Mức độ chạy ổn định', ['4 — Mượt, hầu như không lỗi', '3 — Thi thoảng lỗi, chạy lại được', '2 — Hay lỗi, phải mò cách né', '1 — Thường xuyên không chạy được'], { required: true })),
    s('per-step', checkbox('step-issues', 'Không ổn ở đâu?', ['Cài đặt / môi trường / đăng nhập', 'Kết nối nguồn', 'Treo / timeout', 'Sai format / thiếu file', 'Mất dữ liệu', 'Lỗi hiển thị'], { allowOther: true })),
    s('per-step', scale('step-quality', 'Chất lượng output', { required: true })),
    s('per-step', radio('step-usefulness', 'Mức hữu ích', ['Giúp nhiều — thay phần lớn việc tay', 'Giúp vừa — làm nền để sửa tiếp', 'Giúp ít — tham khảo là chính', 'Không giúp — làm tay nhanh hơn'], { required: true })),
    s('per-step', radio('step-runtime', 'Thời gian chạy', ['Nhanh hơn kỳ vọng', 'Chấp nhận được', 'Hơi lâu', 'Quá lâu'])),

    s('ux-output', scale('ux-accuracy', 'Journey/UX Spec đúng nghiệp vụ', { required: true })),
    s('ux-output', checkbox('ux-missing', 'Những case thường bị thiếu', ['Luồng phụ', 'Case lỗi / exception', 'Loading / empty / error', 'Phân quyền / actor phụ', 'Validation form', 'Không thiếu đáng kể'], { required: true })),
    s('ux-output', radio('ux-usable', 'Bản UX dùng được ở mức nào?', ['Làm thẳng wireframe', 'Làm khung thảo luận', 'Chỉ tham khảo', 'Không dùng'])),
    s('ux-output', radio('ux-time-saved', 'Tiết kiệm thời gian', ['>70%', '30–70%', '<30%', 'Không tiết kiệm', 'Tốn thêm thời gian'])),
    s('ux-output', text('ux-most-fixed', 'Điều phải sửa nhiều nhất', { multiline: true })),
    s('ux-output', radio('ai-trust', 'Mức tin kết quả AI', ['Tin, ít kiểm tra lại', 'Tin một phần, luôn đối chiếu', 'Không tin, kiểm tra từng ý'])),

    s('figma', scale('figma-structure', 'Cấu trúc file Figma chuẩn', { required: true })),
    s('figma', checkbox('figma-issues', 'Phần chưa chuẩn', ['Tên layer', 'Component / variant', 'Auto-layout', 'Font / màu / token', 'Icon / ảnh', 'Thiếu màn / state', 'Không có gì đáng kể'])),
    s('figma', radio('figma-rework', 'Tỷ lệ phải sửa lại', ['<10%', '10–30%', '30–60%', '>60%'], { required: true })),
    s('figma', radio('figma-vs-manual', 'So với tự dựng Figma', ['Tiết kiệm nhiều', 'Tiết kiệm chút ít', 'Ngang nhau', 'Tốn hơn'], { required: true })),
    s('figma', text('figma-wish', 'Muốn bổ sung gì nhất?', { multiline: true })),

    s('ai-design', scale('design-beauty', 'Thiết kế AI đẹp', { required: true })),
    s('ai-design', scale('design-consistency', 'Mức nhất quán', { required: true })),
    s('ai-design', scale('design-system-fit', 'Bám design system', { required: true })),
    s('ai-design', scale('design-writing', 'UX writing / thuật ngữ', { required: true })),
    s('ai-design', radio('design-coverage', 'Độ phủ nghiệp vụ', ['Đủ màn và case', 'Đủ màn chính, thiếu case phụ', 'Thiếu màn chính', 'Sai nghiệp vụ'], { required: true })),
    s('ai-design', radio('design-prototype', 'Prototype tương tác', ['Đủ luồng', 'Được một phần', 'Hầu như tĩnh', 'Không mở được'])),

    s('app-exp', radio('app-speed', 'Tốc độ tổng thể', ['Nhanh, mượt', 'Ổn, đôi lúc chậm', 'Chậm, hay lag', 'Rất chậm / hay đơ'], { required: true })),
    s('app-exp', checkbox('app-lag', 'Chỗ hay lag', ['Mở project / chuyển tab', 'Preview HTML/React', 'Canvas / React Flow', 'Chat khi agent chạy', 'Push/pull dữ liệu', 'Đăng nhập / SSO', 'Không gặp'])),
    s('app-exp', scale('app-stability', 'Độ ổn định', { required: true })),
    s('app-exp', scale('app-ease', 'Mức dễ dùng', { required: true })),
    s('app-exp', text('app-annoyance', 'Điều khó chịu nhất', { multiline: true })),

    s('speed-cost', radio('gen-docs-speed', 'Tốc độ sinh tài liệu', ['<5 phút', '5–15 phút', '15–30 phút', '>30 phút'], { required: true })),
    s('speed-cost', radio('gen-ui-speed', 'Tốc độ sinh UI', ['<5 phút', '5–15 phút', '15–30 phút', '>30 phút'], { required: true })),
    s('speed-cost', radio('wait-behavior', 'Trong lúc chờ AI', ['Theo dõi log/chat', 'Làm việc khác', 'Quên luôn'])),
    s('speed-cost', radio('token-value', 'Giá trị so với chi phí token', ['Rất đáng', 'Đáng', 'Chưa đáng', 'Không biết chi phí'])),

    s('overall', radio('pipeline-complete', 'Pipeline đã đủ cho quy trình?', ['Đủ', 'Gần đủ', 'Thiếu nhiều', 'Sai hướng'], { required: true })),
    s('overall', checkbox('missing-steps', 'Thiếu bước nào?', ['Research người dùng / đối thủ (định lượng)', 'Persona có dữ liệu', 'Human review gate (người duyệt)', 'Design QA tự động', 'Xuất slide/docx', 'Quản lý phiên bản / so sánh run'], { allowOther: true })),
    s('overall', text('redundant-steps', 'Bước thừa / không dùng')),
    s('overall', radio('production-ready', 'Sẵn sàng dùng cho dự án thật?', ['Có, làm luồng chính', 'Có, làm luồng phụ song song cách cũ', 'Chưa — cần cải thiện thêm', 'Không'], { required: true })),
    s('overall', scale('nps', 'Khả năng giới thiệu (0–10)', { required: true, scaleMin: 0, scaleMax: 10 })),
    s('overall', text('one-change', 'Nếu chỉ sửa một điều, bạn sửa gì?', { required: true, multiline: true })),
    s('overall', text('other-notes', 'Ý kiến khác', { multiline: true })),
  ],
};

function nonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

/** Kiểm shape danh sách câu hỏi và sections. */
export function validateFormQuestions(questions: unknown, sections?: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(questions) || questions.length === 0) return ['questions: phải là mảng không rỗng'];
  const ids = new Set<string>();
  const sectionIds = new Set<string>();
  const parsedSections: Array<Record<string, unknown>> = [];
  if (sections !== undefined) {
    if (!Array.isArray(sections) || sections.length === 0) errors.push('sections: phải là mảng không rỗng');
    else sections.forEach((raw, index) => {
      const prefix = `Phần ${index + 1}`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${prefix} — phải là object`); return; }
      const section = raw as Record<string, unknown>; parsedSections.push(section);
      if (!nonEmptyString(section.id) || !SLUG_RE.test(section.id)) errors.push(`${prefix} — id: phải là slug không rỗng`);
      else if (sectionIds.has(section.id)) errors.push(`${prefix} — id: bị trùng`); else sectionIds.add(section.id);
      if (!nonEmptyString(section.title)) errors.push(`${prefix} — title: không được rỗng`);
    });
  }
  questions.forEach((raw, index) => {
    const prefix = `Câu ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${prefix} — câu hỏi phải là object`); return; }
    const question = raw as Record<string, unknown>;
    const id = question.id;
    if (!nonEmptyString(id) || !SLUG_RE.test(id)) errors.push(`${prefix} — id: phải là slug không rỗng`);
    else if (ids.has(id)) errors.push(`${prefix} — id: bị trùng`); else ids.add(id);
    if (!nonEmptyString(question.label)) errors.push(`${prefix} — label: không được rỗng`);
    const type = question.type;
    if (typeof type !== 'string' || !QUESTION_TYPES.has(type)) { errors.push(`${prefix} — type: phải thuộc radio, checkbox, text, scale`); return; }
    const hasOptionsSource = 'optionsSource' in question && question.optionsSource !== undefined;
    if (hasOptionsSource && question.optionsSource !== 'workflow-steps') errors.push(`${prefix} — optionsSource: chỉ nhận workflow-steps`);
    if (hasOptionsSource && type !== 'checkbox') errors.push(`${prefix} — optionsSource: chỉ hợp lệ cho checkbox`);
    if (hasOptionsSource && 'options' in question && question.options !== undefined) errors.push(`${prefix} — options: không được dùng cùng optionsSource`);
    if (type === 'radio' || type === 'checkbox') {
      if (!hasOptionsSource && (!Array.isArray(question.options) || question.options.length < 2 || question.options.some((o) => !nonEmptyString(o)) || new Set(question.options).size !== question.options.length)) errors.push(`${prefix} — options: phải có ít nhất 2 chuỗi không rỗng, không trùng nhau`);
    } else if (type === 'scale') {
      if (question.scaleMax !== 5 && question.scaleMax !== 10) errors.push(`${prefix} — scaleMax: phải là 5 hoặc 10`);
    } else {
      if ('options' in question) errors.push(`${prefix} — options: text không được mang field này`);
      if ('scaleMax' in question) errors.push(`${prefix} — scaleMax: text không được mang field này`);
    }
    if ('scaleMin' in question && question.scaleMin !== undefined && (type !== 'scale' || (question.scaleMin !== 0 && question.scaleMin !== 1))) errors.push(`${prefix} — scaleMin: chỉ hợp lệ cho scale, giá trị 0 hoặc 1`);
    if ('multiline' in question && question.multiline !== undefined && (type !== 'text' || typeof question.multiline !== 'boolean')) errors.push(`${prefix} — multiline: chỉ hợp lệ cho text và phải là boolean`);
    if ('prefill' in question && question.prefill !== undefined && question.prefill !== 'project-id' && question.prefill !== 'completed-steps') errors.push(`${prefix} — prefill: giá trị không hợp lệ`);
    if (question.prefill === 'project-id' && type !== 'text') errors.push(`${prefix} — prefill: project-id chỉ hợp lệ cho text`);
    if (question.prefill === 'completed-steps' && (type !== 'checkbox' || !hasOptionsSource)) errors.push(`${prefix} — prefill: completed-steps cần checkbox có optionsSource`);
    if ('allowOther' in question && question.allowOther !== undefined && type !== 'radio' && type !== 'checkbox') errors.push(`${prefix} — allowOther: chỉ hợp lệ cho radio/checkbox`);
    if (sections !== undefined && !nonEmptyString(question.sectionId)) errors.push(`${prefix} — sectionId: bắt buộc khi sections có mặt`);
    if (sections === undefined && 'sectionId' in question && question.sectionId !== undefined) errors.push(`${prefix} — sectionId: không hợp lệ khi sections vắng`);
    if (sections !== undefined && nonEmptyString(question.sectionId) && !sectionIds.has(question.sectionId)) errors.push(`${prefix} — sectionId: không tồn tại`);
  });
  if (sections !== undefined) {
    const questionById = new Map<string, Record<string, unknown>>();
    questions.forEach((raw) => { if (raw && typeof raw === 'object' && !Array.isArray(raw) && nonEmptyString((raw as Record<string, unknown>).id)) questionById.set((raw as Record<string, unknown>).id as string, raw as Record<string, unknown>); });
    parsedSections.forEach((section, index) => {
      if (!('repeatForQuestionId' in section) || section.repeatForQuestionId === undefined) return;
      const prefix = `Phần ${index + 1} — repeatForQuestionId`;
      const target = typeof section.repeatForQuestionId === 'string' ? questionById.get(section.repeatForQuestionId) : undefined;
      const targetSectionIndex = target && typeof target.sectionId === 'string' ? parsedSections.findIndex((candidate) => candidate.id === target.sectionId) : -1;
      if (!target) errors.push(`${prefix}: câu hỏi không tồn tại`);
      else if (target.type !== 'checkbox') errors.push(`${prefix}: câu hỏi phải là checkbox`);
      else if (targetSectionIndex < 0 || targetSectionIndex >= index) errors.push(`${prefix}: phải thuộc section không lặp đứng trước`);
      else if (parsedSections[targetSectionIndex]?.repeatForQuestionId !== undefined) errors.push(`${prefix}: section nguồn không được lặp`);
    });
  }
  return errors;
}

function clientOf(opts: { client?: MediaClient }): FormStoreClient { return opts.client ?? new MediaClient(mediaConfigFromEnv()); }
function parseForm(path: string, content: Buffer): FeedbackFormDef | null {
  const match = FORM_PATH_RE.exec(path); if (!match) return null;
  try { const parsed = JSON.parse(content.toString('utf8')) as unknown; if (!parsed || typeof parsed !== 'object') return null; const form = parsed as Partial<FeedbackFormDef>; const version = Number(match[1]); if (form.version !== version || typeof form.title !== 'string' || typeof form.createdAt !== 'number' || validateFormQuestions(form.questions, form.sections).length > 0) return null; return form as FeedbackFormDef; } catch { return null; }
}
async function resolveForms(projectId: string, client: FormStoreClient): Promise<FeedbackFormDef[]> { const listed = await client.listFiles(projectId); const paths = listed.map((file) => (typeof file.path === 'string' ? file.path : null)).filter((path): path is string => path !== null && FORM_PATH_RE.test(path)); const forms: FeedbackFormDef[] = []; for (const path of paths) { try { const form = parseForm(path, await client.downloadFile(projectId, path)); if (form) forms.push(form); } catch {} } const byVersion = new Map(forms.map((form) => [form.version, form])); if (!byVersion.has(1)) byVersion.set(1, DEFAULT_FEEDBACK_FORM); return [...byVersion.values()].sort((a, b) => a.version - b.version); }
export async function readFeedbackForms(projectId: string, opts: { client?: MediaClient } = {}): Promise<FeedbackFormsResponse> { try { return { storeReachable: true, forms: await resolveForms(projectId, clientOf(opts)) }; } catch { return { storeReachable: false, forms: [DEFAULT_FEEDBACK_FORM] }; } }
export async function saveFeedbackForm(projectId: string, draft: { title: string; sections?: FeedbackFormSection[]; questions: FeedbackQuestion[] }, opts: { client?: MediaClient; user?: string } = {}): Promise<FeedbackFormDef> { const errors = validateFormQuestions(draft.questions, draft.sections); if (!nonEmptyString(draft.title)) errors.unshift('title: không được rỗng'); if (errors.length) throw new Error(`Form không hợp lệ: ${errors.join('; ')}`); const client = clientOf(opts); const existing = await resolveForms(projectId, client); const version = Math.max(...existing.map((form) => form.version), 1) + 1; const form: FeedbackFormDef = { version, title: draft.title, ...(draft.sections ? { sections: draft.sections } : {}), questions: draft.questions, createdAt: Date.now(), ...(opts.user ? { createdBy: opts.user } : {}) }; await client.uploadFile(projectId, FORMS_DIR, `feedback/forms/v${version}.json`, 'application/json', Buffer.from(`${JSON.stringify(form, null, 2)}\n`, 'utf8')); return form; }
