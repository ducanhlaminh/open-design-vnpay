// ScreensDiscoveredPreview — preview cho `screens-discovered.json`: danh sách
// màn sinh cùng bước Luồng màn hình (dr-flow, skill docs-screen-flow — WP
// dr-screens-merge 2026-08-27: daemon dẫn xuất từ screens.json v2, ĐÚNG contract
// cũ của dr-screens/docs-screen-discovery nên preview này không đổi shape;
// dr-screens giờ là bước ẩn chạy tay khi tài liệu không có luồng).
//
// Vì sao cần preview riêng (bug preview 0.8.143): trước đây Quick result của
// stage này không có file previewable nào nên fallback liệt kê tất cả, và
// `comp/_screens.json` (ScreensManifest, có mảng `screens`) lọt qua heuristic
// "có screens → UX-Spec" của SpecFileViewer rồi render bằng UxSpecView — một
// component sinh ra cho workflow ux-spec, đòi screen_type/actor/components/
// wireframes mà dữ liệu phát hiện màn không có → toàn dấu "−", "0 THÀNH PHẦN"
// và hint sai "chạy lại bước UX Spec" (docs-review không có stage đó).
//
// Dữ liệu THẬT của stage: danh sách màn theo TRANG NGUỒN, mỗi màn có anchor
// nguyên văn trong tài liệu, khối bổ sung (blocks) lồng dưới màn cha, mục đã
// loại trừ kèm lý do, và quyết định nhóm biến thể App/Web. Preview này hiển
// thị đúng những thứ đó — read-only, không có hành vi sửa (sửa danh sách màn
// là việc của ScreenListManager ở bước dr-comp).
import { useMemo, useState } from 'react';

// Shape theo skills/docs-screen-discovery/SKILL.md §Output (daemon
// toDiscoveredDoc sinh cùng shape từ screens.json v2 của docs-screen-flow).
// Khai LOCAL vì đây là contract giữa skill/daemon và preview — packages/
// contracts không export nó. Parse khoan dung: field lạ bỏ qua, field thiếu
// coi như rỗng.
export interface DiscoveredBlock {
  name: string;
  anchorText?: string;
  why?: string;
}
export interface DiscoveredScreen {
  code: string | null;
  name: string;
  anchorText?: string;
  why?: string;
  blocks?: DiscoveredBlock[];
  /** WP screen-flow-platform-split: nền tảng của màn (agent quyết trong
   *  screens.json; discovery = hợp các flow). Vắng = tài liệu một nền tảng. */
  platform?: 'app' | 'web';
  /** Khoá nhóm biến thể cùng màn nghiệp vụ ở 2 nền tảng (suy từ hậu tố key). */
  groupKey?: string;
}
export interface DiscoveredPage {
  source: string;
  screens: DiscoveredScreen[];
}
export interface DiscoveredExcluded {
  name: string;
  source?: string;
  reason: string;
  partOf?: string;
}
export interface DiscoveredGroupSuggestion {
  suggestionId: string;
  decision: 'confirm' | 'reject';
  anchorTextA?: string;
  anchorTextB?: string;
  why?: string;
}
export interface ScreensDiscoveredDoc {
  schema_version: 1;
  generatedAt?: string;
  pages: DiscoveredPage[];
  excluded?: DiscoveredExcluded[];
  groupSuggestions?: DiscoveredGroupSuggestion[];
}

/** Shape guard cho SpecFileViewer: đúng file screens-discovered.json v1. */
export function isScreensDiscoveredDoc(value: unknown): value is ScreensDiscoveredDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  if (doc.schema_version !== 1) return false;
  if (!Array.isArray(doc.pages)) return false;
  return doc.pages.every(
    (p) => !!p && typeof p === 'object' && typeof (p as DiscoveredPage).source === 'string' && Array.isArray((p as DiscoveredPage).screens),
  );
}

// Token màu của app (styles/tokens.css) — cùng khuôn ScreenListManager.
const M = {
  ink: 'var(--text, #1a1916)',
  soft: 'var(--text-muted, #57544e)',
  border: 'var(--border, #e1e5eb)',
  paper: 'var(--bg, #fff)',
  subtle: 'var(--bg-subtle, #f6f7f9)',
  accent: 'var(--accent, #0066b3)',
  accentTint: 'var(--accent-tint, #e6f0f8)',
} as const;

// Nhãn chuẩn hóa App/Web (screen-variants): biến thể được skill đánh hậu tố
// `-APP`/`-WEB` vào code (code null thì vào cuối name) — badge suy từ đúng
// quy ước đó, không đoán từ nội dung.
function platformOf(screen: DiscoveredScreen): 'App' | 'Web' | null {
  // Field `platform` (flow tách theo nền tảng) thắng quy ước hậu tố.
  if (screen.platform === 'app') return 'App';
  if (screen.platform === 'web') return 'Web';
  const marker = (screen.code ?? screen.name).trim();
  if (/-APP$/i.test(marker)) return 'App';
  if (/-WEB$/i.test(marker)) return 'Web';
  return null;
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

function Chip({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'accent' }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        whiteSpace: 'nowrap',
        color: tone === 'accent' ? M.accent : M.soft,
        background: tone === 'accent' ? M.accentTint : 'transparent',
        border: `1px solid ${tone === 'accent' ? M.accent : M.border}`,
      }}
    >
      {children}
    </span>
  );
}

function AnchorLine({ text }: { text: string }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 11,
        color: M.soft,
        marginTop: 2,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
      title={text}
    >
      {text}
    </div>
  );
}

