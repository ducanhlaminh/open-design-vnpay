// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FeedbackFormDef } from '@open-design/contracts';
import { FeedbackFormFill, fillErrors } from '../../src/components/feedback/FeedbackFormFill';

afterEach(() => cleanup());
vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:test') });

const context = { projectId: 'p', steps: [] };
const base = (questions: FeedbackFormDef['questions'], extra: Partial<FeedbackFormDef> = {}): FeedbackFormDef => ({ version: 1, title: 'Phản hồi', questions, createdAt: 1, ...extra });
const q = { id: 'q', label: 'Câu hỏi', type: 'radio' as const, options: ['Có', 'Không'], required: true };
const props = (form: FeedbackFormDef, overrides: Partial<React.ComponentProps<typeof FeedbackFormFill>> = {}) => ({ form, context, stageOutputs: [], onUploadImage: vi.fn(async () => ({ kind: 'image' as const, path: 'x', name: 'x.png' })), onSubmit: vi.fn(async () => {}), ...overrides });

it('fillErrors kiểm tra required, Khác, text cap, scaleMin 0', () => {
  const form = base([
    q, { id: 'r', label: 'Radio', type: 'radio', options: ['A'], allowOther: true },
    { id: 'c', label: 'Checkbox', type: 'checkbox', options: ['A'], allowOther: true },
    { id: 't', label: 'Văn bản', type: 'text' },
  ]);
  expect(fillErrors(form, {}, {})).toContain('Vui lòng trả lời: Câu hỏi');
  expect(fillErrors(form, { q: 'Có', r: '__other__', c: ['__other__'] }, {})).toHaveLength(2);
  expect(fillErrors(form, { t: 'x'.repeat(4001) }, {})).toContain('Văn bản không được vượt quá 4000 ký tự');
  expect(fillErrors(form, { q: 'Có', r: '__other__', c: ['A'], t: 'ok' }, { r: 'khác' })).toEqual([]);
  expect(fillErrors(base([{ id: 's', label: 'Điểm', type: 'scale', scaleMin: 0, scaleMax: 5, required: true }]), { s: 0 }, {})).toEqual([]);
});

it('render đủ radio, checkbox, text, scale', () => {
  render(<FeedbackFormFill {...props(base([q, { id: 'c', label: 'Chọn', type: 'checkbox', options: ['A'] }, { id: 't', label: 'Mô tả', type: 'text', multiline: true }, { id: 's', label: 'Điểm', type: 'scale', scaleMax: 5 }]))} />);
  expect(screen.getByText('Câu hỏi')).toBeTruthy(); expect(screen.getByText('Chọn')).toBeTruthy(); expect(screen.getByLabelText('Mô tả')).toBeTruthy(); expect(screen.getAllByRole('button', { name: /^[1-5]$/ })).toHaveLength(5);
});

it('radio Khác hiện input, submit payload đúng', async () => {
  const onSubmit = vi.fn(async () => {});
  render(<FeedbackFormFill {...props(base([q, { id: 'r', label: 'Lý do', type: 'radio', options: ['A'], allowOther: true }]), { onSubmit })} />);
  fireEvent.click(screen.getByLabelText('Có')); fireEvent.click(screen.getByLabelText('Khác')); fireEvent.change(screen.getByLabelText('Nội dung khác cho Lý do'), { target: { value: 'Nội dung' } }); fireEvent.click(screen.getByRole('button', { name: /Gửi phản hồi/ }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ answers: expect.objectContaining({ r: '__other__' }), otherTexts: { r: 'Nội dung' } })));
});

it('tick output stage submit đủ 2 ref', async () => {
  const onSubmit = vi.fn(async () => {});
  render(<FeedbackFormFill {...props(base([]), { onSubmit, stageOutputs: [{ stageId: 's', stageName: 'Bước 1', files: [{ sourcePath: 'a', name: 'a.md' }, { sourcePath: 'b', name: 'b.md' }] }] })} />);
  fireEvent.click(screen.getByLabelText('a.md')); fireEvent.click(screen.getByLabelText('b.md')); fireEvent.click(screen.getByRole('button', { name: /Gửi phản hồi/ }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ stageFiles: [{ stageId: 's', sourcePath: 'a', name: 'a.md' }, { stageId: 's', sourcePath: 'b', name: 'b.md' }] })));
});

