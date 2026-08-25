import { useEffect, useMemo, useState } from 'react';

import { fetchProjectFileText } from '../providers/registry';
import { DrawioViewer } from './DrawioViewer';
import styles from './ScreenFlowPreview.module.css';

export interface ScreenFlowIndexEntryView {
  id: string;
  title: string;
  sourceMode: 'reused' | 'generated';
  sourcePath: string | null;
  files: { model: string; drawio: string };
  unlinkedCount: number;
  warnings: string[];
}

export interface ScreenFlowIndexView {
  flows: ScreenFlowIndexEntryView[];
  warnings: string[];
}

export interface ScreenFlowModelView {
  flowId: string;
  screens: { key: string; cellIds: string[] }[];
  unlinkedScreens: string[];
  warnings: string[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const textList = (value: unknown): string[] => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);

function sourcePathOf(value: unknown): string | null {
  if (typeof value === 'string') return text(value) || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  return text(source.asIs) || text(source.path) || text(source.file) || text(source.diagram) || null;
}

export function parseScreenFlowIndex(raw: string | null): ScreenFlowIndexView | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.flows)) return null;
    const flows: ScreenFlowIndexEntryView[] = [];
    for (const value of parsed.flows) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const flow = value as Record<string, unknown>;
      const id = text(flow.id);
      const files = flow.files && typeof flow.files === 'object' && !Array.isArray(flow.files) ? (flow.files as Record<string, unknown>) : null;
      const model = text(files?.model) || text(files?.screenFlow) || text(flow.modelFile);
      const drawio = text(files?.drawio) || text(flow.drawioFile);
      if (!id || !model || !drawio) continue;
      flows.push({
        id,
        title: text(flow.title) || id,
        sourceMode: text(flow.sourceMode) === 'reused' ? 'reused' : 'generated',
        sourcePath: sourcePathOf(flow.source),
        files: { model, drawio },
        unlinkedCount: typeof flow.unlinkedCount === 'number' && flow.unlinkedCount >= 0 ? flow.unlinkedCount : 0,
        warnings: textList(flow.warnings),
      });
    }
    return { flows, warnings: textList(parsed.warnings) };
  } catch {
    return null;
  }
}

export function parseScreenFlowModel(raw: string | null): ScreenFlowModelView | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.screens)) return null;
    const seen = new Set<string>();
    const screens: ScreenFlowModelView['screens'] = [];
    for (const value of parsed.screens) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const screen = value as Record<string, unknown>;
      const key = text(screen.key);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const cellIds = [...textList(screen.cellIds), text(screen.cellId), text(screen.drawioCellId)].filter(Boolean);
      screens.push({ key, cellIds: [...new Set(cellIds)] });
    }
    return {
      flowId: text(parsed.id) || text(parsed.flowId),
      screens,
      unlinkedScreens: textList(parsed.unlinkedScreens),
      warnings: textList(parsed.warnings),
    };
  } catch {
    return null;
  }
}

/** Đọc metadata ổn định do daemon ghi; tuyệt đối không suy screen key từ label. */
export function screenCellMapFromXml(xml: string): Map<string, string> {
  const result = new Map<string, string>();
  if (typeof DOMParser === 'undefined' || !xml) return result;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return result;
  for (const node of doc.querySelectorAll('[od-screen-key]')) {
    const key = text(node.getAttribute('od-screen-key'));
    const ownId = text(node.getAttribute('id'));
    const childId = text(node.querySelector('mxCell')?.getAttribute('id'));
    const id = ownId || childId;
    if (key && id && !result.has(id)) result.set(id, key);
  }
  return result;
}

