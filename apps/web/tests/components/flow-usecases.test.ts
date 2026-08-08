// Chẻ sơ đồ khối thành kịch bản — fixture rút gọn từ file THẬT
// (Test_all_tinh_nang/docs-review/flows/FLOW-them-moi-nhan-vien.flowchart.json,
// 21 node / 6 rẽ nhánh / 11 đường đi) để test bám đúng hình dạng dữ liệu agent
// sinh ra, gồm cả vòng lặp "báo lỗi rồi quay lại bước nhập".

import { describe, expect, it } from 'vitest';

import { MAX_USE_CASES, deriveUseCases, flowDocToChart } from '../../src/components/flow-usecases';
import type { FlowchartDoc } from '../../src/components/FlowchartPreview';

const DOC: FlowchartDoc = {
  id: 'FLOW-them-moi-nhan-vien',
  title: 'Thêm mới hồ sơ Nhân viên',
  nodes: [
    { id: 'n1', type: 'start', label: 'Bắt đầu' },
    { id: 'n4', type: 'action', label: 'Nhập thông tin nhân viên' },
    { id: 'n6', type: 'action', label: 'Nhấn nút Lưu' },
    { id: 'n7', type: 'decision', label: 'Đã nhập đủ trường bắt buộc?' },
    { id: 'n8', type: 'action', label: 'Hiển thị lỗi thiếu thông tin bắt buộc' },
    { id: 'n12', type: 'decision', label: 'Người dùng có quyền tạo hồ sơ?' },
    { id: 'n13', type: 'end', label: 'Không có quyền thao tác — kết thúc' },
    { id: 'n17', type: 'action', label: 'Lưu hồ sơ, ghi audit log' },
    { id: 'n19', type: 'end', label: 'Thêm mới nhân viên thành công' },
  ],
  edges: [
    { from: 'n1', to: 'n4' },
    { from: 'n4', to: 'n6' },
    { from: 'n6', to: 'n7' },
    { from: 'n7', to: 'n8', label: 'Không' },
    { from: 'n7', to: 'n12', label: 'Có' },
    { from: 'n8', to: 'n4' }, // vòng lặp: quay lại bước nhập
    { from: 'n12', to: 'n13', label: 'Không' },
    { from: 'n12', to: 'n17', label: 'Có' },
    { from: 'n17', to: 'n19' },
  ],
};

