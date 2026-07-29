// figma-audit — Lớp 1 của audit "Preview ↔ Figma": soi TĨNH các file capture
// (react-ds/figma-screens/screens/*.capture.json — figma-h2d IR kèm marker
// data-fig-comp/variant) đối chiếu với bộ DS đã stage, và BÁO TRƯỚC những gì
// sẽ hỏng khi dán vào Figma — không cần mở Figma:
//
//   1. unknown-component  — marker trỏ component không tồn tại trong bộ DS
//                            → plugin sẽ drop node (frame trống).
//   2. icon-file-component — component là ICON/ILLUSTRATION (components/icons):
//                            bộ icon nằm ở FILE FIGMA KHÁC (Iconography) so với
//                            UI Lib; nếu file đang mở không chứa page icon đó,
//                            plugin unmatched → icon biến mất (vụ dấu ✓ xanh).
//   3. variant-fallback   — fig-variant capture được KHÔNG khớp bộ variant của
//                            component (VARIANTS trong bản compile): Figma
//                            setProperties fail LẶNG LẼ → instance dùng variant
//                            default → Figma trông khác hẳn preview (vụ header).
//   4. oversize-layer     — node con trong subtree một component tràn xa khỏi
//                            khung component (kiểu IPayBackground 375×812 nằm
//                            trong nav cao ~100px) → web preview bị lớp nền đè
//                            (khối đen) trong khi Figma dựng instance gốc thì
//                            không — gap fidelity của compile-core, cần báo
//                            upstream chứ không phải lỗi agent.
//
// Output: react-ds/figma-screens/audit.json (nằm trong outputs của stage nên
// sync/pull như mọi artifact khác) + summary trả về cho route/CLI/UI.

import fs from 'node:fs';
import path from 'node:path';

export interface FigmaAuditFinding {
  rule: 'unknown-component' | 'icon-file-component' | 'variant-fallback' | 'oversize-layer';
  level: 'error' | 'warning';
  /** Frame name (capture file's `name`). */
  screen: string;
  /** Figma component display name from the marker (khi có). */
  comp?: string;
  detail: string;
  fix: string;
}

/** Finding đã GỘP theo (rule, comp) qua mọi frame — một component dùng ở 6
 *  màn/state chỉ báo MỘT dòng kèm danh sách màn, thay vì 6 dòng lặp. */
export interface FigmaAuditAggregated {
  rule: FigmaAuditFinding['rule'];
  level: FigmaAuditFinding['level'];
  comp?: string;
  /** Các frame (màn/state) dính finding này. */
  screens: string[];
  detail: string;
  fix: string;
}

