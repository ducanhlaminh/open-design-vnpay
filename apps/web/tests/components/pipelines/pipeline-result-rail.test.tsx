// @vitest-environment jsdom
//
// Rail trái (cây file) của Quick result nay thu gọn/mở rộng được, trạng thái
// nhớ qua localStorage — vì PipelineResultBody dùng chung cho MỌI bước (modal
// lẫn trang PipelineResultView), nên toggle đặt ở đây thì mọi bước đều hưởng
// (WP17b). Chỉ test nhánh có rail (showRail=true, >=2 file); nhánh 1 file vẫn
// giữ nguyên như cũ (không có nút toggle) theo must_not của spec.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectFile } from '@open-design/contracts';

// FileViewer thật kéo theo AnalyticsProvider/artifact renderer registry — quá
// nặng cho test rail thuần UI, nên mock thành stub hiển thị tên file đang mở.
vi.mock('../../../src/components/FileViewer', () => ({
  FileViewer: ({ file }: { file: ProjectFile }) => <div data-testid="file-viewer-stub">{file.name}</div>,
}));

import { PipelineResultBody } from '../../../src/components/pipelines/PipelineModals';

const RAIL_KEY = 'od.quickResult.rail';

function file(name: string): ProjectFile {
  return { name, size: 10, mtime: 0, kind: 'text', mime: 'text/plain' };
}

// >=2 file để showRail=true (khớp điều kiện visibleFiles.length > 1 trong
// PipelineResultBody).
function twoFileState() {
  const files = [file('docs/a.md'), file('docs/b.md')];
  return {
    files,
    error: null,
    activeName: 'docs/a.md',
    setActiveName: () => {},
    activeTarget: null,
    setActiveTarget: () => {},
    availableTargets: [],
    visibleFiles: files,
    active: files[0] ?? null,
    hasFiles: true,
    outputs: ['docs/'],
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('PipelineResultBody rail collapse', () => {
  it('(a) mặc định rail mở, có cây file', () => {
    render(<PipelineResultBody projectId="P1" projectKind="other" state={twoFileState()} />);
    const aside = screen.getByLabelText('Output files');
    expect(aside.className).not.toMatch(/pl-result-rail--collapsed/);
    expect(screen.getByText('a.md')).toBeTruthy();
    expect(screen.getByText('b.md')).toBeTruthy();
  });

  it('(b) bấm nút ẩn → aside có class --collapsed, cây file biến mất, localStorage lưu 0', () => {
    render(<PipelineResultBody projectId="P1" projectKind="other" state={twoFileState()} />);
    fireEvent.click(screen.getByLabelText('Ẩn danh sách file'));
    const aside = screen.getByLabelText('Output files');
    expect(aside.className).toMatch(/pl-result-rail--collapsed/);
    expect(screen.queryByText('a.md')).toBeNull();
    expect(screen.queryByText('b.md')).toBeNull();
    expect(window.localStorage.getItem(RAIL_KEY)).toBe('0');
  });

  it('(c) render lại với localStorage=0 → khởi tạo đã gọn', () => {
    window.localStorage.setItem(RAIL_KEY, '0');
    render(<PipelineResultBody projectId="P1" projectKind="other" state={twoFileState()} />);
    const aside = screen.getByLabelText('Output files');
    expect(aside.className).toMatch(/pl-result-rail--collapsed/);
    expect(screen.queryByText('a.md')).toBeNull();
    expect(screen.getByLabelText('Hiện danh sách file')).toBeTruthy();
  });

  it('(d) bấm mở → trở lại như (a)', () => {
    window.localStorage.setItem(RAIL_KEY, '0');
    render(<PipelineResultBody projectId="P1" projectKind="other" state={twoFileState()} />);
    fireEvent.click(screen.getByLabelText('Hiện danh sách file'));
    const aside = screen.getByLabelText('Output files');
    expect(aside.className).not.toMatch(/pl-result-rail--collapsed/);
    expect(screen.getByText('a.md')).toBeTruthy();
    expect(window.localStorage.getItem(RAIL_KEY)).toBe('1');
  });

  it('(e) chỉ 1 file (showRail=false) → không có nút toggle', () => {
    const files = [file('docs/a.md')];
    const state = {
      files,
      error: null,
      activeName: 'docs/a.md',
      setActiveName: () => {},
      activeTarget: null,
      setActiveTarget: () => {},
      availableTargets: [],
      visibleFiles: files,
      active: files[0] ?? null,
      hasFiles: true,
      outputs: ['docs/'],
    };
    render(<PipelineResultBody projectId="P1" projectKind="other" state={state} />);
    expect(screen.queryByLabelText('Ẩn danh sách file')).toBeNull();
    expect(screen.queryByLabelText('Hiện danh sách file')).toBeNull();
    expect(screen.queryByLabelText('Output files')).toBeNull();
  });
});
