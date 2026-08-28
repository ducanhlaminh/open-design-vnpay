// Lớp 2 của kiến trúc 3 lớp trích màn hình (dr-comp v2, WP12, quyết định
// 19/08):
//   lớp 1 = quét tất định `scanDocScreens` (screen-components.ts, WP11 —
//           đang sửa file đó SONG SONG với module này) — chỉ đuổi kịp khuôn
//           heading ĐÃ THẤY (MH/SCR/mã mục nhiều cấp);
//   lớp 2 = MODULE NÀY — agent đọc hiểu tài liệu tự do (mọi cách trình bày:
//           bảng, heading, chữ đậm…) khi lớp 1 báo hiệu có màn hình nhưng
//           không quét ra mã nào;
//   lớp 3 = manifest cho người dùng sửa tay (WP13a/b, không thuộc phạm vi
//           module này).
// Vì lớp 2 để agent tự đọc hiểu — không có cấu trúc cố định để đối chiếu như
// lớp 1 — nên KHÔNG được tin lời agent khai tay không: chống ảo giác bằng
// đúng triết lý `validateChanges` của dr-review — mọi màn agent khai phải
// kèm `anchorText` là MỘT DÒNG NGUYÊN VĂN, DUY NHẤT trong trang; daemon đối
// chiếu tất định (validateDocScreenExtract), khớp mới nhận, không khớp thì
// rơi CÓ LÝ DO (reason cụ thể) thay vì âm thầm nuốt — bài học sự cố
// #5d13309f: dr-comp từng loại sạch màn không cảnh báo, gate cứng "chưa gắn
// màn nào" giết cả stage dù agent/tài liệu đã khai đúng.
//
// WP14 đã nối module này vào lượt chạy dr-comp thật (server.ts: kích hoạt
// EXTRACT khi lớp 1 yếu, dời gate 0-màn xuống sau merge lớp 2 + lớp 3, hợp
// origin 'agent' vào union chính thức của ScreenInput) — xem khối docs-comp
// trong server.ts. Ở đây vẫn CHỈ có 3 hàm thuần + hằng số file — không DB,
// không agent, không I/O ngoài tham số truyền vào.

import path from 'node:path';

import type { ScreenPlatformScope } from '@open-design/contracts';

import {
  scanDocScreens,
  isBlockedScreenName,
  findAnchorTextLines,
  codeOfScreenKey,
  resolveInputPlatform,
  screenPlatformToInput,
  type ScreenInput,
} from './screen-components.js';

export const DOC_SCREENS_FILE = 'comp/_doc-screens.json';

// ── needsAgentScreenExtract ─────────────────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const SCREEN_SIGNAL_RE = /danh sách\s+(các\s+)?màn hình|mô tả\s+(các\s+)?màn hình|screen list/i;

/** Heading NGOÀI code fence, theo thứ tự xuất hiện — bản sao cục bộ của logic
 *  quét fence dùng trong screen-components.ts (findScreenSection/
 *  scanDocScreens). Không import hàm quét heading từ đó (không có hàm nào
 *  export riêng phần này) — module này chỉ được phép GỌI `scanDocScreens`,
 *  không phụ thuộc thêm gì khác vào file đang bị WP11 sửa song song. */
