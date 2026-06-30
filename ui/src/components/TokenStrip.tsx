/**
 * F-12 — TokenStrip
 * Renders color swatches parsed from a design system's tokens.css.
 * Used in DSCard, DSPicker.
 */
import { useEffect, useState } from 'react';

interface TokenStripProps {
  tokensUrl: string | null;
  mini?: boolean;   // mini=true: 4 swatches 12px | false: 6 swatches 18px
  className?: string;
}

// Parse --color-* CSS variables (skip text/bg/surface/border to surface brand colors)
function parseColorTokens(css: string, limit: number): string[] {
  const matches = css.matchAll(
    /--color-(?!text|bg|surface|border|muted|overlay)[^:]+:\s*([^;]+)/g,
  );
  return [...matches]
    .map((m) => m[1].trim())
    .filter((v) => v.startsWith('#') || v.startsWith('hsl') || v.startsWith('rgb'))
    .slice(0, limit);
}

export function TokenStrip({ tokensUrl, mini = false, className }: TokenStripProps) {
  const [colors, setColors] = useState<string[]>([]);

  useEffect(() => {
    if (!tokensUrl) {
      setColors([]);
      return;
    }
    let cancelled = false;
    fetch(tokensUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      })
      .then((css) => {
        if (!cancelled) setColors(parseColorTokens(css, mini ? 4 : 6));
      })
      .catch(() => {
        if (!cancelled) setColors([]);
      });
    return () => { cancelled = true; };
  }, [tokensUrl, mini]);

  const size = mini ? 12 : 18;

  if (colors.length === 0) {
    // Placeholder swatches while loading/empty
    return (
      <div style={{ display: 'flex', gap: 2 }} className={className}>
        {Array.from({ length: mini ? 4 : 6 }).map((_, i) => (
          <div
            key={i}
            style={{
              width: size,
              height: size,
              borderRadius: 3,
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              opacity: 0.4,
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 2 }} className={className}>
      {colors.map((c, i) => (
        <div
          key={i}
          title={c}
          style={{
            width: size,
            height: size,
            borderRadius: 3,
            background: c,
            border: '1px solid rgba(255,255,255,0.08)',
            flexShrink: 0,
          }}
        />
      ))}
    </div>
  );
}
