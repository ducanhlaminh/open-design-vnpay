// WP-ds-tokens: token de-facto đào từ node tree của component Figma.
//
// Bối cảnh (xem `.tmp/pipeline/wp-ds-tokens.yaml`): nguồn Figma dùng chung có
// thể KHÔNG publish styles/variables (styles=0, variables=403 Enterprise-
// gated) — con đường "chính thức" để lấy token bị tắc với mọi plan không
// Enterprise. Module này đào token TẤT ĐỊNH thẳng từ node tree của chính các
// component đã có trong catalog (fills/strokes/typography/cornerRadius/
// effects/auto-layout spacing), thống kê tần suất dùng — không gọi AI, không
// đoán, không phụ thuộc quyền truy cập nào ngoài REST đọc node đã sẵn có.
//
// Module THUẦN: không import fs/network. Caller (figma-design-system-
// routes.ts) chịu trách nhiệm gọi `fetchNodeSubtrees`, gom kết quả thành input
// của {@link mineDesignTokens}, rồi tự ghi hai file `renderTokensMd`/
// `renderTokensDtcg` sinh ra.

import { createHash } from 'node:crypto';

/** Một node Figma tối thiểu — chỉ khai đúng field module này đọc, không phải
 *  toàn bộ shape thật (REST trả về nhiều hơn nhiều). `unknown` ở biên ngoài
 *  (input của {@link mineDesignTokens}) được thu hẹp dần bằng các hàm đọc an
 *  toàn bên dưới, không ép kiểu liều lĩnh. */
interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

interface FigmaPaint {
  type?: string;
  visible?: boolean;
  opacity?: number;
  color?: FigmaColor;
  gradientStops?: Array<{ color?: FigmaColor }>;
}

interface FigmaEffect {
  type?: string;
  visible?: boolean;
  color?: FigmaColor;
  offset?: { x?: number; y?: number };
  radius?: number;
  spread?: number;
}

interface FigmaTextStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  lineHeightPercent?: number;
  lineHeightUnit?: string;
}

interface FigmaNode {
  type?: string;
  visible?: boolean;
  fills?: unknown;
  strokes?: unknown;
  effects?: unknown;
  cornerRadius?: number;
  rectangleCornerRadii?: unknown;
  layoutMode?: string;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  style?: FigmaTextStyle;
  children?: unknown;
}

/** Một component (node gốc + tên hiển thị) để đào token — `name` neo mọi
 *  token tìm thấy TRONG SUBTREE về đúng component chứa nó, kể cả token nằm ở
 *  node con lồng sâu (ví dụ chữ bên trong một Button). `node` là `document`
 *  Figma trả về từ `fetchNodeSubtrees` (figma-rest.ts) cho `nodeId` đó. */
export interface MineTokensInput {
  name: string;
  node: unknown;
}

export interface TokenColorEntry {
  hex: string;
  count: number;
  examples: string[];
}

export interface TokenGradientEntry {
  stops: string[];
  count: number;
  examples: string[];
}

export interface TokenTypographyEntry {
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: string;
  count: number;
  examples: string[];
}

export interface TokenRadiusEntry {
  value: number;
  count: number;
  examples: string[];
}

export interface TokenShadowEntry {
  kind: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: string;
  offsetX: number;
  offsetY: number;
  radius: number;
  spread: number;
  count: number;
  examples: string[];
}

export interface TokenSpacingEntry {
  value: number;
  count: number;
  examples: string[];
}

export interface TokenProfile {
  colors: TokenColorEntry[];
  gradients: TokenGradientEntry[];
  typography: TokenTypographyEntry[];
  radii: TokenRadiusEntry[];
  shadows: TokenShadowEntry[];
  spacing: TokenSpacingEntry[];
}

export interface TokensMdMeta {
  generatedAt: string;
  componentCount: number;
}

const MAX_EXAMPLES = 3;
const MAX_ROWS = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// Làm tròn 2 chữ số thập phân — Figma hay trả về số dạng 11.999998 do làm
// tròn nội bộ; token de-facto cần khoá ổn định nên chuẩn hoá trước khi dùng
// làm key nhóm/tên slug.
function roundNum(value: number): number {
  return Math.round(value * 100) / 100;
}

