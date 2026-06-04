/**
 * T29 — DirectionPicker Component
 * 5 visual design directions with color swatches + font stacks.
 * SRS FR-07.2, URD US-02-02
 */
import { useState } from 'react';
import type { Direction } from '../api/runs/http';

// 5 built-in directions from SRS FR-07.2
export const BUILTIN_DIRECTIONS: Direction[] = [
  {
    id: 'editorial-monocle',
    name: 'Editorial Monocle',
    description: 'Magazine-quality editorial with luxurious restraint',
    palette: ['#2B2B2B', '#F5F0E8', '#C9A84C', '#FFFFFF'],
    fontStack: ['Playfair Display', 'Inter'],
  },
  {
    id: 'modern-minimal',
    name: 'Modern Minimal',
    description: 'Crisp white space with bold typography',
    palette: ['#FFFFFF', '#0F0F0F', '#5B5BFF', '#F0F0F0'],
    fontStack: ['Inter', 'Roboto Mono'],
  },
  {
    id: 'warm-soft',
    name: 'Warm Soft',
    description: 'Approachable warmth with natural textures',
    palette: ['#F2E8E4', '#FFFAF7', '#C17C54', '#4A3728'],
    fontStack: ['Lora', 'DM Sans'],
  },
  {
    id: 'tech-utility',
    name: 'Tech Utility',
    description: 'Precision-engineered for power users',
    palette: ['#0A1628', '#00D4FF', '#64748B', '#F8FAFC'],
    fontStack: ['JetBrains Mono', 'Inter'],
  },
  {
    id: 'brutalist-experimental',
    name: 'Brutalist Experimental',
    description: 'Raw, uncompromising, unapologetically bold',
    palette: ['#000000', '#C8FF00', '#FFFFFF', '#FF0000'],
    fontStack: ['Space Grotesk'],
  },
];

interface DirectionPickerProps {
  directions?: Direction[];
  onSelect: (directionId: string) => void;
  disabled?: boolean;
}

export function DirectionPicker({
  directions = BUILTIN_DIRECTIONS,
  onSelect,
  disabled,
}: DirectionPickerProps) {
  const [selected, setSelected] = useState<string | null>(null);

  const handleSelect = (id: string) => {
    if (disabled) return;
    setSelected(id);
    onSelect(id);
  };

  return (
    <div>
      <h3
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: 'var(--color-text)',
          marginBottom: 16,
        }}
      >
        Choose your visual direction
      </h3>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
        {directions.map((dir) => (
          <DirectionCard
            key={dir.id}
            direction={dir}
            isSelected={selected === dir.id}
            onClick={() => handleSelect(dir.id)}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}

function DirectionCard({
  direction,
  isSelected,
  onClick,
  disabled,
}: {
  direction: Direction;
  isSelected: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        borderRadius: 'var(--radius)',
        border: `2px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        background: isSelected ? 'rgba(124,109,250,0.08)' : 'var(--color-surface)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        textAlign: 'left',
        transition: 'border-color 0.15s, background 0.15s',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {/* Color swatches */}
      <div style={{ display: 'flex', gap: 4 }}>
        {direction.palette.slice(0, 4).map((color, i) => (
          <div
            key={i}
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              background: color,
              border: '1px solid rgba(255,255,255,0.1)',
              flexShrink: 0,
            }}
          />
        ))}
      </div>

      {/* Name */}
      <div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-text)',
            marginBottom: 2,
          }}
        >
          {direction.name}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-accent)', opacity: 0.8 }}>
          {direction.fontStack.join(' + ')}
        </div>
      </div>

      {/* Description */}
      <p
        style={{
          fontSize: 12,
          color: 'var(--color-text-muted)',
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        {direction.description}
      </p>
    </button>
  );
}
