// @ts-nocheck
// Vendored from design-v3 fig-pipeline/tools/capture-lib.mjs (branch
// feat/ui-figma-new) — the figma-h2d full-IR capture helpers (marker stamp,
// tk-* token hints, style-diffs, svg-text splice, transform bake). All
// functions take a Playwright page; loadH2dBundle is NOT used here (the
// bundle comes from @open-design/figma-h2d/global instead). Kept verbatim
// apart from this header; re-vendor instead of editing.
// capture-lib.mjs — máy capture PORT TỪ contract-pipeline/studio/scripts/capture-lib.mjs
// (figma-h2d full-IR capture, KHÔNG phải extractor flex tự chế). Khác bản gốc:
//  - marker component là data-fig-comp/variant/props (dispatch của compile-core
//    stamp khi window.__FIG_CAPTURE__) → stampFigMarkers đặt data-slot để figh2d
//    tự emit owningReactComponent "kg:fig|fig-comp=…" — plugin dựng INSTANCE.
//  - không stamp token bg/text/border (fig-pipeline không có contract token);
//    fx (flex/grid/block) + invisible giữ nguyên logic gốc.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

/** figma-h2d capture engine bundle (vendored). */
export function loadH2dBundle() {
  return readFileSync(resolve(HERE, "vendor/figma-h2d.global.js"), "utf8")
}

export async function gotoRetry(page, url) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(url, { waitUntil: "load", timeout: 15000 })
      return
    } catch (e) {
      if (i === 2) throw e
      await page.waitForTimeout(500)
    }
  }
}

/** Webfonts + capture-hostile CSS neutralized (transition/animation TẮT HẲN —
 *  neutralizeTransformPositioning đo NGAY sau khi set translate:none; một
 *  CSSTransition làm giá trị đo được vẫn là giá trị cũ → element trôi SAU đo). */
