import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { collectComponentCatalog } from './docs-components.js';
import { collectCriteriaAnchors } from './docs-review.js';

/** <dsDir>/criteria */
export function dsCriteriaDir(dsDir: string): string {
  return path.join(dsDir, 'criteria');
}

export type DsCriteriaMeta = {
  generatedAt: string;
  components: number;
  rulesBytes: number | null;
  sourceCatalogSha: string | null;
};

export type DsCriteriaState = {
  hasComponents: boolean;
  hasRules: boolean;
  components: number;
  rules: number;
  meta: DsCriteriaMeta | null;
};

export async function readDsCriteriaState(dsDir: string): Promise<DsCriteriaState> {
  const dir = dsCriteriaDir(dsDir);
  const [componentsText, rulesText, metaText] = await Promise.all([
    readFile(path.join(dir, 'components.md'), 'utf8').catch(() => null),
    readFile(path.join(dir, 'rules.md'), 'utf8').catch(() => null),
    readFile(path.join(dir, '_meta.json'), 'utf8').catch(() => null),
  ]);
  let meta: DsCriteriaMeta | null = null;
  if (metaText) {
    try {
      const parsed = JSON.parse(metaText) as DsCriteriaMeta;
      if (typeof parsed.generatedAt === 'string' && typeof parsed.components === 'number') meta = parsed;
    } catch {
      // Malformed metadata should not make the status endpoint fail.
    }
  }
  return {
    hasComponents: componentsText !== null,
    hasRules: rulesText !== null,
    components: componentsText === null ? 0 : collectComponentCatalog(componentsText).size,
    rules: rulesText === null ? 0 : collectCriteriaAnchors([{ name: 'rules.md', text: rulesText }]).size,
    meta,
  };
}

export async function writeDsRulesFile(dsDir: string, text: string): Promise<string[]> {
  const dir = dsCriteriaDir(dsDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'rules.md'), text, 'utf8');
  const anchors = collectCriteriaAnchors([{ name: 'rules.md', text }]);
  return anchors.size === 0
    ? ['rules.md không có heading nào mang anchor dạng `R-XXX` — dr-review sẽ không trace được rule_id về file này.']
    : [];
}

export function validateComponentsMd(text: string): { ok: boolean; errors: string[]; components: number } {
  const catalog = collectComponentCatalog(text);
  const errors: string[] = [];
  if (catalog.size < 1) {
    errors.push('không parse được component nào (heading phải dạng `### `#slug` Tên`)');
  }

  const anchors = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!/^#{1,6} /.test(line)) continue;
    const tokens = [...line.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? '').trim().replace(/^#/, ''));
    if (tokens.length === 0) {
      if (line.startsWith('### ')) errors.push(`heading component thiếu anchor: ${JSON.stringify(line)}`);
      continue;
    }
    for (const token of tokens) {
      if (!token) continue;
      anchors.set(token, (anchors.get(token) ?? 0) + 1);
    }
  }
  for (const [anchor, count] of anchors) {
    if (count >= 2) errors.push(`anchor trùng: #${anchor}`);
  }
  return { ok: errors.length === 0, errors, components: catalog.size };
}

export function validateRulesMd(text: string): { ok: boolean; errors: string[]; rules: number } {
  const errors: string[] = [];
  const anchors = new Map<string, number>();
  let rules = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('### ')) continue;
    const tokens = [...line.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? '').trim());
    const anchor = tokens.find((token) => /^R-[A-Z0-9-]+$/.test(token));
    if (!anchor) {
      errors.push(`heading quy tắc thiếu anchor: ${JSON.stringify(line)}`);
      continue;
    }
    rules += 1;
    anchors.set(anchor, (anchors.get(anchor) ?? 0) + 1);
  }
  if (rules < 1) errors.push('không parse được quy tắc nào');
  for (const [anchor, count] of anchors) {
    if (count >= 2) errors.push(`anchor trùng: #${anchor}`);
  }
  return { ok: errors.length === 0, errors, rules };
}

