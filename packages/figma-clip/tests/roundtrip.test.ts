import { describe, expect, it } from "vitest";

import { irToClip, layoutText, readClip } from "../src/index.js";
import type { IRNode } from "../src/index.js";

const card: IRNode = {
  type: "frame",
  name: "Card",
  layout: { mode: "vertical", gap: 12, padding: [20, 20, 20, 20], sizing: { w: "hug", h: "hug" } },
  style: {
    fills: [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }],
    radius: [16, 16, 16, 16],
    effects: [{ type: "shadow", x: 0, y: 8, blur: 24, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.12 } }],
  },
  children: [
    { type: "text", name: "title", text: { content: "Xin chào Figma", size: 22, weight: 700, color: { r: 0.1, g: 0.1, b: 0.12, a: 1 } } },
    {
      type: "frame",
      name: "btn",
      layout: { mode: "horizontal", padding: [12, 18, 12, 18], justify: "center", align: "center", sizing: { w: "hug", h: "hug" } },
      style: { fills: [{ type: "solid", color: { r: 0.05, g: 0.6, b: 1, a: 1 } }], radius: [10, 10, 10, 10] },
      children: [{ type: "text", name: "lbl", text: { content: "Bắt đầu", size: 15, weight: 700, color: { r: 1, g: 1, b: 1, a: 1 } } }],
    },
  ],
};

describe("irToClip", () => {
  it("produces a clipboard payload that decodes back to the synthesised tree", () => {
    const { html, warnings } = irToClip(card);
    expect(warnings).toEqual([]);
    expect(html).toContain("<!--(figma)");
    expect(html).toContain("<!--(figmeta)");

    const { message } = readClip(html);
    const nodes = message.nodeChanges as Array<Record<string, unknown>>;
    // DOCUMENT + CANVAS + 2 frames + 2 texts
    const names = nodes.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(["Card", "btn", "title", "lbl"]));

    const texts = nodes.filter((n) => n.type === "TEXT");
    expect(texts).toHaveLength(2);
    const title = texts.find((n) => n.name === "title") as Record<string, unknown>;
    expect((title.textData as { characters: string }).characters).toBe("Xin chào Figma");
    expect((title.derivedTextData as { glyphs: unknown[] }).glyphs.length).toBeGreaterThan(0);

    // every glyph's commandsBlob points into the message blob table
    const blobs = message.blobs as unknown[];
    expect(blobs.length).toBeGreaterThan(0);
    for (const t of texts) {
      for (const g of (t.derivedTextData as { glyphs: Array<{ commandsBlob: number }> }).glyphs) {
        expect(g.commandsBlob).toBeGreaterThanOrEqual(0);
        expect(g.commandsBlob).toBeLessThan(blobs.length);
      }
    }
  });

  it("warns and skips characters outside the atlas instead of throwing", () => {
    const { warnings } = irToClip({
      type: "text",
      text: { content: "ok ≈ ✚ end", size: 16, weight: 400 },
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("thiếu glyph");
  });

  it("embeds a raster image as an IMAGE paint with a 20-byte SHA-1 hash", () => {
    // 1x1 red PNG
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const { html, warnings } = irToClip({ type: "image", name: "pic", _w: 64, _h: 64, image: { data: png, format: "image/png", scaleMode: "FILL" } });
    expect(warnings).toEqual([]);
    const { message } = readClip(html);
    const img = (message.nodeChanges as Array<Record<string, unknown>>).find((n) => n.name === "pic")!;
    const paint = (img.fillPaints as Array<Record<string, unknown>>)[0]!;
    expect(paint.type).toBe("IMAGE");
    const hash = (paint.image as { hash: Uint8Array }).hash;
    expect(hash.length).toBe(20);
  });
});

describe("vector icons", () => {
  it("turns SVG paths into editable VECTOR nodes with geometry blobs", () => {
    const { html, warnings } = irToClip({
      type: "vector",
      name: "icon",
      _w: 48,
      _h: 48,
      viewBox: [0, 0, 24, 24],
      paths: [
        // filled triangle
        { d: "M12 2L22 20H2Z", fill: { r: 1, g: 0, b: 0, a: 1 }, fillRule: "nonzero" },
        // stroked check (open path)
        { d: "M20 6L9 17l-5-5", stroke: { r: 0, g: 0.5, b: 0, a: 1 }, strokeWidth: 2 },
      ],
    });
    expect(warnings).toEqual([]);
    const { message } = readClip(html);
    const nodes = message.nodeChanges as Array<Record<string, unknown>>;
    const vectors = nodes.filter((n) => n.type === "VECTOR");
    expect(vectors).toHaveLength(2);
    const filled = vectors[0] as Record<string, unknown>;
    expect(filled.fillPaints).toBeDefined();
    expect((filled.vectorData as { vectorNetworkBlob: number }).vectorNetworkBlob).toBeGreaterThanOrEqual(0);
    // the stroked one carries strokePaints + weight, no fill
    const stroked = vectors[1] as Record<string, unknown>;
    expect(stroked.strokePaints).toBeDefined();
    expect(stroked.strokeWeight).toBeGreaterThan(0);
    // an icon FRAME wraps the vectors at the rendered size
    const iconFrame = nodes.find((n) => n.type === "FRAME" && n.name === "icon") as Record<string, unknown>;
    expect((iconFrame.size as { x: number }).x).toBe(48);
  });
});

describe("layoutText", () => {
  it("lays out Vietnamese diacritics from the atlas", () => {
    const { derivedTextData, glyphBlobs, warnings } = layoutText({ text: "Tiếng Việt", style: "Regular", fontSize: 20 });
    expect(warnings).toEqual([]);
    expect(derivedTextData.glyphs.length).toBe("TiếngViệt".length); // spaces carry no glyph
    expect(glyphBlobs.length).toBeGreaterThan(0);
    expect(derivedTextData.layoutSize.x).toBeGreaterThan(0);
  });
});
