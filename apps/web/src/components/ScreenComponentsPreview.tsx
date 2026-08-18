// Khung nhìn "Màn hình → Component" (bước dr-comp bản mới của docs-review) cho
// `comp/<SCREEN-KEY>.screen.json` và `comp/index.json`: rail màn hình theo thứ
// tự luồng (từ dr-flow), wireframe HTML kiểu ux-spec ở giữa (iframe cô lập,
// bấm block ↔ chọn element, bấm nút có `data-nav` → nhảy sang màn đích), và
// panel phải liệt kê từng element: component Design System đề xuất, biến thể,
// độ tin cậy, nguồn (tài liệu / luồng / bảng / DS), lý do, link Figma khi DS là
// Link Figma (`.figma-catalog/components.json`).
//
// Dữ liệu là output đã được daemon kiểm (`validateScreenComponentsDoc`) —
// đọc khoan dung ở đây chỉ để một element hỏng không làm sập cả khung.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectFile } from '../types';

import { fetchProjectFileText } from '../providers/registry';
import styles from './ScreenComponentsPreview.module.css';

export type ScreenPlatform = 'mobile' | 'web';
export type ScreenConfidence = 'high' | 'medium' | 'low';
export type ScreenProvenance = 'text' | 'flow' | 'table' | 'ds';

export interface ScreenElementView {
  id: string;
  label: string;
  role: string;
  ds: { component: string; anchor: string; variant?: string } | null;
  confidence: ScreenConfidence;
  provenance: ScreenProvenance;
  docType?: string;
  why?: string;
}
export interface ScreenDocView {
  key: string;
  name: string;
  flowId: string;
  platform: ScreenPlatform;
  source: string | null;
  elements: ScreenElementView[];
  nav: { el: string; to: string }[];
  notes: string[];
  /** Daemon-side normalisations of the agent's output (see screen-components.ts). */
  warnings: string[];
}
export interface ScreenRailEntry {
  key: string;
  name: string;
  flowId?: string;
  order: number;
  platform?: ScreenPlatform;
  elements?: number;
  mapped?: number;
  navOut?: string[];
  failed?: string[];
}
export interface RoleMapView {
  platform: ScreenPlatform;
  roles: { role: string; component: string | null; anchor?: string; variant?: string; when?: string; fallback?: string }[];
  notes: string[];
}
interface FigmaRef {
  fileKey: string;
  nodeId: string;
  page?: string;
}

const CONFIDENCE_LABEL: Record<ScreenConfidence, string> = { high: 'Tin cậy cao', medium: 'Tin cậy vừa', low: 'Tin cậy thấp' };
const PROVENANCE_LABEL: Record<ScreenProvenance, string> = { text: 'Tài liệu', flow: 'Luồng', table: 'Bảng cấu trúc', ds: 'Design System' };
const PLATFORM_LABEL: Record<ScreenPlatform, string> = { mobile: 'Mobile', web: 'Web' };

const SCREEN_FILE_RE = /^(.*?)comp\/([^/]+)\.screen\.json$/i;
const INDEX_FILE_RE = /^(.*?)comp\/index\.json$/i;

/** `comp/<KEY>.screen.json` hoặc `comp/index.json` (bản 2.0). */
export function isScreenComponentsFile(file: Pick<ProjectFile, 'name'>): boolean {
  return SCREEN_FILE_RE.test(file.name) || INDEX_FILE_RE.test(file.name);
}

