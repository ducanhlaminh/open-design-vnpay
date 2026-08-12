// Chẻ sơ đồ khối thành kịch bản — fixture rút gọn từ file THẬT
// (Test_all_tinh_nang/docs-review/flows/FLOW-them-moi-nhan-vien.flowchart.json,
// 21 node / 6 rẽ nhánh / 11 đường đi) để test bám đúng hình dạng dữ liệu agent
// sinh ra, gồm cả vòng lặp "báo lỗi rồi quay lại bước nhập".

import { describe, expect, it } from 'vitest';

import { MAX_USE_CASES, deriveUseCases, deriveUseCasesWithEntry, flowDocToChart } from '../../src/components/flow-usecases';
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

  it('tạo id khác nhau khi hai nhánh dùng cùng chuỗi node nhưng khác câu trả lời', () => {
    const converged: FlowchartDoc = {
      id: 'same-nodes',
      nodes: [
        { id: 'start', type: 'start', label: 'Bắt đầu' },
        { id: 'decision', type: 'decision', label: 'Chọn cách xử lý' },
        { id: 'done', type: 'end', label: 'Hoàn tất' },
      ],
      edges: [
        { from: 'start', to: 'decision' },
        { from: 'decision', to: 'done', label: 'Tự xử lý' },
        { from: 'decision', to: 'done', label: 'Gửi duyệt' },
      ],
    };
    const result = deriveUseCases(converged);
    expect(result.useCases).toHaveLength(2);
    expect(new Set(result.useCases.map((useCase) => useCase.id)).size).toBe(2);
  });

  it('loại edge trùng hoàn toàn để không render hai card cùng một kịch bản', () => {
    const duplicated: FlowchartDoc = {
      id: 'duplicate-edge',
      nodes: [
        { id: 'start', type: 'start', label: 'Bắt đầu' },
        { id: 'done', type: 'end', label: 'Hoàn tất' },
      ],
      edges: [
        { from: 'start', to: 'done', label: 'Tiếp tục' },
        { from: 'start', to: 'done', label: 'Tiếp tục' },
      ],
    };
    expect(deriveUseCases(duplicated).useCases).toHaveLength(1);
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

describe('deriveUseCasesWithEntry', () => {
  const commonDoc: FlowchartDoc = {
    id: 'entry',
    nodes: [
      { id: 'start', type: 'start', label: 'Trang chủ' },
      { id: 'menu', type: 'action', label: 'Mở menu Danh mục' },
      { id: 'staff', type: 'action', label: 'Nhân viên' },
      { id: 'save', type: 'action', label: 'Lưu hồ sơ' },
      { id: 'ok', type: 'end', label: 'Thành công' },
      { id: 'no', type: 'action', label: 'Báo lỗi' },
      { id: 'stop', type: 'end', label: 'Dừng' },
    ],
    edges: [
      { from: 'start', to: 'menu' },
      { from: 'menu', to: 'staff' },
      { from: 'staff', to: 'save', label: 'Có' },
      { from: 'save', to: 'ok' },
      { from: 'staff', to: 'no', label: 'Không' },
      { from: 'no', to: 'stop' },
    ],
  };

  it('gộp các bước chung ở đầu, DỪNG trước ngã rẽ (ngã rẽ thuộc về từng kịch bản)', () => {
    const result = deriveUseCasesWithEntry(commonDoc);
    expect(result.entryPath.map((step) => step.node.id)).toEqual(['start', 'menu']);
    // `staff` là điểm rẽ nhánh: node chung nhưng đáp án khác nhau nên nó phải
    // ở lại đầu MỖI kịch bản, không được nằm trong đường vào chung.
    expect(result.useCases.every((useCase) => useCase.steps[0]?.node.id === 'staff')).toBe(true);
    // Không mất bước nào: entryPath + phần riêng = độ dài gốc của từng kịch bản.
    const original = deriveUseCases(commonDoc).useCases;
    result.useCases.forEach((useCase, i) => {
      expect(result.entryPath.length + useCase.steps.length).toBe(original[i]!.steps.length);
    });
  });

  it('does not extract an entry path for one scenario', () => {
    const doc = { ...commonDoc, edges: commonDoc.edges.filter((edge) => edge.from !== 'staff' || edge.label !== 'Không') };
    expect(deriveUseCasesWithEntry(doc).entryPath).toEqual([]);
  });

  it('does not extract a prefix that consumes more than sixty percent', () => {
    const doc: FlowchartDoc = {
      id: 'short',
      nodes: [
        { id: 's', type: 'start', label: 'Trang chủ' },
        { id: 'a', type: 'action', label: 'Mở menu' },
        { id: 'b', type: 'action', label: 'Chọn mục' },
        { id: 'd', type: 'action', label: 'Mở màn tính năng' },
        { id: 'c', type: 'decision', label: 'Tiếp tục?' },
        { id: 'x', type: 'end', label: 'Xong' },
        { id: 'y', type: 'end', label: 'Dừng' },
      ],
      // 4 bước chung / kịch bản dài 6 bước = 67% > trần 60% → không gộp, vì
      // gộp gần hết nội dung thì thẻ kịch bản chẳng còn gì để đọc.
      edges: [
        { from: 's', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'd' }, { from: 'd', to: 'c' },
        { from: 'c', to: 'x', label: 'Có' }, { from: 'c', to: 'y', label: 'Không' },
      ],
    };
    expect(deriveUseCasesWithEntry(doc).entryPath).toEqual([]);
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

describe('deriveUseCasesWithEntry — điểm rẽ nhánh KHÔNG được nằm trong đường vào chung', () => {
  it('dừng tiền tố ngay trước ngã rẽ: node chung nhưng câu trả lời khác nhau', () => {
    // Dạng thật hay gặp: Bắt đầu → thao tác trên màn danh sách → hỏi quyền,
    // rồi mỗi kịch bản trả lời một kiểu. "Hỏi quyền" là node CHUNG nhưng đáp
    // án khác nhau → gộp vào đường vào là nói dối.
    const doc: FlowchartDoc = {
      id: 'FLOW-them',
      nodes: [
        { id: 's', type: 'start', label: 'Bắt đầu' },
        { id: 'a', type: 'action', label: 'Trên SCR-001, nhấn Thêm mới' },
        { id: 'q', type: 'decision', label: 'Có quyền Thêm KH?' },
        { id: 'ok', type: 'end', label: 'Thêm mới thành công' },
        { id: 'no', type: 'end', label: 'Không có quyền' },
      ],
      edges: [
        { from: 's', to: 'a' },
        { from: 'a', to: 'q' },
        { from: 'q', to: 'ok', label: 'Có' },
        { from: 'q', to: 'no', label: 'Không' },
      ],
    };
    const { entryPath, useCases } = deriveUseCasesWithEntry(doc);
    expect(entryPath.map((s) => s.node.id)).toEqual(['s', 'a']);
    // Ngã rẽ ở lại trong TỪNG kịch bản, kèm đúng đáp án của kịch bản đó.
    for (const useCase of useCases) {
      expect(useCase.steps[0]!.node.id).toBe('q');
      expect(useCase.steps[0]!.answer).toBe(useCase.outcome === 'success' ? 'Có' : 'Không');
    }
  });
});
