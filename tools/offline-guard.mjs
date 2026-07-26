/* =====================================================================
 * Logistics Flow Studio - tools/offline-guard.mjs
 * ---------------------------------------------------------------------
 * Offline guard: the app must make ZERO runtime network requests. This
 * scans every tracked app file (.html, .css, .js, .mjs, .webmanifest)
 * for external-asset references and exits nonzero if any is found:
 *
 *   - src= / href= pointing at http(s)://           (scripts, styles,
 *     images, fonts, iframes)
 *   - a real CSS @import (any @import followed by a url( or a quote -
 *     even a local one would miss the service-worker precache list)
 *   - url(http...) in CSS
 *   - fetch("http... / new WebSocket("http... in JS
 *
 * Allowed by design: xmlns attributes, protocol *checks* like
 * location.protocol !== "http:", and prose in comments or Markdown
 * (Markdown is not scanned - github.com anchors in README are fine).
 *
 * Usage:  node tools/offline-guard.mjs
 * ASCII-only output. Exit 0 = clean.
 * ===================================================================== */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/)
  .filter((f) => /\.(html|css|js|mjs|webmanifest)$/i.test(f));

const RULES = [
  { id: "external src/href", re: /(?:src|href)\s*=\s*["']https?:\/\//i },
  { id: "CSS @import", re: /@import\s+(?:url\(|["'])/i },
  { id: "url(http...)", re: /url\(\s*["']?https?:\/\//i },
  { id: "fetch to external host", re: /fetch\(\s*["'`]https?:\/\//i },
  { id: "WebSocket to external host", re: /new\s+WebSocket\(\s*["'`](?:ws|http)s?:\/\//i },
];

let hits = 0;
for (const file of tracked) {
  const lines = readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        console.log("OFFLINE VIOLATION [" + rule.id + "] " + file + ":" + (i + 1) + ": " + line.trim());
        hits++;
      }
    }
  });
}

console.log(
  hits === 0
    ? "Offline guard: clean - no external asset references in " + tracked.length + " app files."
    : "Offline guard: " + hits + " violation(s) found."
);
process.exit(hits === 0 ? 0 : 1);
