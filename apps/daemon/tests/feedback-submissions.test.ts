import { describe, expect, it } from 'vitest';
import type { FeedbackFormDef, FeedbackSubmission } from '@open-design/contracts';
import { readAllFeedbackSubmissions, submitFeedback, uploadFeedbackImage, validateSubmissionAnswers } from '../src/feedback-submissions.js';

type File = { path: string; data: Buffer };
class FakeClient {
  files: File[] = [];
  fail = false;
  async uploadFile(_p: string, _s: string, path: string, _m: string, data: Buffer) { this.files = [...this.files.filter((f) => f.path !== path), { path, data }]; }
  async listFiles(_p: string) { if (this.fail) throw new Error('offline'); return this.files.map((f) => ({ path: f.path })); }
  async downloadFile(_p: string, path: string) { if (this.fail) throw new Error('offline'); const file = this.files.find((f) => f.path === path); if (!file) throw new Error('missing'); return file.data; }
}
const form: FeedbackFormDef = { version: 3, title: 'F', createdAt: 1, questions: [
  { id: 'r', label: 'r', type: 'radio', required: true, options: ['a', 'b'] },
  { id: 'c', label: 'c', type: 'checkbox', options: ['x', 'y'], allowOther: true },
  { id: 's', label: 's', type: 'scale', required: true, scaleMax: 5 },
  { id: 't', label: 't', type: 'text', required: true },
] };
// `valid` KHÔNG chứa '__other__': mọi phép thử "đúng 1 lỗi" bên dưới spread từ
// đây, mà '__other__' thiếu otherTexts tự nó là một lỗi — fixture bẩn làm mọi
// assertion đếm lỗi lệch +1. Ca '__other__' có case riêng.
const valid = { r: 'a', c: ['x'], s: 4, t: 'ok' } as const;

describe('feedback submissions', () => {
  it('validates all answer branches', () => {
    expect(validateSubmissionAnswers(form, { ...valid, nope: 'x' } as never)).toHaveLength(1);
    expect(validateSubmissionAnswers(form, { ...valid, r: 'z' })).toHaveLength(1);
    expect(validateSubmissionAnswers(form, { ...valid, r: '__other__' })).toHaveLength(1);
    expect(validateSubmissionAnswers(form, { ...valid, c: ['x', 'x'] })).toHaveLength(1);
    expect(validateSubmissionAnswers(form, { ...valid, c: ['z'] })).toHaveLength(1);
    expect(validateSubmissionAnswers(form, { ...valid, s: 6 })).toHaveLength(1);
    expect(validateSubmissionAnswers(form, { ...valid, s: 1.5 })).toHaveLength(1);
    expect(validateSubmissionAnswers(form, { ...valid, t: 'x'.repeat(4001) })).toHaveLength(1);
    expect(validateSubmissionAnswers(form, { ...valid, r: '' })).toHaveLength(1);
    expect(validateSubmissionAnswers(form, { ...valid, t: undefined } as never)).toHaveLength(1);
    // '__other__' được chọn mà không có chữ điền tay → lỗi…
    expect(validateSubmissionAnswers(form, { ...valid, c: ['x', '__other__'] })).toHaveLength(1);
    // …có chữ thì hợp lệ trọn bộ.
    expect(validateSubmissionAnswers(form, { ...valid, c: ['x', '__other__'] }, { c: 'detail' })).toEqual([]);
  });
  it('submits, snapshots stages, appends', async () => {
    const client = new FakeClient();
    const input = { projectId: 'p', installationId: 'install/a', user: 'u', channel: 'dev' as const, workflowId: 'w', form, answers: { ...valid, c: ['x', '__other__'] }, otherTexts: { c: 'detail' }, stageFiles: [{ stageId: 'st', sourcePath: 'src.md', name: 'a/b.md', runId: 'run' }], readStageFile: async () => Buffer.from('snapshot') };
    const first = await submitFeedback(input, { client: client as never });
    await submitFeedback(input, { client: client as never });
    const file = client.files.find((f) => f.path === 'feedback/submissions/installa.json');
    expect(JSON.parse(file!.data.toString())).toHaveLength(2);
    const attachment = first.attachments![0]!;
    expect(attachment).toMatchObject({ kind: 'stage-output', stageId: 'st', sourcePath: 'src.md' });
    expect(client.files.some((f) => f.path === attachment.path)).toBe(true);
  });
  it('rejects before upload, caps attachments and stages', async () => {
    const client = new FakeClient();
    const base = { projectId: 'p', installationId: 'i', user: 'u', channel: 'dev' as const, workflowId: 'w', form, answers: valid };
    await expect(submitFeedback({ ...base, answers: { ...valid, r: 'bad' } }, { client: client as never })).rejects.toThrow();
    expect(client.files).toHaveLength(0);
    await expect(submitFeedback({ ...base, images: Array.from({ length: 11 }, () => ({ kind: 'image' as const, path: 'x', name: 'x' })) }, { client: client as never })).rejects.toThrow('10');
    await expect(submitFeedback({ ...base, stageFiles: [{ stageId: 's', sourcePath: 'x', name: 'big' }], readStageFile: async () => Buffer.alloc(10 * 1024 * 1024 + 1) }, { client: client as never })).rejects.toThrow('10MB');
  });
  it('uploads images with validation and sanitization', async () => {
    const client = new FakeClient();
    await expect(uploadFeedbackImage({ projectId: 'p', submissionDraftId: 'd', filename: 'x', contentType: 'image/png', data: Buffer.alloc(6 * 1024 * 1024) }, { client: client as never })).rejects.toThrow('5MB');
    await expect(uploadFeedbackImage({ projectId: 'p', submissionDraftId: 'd', filename: 'x', contentType: 'text/plain', data: Buffer.from('x') }, { client: client as never })).rejects.toThrow('image');
    const image = await uploadFeedbackImage({ projectId: 'p', submissionDraftId: 'd', filename: 'a/b.png', contentType: 'image/png', data: Buffer.from('x') }, { client: client as never });
    expect(image.path).toBe('feedback/attachments/d/ab.png');
  });
  it('merges machines, skips corrupt files, fails soft', async () => {
    const client = new FakeClient();
    const a: FeedbackSubmission = { id: 'a', formVersion: 1, user: 'a', channel: 'dev', workflowId: 'w', answers: {}, createdAt: 20 };
    const b = { ...a, id: 'b', createdAt: 10 };
    client.files = [{ path: 'feedback/submissions/a.json', data: Buffer.from(JSON.stringify([a])) }, { path: 'feedback/submissions/b.json', data: Buffer.from(JSON.stringify([b])) }, { path: 'feedback/submissions/c.json', data: Buffer.from('{') }];
    expect((await readAllFeedbackSubmissions('p', { client: client as never })).submissions.map((x) => x.id)).toEqual(['b', 'a']);
    client.fail = true;
    expect(await readAllFeedbackSubmissions('p', { client: client as never })).toEqual({ storeReachable: false, submissions: [] });
  });
});

