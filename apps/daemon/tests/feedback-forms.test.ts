import { describe, expect, it } from 'vitest';
import type { FeedbackFormDef, FeedbackFormSection, FeedbackQuestion } from '@open-design/contracts';
import { DEFAULT_FEEDBACK_FORM, readFeedbackForms, saveFeedbackForm, validateFormQuestions } from '../src/feedback-forms.js';

type File = { path: string; data: Buffer };
class FakeClient {
  files: File[] = [];
  async uploadFile(_p: string, _s: string, path: string, _m: string, data: Buffer) { this.files.push({ path, data }); }
  async listFiles(_p: string) { return this.files.map((f) => ({ path: f.path })); }
  async downloadFile(_p: string, path: string) { return this.files.find((f) => f.path === path)!.data; }
}
const q = (extra: Partial<FeedbackQuestion> = {}): FeedbackQuestion => ({ id: 'q', label: 'Q', type: 'radio', options: ['a', 'b'], ...extra });
const sections: FeedbackFormSection[] = [{ id: 'first', title: 'First' }, { id: 'second', title: 'Second' }];
const sectionQuestions: FeedbackQuestion[] = [q({ id: 'source', sectionId: 'first', type: 'checkbox', options: ['a', 'b'] }), q({ id: 'target', sectionId: 'second' })];
const has = (errors: string[], text: string) => expect(errors.some((error) => error.includes(text))).toBe(true);

describe('feedback forms', () => {
  it('validates the default wizard shape', () => {
    expect(DEFAULT_FEEDBACK_FORM.title).toBe('Đánh giá chất lượng pipeline');
    expect(DEFAULT_FEEDBACK_FORM.sections).toHaveLength(8);
    expect(DEFAULT_FEEDBACK_FORM.questions).toHaveLength(43);
    expect(DEFAULT_FEEDBACK_FORM.questions.find((x) => x.id === 'nps')).toMatchObject({ scaleMin: 0, scaleMax: 10 });
    expect(DEFAULT_FEEDBACK_FORM.questions.find((x) => x.id === 'steps-used')).toMatchObject({ optionsSource: 'workflow-steps' });
    expect(validateFormQuestions(DEFAULT_FEEDBACK_FORM.questions, DEFAULT_FEEDBACK_FORM.sections)).toEqual([]);
  });

  it.each([
    ['empty', [], 'sections: phải là mảng không rỗng'],
    ['duplicate id', [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }], 'Phần 2 — id: bị trùng'],
    ['empty title', [{ id: 'a', title: '' }], 'Phần 1 — title: không được rỗng'],
  ])('rejects sections %s', (_name, value, expected) => has(validateFormQuestions([q({ sectionId: 'a' })], value), expected as string));

  it.each([
    ['missing target', 'missing', 'câu hỏi không tồn tại'],
    ['radio target', 'radio', 'câu hỏi phải là checkbox'],
    ['target after', 'after', 'phải thuộc section không lặp đứng trước'],
    ['target in repeated section', 'self', 'phải thuộc section không lặp đứng trước'],
  ])('rejects invalid repeat target: %s', (_name, target, expected) => {
    let ss: FeedbackFormSection[]; let qs: FeedbackQuestion[];
    if (target === 'radio') { ss = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', repeatForQuestionId: 'source' }]; qs = [q({ id: 'source', sectionId: 'a' })]; }
    else if (target === 'after') { ss = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', repeatForQuestionId: 'source' }, { id: 'c', title: 'C' }]; qs = [q({ id: 'source', sectionId: 'c', type: 'checkbox', options: ['a', 'b'] })]; }
    else if (target === 'self') { ss = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', repeatForQuestionId: 'source' }]; qs = [q({ id: 'source', sectionId: 'b', type: 'checkbox', options: ['a', 'b'] })]; }
    else { ss = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', repeatForQuestionId: 'missing' }]; qs = [q({ id: 'source', sectionId: 'a', type: 'checkbox', options: ['a', 'b'] })]; }
    has(validateFormQuestions(qs, ss), expected as string);
  });

  it('requires consistent section ownership', () => {
    has(validateFormQuestions([q()], sections), 'sectionId: bắt buộc');
    has(validateFormQuestions([q({ sectionId: 'unknown' })], sections), 'sectionId: không tồn tại');
    has(validateFormQuestions([q({ sectionId: 'first' })]), 'sectionId: không hợp lệ');
  });

  it('validates optionsSource', () => {
    has(validateFormQuestions([q({ optionsSource: 'workflow-steps' })]), 'optionsSource: chỉ hợp lệ cho checkbox');
    has(validateFormQuestions([q({ type: 'checkbox', optionsSource: 'workflow-steps', options: ['a', 'b'] })]), 'options: không được dùng cùng optionsSource');
    expect(validateFormQuestions([{ id: 'steps', label: 'Steps', type: 'checkbox', optionsSource: 'workflow-steps' }])).toEqual([]);
  });

  it.each([
    [q({ type: 'text', scaleMin: 2 } as never), 'scaleMin'],
    [q({ type: 'text', scaleMin: 1 }), 'scaleMin'],
    [q({ type: 'radio', multiline: true }), 'multiline'],
    [q({ type: 'checkbox', prefill: 'project-id', options: ['a', 'b'] }), 'project-id'],
    [q({ type: 'checkbox', prefill: 'completed-steps', options: ['a', 'b'] }), 'completed-steps'],
  ] as const)('rejects invalid field %s', (question, expected) => has(validateFormQuestions([question]), expected));

  it('saves sections and preserves them in storage', async () => {
    const client = new FakeClient();
    const draft = { title: 'Wizard', sections, questions: sectionQuestions };
    const saved = await saveFeedbackForm('p', draft, { client: client as never });
    expect(saved.sections).toEqual(sections);
    expect(JSON.parse(client.files[0]!.data.toString())).toMatchObject({ sections, questions: sectionQuestions });
    expect((await readFeedbackForms('p', { client: client as never })).forms).toHaveLength(2);
  });

  it('saves workflowId for per-workflow forms and rejects blank workflowId', async () => {
    const client = new FakeClient();
    const draft = { title: 'PRD', workflowId: 'docs-to-prd', sections, questions: sectionQuestions };
    const saved = await saveFeedbackForm('p', draft, { client: client as never });
    expect(saved.workflowId).toBe('docs-to-prd');
    expect(JSON.parse(client.files[0]!.data.toString())).toMatchObject({ workflowId: 'docs-to-prd' });
    await expect(saveFeedbackForm('p', { ...draft, workflowId: '  ' }, { client: client as never })).rejects.toThrow('workflowId');
  });
});