export function aggregateFindings(perScreen: FigmaAuditFinding[]): FigmaAuditAggregated[] {
  const byKey = new Map<string, FigmaAuditAggregated>();
  for (const f of perScreen) {
    const key = `${f.rule}|${f.comp ?? f.detail}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.screens.includes(f.screen)) existing.screens.push(f.screen);
    } else {
      byKey.set(key, {
        rule: f.rule,
        level: f.level,
        ...(f.comp ? { comp: f.comp } : {}),
        screens: [f.screen],
        detail: f.detail,
        fix: f.fix,
      });
    }
  }
  // Error trước, warning sau; trong cùng level thì comp dính nhiều màn lên đầu.
  return [...byKey.values()].sort(
    (a, b) => (a.level === b.level ? b.screens.length - a.screens.length : a.level === 'error' ? -1 : 1),
  );
}

export interface FigmaAuditResult {
  screens: number;
  markers: number;
  findings: FigmaAuditAggregated[];
  summary: Record<string, number>;
  /** react-ds-relative path of the written report. */
  auditJson: string;
}

type IrNode = {
  owningReactComponent?: string;
  rect?: { x: number; y: number; width: number; height: number };
  childNodes?: IrNode[];
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Parse `kg:fig|fig-comp=<name>;fig-variant=<encJSON>;fig-props=<encJSON>`. */
export function parseFigMarker(raw: string): { comp: string; variant?: Record<string, unknown> } | null {
  if (!raw.startsWith('kg:fig|')) return null;
  const out: { comp: string; variant?: Record<string, unknown> } = { comp: '' };
  for (const part of raw.slice('kg:fig|'.length).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 'fig-comp') out.comp = value;
    if (key === 'fig-variant') {
      try {
        const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          out.variant = parsed as Record<string, unknown>;
        }
      } catch {
        /* variant hỏng → bỏ qua, không chặn audit */
      }
    }
  }
  return out.comp ? out : null;
}

/** Canonical form of a variant dict — order-independent so
 *  "Level=Level 2|Type=Text" và {"Type":"Text","Level":"Level 2"} so được. */
function canonicalVariant(entries: Record<string, unknown>): string {
  return Object.entries(entries)
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort()
    .join('|');
}

export interface DsAuditData {
  /** Normalized ui component names (từ src/ds/components/ui/*.tsx). */
  uiComps: Set<string>;
  /** Normalized icon component names (từ src/ds/components/icons/*.tsx). */
  iconComps: Set<string>;
  /** normalized name → tập variant hợp lệ (canonical) + default (hiển thị). */
  variants: Map<string, { combos: Set<string>; defaultLabel?: string }>;
}

/** Đọc dữ liệu đối chiếu từ bộ DS đã stage trong run cwd. */
export async function readDsAuditData(reactDsDir: string): Promise<DsAuditData> {
  const list = async (dir: string) =>
    (await fs.promises.readdir(dir).catch(() => [] as string[]))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => f.slice(0, -'.tsx'.length));
  const uiDir = path.join(reactDsDir, 'src', 'ds', 'components', 'ui');
  const uiSlugs = await list(uiDir);
  const iconSlugs = await list(path.join(reactDsDir, 'src', 'ds', 'components', 'icons'));
  const variants = new Map<string, { combos: Set<string>; defaultLabel?: string }>();
  for (const slug of uiSlugs) {
    const src = await fs.promises.readFile(path.join(uiDir, `${slug}.tsx`), 'utf8').catch(() => '');
    const combos = new Set<string>();
    for (const m of src.matchAll(/VARIANTS\["([^"]+)"\]/g)) {
      const dict: Record<string, string> = {};
      for (const pair of m[1]!.split('|')) {
        const eq = pair.indexOf('=');
        if (eq > 0) dict[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      combos.add(canonicalVariant(dict));
    }
    let defaultLabel: string | undefined;
    const defaults = /const FIG_DEFAULTS = (\{[^\n]*\})/.exec(src)?.[1];
    const keys = /const FIG_VARIANT_KEYS = (\{[^\n]*\})/.exec(src)?.[1];
    if (defaults && keys) {
      try {
        const defObj = JSON.parse(defaults) as Record<string, unknown>;
        const keyMap = JSON.parse(keys) as Record<string, string>;
        defaultLabel = Object.entries(keyMap)
          .map(([prop, figName]) => `${figName}=${String(defObj[prop])}`)
          .join('|');
      } catch {
        /* best-effort */
      }
    }
    if (combos.size > 0) variants.set(norm(slug), { combos, ...(defaultLabel ? { defaultLabel } : {}) });
  }
  return {
    uiComps: new Set(uiSlugs.map(norm)),
    iconComps: new Set(iconSlugs.map(norm)),
    variants,
  };
}

/** Node con tràn khỏi khung component bao nhiêu thì tính là oversize. */
const OVERSIZE_SLACK_PX = 100;

/** Audit MỘT frame capture. Pure — unit-test được. */
export function auditCaptureDoc(screen: string, root: IrNode, ds: DsAuditData): {
  findings: FigmaAuditFinding[];
  markers: number;
} {
  const findings: FigmaAuditFinding[] = [];
  let markers = 0;
  // Một component bị dùng ở nhiều node trong cùng frame → chỉ báo một lần
  // per (rule, comp) cho đỡ nhiễu.
  const seen = new Set<string>();
  const push = (f: FigmaAuditFinding) => {
    const key = `${f.rule}|${f.comp ?? ''}|${f.screen}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  const walk = (node: IrNode, markerAncestor: { comp: string; rect?: IrNode['rect'] } | null) => {
    const raw = node.owningReactComponent ?? '';
    let currentMarker = markerAncestor;
    if (raw.startsWith('kg:fig')) {
      const marker = parseFigMarker(raw);
      if (marker) {
        markers += 1;
        currentMarker = { comp: marker.comp, rect: node.rect };
        const n = norm(marker.comp);
        if (!ds.uiComps.has(n) && !ds.iconComps.has(n)) {
          push({
            rule: 'unknown-component',
            level: 'error',
            screen,
            comp: marker.comp,
            detail: 'Marker trỏ component không tồn tại trong bộ DS đã import — plugin sẽ DROP node này khi dán.',
            fix: 'Kiểm tra tên component trong app (data-fig-comp) hoặc re-import DS cho khớp lib.',
          });
        } else if (!ds.uiComps.has(n) && ds.iconComps.has(n)) {
          push({
            rule: 'icon-file-component',
            level: 'warning',
            screen,
            comp: marker.comp,
            detail: 'Đây là ICON/ILLUSTRATION — bộ icon nằm ở file Figma Iconography, không phải file UI Lib. Nếu file đang mở khi dán không chứa page icon này, plugin unmatched → icon BIẾN MẤT.',
            fix: 'Copy page icon/illustration vào file UI Lib trước khi dán (hoặc dán trong file có đủ cả hai bộ).',
          });
        } else if (marker.variant && Object.keys(marker.variant).length > 0) {
          const spec = ds.variants.get(n);
          if (spec && !spec.combos.has(canonicalVariant(marker.variant))) {
            push({
              rule: 'variant-fallback',
              level: 'error',
              screen,
              comp: marker.comp,
              detail: `Variant capture được (${canonicalVariant(marker.variant)}) KHÔNG có trong bộ variant của component — Figma setProperties sẽ fail lặng lẽ và instance rơi về default${spec.defaultLabel ? ` (${spec.defaultLabel})` : ''} → Figma trông KHÁC preview.`,
              fix: 'Sửa app dùng đúng variant có thật (xem VARIANTS trong component / bảng props ở catalog.md) rồi capture lại.',
            });
          }
        }
        // Oversize check cho subtree của CHÍNH marker này.
        if (node.rect) {
          const r = node.rect;
          const scan = (child: IrNode) => {
            const c = child.rect;
            if (c) {
              const spillY = c.height - r.height;
              const spillX = c.width - r.width;
              if (spillY > OVERSIZE_SLACK_PX || spillX > OVERSIZE_SLACK_PX) {
                push({
                  rule: 'oversize-layer',
                  level: 'warning',
                  screen,
                  comp: marker.comp,
                  detail: `Một layer bên trong component tràn xa khỏi khung (${Math.round(c.width)}×${Math.round(c.height)} trong khung ${Math.round(r.width)}×${Math.round(r.height)}) — web preview bị lớp này đè (nền phủ/khối đen) trong khi Figma dựng instance gốc thì không.`,
                  fix: 'Gap fidelity của compile-core (layer Background absolute full-screen không được clip) — báo design-v3; tạm thời bọc component bằng wrapper overflow:hidden + chiều cao cố định trong app.',
                });
                return; // một phát hiện per component là đủ
              }
            }
            for (const gc of child.childNodes ?? []) scan(gc);
          };
          for (const child of node.childNodes ?? []) scan(child);
        }
      }
    }
    for (const child of node.childNodes ?? []) walk(child, currentMarker);
  };
  walk(root, null);
  return { findings, markers };
}

/** Chạy audit trên toàn bộ figma-screens của một react-ds dir. */
export async function runFigmaAudit(reactDsDir: string): Promise<FigmaAuditResult> {
  const screensDir = path.join(reactDsDir, 'figma-screens', 'screens');
  const files = (await fs.promises.readdir(screensDir).catch(() => [] as string[]))
    .filter((f) => f.endsWith('.capture.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(
      'chưa có figma-screens/screens/*.capture.json — bấm "Capture Figma" (hoặc `od pipeline figma-capture`) trước khi audit.',
    );
  }
  const ds = await readDsAuditData(reactDsDir);
  if (ds.uiComps.size === 0) {
    throw new Error('react-ds/src/ds chưa được stage — chạy stage "UI-Spec (React DS)" trước.');
  }
  const perScreen: FigmaAuditFinding[] = [];
  let markers = 0;
  for (const file of files) {
    const raw = await fs.promises.readFile(path.join(screensDir, file), 'utf8');
    let doc: { name?: string; doc?: { root?: IrNode } & IrNode };
    try {
      doc = JSON.parse(raw) as typeof doc;
    } catch {
      continue; // file hỏng không chặn cả audit
    }
    const root = (doc.doc?.root ?? doc.doc) as IrNode | undefined;
    if (!root) continue;
    const res = auditCaptureDoc(doc.name ?? file, root, ds);
    perScreen.push(...res.findings);
    markers += res.markers;
  }
  const findings = aggregateFindings(perScreen);
  const summary: Record<string, number> = {};
  for (const f of findings) summary[f.rule] = (summary[f.rule] ?? 0) + 1;
  const report = {
    kind: 'od-figma-audit',
    version: 1,
    generatedAt: new Date().toISOString(),
    screens: files.length,
    markers,
    summary,
    findings,
  };
  const auditJson = path.join('figma-screens', 'audit.json');
  await fs.promises.writeFile(
    path.join(reactDsDir, auditJson),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  return { screens: files.length, markers, findings, summary, auditJson };
}