function toHex2(channel: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(channel)));
  return clamped.toString(16).padStart(2, '0').toUpperCase();
}

/** rgba (kênh 0..1 của Figma) → hex 6 ký tự, hoặc hex 8 ký tự (kèm alpha) khi
 *  độ mờ hiệu dụng (color.a × paint.opacity) nhỏ hơn 1. */
function colorToHex(color: FigmaColor, opacity?: number): string {
  const alpha = (color.a ?? 1) * (opacity ?? 1);
  const hex = `#${toHex2(color.r * 255)}${toHex2(color.g * 255)}${toHex2(color.b * 255)}`;
  if (alpha < 1) return `${hex}${toHex2(Math.max(0, alpha) * 255)}`;
  return hex;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';
}

interface Bucket<T> {
  count: number;
  examples: string[];
  value: T;
}

function bump<T>(buckets: Map<string, Bucket<T>>, key: string, value: T, componentName: string): void {
  const existing = buckets.get(key);
  if (existing) {
    existing.count += 1;
    if (!existing.examples.includes(componentName) && existing.examples.length < MAX_EXAMPLES) {
      existing.examples.push(componentName);
    }
    return;
  }
  buckets.set(key, { count: 1, examples: [componentName], value });
}

// Sắp xếp tất định: tần suất giảm dần, hoà thì theo `tieBreak` tăng dần (chuỗi
// so sánh ổn định) — cần cho bất biến "gọi 2 lần cùng input → deep-equal".
function sortedEntries<T>(buckets: Map<string, Bucket<T>>, tieBreak: (value: T) => string): Array<{ count: number; examples: string[]; value: T }> {
  return [...buckets.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return tieBreak(a.value) < tieBreak(b.value) ? -1 : tieBreak(a.value) > tieBreak(b.value) ? 1 : 0;
  });
}

/** Duyệt đệ quy toàn bộ subtree của mỗi component, thu tần suất
 *  colors/typography/radii/shadows/spacing. Tất định: cùng input luôn ra
 *  cùng `TokenProfile` (thứ tự mảng đã sort ổn định), không gọi mạng/AI. */
