/**
 * F-15b — SpinnerIcon
 * SVG spinner with CSS animation — used for loading states.
 */
interface SpinnerIconProps {
  size?: number;
  color?: string;
}

export function SpinnerIcon({ size = 16, color = 'var(--color-accent)' }: SpinnerIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ animation: 'spin 0.7s linear infinite', flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="10" stroke={color} strokeOpacity="0.2" strokeWidth="3" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
