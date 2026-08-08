import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';
import type {
  FeedbackAnswerValue,
  FeedbackAttachment,
  FeedbackFormDef,
  FeedbackQuestion,
  FeedbackStageFileRef,
  FeedbackSubmission,
} from '@open-design/contracts';

const SUBMISSIONS_DIR = 'feedback/submissions';
const ATTACHMENTS_DIR = 'feedback/attachments';
const IMAGE_CAP = 5 * 1024 * 1024;
const STAGE_CAP = 10 * 1024 * 1024;
const ATTACHMENT_CAP = 10;

type Client = Pick<MediaClient, 'uploadFile' | 'listFiles' | 'downloadFile'>;

function clientOf(opts?: { client?: MediaClient }): Client {
  return opts?.client ?? new MediaClient(mediaConfigFromEnv());
}

function cleanFileName(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '');
  return cleaned || 'attachment';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function answerEmpty(question: FeedbackQuestion, value: FeedbackAnswerValue): boolean {
  if (question.type === 'text' || question.type === 'radio') return typeof value === 'string' && value.trim() === '';
  if (question.type === 'checkbox') return Array.isArray(value) && value.length === 0;
  return false;
}

function optionError(question: FeedbackQuestion, key: string, value: FeedbackAnswerValue, otherTexts: Record<string, string>): boolean {
  const options = new Set(question.options ?? []);
  const allowsOther = question.allowOther === true;
  const validOther = (selected: boolean) => !selected || (allowsOther && isNonEmptyString(otherTexts[key]));
  if (question.type === 'radio') {
    return typeof value !== 'string'
      || (value !== '__other__' && question.optionsSource !== 'workflow-steps' && !options.has(value))
      || !validOther(value === '__other__');
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0) || new Set(value).size !== value.length) return true;
  return value.some((item) => item !== '__other__' && question.optionsSource !== 'workflow-steps' && !options.has(item))
    || !validOther(value.includes('__other__'));
}

function sectionQuestions(form: FeedbackFormDef): Map<string, string> {
  return new Map((form.sections ?? []).map((section) => [section.id, section.repeatForQuestionId ?? '']));
}

function expectedKeysOf(form: FeedbackFormDef, answers: Record<string, FeedbackAnswerValue>): Map<string, FeedbackQuestion> {
  const sectionById = sectionQuestions(form);
  const expected = new Map<string, FeedbackQuestion>();
  for (const question of form.questions) {
    const repeatForQuestionId = question.sectionId ? sectionById.get(question.sectionId) : undefined;
    if (!repeatForQuestionId) {
      expected.set(question.id, question);
      continue;
    }
    const instances = Array.isArray(answers[repeatForQuestionId]) ? answers[repeatForQuestionId] : [];
    for (const option of instances) {
      if (typeof option === 'string' && option !== '__other__') expected.set(`${question.id}@${option}`, question);
    }
  }
  return expected;
}

function questionIdFromAnswerKey(key: string): string {
  const at = key.indexOf('@');
  return at === -1 ? key : key.slice(0, at);
}

/** Đối chiếu answers với ĐÚNG version form người dùng đã điền. Lỗi tiếng Việt
 * nêu id câu hỏi. Đây là hàng rào quan trọng nhất của module: answers là dữ
 * liệu thống kê sẽ được đếm mù theo option — một giá trị ngoài options lọt
 * vào là số liệu sai không ai phát hiện. */
export function validateSubmissionAnswers(
  form: FeedbackFormDef,
  answers: Record<string, FeedbackAnswerValue>,
  otherTexts: Record<string, string> = {},
): string[] {
  const errors: string[] = [];
  const expected = expectedKeysOf(form, answers);
  const questions = new Map(form.questions.map((question) => [question.id, question]));

  for (const id of Object.keys(answers)) {
    if (!expected.has(id)) errors.push(`Câu hỏi ${id} không tồn tại trong form`);
  }
  for (const [key, text] of Object.entries(otherTexts)) {
    const question = expected.get(key) ?? questions.get(questionIdFromAnswerKey(key));
    const value = answers[key];
    const selected = Array.isArray(value) ? value.includes('__other__') : value === '__other__';
    if (!question || !question.allowOther || !selected || !isNonEmptyString(text)) errors.push(`Câu hỏi ${key} có otherTexts không hợp lệ`);
  }

  for (const [key, question] of expected) {
    const value = answers[key];
    if (value === undefined) {
      if (question.required) errors.push(`Câu hỏi ${key} là bắt buộc`);
      continue;
    }
    if (answerEmpty(question, value)) {
      if (question.required) errors.push(`Câu hỏi ${key} là bắt buộc`);
      else errors.push(`Câu hỏi ${key} không được rỗng`);
      continue;
    }
    if (question.type === 'radio' || question.type === 'checkbox') {
      if (optionError(question, key, value, otherTexts)) errors.push(`Câu hỏi ${key} có lựa chọn không hợp lệ`);
    } else if (question.type === 'scale') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < (question.scaleMin ?? 1) || value > (question.scaleMax ?? 0)) {
        errors.push(`Câu hỏi ${key} có điểm không hợp lệ`);
      }
    } else if (typeof value !== 'string' || value.length > 4000) {
      errors.push(`Câu hỏi ${key} có nội dung không hợp lệ`);
    }
    if (otherTexts[key] !== undefined && question.type !== 'radio' && question.type !== 'checkbox') {
      errors.push(`Câu hỏi ${key} không hỗ trợ lựa chọn khác`);
    }
  }
  return errors;
}

