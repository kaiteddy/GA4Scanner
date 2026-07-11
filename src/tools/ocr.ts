/**
 * OCR grounding for GA4 (FileMaker is a custom-drawn canvas with NO accessibility tree, so there
 * is nothing to query for element positions — we must read the pixels). Apple's Vision framework
 * (native Swift binary, on-device, no GPU) turns the current VM screen into a list of text elements
 * with bounding boxes. `find_text` locates by visible text; `click_text` clicks the box Vision reports.
 *
 * EFFICIENCY ("cheapest method that works" — cached coord → OCR):
 *   - The pipeline is cheap already (measured: prlctl capture 0.30s + sips 0.08s + Vision .accurate
 *     0.52s ≈ 0.9s per detection). Vision .fast (~0.1s) was tried and REJECTED — it misses GA4's
 *     small nav/tab text entirely (found 0 of the nav labels), so accurate is the reliable floor.
 *   - A resolution-keyed COORDINATE MEMORY: every OCR bulk-caches the position of each unambiguous
 *     label, so after one detection subsequent clicks on the same screen are INSTANT coordinate
 *     clicks (no capture, no OCR). Keyed by the image height (which encodes the guest resolution),
 *     so a resolution change can't reuse stale coords. Cleared per fill_invoice/issue_invoice op
 *     (invoice.ts) so each operation re-verifies once at its true resolution, then flies.
 *
 * Coordinates are the SAME 1200-wide image space every other tool uses, so an OCR center feeds
 * straight into toAbsoluteCoords/macClick.
 */

