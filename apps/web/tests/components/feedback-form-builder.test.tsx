// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FeedbackFormDef, FeedbackQuestion } from '@open-design/contracts';
import { FeedbackFormBuilder, builderDraftErrors } from '../../src/components/feedback/FeedbackFormBuilder';

afterEach(() => cleanup());

const question = (overrides: Partial<FeedbackQuestion> = {}): FeedbackQuestion => ({ id: 'rating', label: 'Đánh giá', type: 'radio', options: ['Tốt', 'Chưa tốt'], ...overrides });
const form = (questions: FeedbackQuestion[] = [question()]): FeedbackFormDef => ({ version: 1, title: 'Feedback', questions, createdAt: 1 });
const save = () => vi.fn(async (_draft: { title: string; sections?: { title: string }[]; questions: FeedbackQuestion[] }) => undefined);

function clickText(text: string) { fireEvent.click(screen.getByText(text)); }

 describe('builderDraftErrors', () => {
  it('mirrors legacy and extended validation branches', () => {
    expect(builderDraftErrors({ title: 'x', questions: [question({ id: 'same', label: 'A' }), question({ id: 'same', label: 'B' })] }).join(' ')).toContain('id bị trùng');
    expect(builderDraftErrors({ title: 'x', questions: [question({ options: ['Một'] })] }).join(' ')).toContain('ít nhất 2');
    expect(builderDraftErrors({ title: 'x', questions: [question({ type: 'scale', options: undefined })] }).join(' ')).toContain('thang điểm');
    expect(builderDraftErrors({ title: 'x', questions: [question({ type: 'text', options: ['x'] })] }).join(' ')).toContain('văn bản');
    expect(builderDraftErrors({ title: 'x', questions: [question({ type: 'scale', allowOther: true, options: undefined, scaleMax: 5 })] }).join(' ')).toContain('Khác');
    expect(builderDraftErrors({ title: 'x', questions: [question({ id: 'a', label: 'A' }), question({ id: 'b', label: 'B' })] })).toEqual([]);
    expect(builderDraftErrors({ title: 'x', sections: [{ id: 's', title: 'S' }, { id: 's', title: 'T' }], questions: [question({ sectionId: 's' })] }).join(' ')).toContain('Id phần bị trùng');
    expect(builderDraftErrors({ title: 'x', sections: [{ id: 's', title: 'S' }, { id: 't', title: 'T', repeatForQuestionId: 'rating' }], questions: [question({ sectionId: 's' })] }).join(' ')).toContain('lặp theo');
    expect(builderDraftErrors({ title: 'x', sections: [{ id: 's', title: 'S' }, { id: 't', title: 'T' }], questions: [question({ sectionId: 't' }), question({ id: 'radio', label: 'R', type: 'radio', options: ['a', 'b'], sectionId: 's' })] })).toEqual([]);
    expect(builderDraftErrors({ title: 'x', sections: [{ id: 's', title: 'S' }], questions: [question({ sectionId: 'bad' })] }).join(' ')).toContain('không tồn tại');
    expect(builderDraftErrors({ title: 'x', questions: [question({ sectionId: 's' })] }).join(' ')).toContain('không có sections');
    expect(builderDraftErrors({ title: 'x', questions: [question({ type: 'checkbox', optionsSource: 'workflow-steps', options: ['x', 'y'] })] }).join(' ')).toContain('không được có options');
    expect(builderDraftErrors({ title: 'x', questions: [question({ type: 'scale', options: undefined, scaleMax: 5, scaleMin: 2 as never })] }).join(' ')).toContain('0 hoặc 1');
    expect(builderDraftErrors({ title: 'x', questions: [question({ type: 'radio', prefill: 'project-id' })] }).join(' ')).toContain('project-id');
  });
});

