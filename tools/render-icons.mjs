// Renders module/assets/icon.svg, the one source for the Music Deck icon, to the Stream Deck
// plugin icons (256 px and @2x 512 px). Re-run after replacing icon.svg.
// Run: PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node tools/render-icons.mjs
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const svg = readFileSync(new URL("module/assets/icon.svg", root), "utf8");
const out = "deck-plugin/com.edenmichal.musicdeck.sdPlugin/imgs/plugin/";
const browser = await chromium.launch();
try {
  for (const [size, name] of [[256, "icon.png"], [512, "icon@2x.png"]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    await page.setContent(`<!doctype html><body style="margin:0;background:transparent"><img id="icon" width="${size}" height="${size}" style="display:block" src="${src}"></body>`);
    await page.waitForFunction(() => document.getElementById("icon").complete);
    const path = decodeURIComponent(new URL(out + name, root).pathname);
    await page.screenshot({ path, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log(`Rendered ${out}${name}`);
  }
} finally {
  await browser.close();
}
