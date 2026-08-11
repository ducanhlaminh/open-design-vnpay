import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { fetchDesignSystemReactInfo } from '../providers/registry';
import type { DesignSystemReactInfo, DesignSystemSummary } from '../types';
import { DesignSpecView } from './DesignSpecView';
import { FigmaDsPreviewTabs } from './FigmaDsPreviewTabs';
import { PreviewModal } from './PreviewModal';

interface Props {
  system: DesignSystemSummary;
  onClose: () => void;
  /** Open already expanded to the viewport (card "Fullscreen" action). */
  initialFullscreen?: boolean;
}

// Detail modal for react-bundle design systems (Figma IR imports). Unlike the
// generic DesignSystemPreviewModal (marketing showcase + tokens page rendered
// from DESIGN.md), this one fronts the COMPILED showcase — the real imported
// components rendered from react/ source — with a side panel carrying the
// compiler's own artifacts: inventory counts, the STYLE-GUIDE token contract,
// and the per-component API catalog.
export function FigmaDesignSystemDetailModal({ system, onClose, initialFullscreen }: Props) {
  const t = useT();
  const [info, setInfo] = useState<DesignSystemReactInfo | null | undefined>(undefined);

  // The side panel and the subtitle stats share one payload; fetch it once
  // per system on mount rather than lazily on sidebar-open.
  useEffect(() => {
    setInfo(undefined);
    void fetchDesignSystemReactInfo(system.id).then((detail) => setInfo(detail));
  }, [system.id]);

  const specSource =
    info === undefined
      ? undefined
      : info === null
        ? null
        : [info.styleGuide.trim(), info.catalog.trim()].filter(Boolean).join('\n\n---\n\n');

  return (
    <PreviewModal
      title={system.title}
      subtitle={
        info
          ? t('ds.reactStats', { components: info.components, icons: info.icons })
          : system.summary || system.category
      }
      // MỘT view duy nhất: PreviewModal chỉ vẽ dải tab của nó khi có >1 view,
      // nên tab bar 3 phần (Showcase / Thành phần / Nguyên tắc) + nút Tải lại
      // của FigmaDsPreviewTabs là dải tab DUY NHẤT người dùng thấy — và giống
      // hệt dải tab ở khung preview màn Edit, vì dùng chung component.
      views={[
        {
          id: 'preview',
          label: t('ds.showcase'),
          custom: <FigmaDsPreviewTabs systemId={system.id} />,
        },
      ]}
      initialViewId="preview"
      initialFullscreen={initialFullscreen}
      exportTitleFor={(viewId) => `${system.title} — ${viewId}`}
      onClose={onClose}
      sidebar={{
        label: t('ds.reactDetailToggle'),
        // Đóng sẵn: 3 tab cần trọn bề ngang. STYLE-GUIDE + catalog vẫn cách
        // một cú bấm.
        defaultOpen: false,
        contentKey: system.id,
        content: (
          <DesignSpecView
            source={specSource}
            loadingLabel={t('ds.reactDetailLoading')}
          />
        ),
      }}
    />
  );
}
