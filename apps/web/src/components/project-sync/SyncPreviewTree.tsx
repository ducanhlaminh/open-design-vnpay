import { useMemo, useState } from 'react';
import type {
  ProjectSyncChange,
  ProjectSyncDirection,
  ProjectSyncEntry,
  ProjectSyncPlan,
  ProjectSyncResolution,
  SyncEntitySummary,
} from '@open-design/contracts';

import { Icon } from '../Icon';
import { SyncStateBadge } from './SyncStateBadge';
import styles from './ProjectSyncPreview.module.css';

export interface SyncPreviewTreeProps {
  plan: ProjectSyncPlan;
  resolutions: Readonly<Record<string, ProjectSyncResolution>>;
  onResolutionChange: (path: string, resolution: ProjectSyncResolution) => void;
}

interface FolderNode {
  key: string;
  label: string;
  entity?: SyncEntitySummary;
  folders: Map<string, FolderNode>;
  files: ProjectSyncEntry[];
}

function folder(key: string, label: string, entity?: SyncEntitySummary): FolderNode {
  return { key, label, ...(entity ? { entity } : {}), folders: new Map(), files: [] };
}

function childFolder(parent: FolderNode, key: string, label: string, entity?: SyncEntitySummary): FolderNode {
  const current = parent.folders.get(key);
  if (current) {
    if (entity) current.entity = entity;
    return current;
  }
  const next = folder(`${parent.key}/${key}`, label, entity);
  parent.folders.set(key, next);
  return next;
}

function segmentLabel(segment: string, featureNames: ReadonlyMap<string, string>): string {
  if (segment === 'context') return 'Tài liệu dùng chung';
  if (segment === 'bound-context') return 'Tài liệu dùng chung';
  if (segment === 'features') return 'Các tính năng';
  if (segment === 'outputs' || segment === 'output') return 'Kết quả';
  if (segment === 'review') return 'Review';
  return featureNames.get(segment) ?? segment;
}

function buildTree(plan: ProjectSyncPlan): FolderNode {
  const selectedFeature = plan.features[0];
  const rootEntity = plan.scope.kind === 'app' ? plan.app : selectedFeature;
  const root = folder('root', rootEntity?.name ?? (plan.scope.kind === 'app' ? 'Dự án' : 'Tính năng'), rootEntity);
  const featureNames = new Map(plan.features.map((feature) => [feature.id, feature.name]));

  if (plan.context) childFolder(root, 'context', 'Tài liệu dùng chung', plan.context);
  if (plan.scope.kind === 'app' && plan.features.length > 0) {
    const features = childFolder(root, 'features', 'Các tính năng');
    for (const feature of plan.features) childFolder(features, feature.id, feature.name, feature);
  }

  for (const entry of plan.entries) {
    const segments = entry.path.split('/').filter(Boolean);
    if (segments[0] === 'app' || (plan.scope.kind === 'feature' && segments[0] === 'feature')) segments.shift();
    if (segments[0] === 'bound-context') segments[0] = 'context';
    segments.pop();
    let parent = root;
    for (const segment of segments) {
      parent = childFolder(parent, segment, segmentLabel(segment, featureNames));
    }
    parent.files.push(entry);
  }
  return root;
}

function combinedState(node: FolderNode): ProjectSyncChange {
  if (node.entity) return node.entity.state;
  const states = [
    ...node.files.map((entry) => entry.change),
    ...[...node.folders.values()].map(combinedState),
  ];
  if (states.length === 0 || states.every((state) => state === 'unchanged')) return 'unchanged';
  if (states.every((state) => state === 'new')) return 'new';
  if (states.every((state) => state === 'deleted')) return 'deleted';
  return 'changed';
}

function ResolutionControl({ entry, direction, value, onChange }: {
  entry: ProjectSyncEntry;
  direction: ProjectSyncDirection;
  value: ProjectSyncResolution;
  onChange: (value: ProjectSyncResolution) => void;
}) {
  if (direction !== 'pull' || entry.change === 'unchanged' || (!entry.local && entry.origin)) return null;
  const localOnly = Boolean(entry.local && !entry.origin);
  const label = localOnly ? 'Tệp chỉ có trên máy' : 'Tệp có xung đột giữa bản trên máy và kho chung';
  return (
    <fieldset className={styles.resolution} aria-label={`${label}: ${entry.path}`}>
      <label>
        <input type="radio" name={`resolution-${entry.path}`} checked={value === 'skip'} onChange={() => onChange('skip')} />
        Giữ bản trên máy
      </label>
      <label>
        <input type="radio" name={`resolution-${entry.path}`} checked={value === 'pull'} onChange={() => onChange('pull')} />
        {localOnly ? 'Xóa khỏi máy theo kho chung' : 'Dùng bản trong kho chung'}
      </label>
    </fieldset>
  );
}