export interface SubmitFeedbackInput {
  projectId: string;
  installationId: string;
  user: string;
  channel: 'dev' | 'packaged';
  workflowId: string;
  runId?: string;
  form: FeedbackFormDef;
  answers: Record<string, FeedbackAnswerValue>;
  otherTexts?: Record<string, string>;
  images?: FeedbackAttachment[];
  stageFiles?: FeedbackStageFileRef[];
  readStageFile?: (sourcePath: string) => Promise<Buffer>;
}

export async function submitFeedback(input: SubmitFeedbackInput, opts?: { client?: MediaClient }): Promise<FeedbackSubmission> {
  const errors = validateSubmissionAnswers(input.form, input.answers, input.otherTexts);
  if (errors.length) throw new Error(`Answers không hợp lệ: ${errors.join('; ')}`);
  const images = input.images ?? [];
  const stages = input.stageFiles ?? [];
  if (images.length + stages.length > ATTACHMENT_CAP) throw new Error(`Tối đa ${ATTACHMENT_CAP} đính kèm`);
  const client = clientOf(opts);
  const id = randomUUID();
  const attachments: FeedbackAttachment[] = [...images];
  for (const stage of stages) {
    const data = await (input.readStageFile ?? ((source: string) => fs.readFile(path.resolve(source))))(stage.sourcePath);
    if (data.length > STAGE_CAP) throw new Error(`File ${stage.name} vượt quá 10MB`);
    const name = cleanFileName(stage.name);
    const remotePath = `${ATTACHMENTS_DIR}/${id}/${name}`;
    await client.uploadFile(input.projectId, `${ATTACHMENTS_DIR}/${id}`, remotePath, 'application/octet-stream', data);
    attachments.push({ kind: 'stage-output', path: remotePath, name, stageId: stage.stageId, sourcePath: stage.sourcePath, ...(stage.runId ? { runId: stage.runId } : {}) });
  }
  const submission: FeedbackSubmission = {
    id, formVersion: input.form.version, user: input.user, channel: input.channel,
    workflowId: input.workflowId, ...(input.runId ? { runId: input.runId } : {}),
    answers: input.answers, ...(input.otherTexts ? { otherTexts: input.otherTexts } : {}),
    ...(attachments.length ? { attachments } : {}), createdAt: Date.now(),
  };
  const submissionPath = `${SUBMISSIONS_DIR}/${cleanFileName(input.installationId)}.json`;
  let existing: FeedbackSubmission[] = [];
  try { existing = JSON.parse((await client.downloadFile(input.projectId, submissionPath)).toString('utf8')) as FeedbackSubmission[]; } catch { /* absent first file */ }
  existing = Array.isArray(existing) ? existing : [];
  existing.push(submission);
  existing.sort((a, b) => a.createdAt - b.createdAt);
  await client.uploadFile(input.projectId, SUBMISSIONS_DIR, submissionPath, 'application/json', Buffer.from(`${JSON.stringify(existing, null, 2)}\n`));
  return submission;
}

export async function uploadFeedbackImage(
  input: { projectId: string; submissionDraftId: string; filename: string; contentType: string; data: Buffer },
  opts?: { client?: MediaClient },
): Promise<FeedbackAttachment> {
  if (input.data.length > IMAGE_CAP) throw new Error('Ảnh vượt quá 5MB');
  if (!input.contentType.startsWith('image/')) throw new Error('Đính kèm phải có contentType image/*');
  const name = cleanFileName(input.filename);
  const remotePath = `${ATTACHMENTS_DIR}/${input.submissionDraftId}/${name}`;
  await clientOf(opts).uploadFile(input.projectId, `${ATTACHMENTS_DIR}/${input.submissionDraftId}`, remotePath, input.contentType, input.data);
  return { kind: 'image', path: remotePath, name };
}

export async function readAllFeedbackSubmissions(projectId: string, opts?: { client?: MediaClient }): Promise<{ storeReachable: boolean; submissions: FeedbackSubmission[] }> {
  const client = clientOf(opts);
  try {
    const files = await client.listFiles(projectId);
    const paths = files.map((file) => file.path).filter((file): file is string => typeof file === 'string' && file.startsWith(`${SUBMISSIONS_DIR}/`) && file.endsWith('.json'));
    const submissions: FeedbackSubmission[] = [];
    for (const file of paths) {
      try {
        const parsed = JSON.parse((await client.downloadFile(projectId, file)).toString('utf8')) as unknown;
        if (Array.isArray(parsed)) submissions.push(...parsed as FeedbackSubmission[]);
      } catch { /* bỏ qua file hỏng */ }
    }
    submissions.sort((a, b) => a.createdAt - b.createdAt);
    return { storeReachable: true, submissions };
  } catch {
    return { storeReachable: false, submissions: [] };
  }
}
