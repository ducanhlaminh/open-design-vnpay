/* ===================================================================== *
 *  JSON-DRIVEN SCREEN RENDERER  (shell runtime — do NOT edit by hand).
 *
 *  The shell fetches ./screen.json (a nested content tree) and walks it,
 *  mounting verbatim VNPAY components by slug. This mirrors design-v3's
 *  ScreenRenderer: a component map + Pascal->kebab slug normaliser +
 *  an Asset primitive + recursive children/text.
 *
 *  Authors edit screen.json, NOT this block.
 * ===================================================================== */
const { useState, useEffect } = React;

/* asset.icon.* token  ->  Lucide icon name. Extend as new screens need it. */
const ICON_TOKEN_TO_LUCIDE = {
  "asset.icon.add": "Plus",
  "asset.icon.search": "Search",
  "asset.icon.products": "Package",
  "asset.icon.orders": "ReceiptText",
  "asset.icon.cash": "Banknote",
  "asset.icon.home": "Home",
  "asset.icon.history": "History",
  "asset.icon.back": "ChevronLeft",
  "asset.icon.close": "X",
  "asset.icon.menu": "Menu",
  "asset.icon.more": "MoreVertical",
  "asset.icon.settings": "Settings",
  "asset.icon.user": "User",
  "asset.icon.cart": "ShoppingCart",
  "asset.icon.check": "Check",
  "asset.icon.edit": "Pencil",
  "asset.icon.delete": "Trash2",
  "asset.icon.filter": "SlidersHorizontal",
  "asset.icon.chevron-right": "ChevronRight",
  "asset.icon.bell": "Bell",
  "asset.icon.scan": "ScanLine",
  // --- VNPAY Glass: auth + wallet + services ---
  "asset.icon.phone": "Phone",
  "asset.icon.lock": "Lock",
  "asset.icon.eye": "Eye",
  "asset.icon.eye-off": "EyeOff",
  "asset.icon.fingerprint": "Fingerprint",
  "asset.icon.face-id": "ScanFace",
  "asset.icon.shield": "ShieldCheck",
  "asset.icon.wallet": "Wallet",
  "asset.icon.qr": "QrCode",
  "asset.icon.send": "Send",
  "asset.icon.transfer": "ArrowLeftRight",
  "asset.icon.topup": "Smartphone",
  "asset.icon.bill": "ReceiptText",
  "asset.icon.ticket": "Ticket",
  "asset.icon.gift": "Gift",
  "asset.icon.medal": "Medal",
  "asset.icon.crown": "Crown",
  "asset.icon.star": "Star",
  "asset.icon.sparkles": "Sparkles",
  "asset.icon.zap": "Zap",
  "asset.icon.grid": "LayoutGrid",
  "asset.icon.arrow-up-right": "ArrowUpRight",
  "asset.icon.arrow-down-left": "ArrowDownLeft",
  "asset.icon.plus": "Plus",
  "asset.icon.plane": "Plane",
  "asset.icon.car": "Car",
  "asset.icon.droplet": "Droplet",
  "asset.icon.wifi": "Wifi",
  "asset.icon.tv": "Tv",
  "asset.icon.shopping-bag": "ShoppingBag",
  "asset.icon.chevron-down": "ChevronDown",
  "asset.icon.eye-num": "Eye",
  "asset.icon.help": "CircleHelp",
};

/* asset.icon.<kebab-name> -> PascalCase Lucide export name (arrow-up-right ->
   ArrowUpRight). Lets any icon token resolve without a manual table entry;
   ICON_TOKEN_TO_LUCIDE stays only for names that don't map 1-1. */