/** `comp/<KEY>.screen.json` → `{ root: '<prefix>', key }`; `comp/index.json` → key null. */
export function screenComponentsLocationOf(fileName: string): { root: string; key: string | null } | null {
  const m = SCREEN_FILE_RE.exec(fileName);
  if (m) return { root: m[1]!, key: m[2]! };
  const i = INDEX_FILE_RE.exec(fileName);
  if (i) return { root: i[1]!, key: null };
  return null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/** Đọc `comp/<KEY>.screen.json` khoan dung: element thiếu id/label bị bỏ. */
export function parseScreenDoc(raw: string, fallbackKey: string): ScreenDocView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o.elements)) return null;
  const elements: ScreenElementView[] = [];
  const ids = new Set<string>();
  for (const e of o.elements) {
    if (!e || typeof e !== 'object') continue;
    const el = e as Record<string, unknown>;
    const id = str(el.id);
    const label = str(el.label);
    if (!id || !label || ids.has(id)) continue;
    ids.add(id);
    let ds: ScreenElementView['ds'] = null;
    if (el.ds && typeof el.ds === 'object') {
      const d = el.ds as Record<string, unknown>;
      const component = str(d.component);
      const anchor = str(d.anchor);
      if (component) ds = { component, anchor, ...(str(d.variant) ? { variant: str(d.variant) } : {}) };
    }
    const confidence = str(el.confidence) as ScreenConfidence;
    const provenance = str(el.provenance) as ScreenProvenance;
    const view: ScreenElementView = {
      id,
      label,
      role: str(el.role),
      ds,
      confidence: confidence in CONFIDENCE_LABEL ? confidence : 'medium',
      provenance: provenance in PROVENANCE_LABEL ? provenance : 'text',
    };
    if (str(el.docType)) view.docType = str(el.docType);
    if (str(el.why)) view.why = str(el.why);
    elements.push(view);
  }
  const nav: { el: string; to: string }[] = [];
  for (const n of Array.isArray(o.nav) ? o.nav : []) {
    if (!n || typeof n !== 'object') continue;
    const nn = n as Record<string, unknown>;
    if (str(nn.el) && str(nn.to) && ids.has(str(nn.el))) nav.push({ el: str(nn.el), to: str(nn.to) });
  }
  const platform = str(o.platform) === 'web' ? 'web' : 'mobile';
  return {
    key: str(o.key) || fallbackKey,
    name: str(o.name),
    flowId: str(o.flowId),
    platform,
    source: str(o.source) || null,
    elements,
    nav,
    notes: strList(o.notes),
    warnings: strList(o.warnings),
  };
}

/** Rail từ `comp/index.json` (2.0). Bản 1.x (không có `screens[].key`) → null. */
export function parseScreenIndex(raw: string | null): { screens: ScreenRailEntry[]; failed: { key: string; name: string; errors: string[] }[] } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o.screens)) return null;
  const screens: ScreenRailEntry[] = [];
  for (const [i, s] of o.screens.entries()) {
    if (!s || typeof s !== 'object') continue;
    const x = s as Record<string, unknown>;
    const key = str(x.key);
    if (!key) continue;
    const entry: ScreenRailEntry = { key, name: str(x.name) || key, order: typeof x.order === 'number' ? x.order : i };
    if (str(x.flowId)) entry.flowId = str(x.flowId);
    if (str(x.platform) === 'web' || str(x.platform) === 'mobile') entry.platform = str(x.platform) as ScreenPlatform;
    if (typeof x.elements === 'number') entry.elements = x.elements;
    if (typeof x.mapped === 'number') entry.mapped = x.mapped;
    entry.navOut = strList(x.navOut);
    screens.push(entry);
  }
  if (screens.length === 0 && !Array.isArray(o.failed)) return null;
  const failed: { key: string; name: string; errors: string[] }[] = [];
  for (const f of Array.isArray(o.failed) ? o.failed : []) {
    if (!f || typeof f !== 'object') continue;
    const x = f as Record<string, unknown>;
    if (!str(x.key)) continue;
    failed.push({ key: str(x.key), name: str(x.name) || str(x.key), errors: strList(x.errors) });
  }
  return { screens, failed };
}

/** Rail dự phòng từ `comp/_inputs.json` (khi index.json chưa có — đang chạy dở
 *  hoặc mọi màn đều hỏng). */
