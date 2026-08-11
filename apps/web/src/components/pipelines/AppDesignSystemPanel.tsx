'use client';

import { useEffect, useMemo, useState } from 'react';
import type { DesignSystemFileDetail, DesignSystemReactInfo, DesignSystemSummary } from '@open-design/contracts';
import { DesignSpecView } from '../DesignSpecView';
import { fetchDesignSystemCriteriaFile, fetchDesignSystemReactInfo, fetchDesignSystems } from '../../providers/registry';
import styles from './AppDesignSystemPanel.module.css';

type View = 'showcase' | 'criteria';

interface Props {
  appId: string;
  designSystemId?: string | null;
}

export function AppDesignSystemPanel({ appId, designSystemId }: Props) {
  const [view, setView] = useState<View>('showcase');
  const [system, setSystem] = useState<DesignSystemSummary | null>(null);
  const [reactInfo, setReactInfo] = useState<DesignSystemReactInfo | null | undefined>(undefined);
  const [criteria, setCriteria] = useState<DesignSystemFileDetail | null | undefined>(undefined);
  const [showcaseError, setShowcaseError] = useState(false);

  useEffect(() => {
    setView('showcase');
    setSystem(null);
    setReactInfo(undefined);
    setCriteria(undefined);
    setShowcaseError(false);
    if (!designSystemId) return;
    let alive = true;
    void Promise.all([fetchDesignSystems(), fetchDesignSystemReactInfo(designSystemId)]).then(([systems, info]) => {
      if (!alive) return;
      setSystem(systems.find((item) => item.id === designSystemId) ?? null);
      setReactInfo(info);
    });
    return () => { alive = false; };
  }, [appId, designSystemId]);

  useEffect(() => {
    if (!designSystemId || view !== 'criteria') return;
    let alive = true;
    void fetchDesignSystemCriteriaFile(designSystemId).then((result) => {
      if (!alive) return;
      setCriteria('error' in result ? null : result);
    });
    return () => { alive = false; };
  }, [designSystemId, view]);

  const title = system?.title ?? designSystemId ?? 'Design System';
  const componentCount = useMemo(
    () => criteria?.content.match(/^###\s+`/gm)?.length ?? 0,
    [criteria],
  );

  if (!designSystemId) {
    return <section className={styles.section} aria-label="Design System"><p className={styles.empty}>Dự án chưa chọn Design System. Chọn DS ở <strong>Sửa dự án</strong>.</p></section>;
  }

  return (
    <section className={styles.section} aria-label="Design System">
      <div className={styles.header}>
        <div><h2 className={styles.heading}>{title}</h2><p className={styles.muted}>Design System gắn cho dự án này.</p></div>
      </div>
      <div className={styles.modeBar} role="tablist" aria-label="Nội dung Design System">
        <button type="button" role="tab" aria-selected={view === 'showcase'} className={`${styles.modeButton}${view === 'showcase' ? ` ${styles.modeButtonActive}` : ''}`} onClick={() => setView('showcase')}>Showcase</button>
        <button type="button" role="tab" aria-selected={view === 'criteria'} className={`${styles.modeButton}${view === 'criteria' ? ` ${styles.modeButtonActive}` : ''}`} onClick={() => setView('criteria')}>Danh mục component</button>
      </div>
      {view === 'showcase' ? (
        <div className={styles.frameWrap}>
          {showcaseError || reactInfo === null ? <p className={styles.empty}>DS này không phải bản nạp từ Figma nên không có showcase.</p> : <iframe className={styles.frame} title={`${title} showcase`} src={`/api/design-systems/${encodeURIComponent(designSystemId)}/showcase`} onError={() => setShowcaseError(true)} />}
        </div>
      ) : (
        <div className={styles.criteriaWrap}>
          <div className={styles.criteriaHead}><h3 className={styles.subheading}>Danh mục component</h3>{criteria ? <p className={styles.meta}>{componentCount} component · {criteria.updatedAt ? new Date(criteria.updatedAt).toLocaleString('vi-VN') : 'chưa rõ thời gian cập nhật'}</p> : null}</div>
          {criteria === undefined ? <p className={styles.muted}>Đang tải danh mục…</p> : criteria === null ? <div className={styles.empty}><p>Chưa có danh mục. Danh mục sinh tự động khi nạp DS Figma; vào trang Design System bấm <strong>Sinh lại</strong>.</p><p className={styles.muted}>Đây là danh mục bước “Màn hình → Component” dùng để đối chiếu.</p></div> : <DesignSpecView source={criteria.content} loadingLabel="Đang tải danh mục…" />}
        </div>
      )}
    </section>
  );
}
