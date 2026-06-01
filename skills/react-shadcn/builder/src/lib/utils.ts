import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Phase 31-07 (D-31-02) — pickDisplay
 *
 * Resolve a human-friendly label for any tree node that carries
 * `displayName` (preferred), `name` (fallback), and a kebab-case `slug`
 * (last resort). UI components call this so friendly labels like
 * "Default", "Alias", "Light" surface instead of kebab slugs like
 * "shadcn-default", "alias", "light" — while slugs remain the stable
 * identifier for URLs, aria-label identifiers, and data-* attributes.
 */
export function pickDisplay(node: {
  displayName?: string;
  name?: string;
  slug: string;
}): string {
  if (typeof node.displayName === "string" && node.displayName.length > 0) {
    return node.displayName;
  }
  if (typeof node.name === "string" && node.name.length > 0) {
    return node.name;
  }
  return node.slug;
}
