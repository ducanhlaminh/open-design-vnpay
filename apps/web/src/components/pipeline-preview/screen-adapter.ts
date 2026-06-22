// Adapt a react-shadcn `screen.json` to the shape preview-runtime-v3 expects.
//
// The skill (skills/react-shadcn/references/screen.schema.json) emits one of:
//   { screen: { roots: [node, …] } } | { roots: [node, …] } | [node, …]
// and each node carries `componentSlug` (PascalCase "Button" / HTML tag "div").
//
// preview-runtime-v3's extractTree(), by contrast, only reads a SINGLE root at
// `spec.layout.tree` (or `spec.tree`) and each node's `component` field (its
// toScreenNode does NOT read `componentSlug`). So a raw skill output renders
// blank. This adapter bridges the gap on the host side (the runtime is a
// prebuilt bundle we don't rebuild):
//   • unwrap to a roots[] array (any of the three skill forms, plus the
//     already-runtime {layout:{tree}} / {tree} / bare-node forms),
//   • collapse to a single root (wrap >1 roots in a flex column container),
//   • rename componentSlug → component recursively.
// ScreenRenderer kebab-cases the slug itself (componentCatalogSlug), so a
// PascalCase componentSlug like "Button" still resolves to the "button"
// primitive after the rename.

interface RawNode {
  component?: string;
  componentSlug?: string;
  type?: string;
  props?: Record<string, unknown>;
  text?: string;
  children?: RawNode[];
  overlay?: boolean;
  defaultOpen?: boolean;
  id?: string;
}

export interface RuntimeNode {
  component: string;
  props?: Record<string, unknown>;
  text?: string;
  children?: RuntimeNode[];
  overlay?: boolean;
  defaultOpen?: boolean;
}

export interface RuntimeSpec {
  layout: { tree: RuntimeNode };
}

function mapNode(n: RawNode): RuntimeNode {
  const component = n.component ?? n.componentSlug ?? n.type ?? 'div';
  const out: RuntimeNode = { component };
  // Carry id through as data-node-id so future flow wiring can anchor on it.
  const props = { ...(n.props ?? {}) };
  if (n.id && props['data-node-id'] === undefined) props['data-node-id'] = n.id;
  if (Object.keys(props).length > 0) out.props = props;
  if (typeof n.text === 'string') out.text = n.text;
  if (Array.isArray(n.children) && n.children.length > 0) {
    out.children = n.children.map(mapNode);
  }
  if (n.overlay === true) out.overlay = true;
  if (n.defaultOpen === true) out.defaultOpen = true;
  return out;
}

function rootsFrom(raw: unknown): RawNode[] | null {
  if (Array.isArray(raw)) return raw as RawNode[];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  // Already the runtime shape — still pass nodes through mapNode so a stray
  // componentSlug or nested id is normalized.
  const layout = o.layout as { tree?: RawNode } | undefined;
  if (layout?.tree) return [layout.tree];
  if (o.tree && typeof o.tree === 'object') return [o.tree as RawNode];

  // Skill forms.
  const screen = o.screen as { roots?: RawNode[] } | undefined;
  if (Array.isArray(screen?.roots)) return screen!.roots;
  if (Array.isArray(o.roots)) return o.roots as RawNode[];

  // A single bare node.
  if (typeof o.component === 'string' || typeof o.componentSlug === 'string') {
    return [o as RawNode];
  }
  return null;
}

/** Normalize any accepted screen.json form into the runtime's {layout:{tree}}.
 *  Returns null when no renderable node tree can be extracted. */
export function adaptScreenSpec(raw: unknown): RuntimeSpec | null {
  const roots = rootsFrom(raw);
  if (!roots || roots.length === 0) return null;
  const tree =
    roots.length === 1
      ? mapNode(roots[0]!)
      : { component: 'div', props: { className: 'flex flex-col' }, children: roots.map(mapNode) };
  return { layout: { tree } };
}