export async function commitGeneratedRulesMd(
  dsDir: string,
): Promise<{ ok: boolean; errors: string[]; rules: number }> {
  const nextPath = path.join(dsCriteriaDir(dsDir), 'rules.md.next');
  let text: string;
  try {
    text = await readFile(nextPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        ok: false,
        errors: ['Agent kết thúc nhưng không sinh ra "criteria/rules.md.next" — không có gì để kiểm tra. Thử chạy lại (agent có thể đã báo xong mà quên ghi file).'],
        rules: 0,
      };
    }
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], rules: 0 };
  }
  const result = validateRulesMd(text);
  if (!result.ok) {
    await rm(nextPath, { force: true });
    return result;
  }
  try {
    await rename(nextPath, path.join(dsCriteriaDir(dsDir), 'rules.md'));
  } catch (error) {
    await rm(nextPath, { force: true }).catch(() => undefined);
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], rules: 0 };
  }
  return result;
}

export async function commitGeneratedComponentsMd(
  dsDir: string,
  opts: { now?: Date } = {},
): Promise<{ ok: boolean; errors: string[]; components: number }> {
  const dir = dsCriteriaDir(dsDir);
  const nextPath = path.join(dir, 'components.md.next');
  let text: string;
  try {
    text = await readFile(nextPath, 'utf8');
  } catch (error) {
    // ENOENT ở đây gần như luôn là: agent kết thúc "succeeded" nhưng KHÔNG
    // thực sự ghi `criteria/components.md.next` (model báo đã tạo file trong
    // câu trả lời mà không gọi tool ghi, hoặc ghi nhầm đường dẫn). Đường thô
    // "no such file or directory ... components.md.next" vô nghĩa với người
    // dùng — dịch thành thông báo nói đúng nguyên nhân và cách khắc phục.
    const isMissing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    if (isMissing) {
      return {
        ok: false,
        errors: [
          'Agent kết thúc nhưng không sinh ra "criteria/components.md.next" — ' +
            'không có gì để kiểm tra. Thử chạy lại (agent có thể đã báo xong mà quên ghi file), ' +
            'hoặc kiểm tra design system này có "react/docs/catalog.md" hợp lệ.',
        ],
        components: 0,
      };
    }
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], components: 0 };
  }
  const result = validateComponentsMd(text);
  if (!result.ok) {
    await rm(nextPath, { force: true });
    return result;
  }

  const rulesPath = path.join(dir, 'rules.md');
  const catalogPath = path.join(dsDir, 'react', 'docs', 'catalog.md');
  const [rulesBytes, catalogText] = await Promise.all([
    stat(rulesPath).then((value) => value.size).catch(() => null),
    readFile(catalogPath, 'utf8').catch(() => null),
  ]);
  const meta: DsCriteriaMeta = {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    components: result.components,
    rulesBytes,
    sourceCatalogSha: catalogText === null ? null : createHash('sha256').update(catalogText).digest('hex'),
  };
  try {
    await rename(nextPath, path.join(dir, 'components.md'));
    await writeFile(path.join(dir, '_meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  } catch (error) {
    await rm(nextPath, { force: true }).catch(() => undefined);
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], components: 0 };
  }
  return result;
}

