export const SYNC_COPY = {
  shareTitle: 'Chia sẻ kết quả',
  downloadTitle: 'Lấy dự án về máy',
  loadingProjects: 'Đang tải danh sách dự án…',
  noSharedProjects: 'Chưa có dự án nào được chia sẻ với bạn.',
  searchPlaceholder: 'Tìm theo tên hoặc mã dự án…',
  noSearchResults: (query: string) => `Không tìm thấy dự án phù hợp với “${query}”.`,
  selectAll: 'Chọn tất cả',
  selectedCount: (selected: number, total: number) => `${selected}/${total} dự án đã chọn`,
  shareSelection: (features: number, apps: number) =>
    `${features} Feature và ${apps} App sẽ được chia sẻ`,
  chooseProject: 'Chọn ít nhất một dự án.',
  chooseStep: 'Chọn ít nhất một bước cần đồng bộ.',
  reconnect: 'Kết nối lại',
  reconnectHint: 'Phiên đăng nhập đã hết hạn. Kết nối lại để chia sẻ hoặc lấy dự án về máy.',
  downloadSuccess: (projects: number, files: number) => `Đã lấy ${projects} dự án về máy · ${files} tệp`,
  shareSuccess: (projects: number, files: number) => `Đã chia sẻ ${projects} Feature cùng App cha · ${files} tệp`,
  downloadError: 'Không thể lấy dự án về máy',
  shareError: 'Không thể chia sẻ kết quả',
} as const;

export function projectTransferLabel(isLocal: boolean): string {
  return isLocal ? 'Cập nhật bản trên máy' : 'Dự án mới';
}

export function stepDifferenceLabel(differs: boolean, hasFiles: boolean): string | null {
  if (differs) return 'Có thay đổi';
  return hasFiles ? 'Đã cập nhật' : null;
}

export function accessRoleLabel(role: 'owner' | 'editor' | 'viewer' | 'admin'): string {
  return { owner: 'Chủ dự án', editor: 'Có thể chỉnh sửa', viewer: 'Chỉ xem', admin: 'Quản trị' }[role];
}

export function publishedDestinationNote(result: Record<string, unknown>): string | null {
  if (result.status === 'auth_required') return 'Chưa thể chia sẻ: cần kết nối lại tài khoản.';
  if (result.status === 'pending_approval') return 'Dự án mới đã gửi tới Pipeline Studio và đang chờ duyệt.';
  if (result.status === 'published') return 'Kết quả đã cập nhật vào dự án chính.';
  if (result.status === 'rejected') return 'Yêu cầu chia sẻ bị từ chối; xem lý do trong Pipeline Studio.';
  if (result.status === 'error') return typeof result.message === 'string' ? result.message : 'Không thể chia sẻ dự án.';
  return null;
}