describe('FeedbackFormBuilder', () => {
  it('renders questions and adds a new question', () => {
    render(<FeedbackFormBuilder form={form([question(), question({ id: 'b', label: 'Khác' })])} onSave={save()} />);
    expect(screen.getAllByText(/^Câu \d+$/)).toHaveLength(2);
    clickText('Thêm câu hỏi');
    expect(screen.getAllByText(/^Câu \d+$/)).toHaveLength(3);
  });

  it('moves questions up and down', () => {
    render(<FeedbackFormBuilder form={form([question(), question({ id: 'b', label: 'B' })])} onSave={save()} />);
    const labels = () => screen.getAllByLabelText('Nhãn').map((input) => (input as HTMLInputElement).value);
    expect(labels()).toEqual(['Đánh giá', 'B']);
    fireEvent.click(screen.getByLabelText('Đưa câu 2 lên'));
    expect(labels()).toEqual(['B', 'Đánh giá']);
  });

  it('clears options when radio changes to text and saves payload', async () => {
    const onSave = save();
    render(<FeedbackFormBuilder form={form()} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Kiểu'), { target: { value: 'text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu (tạo version mới)' }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0].questions[0]).not.toHaveProperty('options');
  });

  it('disables save and shows validation errors for an invalid draft', () => {
    render(<FeedbackFormBuilder form={form([question({ options: ['Một'] })])} onSave={save()} />);
    expect((screen.getByRole('button', { name: 'Lưu (tạo version mới)' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('ít nhất 2');
  });

  it('saves a valid payload exactly once', async () => {
    const onSave = save();
    render(<FeedbackFormBuilder form={form()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lưu (tạo version mới)' }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toEqual({ title: 'Feedback', questions: [question()] });
  });

  it('renders sections, renames one, and limits repeat source to prior checkbox questions', async () => {
    const onSave = save();
    const sections = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }];
    render(<FeedbackFormBuilder form={{ ...form([question({ sectionId: 'a', type: 'checkbox' }), question({ id: 'r', label: 'Radio', sectionId: 'b', options: ['a', 'b'] })]), sections }} onSave={onSave} />);
    expect(screen.getByLabelText('Tên phần 1')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tên phần 1'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu (tạo version mới)' }));
    await vi.waitFor(() => expect(onSave.mock.calls[0]?.[0].sections?.[0]?.title).toBe('Renamed'));
    const repeatSelects = screen.getAllByLabelText('Lặp theo') as HTMLSelectElement[];
    expect(Array.from(repeatSelects[1]?.options ?? []).map((option) => option.text)).toContain('Đánh giá');
    expect(Array.from(repeatSelects[0]?.options ?? []).map((option) => option.text)).not.toContain('Đánh giá');
  });

  it('toggles workflow options and omits static options', async () => {
    const onSave = save();
    render(<FeedbackFormBuilder form={form([question({ type: 'checkbox' })])} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText('Lựa chọn = các bước pipeline'));
    expect(screen.queryByText('Lựa chọn')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lưu (tạo version mới)' }));
    await vi.waitFor(() => expect(onSave.mock.calls[0]?.[0].questions[0]).toMatchObject({ optionsSource: 'workflow-steps' }));
    expect(onSave.mock.calls[0]?.[0].questions[0]).not.toHaveProperty('options');
  });

  it('adds scaleMin 0, removes it when unticked, and clears extended fields on type change', async () => {
    const onSave = save();
    render(<FeedbackFormBuilder form={form([question({ type: 'checkbox', optionsSource: 'workflow-steps', options: undefined, prefill: 'completed-steps' })])} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Kiểu'), { target: { value: 'scale' } });
    fireEvent.click(screen.getByLabelText('Bắt đầu từ 0'));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu (tạo version mới)' }));
    await vi.waitFor(() => expect(onSave.mock.calls[0]?.[0].questions[0]).toMatchObject({ scaleMin: 0 }));
    cleanup();
    const onSave2 = save();
    render(<FeedbackFormBuilder form={form([question({ type: 'checkbox', optionsSource: 'workflow-steps', options: undefined, prefill: 'completed-steps' })])} onSave={onSave2} />);
    fireEvent.change(screen.getByLabelText('Kiểu'), { target: { value: 'text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu (tạo version mới)' }));
    await vi.waitFor(() => expect(onSave2.mock.calls[0]?.[0].questions[0]).not.toHaveProperty('optionsSource'));
    expect(onSave2.mock.calls[0]?.[0].questions[0]).not.toHaveProperty('prefill');
  });
});