const wizardForm: FeedbackFormDef = {
  version: 5, title: 'W', createdAt: 1,
  sections: [
    { id: 'info', title: 'Thông tin' },
    { id: 'per-step', title: 'Từng bước', repeatForQuestionId: 'steps' },
  ],
  questions: [
    { id: 'steps', label: 's', type: 'checkbox', sectionId: 'info', required: true, optionsSource: 'workflow-steps', allowOther: true },
    { id: 'q', label: 'q', type: 'radio', sectionId: 'per-step', required: true, options: ['ok', 'bad'] },
    { id: 'note', label: 'n', type: 'text', sectionId: 'per-step' },
    { id: 'nps', label: 'nps', type: 'scale', sectionId: 'info', required: true, scaleMin: 0, scaleMax: 10 },
  ],
};
const wizardValid = { steps: ['Docs', 'UX'], 'q@Docs': 'ok', 'q@UX': 'bad', nps: 0 } as const;

describe('feedback submissions with repeated sections', () => {
  it('validates repeated instances and scaleMin', () => {
    expect(validateSubmissionAnswers(wizardForm, wizardValid)).toEqual([]);
    expect(validateSubmissionAnswers(wizardForm, { ...wizardValid, nps: -1 })).toHaveLength(1);
    expect(validateSubmissionAnswers(wizardForm, { ...wizardValid, nps: 11 })).toHaveLength(1);
    expect(validateSubmissionAnswers(wizardForm, { steps: ['Docs', 'UX'], 'q@Docs': 'ok', nps: 0 })).toHaveLength(1);
    expect(validateSubmissionAnswers(wizardForm, { ...wizardValid, 'q@Figma': 'ok' })).toHaveLength(1);
    expect(validateSubmissionAnswers(wizardForm, { steps: [], nps: 0 })).toHaveLength(1);
  });

  it('supports dynamic options, other, and instance otherTexts', () => {
    expect(validateSubmissionAnswers(wizardForm, { steps: ['Anything', 'Xyz'], 'q@Anything': 'ok', 'q@Xyz': 'bad', nps: 0 })).toEqual([]);
    expect(validateSubmissionAnswers(wizardForm, { steps: ['A', 'A'], 'q@A': 'ok', nps: 0 })).toHaveLength(1);
    expect(validateSubmissionAnswers(wizardForm, { steps: ['Docs', '__other__'], 'q@Docs': 'ok', nps: 0 })).toHaveLength(1);
    expect(validateSubmissionAnswers(wizardForm, { steps: ['Docs', '__other__'], 'q@Docs': 'ok', nps: 0 }, { steps: 'chi tiết' })).toEqual([]);

    const form = { ...wizardForm, questions: [...wizardForm.questions, { id: 'issues', label: 'i', type: 'checkbox' as const, sectionId: 'per-step', allowOther: true, options: ['x'] }] };
    const answers = { steps: ['Docs', 'UX'], 'q@Docs': 'ok', 'q@UX': 'bad', nps: 0, 'issues@Docs': ['x', '__other__'] };
    expect(validateSubmissionAnswers(form, answers, { 'issues@Docs': 'note' })).toEqual([]);
    expect(validateSubmissionAnswers(form, answers)).toHaveLength(1);
  });

  it('submits a valid wizard form', async () => {
    const client = new FakeClient();
    const submission = await submitFeedback({ projectId: 'p', installationId: 'wizard', user: 'u', channel: 'dev', workflowId: 'w', form: wizardForm, answers: wizardValid }, { client: client as never });
    expect(submission.answers).toEqual(wizardValid);
    expect(client.files).toHaveLength(1);
  });
});
