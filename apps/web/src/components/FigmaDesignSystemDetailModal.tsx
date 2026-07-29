import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { fetchDesignSystemReactInfo } from '../providers/registry';
import type { DesignSystemReactInfo, DesignSystemSummary } from '../types';
import { DesignSpecView } from './DesignSpecView';
import { PreviewModal } from './PreviewModal';
import { WireframeMapView } from './WireframeMapView';

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
      views={[
        {
          id: 'showcase',
          label: t('ds.showcase'),
          // URL-load instead of srcDoc: the compiled showcase lazy-fetches
          // its icon SVGs from the react-assets route, and only a
          // same-origin iframe lets those requests carry the app's auth.
          custom: (
            <iframe
              className="figma-ds-showcase-frame"
              title={`${system.title} showcase`}
              src={`/api/design-systems/${encodeURIComponent(system.id)}/showcase`}
            />
          ),
        },
        {
          id: 'wireframe-map',
          label: t('ds.wireframeMap'),
          custom: <WireframeMapView systemId={system.id} />,
        },
      ]}
      initialViewId="showcase"
      initialFullscreen={initialFullscreen}
      exportTitleFor={(viewId) => `${system.title} — ${viewId}`}
      onClose={onClose}
      sidebar={{
        label: t('ds.reactDetailToggle'),
        defaultOpen: true,
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
