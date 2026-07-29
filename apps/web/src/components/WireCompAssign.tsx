// WireCompAssign — panel "Gán component" của preview ux-spec: chốt component
// design-system cho từng leaf wireframe (ghi vào prop chung `comp` của DSL v2
// rồi PUT ngược vào wireframes/<id>.wire.json). Bước ui-react-ds sau đó BẮT
// BUỘC dùng đúng component đã chốt (verify.mjs check `locked-comp`).
//
// Nguồn candidates: GET /api/design-systems/:id/wireframe-map — bản JSON của
// bảng "Wireframe mapping" sinh lúc import DS Figma. DS của target lấy từ
// targets.json (designSystemByTarget) qua GET /api/pipelines; project single-
// build hoặc target chưa gán DS thì panel nói rõ thay vì đoán.
import { useEffect, useMemo, useState } from 'react';
import { UI_TARGETS, UI_TARGET_IDS, type PipelinesResponse, type UiTarget } from '@open-design/contracts';
import type { DesignSystemSummary } from '@open-design/contracts';
import { fetchDesignSystems } from '../providers/registry';
import { CompPickerModal } from './CompPickerModal';
import type { WireDoc, WireLeaf, WireNode } from './WireFrameView';

interface WireframeMapDoc {
  slugs: Array<{ slug: string; candidates?: string[]; none?: string }>;
  specials: { templates: string[]; charts: string[]; other: string[] };
  components: string[];
}

const isContainer = (n: WireNode): n is Extract<WireNode, { children: WireNode[] }> =>
  Array.isArray((n as { children?: unknown }).children);

type LeafRef = { leaf: WireLeaf; path: number[] };

function collectLeaves(node: WireNode | undefined, path: number[] = [], out: LeafRef[] = []): LeafRef[] {
  if (!node) return out;
  if (isContainer(node)) {
    node.children.forEach((child, i) => collectLeaves(child, [...path, i], out));
    return out;
  }
  out.push({ leaf: node as WireLeaf, path });
  return out;
}

function leafSlug(leaf: WireLeaf): string {
  return String(leaf.c ?? leaf.componentType ?? leaf.type ?? '');
}

function leafComp(leaf: WireLeaf): string {
  const fromProps = (leaf.props as Record<string, unknown> | undefined)?.comp;
  if (typeof fromProps === 'string') return fromProps;
  const flat = (leaf as unknown as Record<string, unknown>).comp;
  return typeof flat === 'string' ? flat : '';
}

/** Immutable set/clear of `props.comp` at a tree path. */
function withComp(node: WireNode, path: number[], comp: string | null): WireNode {
  if (path.length === 0) {
    const leaf = { ...(node as WireLeaf) };
    const props = { ...(leaf.props ?? {}) } as Record<string, unknown>;
    if (comp) props.comp = comp;
    else delete props.comp;
    delete (leaf as Record<string, unknown>).comp;
    return { ...leaf, props } as WireNode;
  }
  const container = node as Extract<WireNode, { children: WireNode[] }>;
  const [head, ...rest] = path;
  return {
    ...container,
    children: container.children.map((child, i) => (i === head ? withComp(child, rest, comp) : child)),
  } as WireNode;
}

const S = {
  border: 'var(--border, #e1e5eb)',
  ink: 'var(--text, #1a1a1a)',
  soft: 'var(--text-soft, #4b5563)',
  accent: 'var(--accent, #0066b3)',
  paper: 'var(--bg, #faf9f7)',
  subtle: 'var(--bg-subtle, #eef1f5)',
} as const;