/** Chép bộ tiêu chí review của một Design System vào `<wf>/criteria/`.
 *
 *  DS ở đây KHÔNG sinh UI — nó chỉ là NGUỒN FILE (cờ `usesDesignSystemCriteria`
 *  trong pipelines.ts, cố ý tách khỏi `acceptsDesignSystem`). Chép ở bước nạp
 *  tài liệu vì đó là bước duy nhất chạy TRƯỚC cả `dr-comp` lẫn `dr-review` —
 *  hai bên tiêu thụ `criteria/components.md` và `criteria/rules.md`; stage ux
 *  đọc thêm tài liệu tham chiếu `criteria/catalog.md` và `criteria/examples.md`.
 *
 *  Ghi đè có chủ ý: đã chọn DS thì DS là nguồn sự thật. Không chọn DS thì hàm
 *  này không được gọi, nên file người dùng tự upload (⋯ → Tải file lên) sống
 *  qua mọi lần chạy lại — `criteria/` không phải output của stage nào.
 *
 *  DS là nguồn sự thật TRỌN VẸN — kể cả phần "không có", ở CẢ hai mức:
 *   - thiếu MỘT trong hai file (DS chỉ có `rules.md`, không có
 *     `components.md`): file đích cùng tên bị GỠ.
 *   - không có thư mục `criteria/` NÀO CẢ (DS chưa generate gì, hoặc job sinh
 *     chưa từng chạy): CẢ HAI file đích bị gỡ — ca nặng hơn thiếu một file lẻ.
 *  Không gỡ thì đổi từ DS A (có tiêu chí) sang DS B (thiếu một phần hoặc toàn
 *  bộ) sẽ để lại dữ liệu CŨ của DS A nằm lẫn với DS B hiện tại —
 *  `dsCriteriaDirective` stat thấy file tồn tại nên báo agent đó là tiêu chí
 *  hợp lệ của DS hiện tại, một lỗi trộn dữ liệu hoàn toàn im lặng.
 *
 *  KHÔNG BAO GIỜ THROW. DS chưa có `components.md` là chuyện bình thường (job
 *  sinh có thể đang chạy hoặc đã hỏng), và bước nạp tài liệu không có lý do gì
 *  phải fail vì thiếu một input TUỲ CHỌN: skill của cả `dr-comp` lẫn
 *  `dr-review` đều có nhánh "thiếu danh mục → mọi verdict là ok".
 *
 *  NGUỒN DS LÀ CẤP APP, không phải picker theo từng lần chạy. Caller tra qua
 *  `criteriaDesignSystemForProject()`: `project.metadata.studioConfig.appId` →
 *  `pipeline_apps.design_system_id`. Một App dùng MỘT bộ design system, nên hai
 *  feature cùng App không thể review theo hai danh mục khác nhau. Chỗ chọn cũ
 *  (`RunAllConfig.criteriaDesignSystemId` + picker DS trên panel run-all) đã bị
 *  gỡ ở commit 23b09c0 — đừng khôi phục nó; cờ `usesDesignSystemCriteria` còn
 *  lại chỉ có nghĩa "stage NÀY tiêu thụ criteria của DS", không còn liên quan
 *  tới việc DS được chọn ở đâu.
 *
 *  @param designSystemId id chỉ dùng để gắn vào log — thư mục DS thật sự do
 *    `resolveDsDir` quyết định (tham số hoá thay vì gọi `dsDirForId` trực
 *    tiếp, vì hàm đó sống trong server.ts và dùng
 *    `USER_DESIGN_SYSTEMS_DIR`/`DESIGN_SYSTEMS_DIR` riêng của daemon runtime —
 *    truyền `dsDirForId` ở call site thật, truyền stub ở test).
 *  @param cwd workflow (hoặc run) cwd nhận `criteria/`.
 *  @param resolveDsDir tra `designSystemId` → thư mục DS trên đĩa, hoặc `null`
 *    nếu không có. */
