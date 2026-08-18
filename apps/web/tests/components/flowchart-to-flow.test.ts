// Chuyển sơ đồ khối dr-flow (`*.flowchart.json`, node có `screen`) sang FlowDoc
// cho tab "Flow màn hình". Bốn hình dạng: tuyến tính nhiều bước cùng màn, vòng
// lặp báo lỗi qua điểm rẽ nhánh (đúng ví dụ trong skill), file cũ không gán
// màn, và start CHÍNH là một màn.

import { describe, expect, it } from 'vitest';

import { flowchartToFlowDoc } from '../../src/components/flowchart-to-flow';
import type { FlowchartDoc } from '../../src/components/FlowchartPreview';

const A = 'urd-nhan-vien__SCR-001';
const B = 'urd-nhan-vien__SCR-002';

const kinds = (r: ReturnType<typeof flowchartToFlowDoc>) =>
  Object.fromEntries((r.flow.nodes ?? []).map((n) => [n.id, n.kind]));

describe('flowchartToFlowDoc', () => {
  it('tuyến tính: action liên tiếp cùng màn gộp thành MỘT node màn, nhãn dồn sang cạnh đi ra', () => {
    const doc: FlowchartDoc = {
      id: 'FLOW-1',
      title: 'Thêm mới',
      nodes: [
        { id: 'n1', type: 'start', label: 'Trang chủ' },
        { id: 'n2', type: 'action', label: 'Mở form', screen: A },
        { id: 'n3', type: 'action', label: 'Nhập thông tin', screen: A },
        { id: 'n4', type: 'action', label: 'Bấm Lưu', screen: A },
        { id: 'n5', type: 'action', label: 'Xem kết quả', screen: B },
        { id: 'n6', type: 'end', label: 'Xong' },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
        { from: 'n3', to: 'n4' },
        { from: 'n4', to: 'n5' },
        { from: 'n5', to: 'n6' },
      ],
    };
    const r = flowchartToFlowDoc(doc, { [A]: 'Danh sách Nhân viên' });

    expect(kinds(r)).toEqual({ n1: 'nav', [A]: 'screen', [B]: 'screen', n6: 'end' });
    expect(r.flow.edges).toEqual([
      { from: 'n1', to: A },
      { from: A, to: B, label: 'Mở form → Nhập thông tin → Bấm Lưu' },
      { from: B, to: 'n6', label: 'Xem kết quả' },
    ]);
    // entry = màn đầu tiên gặp từ start; tên từ index, không có thì fallback key.
    expect(r.flow.entry).toBe(A);
    expect(r.flow.name).toBe('Thêm mới');
    expect(r.screens).toEqual([
      { id: A, name: 'Danh sách Nhân viên' },
      { id: B, name: B },
    ]);
    expect((r.flow.nodes ?? []).find((n) => n.id === A)?.label).toBe('Danh sách Nhân viên');
  });

  it('vòng lặp báo lỗi: cạnh nội bộ cụm biến mất, mọi cạnh khác giữ nguyên nhãn gốc', () => {
    // Đúng ví dụ trong skill docs-flow-ux (bản cũ docs-flow-extract): n2 và n4 cùng màn, n4 → n2 quay lại.
    const doc: FlowchartDoc = {
      id: 'FLOW-login',
      nodes: [
        { id: 'n1', type: 'start', label: 'Trang chủ' },
        { id: 'n2', type: 'action', label: 'Nhập tên đăng nhập + mật khẩu', screen: A },
        { id: 'n3', type: 'decision', label: 'Thông tin hợp lệ?' },
        { id: 'n4', type: 'action', label: 'Hiện thông báo lỗi', screen: A },
        { id: 'n5', type: 'end', label: 'Vào màn hình chính' },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
        { from: 'n3', to: 'n5', label: 'Có' },
        { from: 'n3', to: 'n4', label: 'Không' },
        { from: 'n4', to: 'n2' },
      ],
    };
    const r = flowchartToFlowDoc(doc);

    expect(kinds(r)).toEqual({ n1: 'nav', [A]: 'screen', n3: 'decision', n5: 'end' });
    // 5 cạnh gốc − 1 cạnh nội bộ (n4 → n2) = 4; nhánh "Không" quay về màn.
    expect(r.flow.edges).toEqual([
      { from: 'n1', to: A },
      // Lần ngược dừng ở điểm vào cụm (n2 có cạnh từ n1) — không kéo "Hiện
      // thông báo lỗi" của nhánh quay lại vào nhãn cạnh đi thẳng.
      { from: A, to: 'n3', label: 'Nhập tên đăng nhập + mật khẩu' },
      { from: 'n3', to: 'n5', label: 'Có' },
      { from: 'n3', to: A, label: 'Không' },
    ]);
    expect(r.screens.map((s) => s.id)).toEqual([A]);
    expect(r.flow.entry).toBe(A);
  });

  it('file cũ không gán màn: toàn nav/decision/end, giữ đủ cạnh, không entry, screens rỗng', () => {
    const doc: FlowchartDoc = {
      id: 'FLOW-legacy',
      nodes: [
        { id: 'n1', type: 'start', label: 'Bắt đầu' },
        { id: 'n2', type: 'action', label: 'Nhập' },
        { id: 'n3', type: 'decision', label: 'Hợp lệ?' },
        { id: 'n4', type: 'action', label: 'Báo lỗi' },
        { id: 'n5', type: 'end', label: 'Xong' },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
        { from: 'n3', to: 'n5', label: 'Có' },
        { from: 'n3', to: 'n4', label: 'Không' },
        { from: 'n4', to: 'n2' },
      ],
    };
    const r = flowchartToFlowDoc(doc);

    expect(kinds(r)).toEqual({ n1: 'nav', n2: 'nav', n3: 'decision', n4: 'nav', n5: 'end' });
    expect(r.flow.edges).toEqual(doc.edges);
    expect(r.flow.entry).toBeUndefined();
    expect(r.screens).toEqual([]);
  });

  it('start CÓ screen: chính nó là màn và là entry; nhãn start không lọt vào nhãn cạnh', () => {
    const HOME = 'urd-nhan-vien__SCR-000';
    const doc: FlowchartDoc = {
      id: 'FLOW-home',
      nodes: [
        { id: 'n1', type: 'start', label: 'Trang chủ', screen: HOME },
        { id: 'n2', type: 'action', label: 'Chọn menu Nhân viên', screen: HOME },
        { id: 'n3', type: 'action', label: 'Xem danh sách', screen: A },
        { id: 'n4', type: 'end', label: 'Xong' },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
        { from: 'n3', to: 'n4' },
      ],
    };
    const r = flowchartToFlowDoc(doc);

    expect(kinds(r)).toEqual({ [HOME]: 'screen', [A]: 'screen', n4: 'end' });
    expect(r.flow.entry).toBe(HOME);
    expect(r.flow.edges).toEqual([
      { from: HOME, to: A, label: 'Chọn menu Nhân viên' },
      { from: A, to: 'n4', label: 'Xem danh sách' },
    ]);
    expect(r.screens.map((s) => s.id)).toEqual([HOME, A]);
  });

  it('cạnh đi ra đã có nhãn gốc thì giữ nhãn gốc, không ghi đè bằng nhãn action', () => {
    const doc: FlowchartDoc = {
      id: 'FLOW-x',
      nodes: [
        { id: 'n1', type: 'start', label: 'Bắt đầu' },
        { id: 'n2', type: 'action', label: 'Nhập', screen: A },
        { id: 'n3', type: 'end', label: 'Xong' },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3', label: 'Lưu thành công' },
      ],
    };
    expect(flowchartToFlowDoc(doc).flow.edges).toEqual([
      { from: 'n1', to: A },
      { from: A, to: 'n3', label: 'Lưu thành công' },
    ]);
  });
});