export async function preparePageForCapture(page, rootSelector = "#root > *") {
  await page.waitForSelector(rootSelector, { timeout: 10000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  await page.addStyleTag({
    content:
      '[data-capture="skip"] { display: none !important; } ' +
      '* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; } ' +
      '*, *::before, *::after { transition: none !important; animation: none !important; }',
  })
}

/** Stamp markers cho figh2d:
 *  1. [data-fig-comp] → data-slot="fig" + re-encode variant/props qua
 *     encodeURIComponent (format marker của figh2d split theo ";" và "=" —
 *     JSON thô có thể chứa cả hai).
 *  2. Container flex/grid/block → data-fx (dir,justify,align,gap,wrap |
 *     grid,cols,rows,colGap,rowGap) + data-slot="tk" — plugin đọc KHAI BÁO
 *     flex của CSS thay vì chỉ đoán hình học rồi revert.
 *  3. Phần tử vô hình (opacity 0 / visibility hidden) → data-invisible.
 *  4. Class tk-* → TÊN TOKEN (đọc từ CSS RULE thật trong globals.css, value
 *     `var(--<token>…)`) stamp data-bg/data-text/data-border/data-radius/
 *     data-shadow — plugin bind variable/style Figma THEO TÊN (value-match
 *     chỉ còn là fallback). Inline `style="…var(--token)"` được vớt sau class
 *     (class thắng) — kênh chuẩn vẫn là class, xem verify.mjs của ui-react-ds. */
export async function stampFigMarkers(page, rootSelector = "#root > *") {
  await page.evaluate((rootSel) => {
    const screenRoot = document.querySelector(rootSel)
    // className tk-* → [{prop, token}] từ stylesheet (nguồn sự thật, không
    // suy từ tên class — suffix -2/-3 khi trùng tên làm reverse-parse sai).
    const tkMap = new Map()
    for (const sheet of document.styleSheets) {
      let rules
      try { rules = sheet.cssRules } catch { continue }
      for (const rule of rules) {
        const sel = rule.selectorText
        if (!sel || !rule.style || sel.indexOf(".tk-") !== 0 || sel.indexOf(",") >= 0 || sel.indexOf(" ") >= 0) continue
        const cls = sel.slice(1)
        // PARSE cssText chứ KHÔNG iterate rule.style: shorthand chứa var()
        // (background/border-color/border-radius của compile-core) enumerate
        // ra RỖNG trong CSSOM — chỉ longhand `color` hiện, bg/border/radius
        // mất sạch hint vì thế.
        const decls = []
        const re = /([-a-zA-Z]+)\s*:\s*[^;{}]*?var\(\s*--([a-zA-Z0-9-]+)/g
        let dm
        while ((dm = re.exec(rule.cssText))) decls.push({ prop: dm[1].toLowerCase(), token: dm[2] })
        if (decls.length) tkMap.set(cls, decls)
      }
    }
    const HINT_ATTR = (prop) => {
      if (prop === "background-color" || prop === "background") return "bg"
      if (prop === "color") return "text"
      if (prop.indexOf("radius") >= 0) return "radius"
      if (prop.indexOf("border") === 0) return "border" // border-color / border-bottom…
      if (prop === "box-shadow") return "shadow"
      // typography: token mang sẵn NHÓM (typography-<group>-font-size…) —
      // plugin gắn TEXT STYLE Figma theo TÊN nhóm thay vì đoán metrics.
      if (prop === "font-size") return "fs"
      if (prop === "line-height") return "lh"
      if (prop === "font-weight") return "fw"
      if (prop === "letter-spacing") return "ls"
      return null
    }
    for (const el of document.body.querySelectorAll("*")) {
      if (el === screenRoot) continue
      if (el.dataset && el.dataset.figComp != null) {
        // Component instance marker — encode phần JSON để sống sót format kg:|k=v;k=v
        el.dataset.slot = "fig"
        if (el.dataset.figVariant) el.dataset.figVariant = encodeURIComponent(el.dataset.figVariant)
        if (el.dataset.figProps) el.dataset.figProps = encodeURIComponent(el.dataset.figProps)
        continue
      }
      const cs = getComputedStyle(el)
      const invisible = parseFloat(cs.opacity) === 0 || cs.visibility === "hidden"
      let fx = null
      if (cs.display === "grid" && el.childElementCount > 0) {
        const cols = (cs.gridTemplateColumns || "").split(" ").filter(Boolean).length || 1
        const rows = (cs.gridTemplateRows || "").split(" ").filter(Boolean).length || 1
        const nRows = Math.max(rows, Math.ceil(el.childElementCount / cols))
        fx = "grid," + cols + "," + nRows + "," + (Math.round((parseFloat(cs.columnGap) || 0) * 100) / 100) + "," + (Math.round((parseFloat(cs.rowGap) || 0) * 100) / 100)
      }
      if (!fx && (cs.display === "block" || cs.display === "flow-root") && el.childElementCount >= 2) {
        fx = "col,start,stretch,0,0"
      }
      if (!fx && (cs.display === "flex" || cs.display === "inline-flex") && el.childElementCount > 0) {
        const dir = (cs.flexDirection || "row").startsWith("column") ? "col" : "row"
        const jMap = { "flex-start": "start", start: "start", left: "start", center: "center", "flex-end": "end", end: "end", right: "end", "space-between": "between", "space-around": "around", "space-evenly": "evenly", normal: "start" }
        const aMap = { "flex-start": "start", start: "start", center: "center", "flex-end": "end", end: "end", stretch: "stretch", baseline: "center", normal: "stretch" }
        const j = jMap[cs.justifyContent] || "start"
        const a = aMap[cs.alignItems] || "stretch"
        const gap = dir === "row" ? parseFloat(cs.columnGap) || 0 : parseFloat(cs.rowGap) || 0
        const wrap = cs.flexWrap === "wrap" ? 1 : 0
        fx = dir + "," + j + "," + a + "," + Math.round(gap * 100) / 100 + "," + wrap
      }
      // Token hints từ class tk-* (bg/text/border/radius/shadow)
      let hinted = false
      for (const cls of el.classList) {
        const decls = tkMap.get(cls)
        if (!decls) continue
        for (const { prop, token } of decls) {
          const attr = HINT_ATTR(prop)
          if (attr && !el.dataset[attr]) {
            el.dataset[attr] = token
            hinted = true
          }
        }
      }
      // FALLBACK: token viết thẳng inline `style="color: var(--x)"`. Kênh chính
      // vẫn là class tk-* (skill ui-react-ds cấm inline token, verify.mjs chặn)
      // — nhưng nếu lọt thì vớt ở đây, thà bind muộn còn hơn mất token im lặng
      // và pha ra giá trị chết trong Figma. Class thắng: chỉ ghi khi còn trống.
      const inlineCss = el.getAttribute("style")
      if (inlineCss && inlineCss.indexOf("var(--") >= 0) {
        const inlineRe = /([-a-zA-Z]+)\s*:\s*[^;]*?var\(\s*--([a-zA-Z0-9-]+)/g
        let im
        while ((im = inlineRe.exec(inlineCss))) {
          const attr = HINT_ATTR(im[1].toLowerCase())
          if (attr && !el.dataset[attr]) {
            el.dataset[attr] = im[2]
            hinted = true
          }
        }
      }
      if (!fx && !invisible && !hinted) continue
      if (fx) el.dataset.fx = fx
      if (invisible) el.dataset.invisible = ""
      if (!el.dataset.slot) el.dataset.slot = "tk"
    }
  }, rootSelector)
}

/** STYLE-DIFF per element — diff computed style vs default ĐÚNG TAG (iframe
 *  sạch), catalog prop plugin dùng được. Correlate IR↔DOM qua key tag+rect.
 *  PORT VERBATIM từ contract capture-lib. */
export async function collectStyleDiffs(page, rootSelector = "#root > *") {
  return page.evaluate((rootSel) => {
    const CATALOG = [
      "display", "flexDirection", "flexWrap", "flexGrow", "flexShrink", "flexBasis",
      "gridTemplateColumns", "gridTemplateRows", "gridAutoFlow",
      "gridColumnStart", "gridColumnEnd", "gridRowStart", "gridRowEnd",
      "justifyContent", "justifyItems", "justifySelf",
      "alignContent", "alignItems", "alignSelf",
      "rowGap", "columnGap", "order",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "marginTop", "marginRight", "marginBottom", "marginLeft",
      "top", "right", "bottom", "left", "position", "zIndex",
      "overflowX", "overflowY", "boxSizing",
      "opacity", "transform", "boxShadow", "mixBlendMode",
      "outlineWidth", "outlineStyle", "outlineColor", "outlineOffset",
      "borderTopWidth", "borderTopStyle", "borderTopColor",
      "borderRightWidth", "borderRightStyle", "borderRightColor",
      "borderBottomWidth", "borderBottomStyle", "borderBottomColor",
      "borderLeftWidth", "borderLeftStyle", "borderLeftColor",
      "backgroundImage", "backgroundColor",
      "textTransform", "letterSpacing", "textAlign", "whiteSpace",
      "textOverflow", "webkitLineClamp",
    ]
    const root = document.querySelector(rootSel)
    if (!root) return []
    let iframe = document.getElementById("__fig_style_defaults")
    if (!iframe) {
      iframe = document.createElement("iframe")
      iframe.id = "__fig_style_defaults"
      // KHÔNG display:none — computed style trong iframe display:none trả rỗng
      iframe.style.cssText = "position:absolute;left:-9999px;top:0;width:10px;height:10px;visibility:hidden;border:0"
      document.documentElement.appendChild(iframe)
    }
    const idoc = iframe.contentDocument
    const iwin = iframe.contentWindow
    const defaults = new Map()
    const defaultsFor = (tag) => {
      let d = defaults.get(tag)
      if (d) return d
      let el
      try { el = idoc.createElement(tag) } catch { el = idoc.createElement("div") }
      idoc.body.appendChild(el)
      const cs = iwin.getComputedStyle(el)
      d = {}
      for (const p of CATALOG) d[p] = cs[p]
      el.remove()
      defaults.set(tag, d)
      return d
    }
    const JUNK = new Set(["none", "normal", "auto", "0px", "rgba(0, 0, 0, 0)"])
    const round2 = (v) => v.replace(/-?\d+\.\d{3,}/g, (m) => String(Math.round(parseFloat(m) * 100) / 100))
    const out = []
    const visit = (el) => {
      if (el.tagName.toLowerCase() === "svg") return
      const cs = getComputedStyle(el)
      const def = defaultsFor(el.tagName.toLowerCase())
      const d = {}
      for (const p of CATALOG) {
        const v = cs[p]
        if (!v || v === def[p] || JUNK.has(v)) continue
        d[p] = round2(v)
      }
      for (const edge of ["Top", "Right", "Bottom", "Left"]) {
        if ((cs["border" + edge + "Width"] || "0px") === "0px") {
          delete d["border" + edge + "Style"]
          delete d["border" + edge + "Color"]
        }
      }
      if ((cs.outlineWidth || "0px") === "0px" || cs.outlineStyle === "none") {
        delete d.outlineWidth
        delete d.outlineStyle
        delete d.outlineColor
        delete d.outlineOffset
      }
      if (Object.keys(d).length) {
        const r = el.getBoundingClientRect()
        out.push({
          k: el.tagName.toUpperCase() + "|" + Math.round(r.x) + "," + Math.round(r.y) + "," + Math.round(r.width) + "," + Math.round(r.height),
          d,
        })
      }
      for (const c of el.children) visit(c)
    }
    visit(root)
    return out
  }, rootSelector)
}

/** Splice style-diff records vào IR (field MỚI `styleDiff`). PORT VERBATIM. */
export function spliceStyleDiffs(docObj, diffs) {
  if (!diffs || !diffs.length) return docObj
  const byKey = new Map()
  for (const rec of diffs) {
    const arr = byKey.get(rec.k) ?? []
    arr.push(rec.d)
    byKey.set(rec.k, arr)
  }
  const walk = (n) => {
    const tag = (n.tag || "").toLowerCase()
    if (tag === "svg") return
    if (Number(n.nodeType) === 1 && n.tag && n.rect) {
      const k = n.tag.toUpperCase() + "|" + Math.round(n.rect.x) + "," + Math.round(n.rect.y) + "," + Math.round(n.rect.width) + "," + Math.round(n.rect.height)
      const arr = byKey.get(k)
      if (arr && arr.length) {
        const d = arr.shift()
        const st = n.styles ?? {}
        const norm = (v) => String(v ?? "").replace(/-?\d+\.\d{3,}/g, (m) => String(Math.round(parseFloat(m) * 100) / 100))
        const slim = {}
        for (const p of Object.keys(d)) if (norm(st[p]) !== d[p]) slim[p] = d[p]
        if (Object.keys(slim).length) n.styleDiff = slim
      }
    }
    ;(n.childNodes || []).forEach(walk)
  }
  walk(docObj.root ?? docObj)
  return docObj
}

/** Overlay portals position bằng transform/translate — figh2d rơi transform:
 *  bake viewport box thật vào left/top trước capture. PORT VERBATIM. */
export async function neutralizeTransformPositioning(page) {
  await page.evaluate(() => {
    const targets = []
    for (const el of document.body.querySelectorAll("*")) {
      const cs = getComputedStyle(el)
      const hasTransform = cs.transform !== "none"
      const hasTranslate = cs.translate && cs.translate !== "none"
      if (!hasTransform && !hasTranslate) continue
      targets.push({ el, want: el.getBoundingClientRect() })
    }
    for (const { el, want } of targets) {
      el.style.transform = "none"
      el.style.translate = "none"
      const now = el.getBoundingClientRect()
      if (Math.abs(now.left - want.left) < 0.5 && Math.abs(now.top - want.top) < 0.5) continue
      const cs = getComputedStyle(el)
      if (cs.position === "static") el.style.position = "relative"
      const left = parseFloat(cs.left) || 0
      const top = parseFloat(cs.top) || 0
      el.style.left = left + (want.left - now.left) + "px"
      el.style.top = top + (want.top - now.top) + "px"
      el.style.right = "auto"
      el.style.bottom = "auto"
      const check = el.getBoundingClientRect()
      if (Math.abs(check.left - want.left) > 0.5 || Math.abs(check.top - want.top) > 0.5) {
        el.style.setProperty("position", "fixed", "important")
        el.style.setProperty("left", want.left + "px", "important")
        el.style.setProperty("top", want.top + "px", "important")
        el.style.setProperty("right", "auto", "important")
        el.style.setProperty("bottom", "auto", "important")
        el.style.setProperty("margin", "0", "important")
        el.style.setProperty("width", want.width + "px", "important")
        el.style.setProperty("height", want.height + "px", "important")
      }
    }
  })
}

/** SVG capture prep — tách <text> khỏi svg (createNodeFromSvg dựng text kém),
 *  stamp data-kg-svg=<idx> để splice. Trả { svgTexts }. PORT từ contract
 *  (bỏ phần colorTokens --chart-*). */
export async function prepareSvgCapture(page) {
  return page.evaluate(() => {
    if (window.__figSvgCapture) return window.__figSvgCapture
    const svgTexts = {}
    let idx = 0
    for (const svg of document.body.querySelectorAll("svg")) {
      const texts = [...svg.querySelectorAll("text")]
      if (!texts.length) continue
      const id = String(idx++)
      svg.setAttribute("data-kg-svg", id)
      const records = []
      const record = (el, textContent) => {
        const r = el.getBoundingClientRect()
        if (!textContent || !textContent.trim() || r.width <= 0) return
        const cs = getComputedStyle(el)
        records.push({
          text: textContent,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          fontFamily: cs.fontFamily,
          color: cs.fill,
          anchor: cs.textAnchor || "start",
        })
      }
      for (const t of texts) {
        const tspans = [...t.querySelectorAll("tspan")].filter((s) => (s.textContent || "").trim())
        if (tspans.length > 0) for (const s of tspans) record(s, s.textContent)
        else record(t, t.textContent)
        window.__figSvgTextRestore = window.__figSvgTextRestore || []
        window.__figSvgTextRestore.push({ parent: t.parentNode, next: t.nextSibling, node: t })
        t.remove()
      }
      if (records.length) svgTexts[id] = records
    }
    window.__figSvgCapture = { svgTexts }
    return window.__figSvgCapture
  })
}

/** Trả svg <text> đã tách về chỗ cũ (TRƯỚC page.screenshot). PORT VERBATIM. */
export async function restoreSvgTexts(page) {
  await page.evaluate(() => {
    const entries = window.__figSvgTextRestore || []
    for (let i = entries.length - 1; i >= 0; i--) {
      const { parent, next, node } = entries[i]
      try { parent.insertBefore(node, next && next.parentNode === parent ? next : null) } catch { /* parent gone */ }
    }
    window.__figSvgTextRestore = []
  })
}

/** Splice svg-text đã tách vào IR (node SVGTEXT tổng hợp). PORT VERBATIM. */
export function spliceSvgTexts(docObj, svgTexts) {
  if (!svgTexts || !Object.keys(svgTexts).length) return docObj
  const walk = (n) => {
    if ((n.tag || "").toLowerCase() === "svg" && typeof n.content === "string") {
      const m = /data-kg-svg="(\d+)"/.exec(n.content)
      const records = m ? svgTexts[m[1]] : null
      if (records && records.length) {
        n.childNodes = (n.childNodes || []).concat(records.map((r) => ({
          nodeType: 1,
          tag: "SVGTEXT",
          styles: {
            fontSize: r.fontSize,
            fontWeight: r.fontWeight,
            fontFamily: r.fontFamily,
            color: r.color,
            lineHeight: `${r.rect.height}px`,
            textAlign: r.anchor === "middle" ? "center" : r.anchor === "end" ? "right" : "left",
          },
          rect: r.rect,
          childNodes: [{ nodeType: 3, text: r.text, rect: r.rect, lineCount: 1 }],
        })))
      }
    }
    ;(n.childNodes || []).forEach(walk)
  }
  walk(docObj.root ?? docObj)
  return docObj
}

/** Capture root với figma-h2d, trả { rect, serialized }. Bundle phải đã được
 *  addScriptTag trước đó. */
export async function captureRootIR(page, rootSelector = "#root > *") {
  return page.evaluate(async (rootSel) => {
    const root = document.querySelector(rootSel)
    if (!root) return { error: "không thấy screen root " + rootSel }
    // eslint-disable-next-line no-undef
    const doc = await figmaH2D.captureElement(root)
    // eslint-disable-next-line no-undef
    const serialized = await figmaH2D.serializeDocument(doc)
    return { rect: (doc.root ?? doc).rect, serialized }
  }, rootSelector)
}

/** Strip phantom 0px insets từ node position:relative. PORT VERBATIM. */
export function sanitizeDoc(obj) {
  const PHANTOM = new Set(["0px", "auto"])
  const walk = (n) => {
    const s = n.styles
    if (s && s.position === "relative") {
      let dropped = 0
      for (const k of ["top", "right", "bottom", "left"]) {
        if (s[k] === undefined || PHANTOM.has(s[k])) {
          delete s[k]
          dropped++
        }
      }
      if (dropped === 4) s.position = "static"
    }
    ;(n.childNodes || []).forEach(walk)
  }
  walk(obj.root ?? obj)
  return obj
}
