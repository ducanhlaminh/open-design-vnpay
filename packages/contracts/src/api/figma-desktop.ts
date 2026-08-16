// Figma Desktop Dev Mode MCP contract — WP2 of the 2026-08-16 Figma Desktop
// drill-down plan (see specs/change/20260816-figma-desktop-tools/spec.md).
//
// Distinct from figma-config.ts (Personal Access Token store + REST catalog
// verification): this contract covers the daemon-proxied Figma Desktop MCP
// (http://127.0.0.1:3845/mcp) tool routes and status probe that let an agent
// pull design context (layout/color/text/variants/screenshot) for one
// component the App already declared through docsReviewComponentSource.

export interface FigmaDesktopStatusResponse {
  /** MCP :3845 answered `initialize`. */
  available: boolean;
  /** Vietnamese reason when `available` is false. */
  detail?: string;
  activeFileTitle?: string | null;
  /** True when the daemon platform can drive `open figma://file/<key>`
   *  (darwin, win32). */
  canSwitch: boolean;
  platform: string;
}

export type FigmaDesktopToolName = 'design-context' | 'screenshot' | 'variable-defs' | 'metadata';

export interface FigmaDesktopToolRequest {
  fileKey: string;
  /** "10:1" or "10-1" (URL form); the route normalizes to "10:1". */
  nodeId: string;
  /** design-context/variable-defs/metadata only; default 'unknown'. */
  clientLanguages?: string;
  clientFrameworks?: string;
}

export interface FigmaDesktopTextToolResponse {
  ok: true;
  tool: FigmaDesktopToolName;
  fileKey: string;
  nodeId: string;
  switched: 'already' | 'switched';
  cached: boolean;
  text: string;
}

export interface FigmaDesktopScreenshotResponse {
  ok: true;
  tool: 'screenshot';
  fileKey: string;
  nodeId: string;
  switched: 'already' | 'switched';
  cached: boolean;
  /** Relative to the run's cwd, e.g. ".figma-catalog/shots/<fileKey>/10-1.png". */
  path: string;
  mimeType: string;
}
