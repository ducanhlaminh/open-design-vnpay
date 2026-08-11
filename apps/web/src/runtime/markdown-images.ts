// Giải đường dẫn ảnh tương đối trong markdown thành URL raw của project.
//
// Vì sao là module riêng chứ không nằm trong FileViewer: cả FileViewer lẫn
// DocRedlinePreview đều cần hàm này, mà FileViewer đã import DocRedlinePreview
// để route file redline. Để DocRedlinePreview import ngược lại FileViewer là
// tạo IMPORT VÒNG giữa một module 8000 dòng và một component — kiểu phụ thuộc
// mà bundler chỉ giải đúng khi may mắn về thứ tự khởi tạo, và hay vỡ dưới
// HMR/React Refresh (một binding thành undefined giữa chừng). Tách ra đây thì
// cả hai bên cùng phụ thuộc vào một lá, không còn vòng.

import { projectRawUrl } from '../providers/registry';

function baseDirFor(fileName: string): string {
  const idx = fileName.lastIndexOf('/');
  return idx >= 0 ? fileName.slice(0, idx + 1) : '';
}

function resolveRelativePath(baseDir: string, rel: string): string {
  const out: string[] = [];
  for (const seg of (baseDir + rel).split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

/** Đổi mọi ref ảnh markdown có đường dẫn TƯƠNG ĐỐI thành URL raw của project
 *  (giải theo thư mục của chính file `.md`). Ref ngoài (`http:`, `data:`) và
 *  ref đã tuyệt đối (`/api/...`) giữ nguyên.
 *
 *  Phần khớp `([^)]+)` cố ý ăn tới dấu `)` đóng chứ không dừng ở khoảng trắng:
 *  tên file đính kèm từ Confluence có thể chứa dấu cách. */
export function inlineMarkdownImages(text: string, projectId: string, fileName: string): string {
  const baseDir = baseDirFor(fileName);
  return text.replace(/(!\[[^\]]*\]\()([^)]+)(\))/g, (full, open: string, src: string, close: string) => {
    const url = src.trim();
    if (/^(https?:|data:|\/)/i.test(url)) return full;
    const abs = resolveRelativePath(baseDir, url.replace(/^\.\//, ''));
    return `${open}${projectRawUrl(projectId, abs)}${close}`;
  });
}