export function mineDesignTokens(components: readonly MineTokensInput[]): TokenProfile {
  const colorBuckets = new Map<string, Bucket<string>>();
  const gradientBuckets = new Map<string, Bucket<string[]>>();
  const typographyBuckets = new Map<string, Bucket<{ fontFamily: string; fontWeight: number; fontSize: number; lineHeight: string }>>();
  const radiusBuckets = new Map<string, Bucket<number>>();
  const shadowBuckets = new Map<string, Bucket<TokenShadowEntry>>();
  const spacingBuckets = new Map<string, Bucket<number>>();

  function readPaints(node: FigmaNode, key: 'fills' | 'strokes', componentName: string): void {
    for (const raw of asArray(node[key])) {
      if (!isRecord(raw)) continue;
      const paint = raw as FigmaPaint;
      if (paint.visible === false) continue;
      if (paint.type === 'SOLID' && isRecord(paint.color)) {
        const hex = colorToHex(paint.color as FigmaColor, paint.opacity);
        bump(colorBuckets, hex, hex, componentName);
        continue;
      }
      if (typeof paint.type === 'string' && paint.type.startsWith('GRADIENT_') && Array.isArray(paint.gradientStops)) {
        const stops = paint.gradientStops
          .filter((stop): stop is { color: FigmaColor } => isRecord(stop) && isRecord(stop.color))
          .map((stop) => colorToHex(stop.color, paint.opacity));
        if (stops.length === 0) continue;
        const key2 = stops.join('>');
        bump(gradientBuckets, key2, stops, componentName);
      }
    }
  }

  function readTypography(node: FigmaNode, componentName: string): void {
    if (node.type !== 'TEXT' || !isRecord(node.style)) return;
    const style = node.style;
    const fontFamily = typeof style.fontFamily === 'string' ? style.fontFamily : undefined;
    const fontWeight = num(style.fontWeight);
    const fontSize = num(style.fontSize);
    if (!fontFamily || fontWeight === undefined || fontSize === undefined) return;
    let lineHeight = 'auto';
    if (style.lineHeightUnit === 'PIXELS' && num(style.lineHeightPx) !== undefined) {
      lineHeight = `${roundNum(num(style.lineHeightPx)!)}px`;
    } else if (num(style.lineHeightPercent) !== undefined) {
      lineHeight = `${roundNum(num(style.lineHeightPercent)!)}%`;
    }
    const key = `${fontFamily}\0${fontWeight}\0${fontSize}\0${lineHeight}`;
    bump(typographyBuckets, key, { fontFamily, fontWeight, fontSize, lineHeight }, componentName);
  }

  function readRadii(node: FigmaNode, componentName: string): void {
    const single = num(node.cornerRadius);
    if (single !== undefined && single !== 0) {
      const value = roundNum(single);
      bump(radiusBuckets, String(value), value, componentName);
    }
    if (Array.isArray(node.rectangleCornerRadii)) {
      for (const raw of node.rectangleCornerRadii) {
        const value = num(raw);
        if (value === undefined || value === 0) continue;
        const rounded = roundNum(value);
        bump(radiusBuckets, String(rounded), rounded, componentName);
      }
    }
  }

  function readShadows(node: FigmaNode, componentName: string): void {
    for (const raw of asArray(node.effects)) {
      if (!isRecord(raw)) continue;
      const effect = raw as FigmaEffect;
      if (effect.visible === false) continue;
      if (effect.type !== 'DROP_SHADOW' && effect.type !== 'INNER_SHADOW') continue;
      const color = isRecord(effect.color) ? colorToHex(effect.color as FigmaColor) : '#000000';
      const offsetX = roundNum(num(effect.offset && (effect.offset as { x?: number }).x) ?? 0);
      const offsetY = roundNum(num(effect.offset && (effect.offset as { y?: number }).y) ?? 0);
      const radius = roundNum(num(effect.radius) ?? 0);
      const spread = roundNum(num(effect.spread) ?? 0);
      const kind = effect.type;
      const key = `${kind}\0${color}\0${offsetX}\0${offsetY}\0${radius}\0${spread}`;
      bump(shadowBuckets, key, { kind, color, offsetX, offsetY, radius, spread, count: 0, examples: [] }, componentName);
    }
  }

  function readSpacing(node: FigmaNode, componentName: string): void {
    if (node.layoutMode !== 'HORIZONTAL' && node.layoutMode !== 'VERTICAL') return;
    const values = [node.itemSpacing, node.paddingLeft, node.paddingRight, node.paddingTop, node.paddingBottom];
    for (const raw of values) {
      const value = num(raw);
      if (value === undefined || value === 0) continue;
      const rounded = roundNum(value);
      bump(spacingBuckets, String(rounded), rounded, componentName);
    }
  }

  function walk(raw: unknown, componentName: string): void {
    if (!isRecord(raw)) return;
    const node = raw as FigmaNode;
    if (node.visible === false) return;
    readPaints(node, 'fills', componentName);
    readPaints(node, 'strokes', componentName);
    readTypography(node, componentName);
    readRadii(node, componentName);
    readShadows(node, componentName);
    readSpacing(node, componentName);
    for (const child of asArray(node.children)) walk(child, componentName);
  }

  for (const component of components) walk(component.node, component.name);

  return {
    colors: sortedEntries(colorBuckets, (hex) => hex).map((e) => ({ hex: e.value, count: e.count, examples: e.examples })),
    gradients: sortedEntries(gradientBuckets, (stops) => stops.join('>')).map((e) => ({ stops: e.value, count: e.count, examples: e.examples })),
    typography: sortedEntries(typographyBuckets, (v) => `${v.fontFamily}\0${v.fontWeight}\0${v.fontSize}\0${v.lineHeight}`)
      .map((e) => ({ ...e.value, count: e.count, examples: e.examples })),
    radii: sortedEntries(radiusBuckets, (v) => String(v)).map((e) => ({ value: e.value, count: e.count, examples: e.examples })),
    shadows: sortedEntries(shadowBuckets, (v) => `${v.kind}\0${v.color}\0${v.offsetX}\0${v.offsetY}\0${v.radius}\0${v.spread}`)
      .map((e) => ({ ...e.value, count: e.count, examples: e.examples })),
    spacing: sortedEntries(spacingBuckets, (v) => String(v)).map((e) => ({ value: e.value, count: e.count, examples: e.examples })),
  };
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const lines: string[] = [];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  const capped = rows.slice(0, MAX_ROWS);
  for (const row of capped) lines.push(`| ${row.join(' | ')} |`);
  if (rows.length > MAX_ROWS) {
    lines.push('');
    lines.push(`… và ${rows.length - MAX_ROWS} giá trị ít dùng khác.`);
  }
  return lines;
}