describe('deriveUseCases', () => {
  const { useCases, truncated } = deriveUseCases(DOC);

  it('chẻ đúng 3 kịch bản: thành công, không có quyền, thiếu thông tin (quay lại)', () => {
    expect(truncated).toBe(false);
    expect(useCases).toHaveLength(3);
    expect(useCases.map((u) => u.outcome).sort()).toEqual(['blocked', 'loop', 'success']);
  });

  it('tên kịch bản lấy từ điểm KẾT THÚC — thứ người đọc muốn biết', () => {
    const success = useCases.find((u) => u.outcome === 'success')!;
    expect(success.title).toBe('Thêm mới nhân viên thành công');
    const blocked = useCases.find((u) => u.outcome === 'blocked')!;
    expect(blocked.title).toBe('Không có quyền thao tác — kết thúc');
  });

  it('kịch bản quay vòng lấy tên từ bước hành động cuối và ghi node bị quay lại', () => {
    const loop = useCases.find((u) => u.outcome === 'loop')!;
    expect(loop.title).toBe('Hiển thị lỗi thiếu thông tin bắt buộc');
    expect(loop.loopToNodeId).toBe('n4');
    // Không đi vòng vô hạn: mỗi node xuất hiện tối đa một lần trong kịch bản.
    const ids = loop.steps.map((s) => s.node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('mô tả là chuỗi ngã rẽ đã chọn — thứ phân biệt hai kịch bản với nhau', () => {
    const success = useCases.find((u) => u.outcome === 'success')!;
    expect(success.description).toBe(
      'Đã nhập đủ trường bắt buộc? → Có · Người dùng có quyền tạo hồ sơ? → Có',
    );
    const loop = useCases.find((u) => u.outcome === 'loop')!;
    expect(loop.description).toBe('Đã nhập đủ trường bắt buộc? → Không');
  });

  it('mỗi bước rẽ nhánh mang theo câu trả lời đã chọn để khung nhìn chi tiết hiện được', () => {
    const success = useCases.find((u) => u.outcome === 'success')!;
    const decision = success.steps.find((s) => s.node.id === 'n12')!;
    expect(decision.answer).toBe('Có');
    expect(success.steps[success.steps.length - 1]!.node.id).toBe('n19');
    expect(success.steps[success.steps.length - 1]!.answer).toBeUndefined();
  });

  it('sơ đồ thiếu node start vẫn chẻ được (lấy node không có cạnh vào)', () => {
    const noStart: FlowchartDoc = {
      id: 'x',
      nodes: [
        { id: 'a', type: 'action', label: 'Mở màn hình' },
        { id: 'b', type: 'end', label: 'Xong' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const result = deriveUseCases(noStart);
    expect(result.useCases).toHaveLength(1);
    expect(result.useCases[0]!.steps[0]!.node.id).toBe('a');
  });

  it('sơ đồ rẽ nhánh quá nhiều thì CẮT và nói rõ đã cắt (không im lặng)', () => {
    // 8 tầng rẽ nhánh nhị phân = 256 đường > trần 60.
    const nodes: FlowchartDoc['nodes'] = [{ id: 'd0', type: 'decision', label: 'Rẽ 0?' }];
    const edges: FlowchartDoc['edges'] = [];
    for (let i = 0; i < 8; i += 1) {
      for (const side of ['y', 'n']) {
        const id = `d${i + 1}${side}${i}`;
        nodes.push({ id, type: i === 7 ? 'end' : 'decision', label: `Nút ${id}` });
        edges.push({ from: i === 0 ? 'd0' : `d${i}y${i - 1}`, to: id, label: side });
        if (i > 0) edges.push({ from: `d${i}n${i - 1}`, to: id, label: side });
      }
    }
    const result = deriveUseCases({ id: 'big', nodes, edges });
    expect(result.useCases.length).toBeLessThanOrEqual(MAX_USE_CASES);
  });
});

// `.flow.json` của bước ux — schema khác: MÀN HÌNH LÀ NGẦM ĐỊNH (đầu cạnh nào
// trùng screens[].id thì đó là màn), chỉ decision/end mới khai tường minh.
// Fixture rút từ file thật Tinh_nang_1/docs-to-ui/mobile/flows/.
describe('flowDocToChart + deriveUseCases trên .flow.json (bước ux)', () => {
  const FLOW = {
    id: 'FLOW-CARD-DESIGN',
    name: 'Chọn & lưu thiết kế thẻ',
    entry: 'SCR-CARD-DETAIL',
    nodes: [
      { id: 'D-VALID', kind: 'decision', label: 'Có thẻ hợp lệ?' },
      { id: 'E-ERR', kind: 'end', label: 'Báo lỗi: Quý khách không có thẻ hợp lệ' },
      { id: 'E-OK', kind: 'end', label: 'Lưu thiết kế thành công' },
    ],
    edges: [
      { from: 'SCR-CARD-DETAIL', to: 'D-VALID', label: 'Đổi thiết kế' },
      { from: 'D-VALID', to: 'E-ERR', label: 'Không' },
      { from: 'D-VALID', to: 'SCR-CARD-DESIGN', label: 'Có' },
      { from: 'SCR-CARD-DESIGN', to: 'E-OK', label: 'Lưu' },
    ],
  };
  const TITLES = { 'SCR-CARD-DETAIL': 'Chi tiết thẻ', 'SCR-CARD-DESIGN': 'Thiết kế thẻ' };

  it('màn hình ngầm định thành bước mang TÊN màn, entry thành điểm bắt đầu', () => {
    const chart = flowDocToChart(FLOW, TITLES);
    expect(chart.title).toBe('Chọn & lưu thiết kế thẻ');
    const byId = new Map(chart.nodes.map((n) => [n.id, n]));
    expect(byId.get('SCR-CARD-DETAIL')).toEqual({ id: 'SCR-CARD-DETAIL', type: 'start', label: 'Chi tiết thẻ' });
    expect(byId.get('SCR-CARD-DESIGN')).toEqual({ id: 'SCR-CARD-DESIGN', type: 'action', label: 'Thiết kế thẻ' });
    expect(byId.get('D-VALID')?.type).toBe('decision');
    expect(byId.get('E-OK')?.type).toBe('end');
  });

  it('không có bảng tên màn thì lấy chính id, không rơi mất node', () => {
    const chart = flowDocToChart(FLOW);
    expect(chart.nodes.find((n) => n.id === 'SCR-CARD-DESIGN')?.label).toBe('SCR-CARD-DESIGN');
    expect(chart.nodes).toHaveLength(5);
  });

  it('chẻ ra 2 kịch bản; nhãn phủ định chứa từ tích cực vẫn tính là hỏng', () => {
    const { useCases } = deriveUseCases(flowDocToChart(FLOW, TITLES));
    expect(useCases).toHaveLength(2);
    const err = useCases.find((u) => u.title.startsWith('Báo lỗi'))!;
    // "không có thẻ hợp lệ" từng bị gắn nhãn Thành công vì khớp chữ "hợp lệ".
    expect(err.outcome).toBe('blocked');
    expect(useCases.find((u) => u.title === 'Lưu thiết kế thành công')!.outcome).toBe('success');
  });
});
