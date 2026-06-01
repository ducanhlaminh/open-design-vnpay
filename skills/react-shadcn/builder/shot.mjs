// Render any artifact HTML in chromium and save a screenshot.
// Usage: PW_CHROME=<chrome> node shot.mjs <path-to.html> [out.png]
import pw from "/Users/anhnd13/Downloads/open-design-main/node_modules/.pnpm/@playwright+test@1.60.0/node_modules/@playwright/test/index.js";
const { chromium } = pw;
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const input = process.argv[2] ?? "../assets/shell.html";
const out = process.argv[3] ?? "/tmp/react-shadcn-shot.png";

// --allow-file-access-from-files so fetch('./screen.json') works from file://.
const browser = await chromium.launch({
  args: ["--allow-file-access-from-files"],
  ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(pathToFileURL(resolve(input)).href, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector("#root *", { timeout: 30000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log("screenshot:", out, errors.length ? `\npageerrors: ${errors}` : "(no page errors)");
