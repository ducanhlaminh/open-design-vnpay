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

// ── dr-flow: rail phẳng, ghi rõ nghĩa (feedback 2026-08-28) ─────────────────
import { drFlowRailItems } from '../../../src/components/pipelines/PipelineModals';

function drFlowState(names: string[]) {
  const files = names.map(file);
  return { ...twoFileState(), files, visibleFiles: files, active: files[0] ?? null, activeName: files[0]?.name ?? null, outputs: ['flows/', 'screens-discovered.json'], pipelineId: 'dr-flow' };
}

describe('Quick result dr-flow — rail phẳng', () => {
  it('drFlowRailItems: App → Web → Danh sách màn, nhãn rõ nghĩa', () => {
    const items = drFlowRailItems([
      file('docs-review/screens-discovered.json'),
      file('docs-review/flows/SCREEN-FLOW--web/as-is.drawio'),
      file('docs-review/flows/SCREEN-FLOW--app/as-is.drawio'),
    ]);
    expect(items.map((i) => i.label)).toEqual(['Luồng màn hình — App', 'Luồng màn hình — Web', 'Danh sách màn']);
    expect(items.map((i) => i.badge)).toEqual(['App', 'Web', undefined]);
  });

  it('một nền tảng → "Luồng màn hình" + "Danh sách màn"', () => {
    const items = drFlowRailItems([file('docs-review/flows/SCREEN-FLOW/as-is.drawio'), file('docs-review/screens-discovered.json')]);
    expect(items.map((i) => i.label)).toEqual(['Luồng màn hình', 'Danh sách màn']);
  });

  it('render: không có tên thư mục/file, chỉ 3 dòng; bấm dòng đổi file', () => {
    const setActiveName = vi.fn();
    const state = { ...drFlowState(['docs-review/flows/SCREEN-FLOW--app/as-is.drawio', 'docs-review/flows/SCREEN-FLOW--web/as-is.drawio', 'docs-review/screens-discovered.json']), setActiveName };
    render(<PipelineResultBody projectId="P1" projectKind="other" state={state} />);
    expect(screen.queryByText('flows')).toBeNull();
    expect(screen.queryByText('SCREEN-FLOW--app')).toBeNull();
    expect(screen.queryByText('as-is.drawio')).toBeNull();
    expect(screen.getByText('Luồng màn hình — App')).toBeTruthy();
    expect(screen.getByText('Luồng màn hình — Web')).toBeTruthy();
    fireEvent.click(screen.getByText('Danh sách màn'));
    expect(setActiveName).toHaveBeenCalledWith('docs-review/screens-discovered.json');
  });

  it('bước khác vẫn dùng cây thư mục', () => {
    render(<PipelineResultBody projectId="P1" projectKind="other" state={{ ...twoFileState(), pipelineId: 'dr-docs' }} />);
    expect(screen.getByText('a.md')).toBeTruthy();
  });
});
