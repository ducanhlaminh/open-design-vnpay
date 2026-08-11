import { describe, expect, it } from "vitest";
import { kgComponentMarker } from "../src/serialize.js";

// Minimal Element stand-in: kgComponentMarker only reads tagName, getAttribute
// and attributes. The full serializer is exercised by the browser harnesses.
function el(tag: string, attrs: Record<string, string>): Element {
  return {
    tagName: tag,
    getAttribute: (name: string) => attrs[name] ?? null,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
  } as unknown as Element;
}

describe("kgComponentMarker — design-system icons", () => {
  // fig-import stamps data-fig-icon(+key) into generated SVG markup. Routing it
  // through kg:fig is what lets the paste plugin swap the layer for the real
  // icon INSTANCE; without it the icon lands in Figma as a plain frame.
  it("routes data-fig-icon through the component-swap channel, key included", () => {
    const marker = kgComponentMarker(
      el("svg", { "data-fig-icon": "ic-chevron-left", "data-fig-icon-key": "5263415f10ade112" }),
    );
    expect(marker).toBe("kg:fig|fig-comp=ic-chevron-left;fig-key=5263415f10ade112");
  });

  it("falls back to the icon name when the library exported no component key", () => {
    expect(kgComponentMarker(el("svg", { "data-fig-icon": "ic-lock" }))).toBe("kg:fig|fig-comp=ic-lock");
  });

  it("keeps the lucide naming convention for generic icons", () => {
    expect(kgComponentMarker(el("svg", { class: "lucide lucide-arrow-left" }))).toBe("icon/arrow-left");
  });

  it("leaves an unmarked svg alone", () => {
    expect(kgComponentMarker(el("svg", { class: "logo" }))).toBeUndefined();
  });

  it("still marks data-slot elements and strips the data- prefix", () => {
    expect(kgComponentMarker(el("div", { "data-slot": "tk", "data-bg": "card-card", "data-node-id": "n1" }))).toBe(
      "kg:tk|bg=card-card",
    );
  });
});