function exampleCell(examples: string[]): string {
  return examples.length > 0 ? examples.join(', ') : '—';
}

/** Render tiếng Việt cho người/agent đọc — mở đầu nói rõ đây là token
 *  de-facto (không phải style/variable Figma publish chính thức), mỗi nhóm
 *  một bảng xếp theo tần suất giảm dần, giới hạn {@link MAX_ROWS} dòng đầu. */
export function renderTokensMd(profile: TokenProfile, meta: TokensMdMeta): string {
  const lines: string[] = [];
  lines.push('# Token de-facto (nguồn Figma)');
  lines.push('');
  lines.push(
    '> Bộ token này được **đào tự động (de-facto)** từ node tree của các component ' +
      'Figma — nguồn này không publish styles/variables chính thức (hoặc không truy ' +
      'cập được), nên đây là giá trị THỰC TẾ đang dùng trong component, không phải ' +
      'bộ token do team design công bố. Mỗi bảng xếp theo tần suất dùng giảm dần. ' +
      'File này tự sinh lại sau mỗi lần Làm mới — không chỉnh tay, mọi sửa tay sẽ mất.',
  );
  lines.push('');
  lines.push(`Sinh lúc: \`${meta.generatedAt}\` · đào từ \`${meta.componentCount}\` component.`);
  lines.push('');

  lines.push('## Màu sắc (colors)');
  lines.push('');
  if (profile.colors.length > 0) {
    lines.push(...renderTable(
      ['Giá trị', 'Số lần dùng', 'Ví dụ component'],
      profile.colors.map((c) => [`\`${c.hex}\``, String(c.count), exampleCell(c.examples)]),
    ));
  } else {
    lines.push('_Không tìm thấy màu SOLID nào trong node tree._');
  }
  lines.push('');

  if (profile.gradients.length > 0) {
    lines.push('## Gradient');
    lines.push('');
    lines.push(...renderTable(
      ['Điểm dừng (stops)', 'Số lần dùng', 'Ví dụ component'],
      profile.gradients.map((g) => [g.stops.map((s) => `\`${s}\``).join(' → '), String(g.count), exampleCell(g.examples)]),
    ));
    lines.push('');
  }

  lines.push('## Chữ (typography)');
  lines.push('');
  if (profile.typography.length > 0) {
    lines.push(...renderTable(
      ['Font · Weight · Size · Line-height', 'Số lần dùng', 'Ví dụ component'],
      profile.typography.map((t) => [`${t.fontFamily} · ${t.fontWeight} · ${t.fontSize}px · ${t.lineHeight}`, String(t.count), exampleCell(t.examples)]),
    ));
  } else {
    lines.push('_Không tìm thấy node TEXT nào có style đầy đủ._');
  }
  lines.push('');

  lines.push('## Bo góc (radius)');
  lines.push('');
  if (profile.radii.length > 0) {
    lines.push(...renderTable(
      ['Giá trị (px)', 'Số lần dùng', 'Ví dụ component'],
      profile.radii.map((r) => [String(r.value), String(r.count), exampleCell(r.examples)]),
    ));
  } else {
    lines.push('_Không tìm thấy bo góc nào khác 0._');
  }
  lines.push('');

  lines.push('## Đổ bóng (shadow)');
  lines.push('');
  if (profile.shadows.length > 0) {
    lines.push(...renderTable(
      ['Mô tả', 'Số lần dùng', 'Ví dụ component'],
      profile.shadows.map((s) => [
        `\`${s.kind}\` ${s.color} · offset ${s.offsetX}/${s.offsetY} · blur ${s.radius} · spread ${s.spread}`,
        String(s.count),
        exampleCell(s.examples),
      ]),
    ));
  } else {
    lines.push('_Không tìm thấy hiệu ứng đổ bóng nào đang hiển thị._');
  }
  lines.push('');

  lines.push('## Khoảng cách (spacing)');
  lines.push('');
  if (profile.spacing.length > 0) {
    lines.push(...renderTable(
      ['Giá trị (px)', 'Số lần dùng', 'Ví dụ component'],
      profile.spacing.map((s) => [String(s.value), String(s.count), exampleCell(s.examples)]),
    ));
  } else {
    lines.push('_Không tìm thấy khoảng cách auto-layout nào khác 0._');
  }
  lines.push('');

  return lines.join('\n');
}

