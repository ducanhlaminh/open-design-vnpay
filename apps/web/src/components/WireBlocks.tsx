// WireBlocks renders the UX-spec HTML document in an isolated iframe.
import { useEffect, useRef, useState } from 'react';

export type DeviceKey = 'desktop' | 'tablet' | 'mobile';

export interface WireBlocksProps {
  html: string;
  platform?: string;
  device?: DeviceKey;
}

const WIDTHS = { desktop: 1280, tablet: 834, mobile: 390 } as const;

export function WireBlocks({ html, platform, device = 'desktop' }: WireBlocksProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(platform === 'web' ? 800 : 844);
  const width = platform === 'web' ? WIDTHS[device] : WIDTHS.mobile;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const resize = () => {
      const body = iframe.contentDocument?.body;
      const measured = body?.scrollHeight ?? 0;
      if (measured > 0) setHeight(Math.max(240, measured));
    };
    iframe.addEventListener('load', resize);
    return () => iframe.removeEventListener('load', resize);
  }, [html]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={html}
      sandbox=""
      title="Wireframe"
      style={{ display: 'block', width, height, maxWidth: '100%', border: 0, background: '#fff' }}
    />
  );
}
