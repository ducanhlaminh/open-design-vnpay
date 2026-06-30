// Headless render check for JSON-driven shell artifacts.
//
// Usage:
//   node verify.mjs                  Self-test: renders ../assets/shell.html with the
//                                    bundled sample screen.json and asserts the known
//                                    sample content mounted (cards, tabs, title…).
//   node verify.mjs <path>           Generic artifact check: <path> is an .html file or
//                                    a directory containing shell.html (+ screen.json).
//                                    Asserts: root mounted, ZERO unresolved "?slug"
//                                    badges, zero console errors.
//
// Chromium resolution order: $PW_CHROME -> system Google Chrome (macOS default
// path) -> playwright-core's bundled browser if installed. playwright-core is a
// local devDependency of this builder (npm install in builder/ first).
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const here = dirname(fileURLToPath(import.meta.url));

// ---- target resolution ------------------------------------------------------
const arg = process.argv[2];
const selfTest = !arg;
let targetHtml;
if (selfTest) {
  targetHtml = resolve(here, "../assets/shell.html");
} else {
  const p = resolve(process.cwd(), arg);
  if (!existsSync(p)) {
    console.error(`verify: path not found: ${p}`);
    process.exit(2);
  }
  if (statSync(p).isDirectory()) {
    const candidates = ["shell.html", "index.html", "shell-light.html"];
    const hit = candidates.map((c) => resolve(p, c)).find((f) => existsSync(f));
    if (!hit) {
      console.error(`verify: no shell.html/index.html in directory: ${p}`);
      process.exit(2);
    }
    targetHtml = hit;
  } else {
    targetHtml = p;
  }
}
const target = pathToFileURL(targetHtml).href;

// ---- chromium executable ----------------------------------------------------
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath =
  process.env.PW_CHROME || (existsSync(MAC_CHROME) ? MAC_CHROME : undefined);

// --allow-file-access-from-files lets fetch('./screen.json') succeed from a
// file:// page, exercising the real 2-file load path (not just the inline
// fallback).
const browser = await chromium.launch({
  args: ["--allow-file-access-from-files"],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage();
const errors = [];
// Generic "Failed to load resource" console noise (favicon etc.) is tracked
// per-URL via requestfailed instead — only screen.json failures are fatal.
page.on("console", (m) => {
  if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
const failedRequests = [];
page.on("requestfailed", (r) => failedRequests.push(r.url()));

await page.goto(target, { waitUntil: "networkidle", timeout: 60000 });
// Wait for React mount (any rendered child under #root), then give the
// Tailwind v4 in-browser engine a beat to JIT the DOM classes.
await page.waitForFunction(
  () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
  { timeout: 30000 },
);
await page.waitForTimeout(1200);

const report = await page.evaluate(() => {
  const btn = document.querySelector('[data-slot="button"]');
  const cs = btn ? getComputedStyle(btn) : null;
  // Unresolved slugs render as a red "?slug" badge — count any that leaked.
  const unresolved = Array.from(document.querySelectorAll("span"))
    .filter((s) => /^\?\S+$/.test(s.textContent.trim()))
    .map((s) => s.textContent.trim());
  return {
    globals: {
      React: typeof window.React,
      UI: typeof window.UI,
      uiCount: window.UI ? Object.keys(window.UI).length : 0,
      Lucide: typeof window.Lucide,
      cn: typeof window.cn,
    },
    rootChildren: document.getElementById("root")?.childElementCount ?? 0,
    htmlDark: document.documentElement.classList.contains("dark"),
    tabsMounted: !!document.querySelector('[data-slot="tabs"]') || !!document.querySelector('[role="tablist"]'),
    cardCount: document.querySelectorAll('[data-slot="card"]').length,
    lucideIcons: document.querySelectorAll("svg.lucide, svg[class*='lucide']").length,
    hasScreenTitle: document.body.innerText.includes("Sản phẩm"),
    unresolved,
    // The render block mounts this error box when screen.json could not load.
    loadErrorBox: document.body.innerText.includes("Không render được màn hình"),
    buttonBg: cs?.backgroundColor ?? null,
    primaryToken: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
  };
});

console.log(JSON.stringify(report, null, 2));
console.log("CONSOLE ERRORS:", errors.length ? errors : "none");
const fatalFailedRequests = failedRequests.filter((u) => /screen\.json(\?|$)/.test(u));
if (failedRequests.length) console.log("FAILED REQUESTS:", failedRequests);
await browser.close();

// ---- assertions ---------------------------------------------------------------
// Generic gate (every artifact must pass):
const genericOk =
  report.rootChildren > 0 &&
  report.unresolved.length === 0 &&
  !report.loadErrorBox &&
  fatalFailedRequests.length === 0 &&
  errors.length === 0;

let ok = genericOk;
if (selfTest) {
  // Self-test additionally pins the known sample-screen content and the
  // light/dark two-file convention of the shipped assets.
  const lightPath = resolve(here, "../assets/shell-light.html");
  const lightFileOk =
    existsSync(lightPath) &&
    /<html[^>]*class="(?!.*dark)[^"]*"/.test(readFileSync(lightPath, "utf8"));
  console.log("shell-light.html present & light:", lightFileOk);
  ok =
    genericOk &&
    report.globals.UI === "object" &&
    report.globals.uiCount > 30 &&
    report.htmlDark &&
    lightFileOk &&
    report.cardCount > 0 &&
    report.hasScreenTitle &&
    report.primaryToken.length > 0 &&
    report.buttonBg && report.buttonBg !== "rgba(0, 0, 0, 0)";
}

console.log(ok ? "\nVERIFY: PASS" : "\nVERIFY: FAIL");
process.exit(ok ? 0 : 1);