export function ScreensDiscoveredPreview({ doc }: { doc: ScreensDiscoveredDoc }) {
  const pages = doc.pages ?? [];
  const excluded = doc.excluded ?? [];
  const suggestions = doc.groupSuggestions ?? [];
  const totalScreens = useMemo(() => pages.reduce((n, p) => n + p.screens.length, 0), [pages]);
  const [showExcluded, setShowExcluded] = useState(false);

  return (
    <div data-testid="screens-discovered-preview" style={{ padding: 16, maxWidth: 860, margin: '0 auto', color: M.ink }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Danh sách màn hình</h1>
        <span style={{ fontSize: 12.5, color: M.soft }}>
          {totalScreens} màn · {pages.length} trang{doc.generatedAt ? ` · ${new Date(doc.generatedAt).toLocaleString('vi-VN')}` : ''}
        </span>
      </div>
      <p style={{ fontSize: 12, color: M.soft, margin: '0 0 14px' }}>
        Danh sách màn nhận diện từ tài liệu, sinh cùng bước Luồng màn hình (dr-flow) — bước Màn hình → Component sẽ dùng danh sách này.
        Muốn thêm/bỏ/đổi tên màn, dùng nút Màn hình ở bước đó.
      </p>

      {pages.map((page) => {
        // Mã hiển thị: giữ mã tài liệu; màn không mã đánh X1, X2… CHỈ đếm qua
        // các màn không mã, theo thứ tự trong trang — khớp cách daemon tự đánh
        // (skill: "daemon tự đánh X1, X2… theo thứ tự dòng anchor trong trang").
        let autoN = 0;
        const displayCodes = page.screens.map((s) => s.code ?? `X${++autoN}`);
        return (
        <section key={page.source} data-testid={`sd-page-${page.source}`} style={{ marginBottom: 16 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 11,
              fontWeight: 700,
              color: M.soft,
              textTransform: 'uppercase',
              marginBottom: 6,
            }}
            title={page.source}
          >
            {baseName(page.source)}
            <span style={{ fontWeight: 500, textTransform: 'none' }}>({page.screens.length} màn)</span>
          </div>
          <div style={{ border: `1px solid ${M.border}`, borderRadius: 10, overflow: 'hidden', background: M.paper }}>
            {page.screens.length === 0 ? (
              <div style={{ padding: 12, fontSize: 12.5, color: M.soft }}>(trang này không có màn nào)</div>
            ) : (
              page.screens.map((screen, i) => {
                const platform = platformOf(screen);
                return (
                  <div key={`${screen.code ?? screen.name}-${i}`} style={{ padding: '9px 12px', borderTop: i ? `1px solid ${M.border}` : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Chip tone="accent">{displayCodes[i]}</Chip>
                      <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }} title={screen.why || undefined}>
                        {screen.name}
                      </span>
                      {platform ? <Chip>{platform}</Chip> : null}
                    </div>
                    {screen.anchorText ? <AnchorLine text={screen.anchorText} /> : null}
                    {(screen.blocks ?? []).map((block, bi) => (
                      <div
                        key={`${block.name}-${bi}`}
                        data-testid="sd-block"
                        style={{ marginTop: 6, marginLeft: 14, paddingLeft: 10, borderLeft: `2px solid ${M.border}` }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
                          <span style={{ fontWeight: 600 }}>{block.name}</span>
                          <Chip>khối bổ sung</Chip>
                        </div>
                        {block.why ? <div style={{ fontSize: 11.5, color: M.soft, marginTop: 1 }}>{block.why}</div> : null}
                        {block.anchorText ? <AnchorLine text={block.anchorText} /> : null}
                      </div>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        </section>
        );
      })}

      {suggestions.length > 0 ? (
        <section data-testid="sd-suggestions" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: M.soft, textTransform: 'uppercase', marginBottom: 6 }}>
            Nhóm biến thể App/Web ({suggestions.length})
          </div>
          <div style={{ border: `1px solid ${M.border}`, borderRadius: 10, overflow: 'hidden', background: M.paper }}>
            {suggestions.map((s, i) => (
              <div key={s.suggestionId} style={{ padding: '8px 12px', fontSize: 12.5, borderTop: i ? `1px solid ${M.border}` : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Chip tone={s.decision === 'confirm' ? 'accent' : 'muted'}>{s.decision === 'confirm' ? 'Xác nhận nhóm' : 'Không nhóm'}</Chip>
                  <span style={{ color: M.soft }}>{s.suggestionId}</span>
                </div>
                {s.why ? <div style={{ fontSize: 11.5, color: M.soft, marginTop: 2 }}>{s.why}</div> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {excluded.length > 0 ? (
        <section data-testid="sd-excluded" style={{ marginBottom: 16 }}>
          <button
            type="button"
            data-testid="sd-excluded-toggle"
            onClick={() => setShowExcluded((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              fontWeight: 700,
              color: M.soft,
              textTransform: 'uppercase',
              background: 'transparent',
              border: 0,
              padding: 0,
              cursor: 'pointer',
              marginBottom: 6,
            }}
          >
            Đã loại trừ ({excluded.length}) {showExcluded ? '▾' : '▸'}
          </button>
          {showExcluded ? (
            <div style={{ border: `1px dashed ${M.border}`, borderRadius: 10, overflow: 'hidden', background: M.subtle }}>
              {excluded.map((e, i) => (
                <div key={`${e.name}-${i}`} style={{ padding: '8px 12px', fontSize: 12.5, borderTop: i ? `1px solid ${M.border}` : 'none' }}>
                  <span style={{ fontWeight: 600 }}>{e.name}</span>
                  {e.partOf ? <span style={{ color: M.soft }}> — thuộc {e.partOf}</span> : null}
                  <div style={{ fontSize: 11.5, color: M.soft, marginTop: 1 }}>{e.reason}</div>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