export async function copyDsCriteriaIntoWorkflow(
  designSystemId: string,
  cwd: string,
  resolveDsDir: (designSystemId: string) => Promise<string | null>,
): Promise<void> {
  try {
    const dsDir = await resolveDsDir(designSystemId);
    const srcDir = dsDir ? dsCriteriaDir(dsDir) : null;
    const dstDir = path.join(cwd, 'criteria');
    if (!srcDir || !(await stat(srcDir).then((s) => s.isDirectory()).catch(() => false))) {
      // DS hiện tại không có thư mục criteria/ nào cả: gỡ CẢ BỐN file đích
      // nếu đang có (sống sót từ một DS khác đã gắn trước đó) — xem
      // doc-comment phía trên.
      const removedStale: string[] = [];
      for (const name of ['components.md', 'rules.md', 'catalog.md', 'examples.md']) {
        const dst = path.join(dstDir, name);
        const hadStale = await stat(dst).then((s) => s.isFile()).catch(() => false);
        await rm(dst, { force: true });
        if (hadStale) removedStale.push(name);
      }
      console.warn(
        `[dr-criteria] DS "${designSystemId}" chưa có thư mục criteria/ — bỏ qua, workflow chạy với bộ tiêu chí mặc định của skill`,
      );
      if (removedStale.length > 0) {
        console.warn(
          `[dr-criteria] DS "${designSystemId}" không có thư mục criteria/ — đã gỡ ${removedStale.join(', ')} còn sót lại trong criteria/ (từ một DS trước đó) để tránh lẫn tiêu chí giữa hai DS`,
        );
      }
      return;
    }
    await mkdir(dstDir, { recursive: true });
    const copied: string[] = [];
    const removedStale: string[] = [];
    const sourceFiles: Array<{ name: string; src: string }> = [
      { name: 'components.md', src: path.join(srcDir, 'components.md') },
      { name: 'rules.md', src: path.join(srcDir, 'rules.md') },
    ];
    type DsManifest = { react?: { catalog?: unknown; examplesIndex?: unknown } };
    let manifest: DsManifest | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(dsDir ?? '', 'manifest.json'), 'utf8'));
      if (parsed && typeof parsed === 'object') manifest = parsed as DsManifest;
    } catch {
      // Manifest missing or malformed: use the stable React bundle paths.
    }
    const react = manifest?.react;
    const normalizedDsDir = path.resolve(dsDir ?? '');
    const resolveManifestPath = (name: string, value: unknown, fallback: string): string => {
      if (typeof value !== 'string' || path.isAbsolute(value)) {
        if (typeof value === 'string' && path.isAbsolute(value)) {
          console.warn(`[dr-criteria] manifest khai đường dẫn ${name} ngoài phạm vi DS — bỏ qua`);
        }
        return path.join(normalizedDsDir, fallback);
      }
      const resolved = path.resolve(normalizedDsDir, value);
      if (resolved !== normalizedDsDir && !resolved.startsWith(`${normalizedDsDir}${path.sep}`)) {
        console.warn(`[dr-criteria] manifest khai đường dẫn ${name} ngoài phạm vi DS — bỏ qua`);
        return path.join(normalizedDsDir, fallback);
      }
      return resolved;
    };
    sourceFiles.push(
      { name: 'catalog.md', src: resolveManifestPath('react.catalog', react?.catalog, 'react/docs/catalog.md') },
      {
        name: 'examples.md',
        src: resolveManifestPath('react.examplesIndex', react?.examplesIndex, 'react/docs/examples.md'),
      },
    );
    for (const { name, src } of sourceFiles) {
      const dst = path.join(dstDir, name);
      if (!(await stat(src).then((s) => s.isFile()).catch(() => false))) {
        // Nguồn không có: gỡ đích nếu đang có bản cũ (từ một DS khác đã gắn
        // trước đó), để "không có" của DS hiện tại không bị lẫn với dữ liệu
        // của DS trước — xem doc-comment phía trên. `force: true` để không
        // throw khi đích cũng không có (trường hợp thường gặp nhất).
        const hadStale = await stat(dst).then((s) => s.isFile()).catch(() => false);
        await rm(dst, { force: true });
        if (hadStale) removedStale.push(name);
        continue;
      }
      await copyFile(src, dst);
      copied.push(name);
    }
    console.log(
      copied.length > 0
        ? `[dr-criteria] chép từ DS "${designSystemId}": ${copied.join(', ')} → criteria/`
        : `[dr-criteria] DS "${designSystemId}" có criteria/ nhưng không có file tiêu chí hoặc tài liệu tham chiếu nào — không chép gì`,
    );
    if (removedStale.length > 0) {
      console.warn(
        `[dr-criteria] DS "${designSystemId}" không có ${removedStale.join(', ')} — đã gỡ bản cũ tương ứng trong criteria/ (còn sót lại từ một DS trước đó) để tránh lẫn tiêu chí giữa hai DS`,
      );
    }
  } catch (error) {
    console.warn('[dr-criteria] chép bộ tiêu chí từ DS thất bại (bỏ qua):', error);
  }
}
