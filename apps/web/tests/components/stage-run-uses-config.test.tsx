// @vitest-environment jsdom
//
// Nút "Chạy" của MỘT bước phải dùng cấu hình đang hiển thị ở panel phải, không
// mở modal hỏi lại.
//
// Vì sao đáng test: trước đây `proceedRun` mở modal cho mọi bước có
// `inputPlaceholder` / `acceptsDesignSystem` / `acceptsPlatform`, trong khi
// panel phải ĐÃ khai đúng những giá trị đó. Hỏi hai lần đã phiền, nhưng hại hơn
// là câu trả lời trong modal có thể khác thứ panel đang hiển thị — màn hình nói
// một đằng, lượt chạy làm một nẻo.
//
// Test đánh vào HÀM THUẦN `resolveStageRunConfig` chứ không mount cả
// `PipelinesView`: nhánh quyết định là thứ cần khoá, còn mount cả màn hình sẽ
// kéo theo fetch dự án/pipeline/design-system và đo nhầm sang mọi thứ khác.
import { describe, expect, it } from 'vitest';
import type { RunAllConfig } from '@open-design/contracts';

const { resolveStageRunConfig } = await import('../../src/components/PipelinesView');

/** Bước cần NGUỒN TÀI LIỆU (dr-docs / docs). */
const docsStage = { inputPlaceholder: 'Confluence URL', acceptsDesignSystem: false, acceptsPlatform: false };
/** Bước sinh UI, cần DESIGN SYSTEM (ui-html / ui-react). */
const uiStage = { inputPlaceholder: undefined, acceptsDesignSystem: true, acceptsPlatform: false };
/** Bước UX Spec, cần PLATFORM / target. */
const uxStage = { inputPlaceholder: undefined, acceptsDesignSystem: false, acceptsPlatform: true };
/** Bước không đòi cấu hình gì (customer journey…). */
const plainStage = { inputPlaceholder: undefined, acceptsDesignSystem: false, acceptsPlatform: false };

describe('resolveStageRunConfig — chạy một bước bằng cấu hình panel phải', () => {
  it('có nguồn Confluence → chạy thẳng, payload mang đúng trang đã cấu hình', () => {
    const cfg: RunAllConfig = { confluencePages: [{ id: '123', url: 'https://cf/x' } as never] };
    const d = resolveStageRunConfig(docsStage, cfg);
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error('unreachable');
    // Danh sách trang đi qua `input` (mỗi dòng một URL) — đó là trường DUY NHẤT
    // `startRun` đọc cho bước docs.
    expect(d.payload?.input).toBe('https://cf/x');
  });

  it('pool App bẩn → chặn chạy và nêu số trang chưa chưng cất', () => {
    const cfg: RunAllConfig = { appPool: { appId: 'app-1', paths: ['a.md'] } };
    const d = resolveStageRunConfig(docsStage, cfg, { clean: false, pending: 3 });
    expect(d).toEqual({
      ok: false,
      missing: 'Tài liệu App chưa chưng cất (còn 3 trang) — bấm "Chưng cất tài liệu" ở màn App/modal Nguồn tài liệu',
    });
  });

  it('pool App sạch → giữ payload app-pool', () => {
    const cfg: RunAllConfig = { appPool: { appId: 'app-1', paths: ['a.md'] } };
    const d = resolveStageRunConfig(docsStage, cfg, { clean: true, pending: 0 });
    expect(d).toEqual({
      ok: true,
      payload: { source: { kind: 'app-pool', appId: 'app-1', paths: ['a.md'] } },
    });
  });

  it('tài liệu tải tay (docsFromUpload) cũng đủ điều kiện chạy, không cần trang Confluence', () => {
    const d = resolveStageRunConfig(docsStage, { docsFromUpload: true });
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error('unreachable');
    // Không có trang nào → không gửi `input` rỗng lên daemon.
    expect(d.payload?.input).toBeUndefined();
  });

  it('CHƯA có nguồn → báo thiếu "Nguồn tài liệu", KHÔNG chạy', () => {
    const d = resolveStageRunConfig(docsStage, {});
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.missing).toBe('Nguồn tài liệu');
  });

  it('design system = null ("Không dùng") LÀ một lựa chọn hợp lệ, không phải chưa cấu hình', () => {
    // Đây là ca dễ sai nhất: `null` và `undefined` trông giống nhau ở chỗ gọi,
    // nhưng `null` nghĩa là người dùng đã chủ động chọn "Không dùng".
    const d = resolveStageRunConfig(uiStage, { designSystemId: null });
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error('unreachable');
    expect(d.designSystemId).toBeNull();
  });

  it('chưa chọn design system bao giờ → báo thiếu "Design system"', () => {
    const d = resolveStageRunConfig(uiStage, {});
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.missing).toBe('Design system');
  });

  it('có target → lấy platform của target đầu tiên', () => {
    const d = resolveStageRunConfig(uxStage, { targets: ['mobile'] as never });
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error('unreachable');
    expect(d.platform).toBe('mobile');
  });

  it('chưa có target lẫn platform → báo thiếu "Sản phẩm cần build"', () => {
    const d = resolveStageRunConfig(uxStage, {});
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.missing).toBe('Sản phẩm cần build');
  });

  it('bước không đòi cấu hình gì → chạy thẳng dù cấu hình rỗng', () => {
    const d = resolveStageRunConfig(plainStage, undefined);
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error('unreachable');
    expect(d.payload).toBeUndefined();
    expect(d.designSystemId).toBeUndefined();
    expect(d.platform).toBeUndefined();
  });
});