function headingsOutsideFence(md: string): string[] {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of lines) {
    const f = /^\s*(```+|~~~+)/.exec(raw);
    if (f) {
      if (fence == null) fence = f[1]!;
      else if (raw.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const m = HEADING_RE.exec(raw);
    if (m) out.push(m[2]!.trim());
  }
  return out;
}

/** Trang có "tín hiệu màn hình" — ít nhất một heading (ngoài code fence) khai
 *  "danh sách/mô tả màn hình" — NHƯNG lớp 1 tất định (`scanDocScreens`, WP11)
 *  không nhận ra màn nào. Đây đúng lúc lớp 2 (agent) cần vào cuộc: tài liệu
 *  CÓ khai màn, chỉ là không theo khuôn heading mà lớp 1 biết đọc. */
export function needsAgentScreenExtract(md: string): boolean {
  const hasSignal = headingsOutsideFence(md).some((h) => SCREEN_SIGNAL_RE.test(h));
  if (!hasSignal) return false;
  return scanDocScreens(md).length === 0;
}

// ── validateDocScreenExtract ────────────────────────────────────────────────

export interface ExtractAccepted {
  source: string;
  code: string;
  name: string;
  line: number;
  /** WP screen-flow-platform-split A0: SCREEN-KEY có thẩm quyền (entry khai
   *  `key`) — mergeExtractedScreens dùng NGUYÊN VĂN thay vì `<stem>__<code>`. */
  key?: string;
  /** Nền tảng AGENT quyết (screens.json v2) — pass-through, daemon không suy. */
  platform?: 'app' | 'web';
  groupKey?: string;
  /** HINT cho lượt SCREEN (kickoff dặn agent đọc lân cận) — không cần khớp
   *  cấu trúc heading hoàn hảo. */
  section?: { startLine: number; endLine: number };
}
export interface ExtractRejected {
  source?: string | undefined;
  code?: string | null | undefined;
  name?: string | undefined;
  anchorText?: string | undefined;
  reason: string;
}
export interface ValidateDocScreenExtractResult {
  accepted: ExtractAccepted[];
  rejected: ExtractRejected[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Parse + kiểm `comp/_doc-screens.json` mà agent (lượt EXTRACT) ghi ra, đối
 *  chiếu tất định với nội dung trang thật (`mdBySource`) — không tin bất kỳ
 *  khai báo nào của agent tay không (xem docblock đầu file). Không throw:
 *  shape hỏng hoàn toàn → accepted rỗng + một rejected có reason. */
export function validateDocScreenExtract(mdBySource: Map<string, string>, doc: unknown): ValidateDocScreenExtractResult {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { accepted: [], rejected: [{ reason: `${DOC_SCREENS_FILE} không phải một object.` }] };
  }
  const o = doc as Record<string, unknown>;
  if (o.schema_version !== 1) {
    return { accepted: [], rejected: [{ reason: `"schema_version" phải là 1 (nhận ${JSON.stringify(o.schema_version)}).` }] };
  }
  if (!Array.isArray(o.pages)) {
    return { accepted: [], rejected: [{ reason: '"pages" phải là một mảng.' }] };
  }

  const accepted: ExtractAccepted[] = [];
  const rejected: ExtractRejected[] = [];

  for (const rawPage of o.pages) {
    if (!rawPage || typeof rawPage !== 'object') {
      rejected.push({ reason: 'Một mục "pages" không phải object.' });
      continue;
    }
    const p = rawPage as Record<string, unknown>;
    const source = str(p.source);
    const rawScreens = Array.isArray(p.screens) ? p.screens : [];
    const md = source ? mdBySource.get(source) : undefined;

    // (i) source phải có trong mdBySource.
    if (!source || md == null) {
      for (const rs of rawScreens) {
        const e = (rs && typeof rs === 'object' ? rs : {}) as Record<string, unknown>;
        rejected.push({
          source: source || undefined,
          code: e.code == null ? null : str(e.code) || undefined,
          name: str(e.name) || undefined,
          anchorText: str(e.anchorText) || undefined,
          reason: `source "${source}" không có trong danh sách trang của lượt chạy (mdBySource).`,
        });
      }
      continue;
    }

    const pageLineCount = md.split(/\r?\n/).length;

    // Vòng 1 — kiểm (ii) anchor duy nhất + (iii) name hợp lệ, GIỮ THỨ TỰ JSON
    // gốc (để vòng 3 biết "cái sau" theo đúng thứ tự agent liệt kê).
    type Candidate = {
      code: string | null;
      name: string;
      anchorText: string;
      line: number;
      key?: string;
      platform?: 'app' | 'web';
      groupKey?: string;
    };
    const candidates: (Candidate | null)[] = rawScreens.map((rs) => {
      if (!rs || typeof rs !== 'object') {
        rejected.push({ source, reason: 'Một mục "screens" không phải object.' });
        return null;
      }
      const e = rs as Record<string, unknown>;
      const anchorTextRaw = str(e.anchorText);
      const name = str(e.name).trim();
      const codeRaw = e.code;
      const code: string | null | undefined =
        codeRaw == null ? null : typeof codeRaw === 'string' ? codeRaw.trim() || null : undefined;
      if (code === undefined) {
        rejected.push({ source, name: name || undefined, anchorText: anchorTextRaw || undefined, reason: '"code" phải là chuỗi hoặc null.' });
        return null;
      }
      const anchorText = anchorTextRaw.trim();
      if (!anchorText) {
        rejected.push({ source, code, name: name || undefined, reason: '"anchorText" rỗng.' });
        return null;
      }
      // WP14: `findAnchorTextLines` là nguồn đối chiếu tất định DUY NHẤT,
      // dùng chung với screen-overrides.ts (lớp 3) — xem docblock của nó ở
      // screen-components.ts.
      const hits = findAnchorTextLines(md, anchorText);
      if (hits.length === 0) {
        rejected.push({ source, code, name: name || undefined, anchorText: anchorTextRaw, reason: `không tìm thấy anchorText "${anchorText}" trong trang (ngoài code fence).` });
        return null;
      }
      if (hits.length > 1) {
        rejected.push({ source, code, name: name || undefined, anchorText: anchorTextRaw, reason: `anchorText "${anchorText}" xuất hiện ${hits.length} lần — không duy nhất.` });
        return null;
      }
      if (!name) {
        rejected.push({ source, code, anchorText: anchorTextRaw, reason: '"name" rỗng.' });
        return null;
      }
      if (isBlockedScreenName(name)) {
        rejected.push({ source, code, name, anchorText: anchorTextRaw, reason: `name "${name}" là mục tài liệu (danh sách/mô tả/luồng màn hình), không phải một màn.` });
        return null;
      }
      // WP screen-flow-platform-split A0: `key` (từ screens.json đã finalize)
      // là thẩm quyền — code lấy từ key, KHÔNG tự đánh lại. `platform`/
      // `groupKey` pass-through (agent quyết, daemon chỉ kiểm giá trị).
      const key = str(e.key).trim() || undefined;
      const platform = e.platform === 'app' || e.platform === 'web' ? e.platform : undefined;
      const groupKey = str(e.groupKey).trim() || undefined;
      return {
        code,
        name,
        anchorText: anchorTextRaw,
        line: hits[0]!,
        ...(key ? { key } : {}),
        ...(platform ? { platform } : {}),
        ...(groupKey ? { groupKey } : {}),
      };
    });

    // Vòng 2 — (iv) code null → tự đánh X1, X2… theo thứ tự DÒNG anchor
    // TRONG TRANG (ổn định giữa các lần chạy — không phụ thuộc thứ tự agent
    // liệt kê trong JSON). CHỈ cho entry KHÔNG có `key` — entry có key giữ
    // đúng code của key (A0: trước đây đánh lại làm comp/_screens.json lệch
    // hẳn screens.json khi thứ tự agent ≠ thứ tự dòng hoặc có màn bị loại).
    const passing = candidates.filter((c): c is Candidate => c != null);
    const nullOrderedByLine = passing.filter((c) => c.code == null && !c.key).sort((a, b) => a.line - b.line);
    const autoCode = new Map<Candidate, string>();
    nullOrderedByLine.forEach((c, i) => autoCode.set(c, `X${i + 1}`));

    // Vòng 3 — (iv) mã trùng trong cùng trang → cái sau (thứ tự JSON gốc,
    // đúng như vòng 1 giữ) rejected.
    const usedCodes = new Set<string>();
    const acceptedBefore = accepted.length;
    for (const c of passing) {
      const finalCode = c.key ? codeOfScreenKey(c.key) : (c.code ?? autoCode.get(c)!);
      if (usedCodes.has(finalCode)) {
        rejected.push({ source, code: finalCode, name: c.name, anchorText: c.anchorText, reason: `mã "${finalCode}" trùng với một màn khác đã nhận trong cùng trang.` });
        continue;
      }
      usedCodes.add(finalCode);
      accepted.push({
        source,
        code: finalCode,
        name: c.name,
        line: c.line,
        ...(c.key ? { key: c.key } : {}),
        ...(c.platform ? { platform: c.platform } : {}),
        ...(c.groupKey ? { groupKey: c.groupKey } : {}),
      });
    }

    // Section — theo thứ tự DÒNG của các màn ACCEPTED (đã loại mã trùng):
    // anchor → anchor-hợp-lệ kế tiếp trừ 1; màn cuối chạy tới hết trang.
    const acceptedThisPage = accepted.slice(acceptedBefore);
    const bySortedLine = [...acceptedThisPage].sort((a, b) => a.line - b.line);
    bySortedLine.forEach((a, i) => {
      const nextLine = i + 1 < bySortedLine.length ? bySortedLine[i + 1]!.line : null;
      a.section = { startLine: a.line, endLine: nextLine != null ? nextLine - 1 : pageLineCount };
    });
  }

  return { accepted, rejected };
}

// ── mergeExtractedScreens ────────────────────────────────────────────────────

export interface MergeExtractedScreensResult {
  screens: ScreenInput[];
  added: string[];
}

/** WP14: `ExtractAccepted.section` chỉ có `{startLine, endLine}` (HINT thô —
 *  xem docblock của nó), còn `ScreenInput.section` (screen-components.ts) đòi
 *  đủ `{heading, startLine, endLine, excerpt}`. Trước WP14, `mergeExtractedScreens`
 *  ép kiểu `as unknown as ScreenInput` che mất chỗ thiếu 2 field này — gỡ cast
 *  (D.1, hợp nhất union `origin`) làm lộ ra, vá đúng tại đây: dựng `heading`/
 *  `excerpt` từ chính `md`, cùng luật cắt 900 ký tự với `sectionFromAnchor`
 *  (screen-overrides.ts) để hai lớp 2/3 nhất quán khi hiển thị section HINT. */
function buildAgentSection(md: string, startLine: number, endLine: number): NonNullable<ScreenInput['section']> {
  const lines = md.split(/\r?\n/);
  const heading = lines[startLine - 1] ?? '';
  const excerptSrc = lines.slice(startLine - 1, endLine).join('\n').trim();
  return {
    heading,
    startLine,
    endLine,
    excerpt: excerptSrc.length > 900 ? `${excerptSrc.slice(0, 900)}…` : excerptSrc,
  };
}

/** Gộp màn agent trích được ở lớp 2 (đã qua `validateDocScreenExtract`) vào
 *  danh sách màn hiện có (lớp 1: flow + doc, WP9/9b/9c/WP11). Màn có sẵn LUÔN
 *  thắng khi trùng khoá — lớp 2 chỉ bổ khuyết những gì lớp 1 bỏ sót, không
 *  bao giờ ghi đè. `order` nối tiếp liên tục để giữ đúng thứ tự rail hiện có
 *  cộng thêm màn mới ở cuối. */
export function mergeExtractedScreens(
  screens: ScreenInput[],
  accepted: ExtractAccepted[],
  mdBySource: Map<string, string>,
  /** WP docs-review-screen-platform: phạm vi người dùng chọn — xem
   *  `resolveInputPlatform` (Cả hai + màn thiếu `platform` → throw). */
  opts?: { screenPlatform?: ScreenPlatformScope | undefined },
): MergeExtractedScreensResult {
  const existingKeys = new Set(screens.map((s) => s.key));
  const out = [...screens];
  const added: string[] = [];
  let nextOrder = screens.reduce((max, s) => Math.max(max, s.order), -1) + 1;

  for (const a of accepted) {
    const stem = path.posix.basename(a.source, '.md');
    // WP screen-flow-platform-split A0: key có thẩm quyền từ screens.json thắng.
    const key = a.key ?? `${stem}__${a.code}`;
    if (existingKeys.has(key)) continue; // màn có sẵn thắng — không nhân đôi.
    existingKeys.add(key);
    const md = mdBySource.get(a.source) ?? '';
    // WP14: 'agent' nay là thành viên chính thức của ScreenInput['origin']
    // (screen-components.ts) — không còn cần cast cục bộ như WP12.
    // WP docs-review-screen-platform: nền tảng = phạm vi người dùng chọn hoặc
    // `platform` agent ghi (screens.json) khi phạm vi Cả hai — KHÔNG suy từ
    // heading/từ khoá tài liệu.
    const platformFields = resolveInputPlatform(opts?.screenPlatform, a.platform ? screenPlatformToInput(a.platform) : null, key);
    const input: ScreenInput = {
      key,
      name: a.name,
      order: nextOrder++,
      flowId: '',
      flowTitle: '',
      source: a.source,
      steps: [],
      navOut: [],
      navIn: [],
      findings: [],
      ...platformFields,
      ...(a.groupKey ? { groupKey: a.groupKey } : {}),
      origin: 'agent',
      ...(a.section ? { section: buildAgentSection(md, a.section.startLine, a.section.endLine) } : {}),
    };
    out.push(input);
    added.push(key);
  }

  return { screens: out, added };
}