it('chọn ảnh gọi upload, resolve hiện tên, reject hiện lỗi', async () => {
  const upload = vi.fn().mockResolvedValue({ kind: 'image' as const, path: 'stored', name: 'photo.png' });
  const onSubmit = vi.fn(async () => {});
  render(<FeedbackFormFill {...props(base([]), { onUploadImage: upload, onSubmit })} />);
  const file = new File(['x'], 'photo.png', { type: 'image/png' }); fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
  await waitFor(() => expect(upload).toHaveBeenCalledWith(file)); expect(screen.getByText('photo.png')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: /Gửi phản hồi/ })); await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ images: [{ kind: 'image', path: 'stored', name: 'photo.png' }] })));
  cleanup(); const reject = vi.fn().mockRejectedValue(new Error('Upload lỗi')); render(<FeedbackFormFill {...props(base([]), { onUploadImage: reject })} />); fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } }); await waitFor(() => expect(screen.getByText('Upload lỗi')).toBeTruthy());
});

it('form lỗi disabled, hợp lệ submit một lần và hiện Đã gửi', async () => {
  const onSubmit = vi.fn(async () => {}); render(<FeedbackFormFill {...props(base([q]), { onSubmit })} />); expect((screen.getByRole('button', { name: /Gửi phản hồi/ }) as HTMLButtonElement).disabled).toBe(true); fireEvent.click(screen.getByLabelText('Có')); fireEvent.click(screen.getByRole('button', { name: /Gửi phản hồi/ })); await waitFor(() => expect(screen.getByText('Đã gửi — cảm ơn!')).toBeTruthy()); expect(onSubmit).toHaveBeenCalledTimes(1);
});

const wizardForm: FeedbackFormDef = base([
  { id: 'used', label: 'Bước đã dùng', type: 'checkbox', optionsSource: 'workflow-steps', prefill: 'completed-steps', sectionId: 'a' },
  { id: 'project', label: 'Dự án', type: 'text', prefill: 'project-id', sectionId: 'a' },
  { id: 'detail', label: 'Chi tiết', type: 'text', required: true, sectionId: 'b' },
], { sections: [{ id: 'a', title: 'Chọn bước' }, { id: 'b', title: 'Chi tiết', repeatForQuestionId: 'used' }] });

it('wizard sidebar, chuyển phần, prefill/options động, section lặp', () => {
  const wizardProps = props(wizardForm, { context: { projectId: 'p', steps: [{ id: '1', label: 'Alpha', completed: true }, { id: '2', label: 'Beta', completed: false }] } });
  render(<FeedbackFormFill {...wizardProps} />);
  expect(screen.getAllByText('Chọn bước').length).toBeGreaterThan(0); expect((screen.getByLabelText('Dự án') as HTMLInputElement).value).toBe('p'); expect((screen.getByLabelText('Alpha') as HTMLInputElement).checked).toBe(true); fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục' })); fireEvent.click(screen.getByRole('button', { name: 'Quay lại' })); expect((screen.getByRole('button', { name: 'Quay lại' }) as HTMLButtonElement).disabled).toBe(true);
});

it('section lặp theo 2 option, keys @option, thiếu phần đầu quay lại', async () => {
  const onSubmit = vi.fn(async () => {});
  const wizardProps = props(wizardForm, { onSubmit, context: { projectId: 'p', steps: [{ id: '1', label: 'Alpha', completed: false }, { id: '2', label: 'Beta', completed: false }] } });
  render(<FeedbackFormFill {...wizardProps} />);
  fireEvent.click(screen.getByLabelText('Alpha')); fireEvent.click(screen.getByLabelText('Beta')); fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục' })); expect(screen.getByText('Chi tiết (Alpha)')).toBeTruthy(); expect(screen.getByText('Chi tiết (Beta)')).toBeTruthy(); fireEvent.change(screen.getAllByLabelText('Chi tiết')[0]!, { target: { value: 'a' } }); fireEvent.change(screen.getAllByLabelText('Chi tiết')[1]!, { target: { value: 'b' } }); fireEvent.click(screen.getByRole('button', { name: /Gửi phản hồi/ })); await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ answers: expect.objectContaining({ 'detail@Alpha': 'a', 'detail@Beta': 'b' }) })));
});
