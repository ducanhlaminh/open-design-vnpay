// Phần dùng chung của hai form khai sinh (NewAppModal / NewFeatureModal).
//
// Người dùng KHÔNG gõ mã (id) cho cả App lẫn Feature. Mã là tên thư mục làm
// việc / khoá project_id chia sẻ — kỹ thuật thuần tuý, người không rành convention
// dễ gõ sai (khoảng trắng, hoa/thường, dấu tiếng Việt). Mã sinh từ tên hiển thị
// qua `toSlugId` bên dưới.

import { useEffect, useState } from 'react';

export const ID_MAX = 64;

export interface AppOption {
  id: string;
  name?: string;
  origin: 'local' | 'remote';
}

// Cùng luật với Pipeline Studio (xem apps/daemon/src/pipeline-routes.ts): id
// phải bắt đầu bằng chữ/số, chỉ gồm A-Z a-z 0-9 . _ -, dài 2–64 ký tự.
export function toSlugId(value: string): string {
  const lower = value.trim().toLowerCase().replace(/đ/g, 'd');
  const stripped = lower.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const dashed = stripped.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = (dashed || 'item').slice(0, ID_MAX);
  // Tên 1 ký tự (vd "A") tạo id 1 ký tự, không qua nổi regex tối thiểu 2 ký tự.
  return base.length >= 2 ? base : `${base}${base}1`.slice(0, ID_MAX);
}

/** Danh sách App đã có: NewAppModal dùng để phát hiện trùng tên, còn
 *  NewFeatureModal dùng làm gợi ý cho combo và để tra TÊN của App cha. */
export function useAppOptions(): AppOption[] {
  const [apps, setApps] = useState<AppOption[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/pipelines/apps');
        const j = await res.json().catch(() => ({}));
        if (alive && Array.isArray(j?.apps)) setApps(j.apps as AppOption[]);
      } catch {
        /* danh sách chỉ là gợi ý — nhập tay vẫn tạo được */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return apps;
}

/** Tên hiển thị của một App (feature chỉ mang bản sao có thể cũ của tên). */
export function appLabelOf(app: Pick<AppOption, 'id' | 'name'>): string {
  return app.name || app.id;
}