export function parseScreenInputsRail(raw: string | null): ScreenRailEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { screens?: unknown };
    if (!Array.isArray(parsed.screens)) return [];
    return parsed.screens
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !!str((s as Record<string, unknown>).key))
      .map((s, i) => ({ key: str(s.key), name: str(s.name) || str(s.key), order: typeof s.order === 'number' ? s.order : i, ...(str(s.flowId) ? { flowId: str(s.flowId) } : {}) }));
  } catch {
    return [];
  }
}

export function parseRoleMapView(raw: string | null): RoleMapView | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || !Array.isArray(o.roles)) return null;
    return {
      platform: str(o.platform) === 'web' ? 'web' : 'mobile',
      roles: o.roles
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !!str((r as Record<string, unknown>).role))
        .map((r) => ({
          role: str(r.role),
          component: str(r.component) || null,
          ...(str(r.anchor) ? { anchor: str(r.anchor) } : {}),
          ...(str(r.variant) ? { variant: str(r.variant) } : {}),
          ...(str(r.when) ? { when: str(r.when) } : {}),
          ...(str(r.fallback) ? { fallback: str(r.fallback) } : {}),
        })),
      notes: strList(o.notes),
    };
  } catch {
    return null;
  }
}

/** `.figma-catalog/components.json` → tên component → {fileKey,nodeId}. Tên
 *  trùng giữa nhiều file thì lấy cái đầu (cùng quy ước với components.md). */
export function parseFigmaRefs(raw: string | null): Map<string, FigmaRef> {
  const map = new Map<string, FigmaRef>();
  if (!raw) return map;
  try {
    const o = JSON.parse(raw) as { files?: unknown };
    for (const f of Array.isArray(o.files) ? o.files : []) {
      if (!f || typeof f !== 'object') continue;
      const file = f as Record<string, unknown>;
      const fileKey = str(file.fileKey);
      if (!fileKey) continue;
      for (const c of Array.isArray(file.components) ? file.components : []) {
        if (!c || typeof c !== 'object') continue;
        const comp = c as Record<string, unknown>;
        const name = str(comp.name);
        const nodeId = str(comp.nodeId);
        if (!name || !nodeId || map.has(name)) continue;
        map.set(name, { fileKey, nodeId, ...(str(comp.page) ? { page: str(comp.page) } : {}) });
      }
    }
  } catch {
    /* không có catalog Figma — không có link */
  }
  return map;
}

export function figmaNodeUrl(ref: FigmaRef): string {
  return `https://www.figma.com/design/${encodeURIComponent(ref.fileKey)}?node-id=${encodeURIComponent(ref.nodeId.replace(':', '-'))}`;
}

// ── Wireframe iframe ───────────────────────────────────────────────────────

/** Kênh cha ↔ iframe: iframe chạy `sandbox="allow-scripts"` (không same-origin,
 *  origin = "null") nên hai bên nói chuyện qua postMessage với đích `*`; mọi
 *  thông điệp đều có tiền tố `od-wf:` để không lẫn với thứ khác trên trang. */
export const WF_MSG = {
  el: 'od-wf:el',
  nav: 'od-wf:nav',
  height: 'od-wf:height',
  highlight: 'od-wf:highlight',
} as const;

const BRIDGE_SCRIPT = `<script>(function(){
  var K = ${JSON.stringify(WF_MSG)};
  var post = function(m){ try { parent.postMessage(m, '*'); } catch (e) {} };
  var active = null;
  var mark = function(id){
    if (active) { active.classList.remove('od-wf-active'); active = null; }
    if (!id) return;
    var n = document.querySelector('[data-el="' + id.replace(/"/g, '\\\\"') + '"]');
    if (n) { active = n; n.classList.add('od-wf-active'); if (n.scrollIntoView) n.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  };
  document.addEventListener('click', function(ev){
    var t = ev.target;
    var navEl = t && t.closest ? t.closest('[data-nav]') : null;
    var el = t && t.closest ? t.closest('[data-el]') : null;
    if (navEl) { ev.preventDefault(); }
    if (el) post({ type: K.el, el: el.getAttribute('data-el') });
    if (navEl) post({ type: K.nav, to: navEl.getAttribute('data-nav') });
  }, true);
  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.type !== K.highlight) return;
    mark(typeof d.el === 'string' ? d.el : null);
  });
  var report = function(){ post({ type: K.height, height: document.documentElement.scrollHeight || document.body.scrollHeight || 0 }); };
  window.addEventListener('load', report);
  if (window.ResizeObserver) { new ResizeObserver(report).observe(document.documentElement); }
  setTimeout(report, 0);
})();</script>`;

