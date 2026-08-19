// ScreenListManager — panel quản lý danh sách "Màn hình" cho bước dr-comp
// (lớp 3 của kiến trúc 3 lớp đã duyệt, WP13b — xem .tmp/pipeline/wp13b.yaml).
// Lớp 1 (daemon) sinh `comp/index.json`/manifest từ luồng + tài liệu + agent
// ở MỖI lần chạy; lớp 2 (`screens-overrides.json`) là file NGƯỜI DÙNG sở hữu,
// sống sót qua re-run; panel này là lớp 3 — nơi người dùng đọc/soạn overrides
// đó. Server luôn coi overrides là MỘT khối (không có API PATCH từng dòng) vì
// nhiều thao tác liên tiếp (đổi tên rồi bỏ, hoặc hai request chạy chồng nhau)
// dễ làm rơi entry nếu ghi từng phần; nên mọi thao tác ở đây tự giữ đủ mảng
// overrides trong state rồi PUT ĐÈ toàn bộ. Thao tác chỉ có hiệu lực ở LẦN
// CHẠY SAU của bước "Màn hình → Component" — daemon đọc overrides khi build
// lại manifest, không sửa gì ở kết quả đã có.
//
// API CONTRACT CỐ ĐỊNH (đóng — không tự đổi, xem wp13b.yaml):
//   GET /api/projects/:projectId/docs-review/screens
//     → 200 { manifest: ScreensManifest | null, overrides: ScreensOverrides | null }
//   PUT /api/projects/:projectId/docs-review/screens-overrides
//     body = ScreensOverrides → 200 { ok: true } | 400 { error: string }
// WP14 đã dựng 2 endpoint này ở daemon (server.ts) đúng contract trên và
// hợp nhất DTO: file này TỪNG khai type LOCAL (WP13b chạy song song, package
// contracts đang được WP13a sửa lúc đó) — nay import thẳng từ
// @open-design/contracts (web đã import package này rộng rãi ở nơi khác,
// xem apps/web/AGENTS.md/providers/*), giữ NGUYÊN tên `ScreenManifestEntry`
// qua alias để không phá test WP13b đã viết theo tên đó.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ScreenOrigin,
  ScreensManifest,
  ScreensManifestEntry as ScreenManifestEntry,
  ScreensOverrideEntry,
  ScreensOverrides,
} from '@open-design/contracts';

export type { ScreenOrigin, ScreensManifest, ScreenManifestEntry, ScreensOverrideEntry, ScreensOverrides };

interface ScreensGetResponse {
  manifest: ScreensManifest | null;
  overrides: ScreensOverrides | null;
}

const ORIGIN_LABEL: Record<ScreenOrigin, string> = { flow: 'Luồng', doc: 'Tài liệu', agent: 'Agent', user: 'Bạn thêm' };
const ORIGIN_COLOR: Record<ScreenOrigin, { fg: string; bg: string; border: string }> = {
  flow: { fg: 'var(--blue, #2348b8)', bg: 'var(--blue-bg, #e8efff)', border: 'var(--blue-border, #c8d6ff)' },
  doc: { fg: 'var(--green, #1f7a3a)', bg: 'var(--green-bg, #e8f7ee)', border: 'var(--green-border, #c6ead2)' },
  agent: { fg: 'var(--amber, #b26200)', bg: 'var(--amber-bg, #fff3e0)', border: 'var(--amber-border, #f4d9a6)' },
  user: { fg: 'var(--purple, #6c3aa6)', bg: 'var(--purple-bg, #f3ecf9)', border: 'var(--purple-border, #e4d4f1)' },
};

// Token màu sẵn có của app (styles/tokens.css) — sáng/tối tự đúng theo theme.
const M = {
  ink: 'var(--text, #1a1916)',
  soft: 'var(--text-muted, #57544e)',
  border: 'var(--border, #e1e5eb)',
  paper: 'var(--bg, #fff)',
  accent: 'var(--accent, #0066b3)',
  green: 'var(--green, #1f7a3a)',
  greenBg: 'var(--green-bg, #e8f7ee)',
  greenBorder: 'var(--green-border, #c6ead2)',
  red: 'var(--red, #9c2a25)',
  redBg: 'var(--red-bg, #fdecea)',
  redBorder: 'var(--red-border, #f5c6c2)',
} as const;