interface DtcgToken {
  $type: string;
  $value: unknown;
  $extensions: { 'od.frequency': number };
}

/** DTCG (W3C Design Tokens Community Group, draft) render — tên mỗi token
 *  ổn định THEO GIÁ TRỊ (không theo thứ tự tần suất) để diff được giữa các
 *  lần refresh: đổi tần suất không đổi tên, chỉ đổi $extensions.od.frequency.
 *
 *  Quyết định phạm vi: gradient KHÔNG có $type chuẩn trong DTCG draft (chỉ
 *  color/dimension/typography/shadow/... là type gọn dùng $value đơn), nên
 *  gradient chỉ xuất hiện ở tokens.md (bảng riêng), không ở đây — tránh bịa
 *  một $type không thuộc chuẩn draft. */
export function renderTokensDtcg(profile: TokenProfile): Record<string, Record<string, DtcgToken>> {
  const color: Record<string, DtcgToken> = {};
  for (const c of profile.colors) {
    color[`c-${c.hex.replace('#', '').toLowerCase()}`] = {
      $type: 'color',
      $value: c.hex,
      $extensions: { 'od.frequency': c.count },
    };
  }

  const typography: Record<string, DtcgToken> = {};
  for (const t of profile.typography) {
    const name = `t-${slugify(t.fontFamily)}-${t.fontWeight}-${t.fontSize}`;
    typography[name] = {
      $type: 'typography',
      $value: {
        fontFamily: t.fontFamily,
        fontWeight: t.fontWeight,
        fontSize: `${t.fontSize}px`,
        lineHeight: t.lineHeight,
      },
      $extensions: { 'od.frequency': t.count },
    };
  }

  const radius: Record<string, DtcgToken> = {};
  for (const r of profile.radii) {
    radius[`r-${r.value}`] = {
      $type: 'dimension',
      $value: `${r.value}px`,
      $extensions: { 'od.frequency': r.count },
    };
  }

  const shadow: Record<string, DtcgToken> = {};
  for (const s of profile.shadows) {
    const name = `sh-${shortHash(`${s.kind}\0${s.color}\0${s.offsetX}\0${s.offsetY}\0${s.radius}\0${s.spread}`)}`;
    shadow[name] = {
      $type: 'shadow',
      $value: {
        color: s.color,
        offsetX: `${s.offsetX}px`,
        offsetY: `${s.offsetY}px`,
        blur: `${s.radius}px`,
        spread: `${s.spread}px`,
        inset: s.kind === 'INNER_SHADOW',
      },
      $extensions: { 'od.frequency': s.count },
    };
  }

  const spacing: Record<string, DtcgToken> = {};
  for (const s of profile.spacing) {
    spacing[`sp-${s.value}`] = {
      $type: 'dimension',
      $value: `${s.value}px`,
      $extensions: { 'od.frequency': s.count },
    };
  }

  return { color, typography, radius, shadow, spacing };
}