const BRIDGE_STYLE = `<style>
[data-el]{cursor:pointer}
.od-wf-active{outline:2px solid #0066b3 !important;outline-offset:2px;box-shadow:0 0 0 4px rgba(0,102,179,.18) !important}
</style>`;

/** Chèn cầu nối (script + style) vào wireframe. Không đụng phần agent viết. */
export function withWireframeBridge(html: string): string {
  const inject = `${BRIDGE_STYLE}${BRIDGE_SCRIPT}`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${inject}</body>`);
  return `${html}${inject}`;
}

type DeviceKey = 'desktop' | 'tablet' | 'mobile';
const DEVICE_WIDTH: Record<DeviceKey, number> = { desktop: 1280, tablet: 834, mobile: 390 };
const DEVICE_LABEL: Record<DeviceKey, string> = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' };

function WireframeFrame({
  html,
  platform,
  device,
  activeEl,
  onSelectEl,
  onNav,
}: {
  html: string;
  platform: ScreenPlatform;
  device: DeviceKey;
  activeEl: string | null;
  onSelectEl: (id: string) => void;
  onNav: (to: string) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(platform === 'web' ? 800 : 844);
  const doc = useMemo(() => withWireframeBridge(html), [html]);
  const width = platform === 'web' ? DEVICE_WIDTH[device] : DEVICE_WIDTH.mobile;

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== ref.current?.contentWindow) return;
      const d = ev.data as { type?: string; el?: string; to?: string; height?: number } | null;
      if (!d || typeof d !== 'object') return;
      if (d.type === WF_MSG.el && typeof d.el === 'string') onSelectEl(d.el);
      else if (d.type === WF_MSG.nav && typeof d.to === 'string') onNav(d.to);
      else if (d.type === WF_MSG.height && typeof d.height === 'number' && d.height > 0) setHeight(Math.max(240, Math.ceil(d.height)));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onSelectEl, onNav]);

  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ type: WF_MSG.highlight, el: activeEl }, '*');
  }, [activeEl, doc]);

  return (
    <iframe
      ref={ref}
      srcDoc={doc}
      sandbox="allow-scripts"
      title="Wireframe"
      data-testid="wireframe-frame"
      onLoad={() => ref.current?.contentWindow?.postMessage({ type: WF_MSG.highlight, el: activeEl }, '*')}
      style={{ display: 'block', width, height, maxWidth: '100%', border: 0, background: '#fff' }}
    />
  );
}

// ── Main view ──────────────────────────────────────────────────────────────

interface LoadedScreen {
  doc: ScreenDocView | null;
  html: string | null;
}

export function ScreenComponentsPreview({ projectId, file }: { projectId: string; file: ProjectFile }) {
  const loc = useMemo(() => screenComponentsLocationOf(file.name), [file.name]);
  const [rail, setRail] = useState<ScreenRailEntry[] | null>(null);
  const [failedMap, setFailedMap] = useState<Map<string, string[]>>(new Map());
  const [roleMap, setRoleMap] = useState<RoleMapView | null>(null);
  const [figmaRefs, setFigmaRefs] = useState<Map<string, FigmaRef>>(new Map());
  const [screens, setScreens] = useState<Map<string, LoadedScreen>>(new Map());
  const [current, setCurrent] = useState<string | null>(null);
  const [activeEl, setActiveEl] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceKey>('desktop');
  const [showRoles, setShowRoles] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rail + role-map + Figma refs (một lần cho cả run).
  useEffect(() => {
    if (!loc) return;
    let cancelled = false;
    setRail(null);
    setError(null);
    setScreens(new Map());
    setActiveEl(null);
    const get = (rel: string) => fetchProjectFileText(projectId, rel);
    void (async () => {
      const [indexRaw, inputsRaw, roleRaw, figmaRaw] = await Promise.all([
        get(`${loc.root}comp/index.json`),
        get(`${loc.root}comp/_inputs.json`),
        get(`${loc.root}comp/_role-map.json`),
        get(`${loc.root}.figma-catalog/components.json`),
      ]);
      if (cancelled) return;
      const index = parseScreenIndex(indexRaw);
      const fromInputs = parseScreenInputsRail(inputsRaw);
      const entries = new Map<string, ScreenRailEntry>();
      for (const s of index?.screens ?? []) entries.set(s.key, s);
      for (const s of fromInputs) if (!entries.has(s.key)) entries.set(s.key, s);
      const failed = new Map<string, string[]>();
      for (const f of index?.failed ?? []) {
        failed.set(f.key, f.errors);
        if (!entries.has(f.key)) entries.set(f.key, { key: f.key, name: f.name, order: 1e9 });
      }
      if (loc.key && !entries.has(loc.key)) entries.set(loc.key, { key: loc.key, name: loc.key, order: 1e9 });
      const list = [...entries.values()].sort((a, b) => a.order - b.order);
      if (list.length === 0) {
        setError('Chưa có màn hình nào — chạy bước "Đánh giá luồng UX" rồi "Màn hình → Component".');
        return;
      }
      setRail(list);
      setFailedMap(failed);
      setRoleMap(parseRoleMapView(roleRaw));
      setFigmaRefs(parseFigmaRefs(figmaRaw));
      setCurrent(loc.key ?? list[0]!.key);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, loc, file.mtime]);

  // Màn đang chọn: doc + wireframe (cache theo key).
  useEffect(() => {
    if (!loc || !current || screens.has(current)) return;
    let cancelled = false;
    const key = current;
    void (async () => {
      const [docRaw, html] = await Promise.all([
        fetchProjectFileText(projectId, `${loc.root}comp/${key}.screen.json`),
        fetchProjectFileText(projectId, `${loc.root}wireframes/${key}.html`),
      ]);
      if (cancelled) return;
      setScreens((prev) => {
        const next = new Map(prev);
        next.set(key, { doc: docRaw ? parseScreenDoc(docRaw, key) : null, html });
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, loc, current, screens]);

  const nameOf = useMemo(() => new Map((rail ?? []).map((r) => [r.key, r.name])), [rail]);
  const loaded = current ? screens.get(current) ?? null : null;
  const doc = loaded?.doc ?? null;
  const platform: ScreenPlatform = doc?.platform ?? roleMap?.platform ?? 'mobile';
  const navByEl = useMemo(() => new Map((doc?.nav ?? []).map((n) => [n.el, n.to])), [doc]);
  const roleByName = useMemo(() => new Map((roleMap?.roles ?? []).map((r) => [r.role, r])), [roleMap]);

  const selectScreen = (key: string) => {
    if (key === current) return;
    setCurrent(key);
    setActiveEl(null);
  };
  const onNav = (to: string) => {
    if (rail?.some((r) => r.key === to)) selectScreen(to);
  };

  if (!loc) return <div className={styles.message}>File không thuộc thư mục comp/.</div>;
  if (error) return <div className={styles.message}>{error}</div>;
  if (!rail || !current) return <div className={styles.message}>Đang tải…</div>;

  const currentEntry = rail.find((r) => r.key === current) ?? null;
  const failedErrors = failedMap.get(current) ?? null;
  const mappedCount = doc ? doc.elements.filter((e) => e.ds).length : 0;
  const code = current.includes('__') ? current.slice(current.lastIndexOf('__') + 2) : current;

  return (
    <div className={styles.root}>
      <aside className={styles.rail} aria-label="Màn hình của luồng">
        <div className={styles.railHead}>
          <span className={styles.railTitle}>Màn hình</span>
          <span className={styles.railCount}>{rail.length}</span>
        </div>
        <ol className={styles.railList}>
          {rail.map((r, i) => {
            const isFailed = failedMap.has(r.key);
            const shortCode = r.key.includes('__') ? r.key.slice(r.key.lastIndexOf('__') + 2) : r.key;
            return (
              <li key={r.key}>
                <button
                  type="button"
                  className={`${styles.railItem} ${r.key === current ? styles.railItemActive : ''} ${isFailed ? styles.railItemFailed : ''}`}
                  onClick={() => selectScreen(r.key)}
                  aria-current={r.key === current ? 'true' : undefined}
                  data-testid={`rail-${r.key}`}
                >
                  <span className={styles.railIndex}>{i + 1}</span>
                  <span className={styles.railBody}>
                    <span className={styles.railName}>{r.name}</span>
                    <span className={styles.railMeta}>
                      <code>{shortCode}</code>
                      {isFailed ? <span className={styles.railFailed}>chạy hỏng</span> : typeof r.mapped === 'number' && typeof r.elements === 'number' ? <span>{r.mapped}/{r.elements} map DS</span> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {roleMap ? (
          <button type="button" className={styles.roleToggle} onClick={() => setShowRoles((v) => !v)} aria-expanded={showRoles}>
            {showRoles ? 'Ẩn bảng vai trò → DS' : `Bảng vai trò → DS (${roleMap.roles.length})`}
          </button>
        ) : null}
        {roleMap && showRoles ? (
          <ul className={styles.roleList} data-testid="role-map">
            {roleMap.roles.map((r) => (
              <li key={r.role} className={styles.roleItem}>
                <code className={styles.roleName}>{r.role}</code>
                <span className={styles.roleComp}>{r.component ?? <em>không có trong DS</em>}</span>
                {r.variant ? <span className={styles.roleVariant}>{r.variant}</span> : null}
                {r.when ? <span className={styles.roleWhen}>{r.when}</span> : null}
                {r.fallback ? <span className={styles.roleWhen}>Thay bằng: {r.fallback}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </aside>

      <section className={styles.main} aria-label="Wireframe">
        <header className={styles.head}>
          <div className={styles.headMain}>
            <h2 className={styles.title}>{doc?.name || currentEntry?.name || current}</h2>
            <code className={styles.key}>{code}</code>
            <span className={styles.platform}>{PLATFORM_LABEL[platform]}</span>
            {doc ? (
              <span className={styles.mapped} data-testid="mapped-count">
                {mappedCount}/{doc.elements.length} element có component DS
              </span>
            ) : null}
          </div>
          <div className={styles.headMeta}>
            {doc?.source ? (
              <span>
                Nguồn: <code>{doc.source}</code>
              </span>
            ) : null}
            {doc?.flowId ? (
              <span>
                Luồng: <code>{doc.flowId}</code>
              </span>
            ) : null}
            {doc && doc.nav.length ? (
              <span className={styles.navLine}>
                Đi tới:{' '}
                {[...new Set(doc.nav.map((n) => n.to))].map((to) => (
                  <button key={to} type="button" className={styles.navChip} onClick={() => onNav(to)} disabled={!rail.some((r) => r.key === to)}>
                    {nameOf.get(to) ?? to}
                  </button>
                ))}
              </span>
            ) : null}
          </div>
        </header>
        {platform === 'web' && loaded?.html ? (
          <div className={styles.deviceBar} role="tablist" aria-label="Kích thước khung">
            {(Object.keys(DEVICE_WIDTH) as DeviceKey[]).map((d) => (
              <button key={d} type="button" role="tab" aria-selected={device === d} className={`${styles.deviceBtn} ${device === d ? styles.deviceBtnActive : ''}`} onClick={() => setDevice(d)}>
                {DEVICE_LABEL[d]}
              </button>
            ))}
          </div>
        ) : null}
        <div className={styles.frameBox}>
          {failedErrors ? (
            <div className={styles.failed} data-testid="screen-failed">
              <strong>Màn này chạy hỏng</strong>
              <ul>
                {failedErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ) : !loaded ? (
            <div className={styles.message}>Đang tải màn…</div>
          ) : loaded.html ? (
            <WireframeFrame html={loaded.html} platform={platform} device={device} activeEl={activeEl} onSelectEl={setActiveEl} onNav={onNav} />
          ) : (
            <div className={styles.message}>Chưa có wireframe cho màn này.</div>
          )}
        </div>
      </section>

      <aside className={styles.panel} aria-label="Component đề xuất">
        <div className={styles.panelHead}>
          <span className={styles.panelTitle}>Component đề xuất</span>
          {doc ? <span className={styles.railCount}>{doc.elements.length}</span> : null}
        </div>
        {!doc ? (
          <div className={styles.message}>{failedErrors ? 'Không có đề xuất — màn chạy hỏng.' : loaded ? 'Không đọc được screen.json.' : 'Đang tải…'}</div>
        ) : (
          <ol className={styles.elList} data-testid="element-list">
            {doc.elements.map((el) => {
              const ref = el.ds ? figmaRefs.get(el.ds.component) ?? null : null;
              const role = roleByName.get(el.role);
              const navTo = navByEl.get(el.id);
              const isActive = el.id === activeEl;
              return (
                <li key={el.id}>
                  <button
                    type="button"
                    className={`${styles.el} ${isActive ? styles.elActive : ''}`}
                    onClick={() => setActiveEl(isActive ? null : el.id)}
                    aria-pressed={isActive}
                    data-testid={`el-${el.id}`}
                  >
                    <span className={styles.elTop}>
                      <span className={styles.elLabel}>{el.label}</span>
                      <span className={`${styles.conf} ${styles[`conf_${el.confidence}`]}`}>{CONFIDENCE_LABEL[el.confidence]}</span>
                    </span>
                    <span className={styles.elDs}>
                      {el.ds ? (
                        <>
                          <span className={styles.dsName}>{el.ds.component}</span>
                          {el.ds.variant ? <span className={styles.dsVariant}>{el.ds.variant}</span> : null}
                        </>
                      ) : (
                        <span className={styles.dsNone}>Không có component DS{role?.fallback ? ` — ${role.fallback}` : ''}</span>
                      )}
                    </span>
                    <span className={styles.elMeta}>
                      {el.role ? <code className={styles.roleTag}>{el.role}</code> : null}
                      <span className={styles.prov}>{PROVENANCE_LABEL[el.provenance]}</span>
                      {el.docType ? <span className={styles.docType}>tài liệu khai: {el.docType}</span> : null}
                      {navTo ? <span className={styles.navTag}>→ {nameOf.get(navTo) ?? navTo}</span> : null}
                    </span>
                    {el.why ? <span className={styles.why}>{el.why}</span> : null}
                  </button>
                  {ref && el.ds ? (
                    <a className={styles.figmaLink} href={figmaNodeUrl(ref)} target="_blank" rel="noreferrer">
                      Mở trong Figma{ref.page ? ` · ${ref.page}` : ''}
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {doc?.notes.length ? (
          <div className={styles.notes}>
            <div className={styles.notesTitle}>Ghi chú của bước</div>
            <ul>
              {doc.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {doc?.warnings.length ? (
          <div className={`${styles.notes} ${styles.warnings}`} data-testid="screen-warnings">
            <div className={styles.notesTitle}>Daemon đã chuẩn hoá ({doc.warnings.length})</div>
            <ul>
              {doc.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