export function WireCompAssign({
  projectId,
  wirePath,
  doc,
}: {
  projectId: string;
  /** Project-relative path of this screen's wire.json (save target). */
  wirePath: string;
  doc: WireDoc;
}) {
  const [open, setOpen] = useState(false);
  const [map, setMap] = useState<WireframeMapDoc | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Target chưa gán DS: cho gán NGAY TẠI ĐÂY (ghi vào targets.json) — run-all
  // là chỗ duy nhất ghi designSystemByTarget lúc đầu, re-run UX Spec lẻ không
  // có picker DS nào khác.
  const [needsDsTarget, setNeedsDsTarget] = useState<UiTarget | null>(null);
  // DS đã resolve (từ targets.json hoặc vừa gán) — nguồn cho preview showcase.
  const [dsId, setDsId] = useState<string | null>(null);
  // Node đang mở modal chọn component (trái: danh sách, phải: preview thật).
  const [pickerFor, setPickerFor] = useState<{
    path: number[];
    slug: string;
    label?: string;
    candidates: string[];
    suggestion?: string;
    current: string;
  } | null>(null);
  const [dsOptions, setDsOptions] = useState<DesignSystemSummary[] | null>(null);
  const [pickedDs, setPickedDs] = useState('');
  const [assigningDs, setAssigningDs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Bản làm việc của cây — giữ lựa chọn đã lưu kể cả khi parent chưa refetch.
  const [tree, setTree] = useState<WireNode | undefined>(doc.layout);
  useEffect(() => setTree(doc.layout), [doc]);

  const leaves = useMemo(() => collectLeaves(tree), [tree]);
  const bySlug = useMemo(() => {
    const m = new Map<string, { candidates: string[]; none?: string }>();
    for (const entry of map?.slugs ?? []) {
      m.set(entry.slug.toLowerCase(), { candidates: entry.candidates ?? [], none: entry.none });
    }
    return m;
  }, [map]);

  useEffect(() => {
    if (!open || map || notice) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/pipelines?projectId=${encodeURIComponent(projectId)}`);
        const data = (await res.json()) as PipelinesResponse;
        const seg = wirePath.split('/')[1] ?? '';
        const target = UI_TARGET_IDS.find((t) => UI_TARGETS[t].dir === seg) as UiTarget | undefined;
        const dsId = target ? data.designSystemByTarget?.[target] : undefined;
        if (!dsId) {
          if (cancelled) return;
          if (!target) {
            setNotice('Dự án chưa chia target hoặc wireframe không nằm trong cây target — gán component cần DS per target.');
            return;
          }
          // Chưa gán DS cho target → mở picker tại chỗ (chỉ DS có bộ React).
          setNeedsDsTarget(target);
          const all = await fetchDesignSystems().catch(() => [] as DesignSystemSummary[]);
          if (!cancelled) {
            const targetPlatform = UI_TARGETS[target].platform;
            setDsOptions(
              all.filter(
                (s) =>
                  s.hasReactBundle &&
                  (targetPlatform === 'mobile' ? s.platform !== 'web' : s.platform !== 'mobile'),
              ),
            );
          }
          return;
        }
        const mapRes = await fetch(`/api/design-systems/${encodeURIComponent(dsId)}/wireframe-map`);
        if (!mapRes.ok) {
          const j = (await mapRes.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) setNotice(j.error ?? 'Không đọc được wireframe-map của design system.');
          return;
        }
        const mapDoc = (await mapRes.json()) as WireframeMapDoc;
        if (!cancelled) {
          setDsId(dsId);
          setMap(mapDoc);
        }
      } catch (err) {
        if (!cancelled) setNotice(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, map, notice, projectId, wirePath]);

  const assignDs = async () => {
    if (!needsDsTarget || !pickedDs || assigningDs) return;
    setAssigningDs(true);
    try {
      const res = await fetch('/api/pipelines/target-design-system', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, target: needsDsTarget, designSystemId: pickedDs }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `assign failed: ${res.status}`);
      }
      const mapRes = await fetch(`/api/design-systems/${encodeURIComponent(pickedDs)}/wireframe-map`);
      if (!mapRes.ok) {
        setNotice('Đã gán DS cho target, nhưng DS này chưa có wireframe-map — re-import DS từ zip Figma rồi mở lại panel.');
      } else {
        setDsId(pickedDs);
        setMap((await mapRes.json()) as WireframeMapDoc);
      }
      setNeedsDsTarget(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setAssigningDs(false);
    }
  };

  const setLeafComp = (path: number[], comp: string | null) => {
    setTree((cur) => (cur ? withComp(cur, path, comp) : cur));
    setSavedAt(null);
  };

  const save = async () => {
    if (!tree || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/wireframe`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: wirePath, tree: { ...doc, layout: tree } }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `save failed: ${res.status}`);
      }
      setSavedAt(Date.now());
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const assigned = leaves.filter(({ leaf }) => leafComp(leaf)).length;

  return (
    <div style={{ border: `1px solid ${S.border}`, borderRadius: 10, background: S.paper, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 12px',
          border: 0,
          background: 'transparent',
          color: S.ink,
          fontSize: 12.5,
          fontWeight: 700,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>Gán component DS cho wireframe</span>
        <span style={{ fontWeight: 500, color: S.soft }}>
          {assigned}/{leaves.length} node đã chốt
        </span>
      </button>
      {open ? (
        <div style={{ borderTop: `1px solid ${S.border}`, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {notice ? (
            <p style={{ margin: 0, fontSize: 12.5, color: S.soft, lineHeight: 1.5 }}>{notice}</p>
          ) : needsDsTarget ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ margin: 0, fontSize: 12.5, color: S.ink, lineHeight: 1.5 }}>
                Target <strong>{UI_TARGETS[needsDsTarget].label}</strong> chưa gán design system —
                chọn tại đây (ghi vào <code>targets.json</code>, các lần chạy stage sau dùng đúng DS này):
              </p>
              {dsOptions === null ? (
                <p style={{ margin: 0, fontSize: 12.5, color: S.soft }}>Đang tải danh sách DS…</p>
              ) : dsOptions.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12.5, color: S.soft }}>
                  Chưa có design system nào có bộ React hợp với target này — import zip Figma ở trang /design-systems trước.
                </p>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <select
                    value={pickedDs}
                    onChange={(e) => setPickedDs(e.target.value)}
                    style={{ flex: 1, minWidth: 0, fontSize: 12.5, padding: '4px 8px', borderRadius: 6, border: `1px solid ${S.border}`, background: S.paper, color: S.ink }}
                  >
                    <option value="">— chọn design system (bộ React từ Figma) —</option>
                    {dsOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                        {s.platform ? ` · ${s.platform === 'mobile' ? 'Mobile' : 'Web'}` : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void assignDs()}
                    disabled={!pickedDs || assigningDs}
                    style={{ padding: '5px 14px', borderRadius: 7, border: 0, background: S.accent, color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: assigningDs ? 'wait' : 'pointer', opacity: pickedDs ? 1 : 0.6 }}
                  >
                    {assigningDs ? 'Đang gán…' : 'Gán DS cho target'}
                  </button>
                </div>
              )}
            </div>
          ) : !map ? (
            <p style={{ margin: 0, fontSize: 12.5, color: S.soft }}>Đang tải wireframe-map…</p>
          ) : (
            <>
              {leaves.map(({ leaf, path }) => {
                const slug = leafSlug(leaf);
                const entry = bySlug.get(slug.toLowerCase());
                const current = leafComp(leaf);
                const suggestion = entry?.candidates?.[0];
                return (
                  <div key={path.join('.')} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span
                      style={{
                        flex: '0 0 44%',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: S.ink,
                      }}
                      title={`${slug}${leaf.label ? ` — ${leaf.label}` : ''}`}
                    >
                      <code style={{ color: S.accent }}>{slug || '(?)'}</code>
                      {leaf.label ? <span style={{ color: S.soft }}> · {leaf.label}</span> : null}
                    </span>
                    {/* Mở modal chọn: trái danh sách tên, phải preview render thật. */}
                    <button
                      type="button"
                      onClick={() =>
                        setPickerFor({
                          path,
                          slug,
                          label: leaf.label,
                          candidates: entry?.candidates ?? [],
                          suggestion,
                          current,
                        })
                      }
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        padding: '4px 8px',
                        borderRadius: 6,
                        border: `1px solid ${current ? S.accent : S.border}`,
                        background: S.paper,
                        color: current ? S.ink : S.soft,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {current ? (
                          <code style={{ color: S.ink, fontWeight: 700 }}>{current}</code>
                        ) : entry?.none ? (
                          `(không gán — ${entry.none})`
                        ) : suggestion ? (
                          `(chưa chốt — gợi ý: ${suggestion})`
                        ) : (
                          '(chưa chốt — bước UI tự chọn theo catalog)'
                        )}
                      </span>
                      <span aria-hidden="true" style={{ flex: 'none', color: S.soft }}>▾</span>
                    </button>
                  </div>
                );
              })}
              {pickerFor && dsId && map ? (
                <CompPickerModal
                  systemId={dsId}
                  slug={pickerFor.slug}
                  label={pickerFor.label}
                  candidates={pickerFor.candidates}
                  components={map.components ?? []}
                  current={pickerFor.current}
                  suggestion={pickerFor.suggestion}
                  onPick={(comp) => setLeafComp(pickerFor.path, comp)}
                  onClose={() => setPickerFor(null)}
                />
              ) : null}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  style={{
                    padding: '5px 14px',
                    borderRadius: 7,
                    border: 0,
                    background: S.accent,
                    color: '#fff',
                    fontSize: 12.5,
                    fontWeight: 700,
                    cursor: saving ? 'wait' : 'pointer',
                  }}
                >
                  {saving ? 'Đang lưu…' : 'Lưu lựa chọn vào wire.json'}
                </button>
                {savedAt ? (
                  <span style={{ fontSize: 12, color: S.soft }}>Đã lưu ✓ — bước UI-Spec (React DS) sẽ dùng đúng các component đã chốt.</span>
                ) : (
                  <span style={{ fontSize: 12, color: S.soft }}>Node bỏ trống dùng gợi ý của bảng map; re-run UX Spec sẽ sinh wireframe mới (lựa chọn cũ nằm trong lịch sử).</span>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
