// Renders a Mermaid diagram source to SVG. Mermaid is dynamically imported so
// it never runs during SSR and stays out of the main bundle until used.
import { useEffect, useRef, useState } from 'react';

let initialized: string | null = null;
let seq = 0;

function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function MermaidDiagram({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        const theme = prefersDark() ? 'dark' : 'neutral';
        if (initialized !== theme) {
          mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'loose', fontFamily: 'inherit' });
          initialized = theme;
        }
        seq += 1;
        const { svg } = await mermaid.render(`mmd-${seq}`, code);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div style={{ padding: 12, fontSize: 12, color: 'var(--red, #dc2626)' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Mermaid error: {error}</div>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--mono, monospace)',
            opacity: 0.8,
            margin: 0,
          }}
        >
          {code}
        </pre>
      </div>
    );
  }
  return <div ref={ref} style={{ padding: 16, overflow: 'auto', height: '100%' }} />;
}