import { exec, toAbsoluteCoords, macClickReliable, macDoubleClick } from "../helpers.js";
import { screenshot } from "./screenshot.js";
import { unlink, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

const VM_NAME = "Win11Manual";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BIN = fileURLToPath(new URL("../native/ocr", import.meta.url));
const SRC = fileURLToPath(new URL("../../native/ocr.swift", import.meta.url));

export interface OcrBox {
  text: string; conf: number;
  cx: number; cy: number;         // center (image space)
  x: number; y: number; w: number; h: number;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const dist = (b: { cx: number; cy: number }, p: { x: number; y: number }) => Math.hypot(b.cx - p.x, b.cy - p.y);

// --- resolution-keyed coordinate memory (detect-once, click-many) ---------------------------
let curImgH = 0;                                   // image height of the last OCR = resolution key
const coordMemo = new Map<string, { cx: number; cy: number }>();
const memoKey = (imgH: number, label: string, near?: { x: number; y: number }) =>
  `${imgH}|${norm(label)}|${near ? `${near.x},${near.y}` : ""}`;

/** Drop all learned coordinates + resolution. Call at the start of a multi-click operation so it
 *  re-verifies once at the current resolution instead of trusting a possibly-stale cache. */
export function clearGroundingCache(): void {
  coordMemo.clear();
  curImgH = 0;
}

async function ensureBin(): Promise<void> {
  if (existsSync(BIN)) return;
  await mkdir(dirname(BIN), { recursive: true });
  await exec("swiftc", ["-O", SRC, "-o", BIN]);
}

/** Capture the VM screen (1200-wide, our image space) and OCR it via Apple Vision. Updates the
 *  resolution key and bulk-caches every unambiguous label for later instant clicks. */
export async function ocrScreen(accurate = true): Promise<OcrBox[]> {
  await ensureBin();
  const ts = Date.now();
  const raw = `/tmp/ga4_ocr_${ts}_raw.png`;
  const img = `/tmp/ga4_ocr_${ts}.png`;
  try {
    await exec("prlctl", ["capture", VM_NAME, "--file", raw]);
    await exec("sips", ["-s", "format", "png", "--resampleWidth", "1200", raw, "--out", img]);
    const out = await exec(BIN, accurate ? [img, "--accurate"] : [img]);
    const parsed = JSON.parse(out) as { h: number; boxes: OcrBox[] };
    curImgH = parsed.h || curImgH;
    const boxes = parsed.boxes || [];
    // Bulk-cache: any label appearing EXACTLY ONCE is safe to remember for a no-OCR click later.
    const counts = new Map<string, number>();
    for (const b of boxes) counts.set(norm(b.text), (counts.get(norm(b.text)) ?? 0) + 1);
    for (const b of boxes) if (counts.get(norm(b.text)) === 1) coordMemo.set(memoKey(curImgH, b.text), { cx: b.cx, cy: b.cy });
    return boxes;
  } finally {
    await unlink(raw).catch(() => {});
    await unlink(img).catch(() => {});
  }
}

/** Find on-screen text boxes matching `text` (exact, case/space-insensitive; falls back to substring). */
export function matchText(boxes: OcrBox[], text: string, minConf = 0.3): OcrBox[] {
  const q = norm(text);
  const ok = boxes.filter((b) => b.conf >= minConf);
  const exact = ok.filter((b) => norm(b.text) === q);
  if (exact.length) return exact;
  return ok.filter((b) => norm(b.text).includes(q));
}

export interface ClickTextArgs {
  text: string; near?: { x: number; y: number }; nth?: number; doubleClick?: boolean; minConf?: number;
  // fresh: bypass the coordinate memory and always OCR (correctness over speed). The interactive
  // click_text tool defaults to fresh; the invoice flow leaves it off so repeat clicks are instant.
  fresh?: boolean;
}

// A grounded click must be as reliable as a coordinate one. GA4/FileMaker eats a
// lone click as focus-activate, so the old single `macClick` here meant click_text
// located the right element and then failed to fire it — the "Issue Only" button
// highlighting without issuing (90721, 90723), and nav tabs needing a second call.
// macClickReliable sends two single clicks with a settle gap, which is what lands.
// `doubleClick` still means a TRUE double-click (open record / select word), so it
// keeps distinct semantics rather than collapsing into "click twice".
async function clickAt(cx: number, cy: number, doubleClick?: boolean): Promise<void> {
  const { absX, absY } = await toAbsoluteCoords(cx, cy);
  if (doubleClick) {
    await macDoubleClick(absX, absY);
  } else {
    await macClickReliable(absX, absY);
  }
}

/** Locate `text` (memory-first, else fast OCR, else accurate OCR) and click it. Returns the matched
 *  box. NO screenshot — the reusable primitive invoice.ts calls per grounded click. */
export async function clickTextBox(args: ClickTextArgs): Promise<OcrBox> {
  // Memory-first: instant coordinate click for a label already learned at the current resolution.
  if (!args.fresh && curImgH > 0) {
    const hit = coordMemo.get(memoKey(curImgH, args.text, args.near));
    if (hit) {
      await clickAt(hit.cx, hit.cy, args.doubleClick);
      return { text: args.text, conf: 1, cx: hit.cx, cy: hit.cy, x: hit.cx, y: hit.cy, w: 0, h: 0 };
    }
  }

  // Accurate OCR (Vision .fast misses GA4's small nav/tab text — measured 0 nav labels found — so
  // accurate ~0.5s is the reliable floor; the coordinate cache above is what makes repeats cheap).
  const boxes = await ocrScreen(true);
  const matches = matchText(boxes, args.text, args.minConf);

  if (!matches.length) {
    const q = norm(args.text);
    const stem = q.slice(0, Math.max(3, q.length - 2));
    const cands = boxes.filter((b) => norm(b.text).includes(stem)).slice(0, 8);
    throw new Error(
      `No on-screen text matches "${args.text}". ` +
        (cands.length
          ? `Nearest: ${cands.map((c) => `"${c.text}"@(${c.cx},${c.cy})`).join(", ")}`
          : `Nothing similar found (is the element on screen / the list open?). Use find_text to inspect.`)
    );
  }

  let target: OcrBox | undefined;
  if (args.near) {
    target = [...matches].sort((a, b) => dist(a, args.near!) - dist(b, args.near!))[0];
  } else if (args.nth != null) {
    target = [...matches].sort((a, b) => a.cy - b.cy || a.cx - b.cx)[args.nth];
    if (!target) throw new Error(`nth=${args.nth} out of range (${matches.length} match(es)).`);
  } else if (matches.length > 1) {
    const where = [...matches].sort((a, b) => a.cy - b.cy || a.cx - b.cx).map((m) => `(${m.cx},${m.cy})`).join(", ");
    throw new Error(`"${args.text}" matched ${matches.length} places: ${where}. Pass near:{x,y} or nth to disambiguate.`);
  } else {
    target = matches[0];
  }

  coordMemo.set(memoKey(curImgH, args.text, args.near), { cx: target.cx, cy: target.cy });
  await clickAt(target.cx, target.cy, args.doubleClick);
  return target;
}

// ---------------------------------------------------------------------------------------------
export const findTextTool = {
  name: "find_text",
  description:
    "OCR the current GA4 screen (Apple Vision) and return every text element whose text matches " +
    "`text` (exact first, else substring), each with its center (x,y) in the standard 1200-wide " +
    "image space + confidence. Read-only — does NOT click. Use to locate an element before " +
    "click_text, to disambiguate when a label appears more than once, or to see why a click_text " +
    "missed. Omit `text` to dump ALL detected text (calibrating a new screen).",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: { type: "string", description: "Text to locate, e.g. 'TYPE A - RETAIL'. Omit to list all detected text." },
      minConf: { type: "number", description: "Min OCR confidence 0-1 (default 0.3)." },
      accurate: { type: "boolean", description: "Recognition level (default true — Vision .fast misses GA4's small text)." },
    },
  },
};

