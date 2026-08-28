/**
 * Sổ nguồn attachment Confluence — `attachments/_sources.json`.
 *
 * Ghi bởi `fetchConfluencePages` NGAY TRONG thư mục attachments, nên đi kèm
 * mọi bản sao của thư mục đó (pool App, review clone, context snapshot…).
 * Mỗi item ánh xạ một file cục bộ (bytes THÔ tải từ wiki, sha256 tính trên
 * bytes thực ghi xuống đĩa) về attachment gốc + version trên Confluence, để
 * project-sync có thể BỎ QUA upload và máy pull tải lại từ wiki đúng phiên
 * bản đã review.
 *
 * Thuần: không phụ thuộc bas-client (bas-client import ngược lại).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ConfluenceSourceItem {
  /** Tên file cục bộ TRONG CÙNG thư mục attachments (khoá duy nhất). */
  name: string;
  /** hex, không prefix. */
  sha256: string;
  size: number;
  /** Trang SỞ HỮU attachment (từ URL /download/attachments/<pageId>/…). */
  pageId: string;
  /** Space của trang đang nhúng; '' nếu không biết. */
  spaceKey: string;
  /** Tên attachment trên Confluence (đã decodeURIComponent). */
  attachment: string;
  /** 0 nếu không xác định được. */
  attachmentVersion: number;
  fetchedAt: number;
}

export interface ConfluenceSourcesLedger {
  version: 1;
  base: string;
  items: ConfluenceSourceItem[];
}

export const CONFLUENCE_SOURCES_FILE = '_sources.json';

function isItem(v: unknown): v is ConfluenceSourceItem {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    o.name.length > 0 &&
    typeof o.sha256 === 'string' &&
    typeof o.size === 'number' &&
    typeof o.pageId === 'string' &&
    typeof o.attachment === 'string'
  );
}

/** Đọc ledger trong `dir`. Không có file / parse lỗi / shape sai → null. */
export async function readConfluenceSourcesLedger(dir: string): Promise<ConfluenceSourcesLedger | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, CONFLUENCE_SOURCES_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ConfluenceSourcesLedger> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.items)) return null;
    return {
      version: 1,
      base: typeof parsed.base === 'string' ? parsed.base : '',
      items: parsed.items.filter(isItem).map((it) => ({
        name: it.name,
        sha256: it.sha256,
        size: it.size,
        pageId: it.pageId,
        spaceKey: typeof it.spaceKey === 'string' ? it.spaceKey : '',
        attachment: it.attachment,
        attachmentVersion: typeof it.attachmentVersion === 'number' && it.attachmentVersion > 0 ? it.attachmentVersion : 0,
        fetchedAt: typeof it.fetchedAt === 'number' ? it.fetchedAt : 0,
      })),
    };
  } catch {
    return null;
  }
}

/** Gộp `items` vào `prev` — thay theo `name` (item mới thắng), sort theo name. */
export function mergeConfluenceSourcesLedger(
  prev: ConfluenceSourcesLedger | null,
  base: string,
  items: ConfluenceSourceItem[],
): ConfluenceSourcesLedger {
  const byName = new Map<string, ConfluenceSourceItem>();
  for (const it of prev?.items ?? []) byName.set(it.name, it);
  for (const it of items) byName.set(it.name, it);
  return {
    version: 1,
    base: base.replace(/\/+$/, ''),
    items: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/** Bỏ item mà file `<dir>/<name>` không còn tồn tại. */
export async function pruneConfluenceSourcesLedger(
  ledger: ConfluenceSourcesLedger,
  dir: string,
): Promise<ConfluenceSourcesLedger> {
  const kept: ConfluenceSourceItem[] = [];
  for (const it of ledger.items) {
    const st = await fs.stat(path.join(dir, it.name)).catch(() => null);
    if (st?.isFile()) kept.push(it);
  }
  return { ...ledger, items: kept };
}

/** Ghi atomically (tmp + rename), JSON 2-space + '\n'. */
export async function writeConfluenceSourcesLedger(dir: string, ledger: ConfluenceSourcesLedger): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, CONFLUENCE_SOURCES_FILE);
  const tmp = path.join(dir, `.${CONFLUENCE_SOURCES_FILE}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** URL tải attachment: pin version khi `pin` và `attachmentVersion > 0`. */
export function confluenceAttachmentDownloadUrl(
  base: string,
  item: Pick<ConfluenceSourceItem, 'pageId' | 'attachment' | 'attachmentVersion'>,
  pin: boolean,
): string {
  const b = base.replace(/\/+$/, '');
  const pinQ = pin && item.attachmentVersion > 0 ? `&version=${item.attachmentVersion}` : '';
  return `${b}/download/attachments/${item.pageId}/${encodeURIComponent(item.attachment)}?api=v2${pinQ}`;
}

export interface ParsedConfluenceDownloadUrl {
  /** Số; '' cho dạng `embedded-page` (chưa biết trang sở hữu). */
  pageId: string;
  attachment: string;
  /** 0 nếu thiếu. */
  version: number;
  /** Chỉ dạng `embedded-page/<space>/<title>/<name>`. */
  spaceKey?: string;
  pageTitle?: string;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Khớp hai dạng URL attachment (tuyệt đối hoặc root-relative):
 *   - `/download/(attachments|thumbnails)/<pageId>/<name>[?version=N…]`
 *   - `/download/attachments/embedded-page/<space>/<title>/<name>` — dạng
 *     `body.export_view` dùng cho ảnh dán (KHÔNG pageId, KHÔNG version) →
 *     `pageId: ''`, kèm `spaceKey` + `pageTitle` để caller tra ngược.
 * `name`/`title` decodeURIComponent; version từ query, 0 nếu thiếu/không số.
 */
export function parseConfluenceDownloadUrl(url: string): ParsedConfluenceDownloadUrl | null {
  let pathname: string;
  let search: string;
  try {
    const u = new URL(url, 'https://placeholder.invalid');
    pathname = u.pathname;
    search = u.search;
  } catch {
    return null;
  }
  const vRaw = new URLSearchParams(search).get('version');
  const version = vRaw && /^\d+$/.test(vRaw) ? Number(vRaw) : 0;
  const emb = /\/download\/attachments\/embedded-page\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/?$/.exec(pathname);
  if (emb) {
    const attachment = safeDecode(emb[3]!);
    if (!attachment) return null;
    return { pageId: '', attachment, version, spaceKey: safeDecode(emb[1]!), pageTitle: safeDecode(emb[2]!) };
  }
  const m = /\/download\/(?:attachments|thumbnails)\/(\d+)\/([^/?#]+)\/?$/.exec(pathname);
  if (!m) return null;
  const attachment = safeDecode(m[2]!);
  if (!attachment) return null;
  return { pageId: m[1]!, attachment, version };
}
