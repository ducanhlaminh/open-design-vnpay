import { describe, expect, it } from "vitest";
import {
  DASH_PROP,
  STYLE_DEFAULTS,
  SVG_PRESENTATION_DEFAULTS,
  toDashProp,
} from "../src/style-defaults.js";

// The DOM-dependent serializer is exercised by the browser harnesses (tests/harness*.html,
// run under headless Chromium). These node-safe unit tests guard the factual CSS default tables
// and the camel→dash mapping the Typed-OM lookups depend on.
describe("toDashProp", () => {
  it("camel-cases to kebab", () => {
    expect(toDashProp("backgroundColor")).toBe("background-color");
    expect(toDashProp("gridTemplateColumns")).toBe("grid-template-columns");
    expect(toDashProp("width")).toBe("width");
  });
  it("prefixes webkit props with a dash", () => {
    expect(toDashProp("webkitTextFillColor")).toBe("-webkit-text-fill-color");
  });
});

describe("STYLE_DEFAULTS", () => {
  it("covers the expected breadth of properties", () => {
    expect(Object.keys(STYLE_DEFAULTS).length).toBeGreaterThan(120);
  });
  it("keeps Chromium-specific defaults the filter relies on", () => {
    expect(STYLE_DEFAULTS.fontFamily).toBe("Times");
    expect(STYLE_DEFAULTS.display).toBe("");
    expect(STYLE_DEFAULTS.transformOrigin).toBe("auto");
    expect(STYLE_DEFAULTS.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });
  it("has a dash mapping for every default prop", () => {
    for (const prop of Object.keys(STYLE_DEFAULTS)) {
      expect(DASH_PROP[prop]).toBe(toDashProp(prop));
    }
  });
});

describe("SVG_PRESENTATION_DEFAULTS", () => {
  it("includes core paint defaults", () => {
    expect(SVG_PRESENTATION_DEFAULTS.fill).toBe("rgb(0, 0, 0)");
    expect(SVG_PRESENTATION_DEFAULTS.stroke).toBe("none");
  });
});