export async function findText(args: { text?: string; minConf?: number; accurate?: boolean }) {
  const boxes = await ocrScreen(args.accurate ?? true);
  const list = args.text ? matchText(boxes, args.text, args.minConf) : boxes;
  const rows = list
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx)
    .map((b) => `(${b.cx},${b.cy}) conf ${b.conf.toFixed(2)}  "${b.text}"`);
  const header = args.text
    ? `${list.length} match(es) for "${args.text}" (of ${boxes.length} text elements):`
    : `${boxes.length} text elements on screen:`;
  return { content: [{ type: "text" as const, text: [header, ...rows].join("\n") }] };
}

export const clickTextTool = {
  name: "click_text",
  description:
    "Locate a UI element by its VISIBLE TEXT via Apple Vision OCR and click its center — the " +
    "grounded alternative to guessing pixel coordinates (which drift with the guest resolution). " +
    "Use for nav tabs (Invoices/Archives), buttons (New Invoice, Issue Only), and dropdown OPTIONS " +
    "(Full, 'TYPE A - RETAIL', Pass) once the list is open. Matches exact text first (case/space-" +
    "insensitive), else substring. If the label appears more than once (e.g. 'Archives' as a top-" +
    "nav AND a sub-tab) the call ERRORS listing the candidates — pass `near:{x,y}` to pick the " +
    "closest, or `nth`. Returns a screenshot; the caller still verifies the result. For non-text " +
    "targets (icons, empty portal cells) use find_text on a nearby label + a coordinate offset, " +
    "or the coordinate tools.",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: { type: "string", description: "Visible text of the element, e.g. 'Issue Only'." },
      near: {
        type: "object",
        description: "Optional disambiguator: pick the match closest to this image-space point.",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      },
      nth: { type: "number", description: "Optional: pick the nth match (0-based, ordered top-to-bottom then left-to-right)." },
      doubleClick: { type: "boolean", description: "Double-click instead of single (default false)." },
      minConf: { type: "number", description: "Min OCR confidence 0-1 (default 0.3)." },
    },
    required: ["text"],
  },
};

export async function clickText(args: ClickTextArgs) {
  // Interactive tool → always fresh (correctness over speed; the LLM may have navigated anywhere).
  const target = await clickTextBox({ ...args, fresh: true });
  await sleep(400);
  const shot = await screenshot();
  return {
    content: [
      { type: "text" as const, text: `Clicked${args.doubleClick ? " (double)" : ""} "${target.text}" at image (${target.cx},${target.cy}) [conf ${target.conf.toFixed(2)}].` },
      ...shot.content,
    ],
  };
}