function artifactPath(root: string, path: string): string {
  const clean = path.replace(/^\.\//, '');
  if (clean.startsWith(root)) return clean;
  if (clean.startsWith('comp/')) return `${root}${clean}`;
  if (clean.startsWith('screen-flows/')) return `${root}comp/${clean}`;
  return `${root}comp/screen-flows/${clean}`;
}

interface LoadedFlow {
  entry: ScreenFlowIndexEntryView;
  model: ScreenFlowModelView;
}

export interface ScreenFlowPreviewProps {
  projectId: string;
  root: string;
  currentScreenKey: string | null;
  onOpenScreen: (key: string) => void;
  requestedFlowId?: string;
  fileMtime?: number;
}

export function ScreenFlowPreview({ projectId, root, currentScreenKey, onOpenScreen, requestedFlowId, fileMtime }: ScreenFlowPreviewProps) {
  const [status, setStatus] = useState<'loading' | 'empty' | 'error' | 'ready'>('loading');
  const [flows, setFlows] = useState<LoadedFlow[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [drawioXml, setDrawioXml] = useState<string | null>(null);
  const [drawioError, setDrawioError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setFlows([]);
    setSelectedId('');
    setDrawioXml(null);
    setDrawioError(false);
    void (async () => {
      const raw = await fetchProjectFileText(projectId, `${root}comp/screen-flows/index.json`);
      if (cancelled) return;
      if (raw == null) {
        setStatus('empty');
        return;
      }
      const index = parseScreenFlowIndex(raw);
      if (!index) {
        setStatus('error');
        return;
      }
      const loaded = (
        await Promise.all(
          index.flows.map(async (entry): Promise<LoadedFlow | null> => {
            const modelRaw = await fetchProjectFileText(projectId, artifactPath(root, entry.files.model));
            const model = parseScreenFlowModel(modelRaw);
            return model ? { entry, model } : null;
          }),
        )
      ).filter((value): value is LoadedFlow => value !== null);
      if (cancelled) return;
      if (loaded.length === 0) {
        setStatus(index.flows.length === 0 ? 'empty' : 'error');
        return;
      }
      const selected =
        loaded.find((flow) => flow.entry.id === requestedFlowId) ??
        loaded.find((flow) => !!currentScreenKey && flow.model.screens.some((item) => item.key === currentScreenKey)) ??
        loaded[0]!;
      setFlows(loaded);
      setSelectedId(selected.entry.id);
      setStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, root, requestedFlowId, fileMtime]);

  const selected = flows.find((flow) => flow.entry.id === selectedId) ?? null;

  // Rail và flow selector là hai cách chọn cùng một ngữ cảnh. Sau lần tải
  // đầu, currentScreenKey có thể đổi mà index/model không đổi; trước đây
  // selectedId giữ nguyên nên người dùng chọn màn thuộc flow A nhưng canvas
  // vẫn nằm ở UNLINKED/flow B.
  useEffect(() => {
    if (!currentScreenKey) return;
    const owner = flows.find((flow) => flow.model.screens.some((screen) => screen.key === currentScreenKey));
    if (owner) setSelectedId((current) => current === owner.entry.id ? current : owner.entry.id);
  }, [currentScreenKey, flows]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setDrawioXml(null);
    setDrawioError(false);
    void fetchProjectFileText(projectId, artifactPath(root, selected.entry.files.drawio)).then((raw) => {
      if (cancelled) return;
      if (!raw) setDrawioError(true);
      else setDrawioXml(raw);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, root, selected]);

  const cellToScreen = useMemo(() => {
    const map = screenCellMapFromXml(drawioXml ?? '');
    for (const item of selected?.model.screens ?? []) {
      for (const id of item.cellIds) if (!map.has(id)) map.set(id, item.key);
    }
    return map;
  }, [drawioXml, selected]);
  const highlightCells = useMemo(() => {
    if (!currentScreenKey) return [];
    return [...cellToScreen].filter(([, key]) => key === currentScreenKey).map(([id]) => id);
  }, [cellToScreen, currentScreenKey]);

  if (status === 'loading') return <div className={styles.message}>Đang tải luồng màn hình…</div>;
  if (status === 'empty') return <div className={styles.message}>Chưa có luồng màn hình — chạy lại bước “Màn hình → Component”.</div>;
  if (status === 'error' || !selected) return <div className={styles.message}>Không đọc được dữ liệu luồng màn hình. Wireframe hiện tại vẫn có thể xem được.</div>;

  const warnings = [...new Set([...selected.entry.warnings, ...selected.model.warnings])];
  const unlinkedCount = Math.max(selected.entry.unlinkedCount, selected.model.unlinkedScreens.length);
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{selected.entry.title}</h2>
          <span className={`${styles.sourceBadge} ${selected.entry.sourceMode === 'reused' ? styles.reused : styles.generated}`}>
            {selected.entry.sourceMode === 'reused' ? 'Tái sử dụng từ tài liệu' : 'Tạo từ luồng nghiệp vụ'}
          </span>
          {flows.length > 1 ? (
            <label className={styles.selectorLabel}>
              <span>Luồng</span>
              <select className={styles.selector} aria-label="Chọn luồng màn hình" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
                {flows.map((flow) => <option key={flow.entry.id} value={flow.entry.id}>{flow.entry.title}</option>)}
              </select>
            </label>
          ) : null}
          {drawioXml ? <a className={styles.download} href={`data:application/xml;charset=utf-8,${encodeURIComponent(drawioXml)}`} download={`${selected.entry.id}.drawio`}>Tải .drawio</a> : null}
        </div>
        {selected.entry.sourcePath ? <div className={styles.source}>Nguồn: <code>{selected.entry.sourcePath}</code></div> : null}
        {unlinkedCount > 0 ? <div className={styles.warning}>{unlinkedCount} màn chưa xác định điều hướng — vẫn hiển thị trong nhóm “Chưa xác định điều hướng”.</div> : null}
        {warnings.length ? <div className={styles.warning}>{warnings.join(' · ')}</div> : null}
      </header>
      <div className={styles.canvas}>
        {drawioError ? (
          <div className={styles.message}>Không tải được file Draw.io của luồng này.</div>
        ) : drawioXml ? (
          <DrawioViewer
            className={styles.viewer}
            xml={drawioXml}
            highlightCells={highlightCells}
            onCellClick={(cellId) => {
              if (!cellId) return;
              const key = cellToScreen.get(cellId);
              if (key) onOpenScreen(key);
            }}
            options={{ toolbar: 'zoom' }}
          />
        ) : <div className={styles.message}>Đang tải sơ đồ…</div>}
      </div>
    </div>
  );
}