function iconTokenToPascal(path) {
  const m = /^asset\.icon\.(.+)$/.exec(path || "");
  if (!m) return null;
  return m[1]
    .split(/[-_.]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

/* <Asset token="asset.icon.add"/> -> a Lucide icon, or a labelled placeholder.
   Lookup order: explicit table -> PascalCase auto-derivation -> placeholder. */
function AssetPrimitive(props) {
  const { token, value, className, title, children, ...rest } = props;
  const path = token || value || "";
  const name = ICON_TOKEN_TO_LUCIDE[path] || iconTokenToPascal(path);
  const Icon = name ? Lucide[name] : null;
  if (Icon) {
    return React.createElement(Icon, {
      ...rest,
      className: className || undefined,
      "aria-label": rest["aria-label"] || title || path,
    });
  }
  // Unmapped token -> labelled placeholder box (keeps the layout footprint).
  return React.createElement("span", {
    ...rest,
    className: cn(
      "inline-grid shrink-0 place-items-center rounded border border-current/30 text-[8px]",
      className || "size-4",
    ),
    title: title || path,
    "aria-hidden": true,
  });
}

/* PascalCase / camelCase -> kebab-case. Verbatim from design-v3
   screen-renderer.tsx (Card -> card, CardHeader -> card-header, …). */
function componentCatalogSlug(component) {
  return String(component)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/* Index every UI export by its catalog slug (InputGroupInput -> input-group-input). */
const UI_BY_SLUG = {};
for (const name of Object.keys(UI)) {
  const v = UI[name];
  if (typeof v === "function" || (v && typeof v === "object")) {
    UI_BY_SLUG[componentCatalogSlug(name)] = v;
  }
}

/* Curated primitive whitelist — design-v3's COMPONENT_PRIMITIVES keys extended
   to cover EVERY component subpart the prebuilt bundle actually exports
   (close/overlay/portal slots, select-group, tooltip-provider, progress parts,
   …). Still whitelist-only: anything outside falls to a red "?slug" badge.
   Deliberately excluded: react-hook-form family (Form, FormField, …) — they
   need function props / form context that a JSON tree cannot express. */
const PRIMITIVE_SLUGS = [
  "accordion", "accordion-item", "accordion-trigger", "accordion-content",
  "alert", "alert-title", "alert-description", "alert-action",
  "alert-dialog", "alert-dialog-trigger", "alert-dialog-content", "alert-dialog-header",
  "alert-dialog-footer", "alert-dialog-title", "alert-dialog-description",
  "alert-dialog-action", "alert-dialog-cancel", "alert-dialog-media",
  "alert-dialog-overlay", "alert-dialog-portal",
  "aspect-ratio",
  "avatar", "avatar-image", "avatar-fallback", "avatar-group", "avatar-group-count",
  "avatar-badge",
  "badge",
  "breadcrumb", "breadcrumb-list", "breadcrumb-item", "breadcrumb-link",
  "breadcrumb-page", "breadcrumb-separator", "breadcrumb-ellipsis",
  "button",
  "card", "card-header", "card-title", "card-description", "card-content", "card-footer",
  "card-action",
  "carousel", "carousel-content", "carousel-item", "carousel-previous", "carousel-next",
  "checkbox",
  "collapsible", "collapsible-trigger", "collapsible-content",
  "command", "command-input", "command-list", "command-empty", "command-group", "command-item",
  "command-dialog", "command-shortcut", "command-separator",
  "dialog", "dialog-trigger", "dialog-content", "dialog-header", "dialog-footer",
  "dialog-title", "dialog-description", "dialog-close", "dialog-overlay", "dialog-portal",
  "drawer", "drawer-trigger", "drawer-content", "drawer-header", "drawer-footer",
  "drawer-title", "drawer-description", "drawer-close", "drawer-overlay", "drawer-portal",
  "dropdown-menu", "dropdown-menu-trigger", "dropdown-menu-content", "dropdown-menu-item",
  "dropdown-menu-label", "dropdown-menu-separator", "dropdown-menu-portal",
  "dropdown-menu-group", "dropdown-menu-checkbox-item", "dropdown-menu-radio-group",
  "dropdown-menu-radio-item", "dropdown-menu-shortcut", "dropdown-menu-sub",
  "dropdown-menu-sub-trigger", "dropdown-menu-sub-content",
  "field", "field-content", "field-description", "field-error", "field-group",
  "field-label", "field-legend", "field-separator", "field-set", "field-title",
  "hover-card", "hover-card-trigger", "hover-card-content",
  "input", "input-group", "input-group-addon", "input-group-button",
  "input-group-input", "input-group-text", "input-group-textarea",
  "input-otp", "input-otp-group", "input-otp-slot", "input-otp-separator",
  "label",
  "pagination", "pagination-content", "pagination-item", "pagination-link",
  "pagination-previous", "pagination-next", "pagination-ellipsis",
  "popover", "popover-trigger", "popover-content", "popover-header", "popover-title",
  "popover-description",
  "progress", "progress-track", "progress-indicator", "progress-label", "progress-value",
  "radio-group", "radio-group-item",
  "scroll-area", "scroll-bar",
  "select", "select-trigger", "select-value", "select-content", "select-item",
  "select-group", "select-label", "select-separator", "select-scroll-up-button",
  "select-scroll-down-button",
  "separator",
  "sheet", "sheet-trigger", "sheet-content", "sheet-header", "sheet-footer",
  "sheet-title", "sheet-description", "sheet-close",
  "skeleton",
  "slider",
  "switch",
  "table", "table-header", "table-body", "table-footer", "table-row",
  "table-head", "table-cell", "table-caption",
  "tabs", "tabs-list", "tabs-trigger", "tabs-content",
  "textarea",
  "toggle", "toggle-group", "toggle-group-item",
  "tooltip", "tooltip-trigger", "tooltip-content", "tooltip-provider",
];

const htmlFallback = (tag) => ({ children, ...props }) =>
  React.createElement(tag, props, children);

/* Mirror of design-v3 COMPONENT_PRIMITIVES, sourced from window.UI. */
const COMPONENT_PRIMITIVES = {};
for (const slug of PRIMITIVE_SLUGS) {
  if (UI_BY_SLUG[slug]) COMPONENT_PRIMITIVES[slug] = UI_BY_SLUG[slug];
}
// Special cases, exactly as design-v3:
COMPONENT_PRIMITIVES["asset"] = AssetPrimitive;     // standalone: token -> Lucide
COMPONENT_PRIMITIVES["form"] = htmlFallback("form"); // shadcn has no Form wrapper -> <form>
// HTML fallbacks (design-v3 ships div/span/p/ul/li/img):
for (const tag of ["div", "span", "p", "ul", "li", "img"]) {
  COMPONENT_PRIMITIVES[tag] = htmlFallback(tag);
}
// Note: design-v3 internal previews `drawer-static` and `xpos-checkout-form`
// are backend/preview-only customs and are intentionally omitted (-> ?badge).

/* Recursive walker — verbatim shape of design-v3 ScreenRenderer.
   Lookup: exact slug, else its componentCatalogSlug. Authored seeds carry
   `componentSlug`; the post-KG render tree carries `component` — accept both. */
function RenderNode({ node }) {
  if (node == null) return null;
  if (typeof node === "string") return node;
  const slug = node.component || node.componentSlug;
  const Comp = COMPONENT_PRIMITIVES[slug] ?? COMPONENT_PRIMITIVES[componentCatalogSlug(slug)];
  if (!Comp) {
    return React.createElement(
      "span",
      { className: "rounded bg-rose-500/10 px-1 font-mono text-[10px] text-rose-300" },
      "?" + slug,
    );
  }
  const kids = [];
  if (node.text != null && node.text !== "") kids.push(node.text);
  if (Array.isArray(node.children)) {
    node.children.forEach((c, i) =>
      kids.push(React.createElement(RenderNode, { key: (c && c.id) || i, node: c })),
    );
  }
  return React.createElement(Comp, { ...(node.props || {}) }, kids.length ? kids : undefined);
}

/* Mobile-first wrapper — NO device frame. Full-width column capped & centered
   on wide screens so mobile layouts stay readable; the brand mesh background
   shows through (no device chrome, ring, or contrasting page backdrop). */
function MobileFirst({ children }) {
  return (
    <div className="min-h-screen w-full flex justify-center">
      <div className="relative flex min-h-screen w-full max-w-[480px] flex-col">
        {children}
      </div>
    </div>
  );
}

/* Opt-in full-bleed for screen.viewport === "desktop". */
function FullBleed({ children }) {
  return <div className="min-h-screen w-full">{children}</div>;
}

// Light/dark is fixed per FILE (the <html class> set at build time), NOT a
// runtime toggle: make-shell.mjs emits shell.html (dark) + shell-light.html
// (light). The brand tokens for both schemes live in the inlined
// vnpay-glass.css (:root = light, html.dark = dark).

/* Accept { screen: {...} } | { roots: [...] } | [ ...roots ]. */
function extractScreen(data) {
  if (!data) return null;
  if (data.screen) return data.screen;
  if (data.roots) return data;
  if (Array.isArray(data)) return { roots: data };
  return data;
}

async function loadScreen() {
  // fetch-first (2-file mode: shell.html + screen.json served together).
  try {
    const res = await fetch("./screen.json", { cache: "no-store" });
    if (res.ok) return extractScreen(await res.json());
  } catch (e) {
    /* null-origin / file:// -> fall through to inline fallback */
  }
  // fail-soft: inline <script type="application/json" id="screen"> if present.
  const el = document.getElementById("screen");
  if (el && el.textContent.trim()) return extractScreen(JSON.parse(el.textContent));
  throw new Error("Khong nap duoc screen.json (fetch that bai va khong co inline fallback).");
}

function App() {
  const [screen, setScreen] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    loadScreen()
      .then((s) => { if (alive) setScreen(s); })
      .catch((e) => { if (alive) setError(e.message || String(e)); });
    return () => { alive = false; };
  }, []);

  let body;
  if (error) {
    body = (
      <div className="min-h-screen grid place-items-center p-8 text-center">
        <div className="max-w-md rounded-lg border border-rose-500/30 bg-rose-500/10 p-6 text-rose-200">
          <p className="mb-1 font-semibold">Không render được màn hình</p>
          <p className="text-sm opacity-80">{error}</p>
        </div>
      </div>
    );
  } else if (!screen) {
    body = (
      <div className="min-h-screen grid place-items-center text-sm text-muted-foreground">
        Đang nạp…
      </div>
    );
  } else {
    const roots = (screen.roots || []).map((r, i) =>
      React.createElement(RenderNode, { key: (r && r.id) || i, node: r }),
    );
    // Mobile-first by default (no frame); opt into full-bleed for desktop.
    const Wrap = screen.viewport === "desktop" ? FullBleed : MobileFirst;
    body = <Wrap>{roots}</Wrap>;
  }

  return body;
}

createRoot(document.getElementById("root")).render(<App />);