function OriginBadge({ origin }: { origin: ScreenOrigin }) {
  const c = ORIGIN_COLOR[origin];
  return (
    <span
      data-testid="origin-badge"
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        color: c.fg,
        background: c.bg,
        border: `1px solid ${c.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {ORIGIN_LABEL[origin]}
    </span>
  );
}

/** Override rename/remove còn hiệu lực cho một key — entry SAU CÙNG trong
 *  mảng thắng (client luôn append entry mới thay vì sửa tại chỗ). */
function pendingActionFor(
  overrides: ScreensOverrideEntry[],
  key: string,
): Extract<ScreensOverrideEntry, { action: 'rename' | 'remove' }> | null {
  for (let i = overrides.length - 1; i >= 0; i -= 1) {
    const o = overrides[i]!;
    if ((o.action === 'rename' || o.action === 'remove') && o.key === key) return o;
  }
  return null;
}

export function ScreenListManager({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [manifest, setManifest] = useState<ScreensManifest | null>(null);
  const [overrides, setOverrides] = useState<ScreensOverrideEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [addSource, setAddSource] = useState('');
  const [addSourceCustom, setAddSourceCustom] = useState('');
  const [addCode, setAddCode] = useState('');
  const [addName, setAddName] = useState('');
  const [addAnchor, setAddAnchor] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/docs-review/screens`);
        const data = (await res.json()) as ScreensGetResponse;
        if (cancelled) return;
        setManifest(data.manifest ?? null);
        setOverrides(data.overrides?.overrides ?? []);
      } catch {
        if (!cancelled) setLoadError('Không tải được danh sách màn hình — thử lại.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const uniqueSources = useMemo(() => {
    const set = new Set<string>();
    for (const s of manifest?.screens ?? []) if (s.source) set.add(s.source);
    return [...set];
  }, [manifest]);

  // Ghi ĐÈ toàn bộ overrides (không PATCH) — xem giải thích ở đầu file.
  async function putOverrides(next: ScreensOverrideEntry[]) {
    setOverrides(next);
    setBanner(null);
    setSaveError(null);
    try {
      const body: ScreensOverrides = { schema_version: 1, overrides: next };
      const res = await fetch(`/api/projects/${projectId}/docs-review/screens-overrides`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setBanner('Đã lưu — chạy lại bước Màn hình → Component để áp dụng.');
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setSaveError(data?.error || `Lưu thất bại (mã lỗi ${res.status}).`);
    } catch {
      // Lỗi mạng: hiện cho người dùng thấy, không nuốt im lặng.
      setSaveError('Không kết nối được máy chủ — thử lại.');
    }
  }

  function startRename(key: string, current: string) {
    setRenamingKey(key);
    setRenameValue(current);
  }
  function cancelRename() {
    setRenamingKey(null);
    setRenameValue('');
  }
  function commitRename(key: string) {
    const name = renameValue.trim();
    if (!name) return;
    const next = overrides.filter((o) => !((o.action === 'rename' || o.action === 'remove') && o.key === key));
    next.push({ action: 'rename', key, name });
    setRenamingKey(null);
    void putOverrides(next);
  }
  function removeScreen(key: string) {
    const next = overrides.filter((o) => !((o.action === 'rename' || o.action === 'remove') && o.key === key));
    next.push({ action: 'remove', key });
    void putOverrides(next);
  }
  function undoRemove(key: string) {
    const next = overrides.filter((o) => !(o.action === 'remove' && o.key === key));
    void putOverrides(next);
  }

  const effectiveAddSource = addSourceCustom.trim() || addSource;
  const canSaveAdd = addCode.trim().length > 0 && addName.trim().length > 0;
  function submitAdd() {
    if (!canSaveAdd) return;
    const entry: ScreensOverrideEntry = {
      action: 'add',
      source: effectiveAddSource,
      code: addCode.trim(),
      name: addName.trim(),
      ...(addAnchor.trim() ? { anchorText: addAnchor.trim() } : {}),
    };
    const next = [...overrides, entry];
    setAddCode('');
    setAddName('');
    setAddAnchor('');
    void putOverrides(next);
  }

  const pendingAdds = overrides.filter(
    (o): o is Extract<ScreensOverrideEntry, { action: 'add' }> => o.action === 'add',
  );
  function undoAdd(index: number) {
    const target = pendingAdds[index];
    if (!target) return;
    const next = overrides.filter((o) => o !== target);
    void putOverrides(next);
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quản lý danh sách màn hình"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1400,
        background: 'rgba(15, 20, 28, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        data-testid="screen-list-manager"
        style={{
          width: 'min(760px, 96vw)',
          maxHeight: '90vh',
          background: M.paper,
          border: `1px solid ${M.border}`,
          borderRadius: 14,
          boxShadow: '0 32px 80px rgba(0,0,0,.28)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${M.border}` }}>
          <strong style={{ fontSize: 14, color: M.ink }}>Màn hình{manifest ? ` (${manifest.screens.length})` : ''}</strong>
          <button
            type="button"
            onClick={onClose}
            title="Đóng (Esc)"
            style={{ marginLeft: 'auto', width: 28, height: 28, border: `1px solid ${M.border}`, borderRadius: 7, background: 'transparent', color: M.soft, cursor: 'pointer', fontSize: 13 }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14, display: 'grid', gap: 14 }}>
          {loading ? (
            <p style={{ fontSize: 12.5, color: M.soft }}>Đang tải…</p>
          ) : loadError ? (
            <p data-testid="load-error" style={{ fontSize: 12.5, color: M.red }}>
              {loadError}
            </p>
          ) : !manifest ? (
            <p data-testid="no-manifest-msg" style={{ fontSize: 12.5, color: M.soft }}>
              Chưa có lần chạy nào — danh sách màn sẽ xuất hiện sau khi chạy bước Màn hình → Component.
            </p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: M.soft, fontSize: 11, textTransform: 'uppercase' }}>
                  <th style={{ padding: '4px 6px' }}>Mã</th>
                  <th style={{ padding: '4px 6px' }}>Tên</th>
                  <th style={{ padding: '4px 6px' }}>Nguồn</th>
                  <th style={{ padding: '4px 6px' }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {manifest.screens.map((s) => {
                  const pending = pendingActionFor(overrides, s.key);
                  const isRemoved = pending?.action === 'remove';
                  const isRenaming = renamingKey === s.key;
                  return (
                    <tr key={s.key} data-testid={`screen-row-${s.key}`} style={{ borderTop: `1px solid ${M.border}`, opacity: isRemoved ? 0.55 : 1 }}>
                      <td style={{ padding: '6px' }}>
                        <code>{s.code}</code>
                      </td>
                      <td style={{ padding: '6px' }}>
                        {isRenaming ? (
                          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              data-testid={`rename-input-${s.key}`}
                              style={{ fontSize: 12.5, padding: '4px 6px', border: `1px solid ${M.border}`, borderRadius: 6, background: M.paper, color: M.ink }}
                            />
                            <button type="button" onClick={() => commitRename(s.key)} disabled={!renameValue.trim()} data-testid={`rename-save-${s.key}`}>
                              Lưu
                            </button>
                            <button type="button" onClick={cancelRename}>
                              Huỷ
                            </button>
                          </span>
                        ) : pending?.action === 'rename' ? (
                          <span>
                            <span style={{ textDecoration: 'line-through', color: M.soft }}>{s.name}</span> <span>{pending.name}</span>{' '}
                            <em style={{ color: M.soft }}>(chờ chạy lại)</em>
                          </span>
                        ) : (
                          s.name
                        )}
                      </td>
                      <td style={{ padding: '6px' }}>
                        <OriginBadge origin={s.origin} />
                      </td>
                      <td style={{ padding: '6px' }}>
                        {isRemoved ? (
                          <span>
                            <em style={{ color: M.soft }}>Sẽ bỏ (chờ chạy lại)</em>{' '}
                            <button type="button" onClick={() => undoRemove(s.key)} data-testid={`undo-remove-${s.key}`}>
                              Hoàn tác
                            </button>
                          </span>
                        ) : (
                          <span style={{ display: 'flex', gap: 6 }}>
                            {!isRenaming ? (
                              <button
                                type="button"
                                onClick={() => startRename(s.key, pending?.action === 'rename' ? pending.name : s.name)}
                                data-testid={`rename-btn-${s.key}`}
                              >
                                Đổi tên
                              </button>
                            ) : null}
                            <button type="button" onClick={() => removeScreen(s.key)} data-testid={`remove-btn-${s.key}`}>
                              Bỏ
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {pendingAdds.length > 0 ? (
            <div data-testid="pending-adds">
              <div style={{ fontSize: 11, fontWeight: 700, color: M.soft, textTransform: 'uppercase' }}>Sắp thêm (chờ chạy lại)</div>
              <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                {pendingAdds.map((a, i) => (
                  <li key={`${a.code}-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
                    <code>{a.code}</code>
                    <span>{a.name}</span>
                    <span style={{ color: M.soft }}>{a.source || '—'}</span>
                    <button type="button" onClick={() => undoAdd(i)} data-testid={`undo-add-${i}`} style={{ marginLeft: 'auto' }}>
                      Hoàn tác
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div style={{ borderTop: `1px solid ${M.border}`, paddingTop: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: M.ink, marginBottom: 6 }}>Thêm màn</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {uniqueSources.length > 0 ? (
                <label style={{ display: 'grid', gap: 3, fontSize: 11.5, color: M.soft }}>
                  Trang nguồn
                  <select
                    value={addSource}
                    onChange={(e) => setAddSource(e.target.value)}
                    data-testid="add-source-select"
                    style={{ fontSize: 12.5, padding: '5px 6px', border: `1px solid ${M.border}`, borderRadius: 6 }}
                  >
                    <option value="">— chọn —</option>
                    {uniqueSources.map((src) => (
                      <option key={src} value={src}>
                        {src}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label style={{ display: 'grid', gap: 3, fontSize: 11.5, color: M.soft }}>
                Hoặc nhập nguồn khác
                <input
                  value={addSourceCustom}
                  onChange={(e) => setAddSourceCustom(e.target.value)}
                  placeholder="ví dụ: docs/confluence/login.md"
                  data-testid="add-source-custom"
                  style={{ fontSize: 12.5, padding: '5px 6px', border: `1px solid ${M.border}`, borderRadius: 6 }}
                />
              </label>
              <label style={{ display: 'grid', gap: 3, fontSize: 11.5, color: M.soft }}>
                Mã màn
                <input value={addCode} onChange={(e) => setAddCode(e.target.value)} data-testid="add-code" style={{ fontSize: 12.5, padding: '5px 6px', border: `1px solid ${M.border}`, borderRadius: 6 }} />
              </label>
              <label style={{ display: 'grid', gap: 3, fontSize: 11.5, color: M.soft }}>
                Tên màn
                <input value={addName} onChange={(e) => setAddName(e.target.value)} data-testid="add-name" style={{ fontSize: 12.5, padding: '5px 6px', border: `1px solid ${M.border}`, borderRadius: 6 }} />
              </label>
              <label style={{ display: 'grid', gap: 3, fontSize: 11.5, color: M.soft }}>
                Neo trong tài liệu (tuỳ chọn)
                <textarea
                  rows={1}
                  value={addAnchor}
                  onChange={(e) => setAddAnchor(e.target.value)}
                  data-testid="add-anchor"
                  placeholder="dán NGUYÊN VĂN một dòng trong tài liệu để daemon định vị mục"
                  style={{ fontSize: 12.5, padding: '5px 6px', border: `1px solid ${M.border}`, borderRadius: 6, resize: 'vertical', fontFamily: 'inherit' }}
                />
              </label>
              <button
                type="button"
                onClick={submitAdd}
                disabled={!canSaveAdd}
                data-testid="add-save"
                style={{
                  justifySelf: 'start',
                  padding: '6px 16px',
                  borderRadius: 8,
                  border: 0,
                  background: M.accent,
                  color: '#fff',
                  fontWeight: 700,
                  cursor: canSaveAdd ? 'pointer' : 'not-allowed',
                  opacity: canSaveAdd ? 1 : 0.6,
                }}
              >
                Lưu
              </button>
            </div>
          </div>

          {banner ? (
            <div data-testid="save-banner" style={{ fontSize: 12.5, color: M.green, background: M.greenBg, border: `1px solid ${M.greenBorder}`, borderRadius: 8, padding: '8px 10px' }}>
              {banner}
            </div>
          ) : null}
          {saveError ? (
            <div data-testid="save-error" style={{ fontSize: 12.5, color: M.red, background: M.redBg, border: `1px solid ${M.redBorder}`, borderRadius: 8, padding: '8px 10px' }}>
              {saveError}
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