function FileLeaf({ entry, direction, resolution, onResolutionChange }: {
  entry: ProjectSyncEntry;
  direction: ProjectSyncDirection;
  resolution: ProjectSyncResolution;
  onResolutionChange: (resolution: ProjectSyncResolution) => void;
}) {
  const fileName = entry.path.split('/').pop() ?? entry.path;
  return (
    <li className={styles.fileNode} data-origin-only={!entry.local && Boolean(entry.origin) || undefined}>
      <div className={styles.fileRow}>
        <span className={styles.treeSpacer} aria-hidden />
        <Icon name={entry.kind === 'output' ? 'file-code' : 'file'} size={14} />
        <span className={styles.filePath} title={entry.path}>{fileName}</span>
        {entry.contextVersion ? <span className={styles.version}>v{entry.contextVersion.replace(/^v/i, '')}</span> : null}
        {entry.confluence ? (
          <span
            className={styles.wikiChip}
            title={`${entry.confluence.attachment} v${entry.confluence.attachmentVersion}`}
            aria-label={`Tải từ Confluence: ${entry.confluence.attachment} v${entry.confluence.attachmentVersion}`}
          >
            wiki
          </span>
        ) : null}
        <SyncStateBadge state={entry.change} />
      </div>
      <ResolutionControl entry={entry} direction={direction} value={resolution} onChange={onResolutionChange} />
    </li>
  );
}

function FolderBranch({ node, direction, resolutions, onResolutionChange, defaultOpen = false }: {
  node: FolderNode;
  direction: ProjectSyncDirection;
  resolutions: Readonly<Record<string, ProjectSyncResolution>>;
  onResolutionChange: (path: string, resolution: ProjectSyncResolution) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const childCount = node.folders.size + node.files.length;
  return (
    <li className={styles.folderNode}>
      <button
        type="button"
        className={styles.folderRow}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.treeToggle} aria-hidden><Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} /></span>
        <Icon name="folder" size={15} />
        <span className={styles.treeName}>{node.label}</span>
        <span className={styles.treeCount}>{childCount}</span>
        {node.entity?.contextVersion ? <span className={styles.version}>v{node.entity.contextVersion.replace(/^v/i, '')}</span> : null}
        <SyncStateBadge state={combinedState(node)} />
      </button>
      {open ? (
        <ul className={styles.folderChildren}>
          {[...node.folders.values()].map((child) => (
            <FolderBranch
              key={child.key}
              node={child}
              direction={direction}
              resolutions={resolutions}
              onResolutionChange={onResolutionChange}
              defaultOpen={child.entity?.kind === 'feature' || child.key.endsWith('/context') || child.key.endsWith('/features')}
            />
          ))}
          {node.files.map((entry) => (
            <FileLeaf
              key={entry.path}
              entry={entry}
              direction={direction}
              resolution={resolutions[entry.path] ?? entry.resolution}
              onResolutionChange={(resolution) => onResolutionChange(entry.path, resolution)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** A real folder tree. App scope is fixed by the server plan; only Pull file
 * conflict choices are interactive. */
export function SyncPreviewTree({ plan, resolutions, onResolutionChange }: SyncPreviewTreeProps) {
  const root = useMemo(() => buildTree(plan), [plan]);
  return (
    <section className={styles.tree} aria-label="Cây dữ liệu sẽ đồng bộ">
      <div className={styles.treeHead}>
        <span>Nội dung sẽ đồng bộ</span>
        <span>{plan.scope.kind === 'app' ? 'Toàn bộ Dự án' : 'Tính năng đang chọn'}</span>
      </div>
      <ul className={styles.treeList}>
        <FolderBranch node={root} direction={plan.direction} resolutions={resolutions} onResolutionChange={onResolutionChange} defaultOpen />
      </ul>
    </section>
  );
}
