// Frozen Figma component catalogue: the snapshot shape figma-rest.ts produces
// from Figma's REST API and the renderer that turns it into the closed
// `criteria/components.md` format the docs-review Screen → Component stage
// already consumes for imported design systems.

import { createHash } from 'node:crypto';

export const FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION = '1.0' as const;

export interface FigmaCatalogProperty {
  name: string;
  type: string;
  values: string[];
}

export interface FigmaCatalogComponent {
  nodeId: string;
  name: string;
  description?: string;
  page?: string;
  properties: FigmaCatalogProperty[];
}

export interface FigmaCatalogFile {
  fileKey: string;
  name: string;
  url: string;
  components: FigmaCatalogComponent[];
}

export interface FigmaComponentCatalogSnapshot {
  schemaVersion: typeof FIGMA_COMPONENT_CATALOG_SCHEMA_VERSION;
  generatedAt: string;
  files: FigmaCatalogFile[];
}

// Exported (WP19a): figma-component-guide.ts / server.ts (khối docs-comp
// freeze) cần tính lại đúng tập anchor còn hợp lệ trong một snapshot Figma để
// lọc `components-guide.md` — không được chép lại thuật toán hash ở nơi khác.
export function anchorFor(fileKey: string, nodeId: string): string {
  const digest = createHash('sha256').update(`${fileKey}\0${nodeId}`).digest('hex').slice(0, 10);
  return `figma-${digest}`;
}

/** Render the frozen snapshot into the existing closed-catalog format. */
export function renderFigmaComponentsMarkdown(snapshot: FigmaComponentCatalogSnapshot): string {
  const occurrences = new Map<string, number>();
  const occurrencesPerFile = new Map<string, number>();
  for (const file of snapshot.files) {
    for (const component of file.components) {
      occurrences.set(component.name.toLocaleLowerCase(), (occurrences.get(component.name.toLocaleLowerCase()) ?? 0) + 1);
      const key = `${file.fileKey}\0${component.name.toLocaleLowerCase()}`;
      occurrencesPerFile.set(key, (occurrencesPerFile.get(key) ?? 0) + 1);
    }
  }
  const lines = [
    '# Danh mục component từ Figma',
    '',
    `> Đã đọc ${snapshot.files.length} file Figma lúc ${snapshot.generatedAt}. Danh mục này được đóng băng trước khi rà soát tài liệu.`,
    '',
  ];
  for (const file of snapshot.files) {
    lines.push(`## ${file.name}`, '', `Nguồn: ${file.url}`, '');
    for (const component of file.components) {
      const duplicate = (occurrences.get(component.name.toLocaleLowerCase()) ?? 0) > 1;
      const duplicateInFile = (occurrencesPerFile.get(`${file.fileKey}\0${component.name.toLocaleLowerCase()}`) ?? 0) > 1;
      const displayName = duplicateInFile
        ? `${component.name} — ${file.name} (${component.nodeId})`
        : duplicate ? `${component.name} — ${file.name}` : component.name;
      lines.push(`### \`#${anchorFor(file.fileKey, component.nodeId)}\` ${displayName}`, '');
      lines.push(`- Figma node: \`${component.nodeId}\``);
      if (component.page) lines.push(`- Trang: ${component.page}`);
      if (component.description) lines.push(`- Mô tả: ${component.description.replace(/\s+/g, ' ')}`);
      if (component.properties.length > 0) {
        lines.push('', '| Thuộc tính | Kiểu | Giá trị |', '|---|---|---|');
        for (const property of component.properties) {
          lines.push(`| ${property.name.replaceAll('|', '\\|')} | ${property.type.replaceAll('|', '\\|')} | ${property.values.join(', ').replaceAll('|', '\\|') || '—'} |`);
        }
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').trim()}\n`;
}
