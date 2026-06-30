// The DOM realm a capture runs against. When serializing an offscreen <iframe> (the web app's
// "Copy to Figma" renders the artifact in a same-origin srcdoc iframe), getComputedStyle,
// createRange, DOMMatrix, CSSStyleSheet etc. MUST come from the iframe's window/document — a
// Range created in the parent document throws WrongDocumentError on selectNode of an iframe node,
// and constructed stylesheets can't be adopted across realms. Thread this everywhere DOM globals
// would otherwise be implicit.

export interface Realm {
  doc: Document;
  win: Window & typeof globalThis;
}

export function realmOf(node: Node | Document): Realm {
  const doc = node.nodeType === Node.DOCUMENT_NODE ? (node as Document) : node.ownerDocument!;
  const win = (doc.defaultView ?? window) as Window & typeof globalThis;
  return { doc, win };
}
