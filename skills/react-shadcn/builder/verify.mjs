// Headless render check for assets/shell.html: mounts the real artifact in
// chromium, lets it fetch ./screen.json, and asserts the JSON-driven renderer
// walked the tree into verbatim components with no unresolved slugs.
import pw from "/Users/anhnd13/Downloads/open-design-main/node_modules/.pnpm/@playwright+test@1.60.0/node_modules/@playwright/test/index.js";
const { chromium } = pw;
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const target = pathToFileURL(resolve(here, "../assets/shell.html")).href;

// Light/dark is per-file: shell.html (dark) + shell-light.html (light), no toggle.
const lightPath = resolve(here, "../assets/shell-light.html");
const lightFileOk =
  existsSync(lightPath) && /<html[^>]*class="(?!.*dark)[^"]*"/.test(readFileSync(lightPath, "utf8"));

// --allow-file-access-from-files lets fetch('./screen.json') succeed from a
// file:// page, exercising the real 2-file load path (not just the inline
// fallback). Set PW_CHROME to a chrome/chromium binary if the bundled one is
// missing or version-mismatched.
const browser = await chromium.launch({
  args: ["--allow-file-access-from-files"],
  ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {}),
});
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(target, { waitUntil: "networkidle", timeout: 60000 });
// Wait for React mount + screen.json fetch + Tailwind JIT pass.
await page.waitForSelector('[data-slot="button"]', { timeout: 30000 });
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
    phoneFrame: !!document.querySelector('.rounded-\\[44px\\]'), // expected FALSE (mobile-first, no frame)
    htmlDark: document.documentElement.classList.contains("dark"),
    tabsMounted: !!document.querySelector('[data-slot="tabs"]') || !!document.querySelector('[role="tablist"]'),
    inputMounted: !!document.querySelector("input"),
    cardCount: document.querySelectorAll('[data-slot="card"]').length,
    lucideIcons: document.querySelectorAll("svg.lucide, svg[class*='lucide']").length,
    hasScreenTitle: document.body.innerText.includes("Sản phẩm"),
    unresolved,
    buttonBg: cs?.backgroundColor ?? null,
    primaryToken: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
    tailwindGeneratedRules: !!document.querySelector("style[type='text/tailwindcss']"),
  };
});

console.log(JSON.stringify(report, null, 2));
console.log("CONSOLE ERRORS:", errors.length ? errors : "none");
console.log("shell-light.html present & light:", lightFileOk);
await browser.close();

const ok =
  report.globals.UI === "object" &&
  report.globals.uiCount > 30 &&
  report.rootChildren > 0 &&
  !report.phoneFrame &&            // mobile-first default → NO device frame
  report.htmlDark &&               // shell.html is the dark file
  lightFileOk &&                   // shell-light.html exists and is the light file
  report.cardCount > 0 &&
  report.hasScreenTitle &&
  report.unresolved.length === 0 &&
  report.primaryToken.length > 0 &&
  report.buttonBg && report.buttonBg !== "rgba(0, 0, 0, 0)";
console.log(ok ? "\nVERIFY: PASS" : "\nVERIFY: FAIL");
process.exit(ok ? 0 : 1);
