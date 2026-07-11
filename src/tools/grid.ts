/**
 * Runtime calibration + read-back for GA4's invoice portal grid.
 *
 * WHY THIS EXISTS: invoice.ts baked image-space coordinates captured on the
 * 2026-07-06 runs (rowY0 365, qty x=753, price x=799, Labour tab [237,316]).
 * The guest resolution has drifted since; on 2026-07-10 the same elements sat at
 * rowY0 351, qty 772, price 814, Labour tab [228,304] — ~14px out. Every
 * fill_invoice click was landing just outside its target, which is why the tool
 * garbled the registration and returned empty drafts, and why the whole invoice
 * ended up being hand-driven cell-by-cell (~40 LLM round-trips, ~30 min each).
 *
 * A hardcoded coordinate is a silent liability: it keeps "working" until the
 * resolution changes, then fails in ways that look like flaky input. So derive
 * the geometry from what's actually on screen: the grid's own column headers.
 * Everything below is READ-ONLY (OCR of a screen capture) — no clicks.
 */

import { ocrScreen, matchText, type OcrBox } from "./ocr.js";

export interface GridGeometry {
  descX: number;      // x inside the Description column (click target)
  qtyX: number;       // x centre of the Qty column
  priceX: number;     // x centre of the Unit Price column
  subTotalX: number;  // x centre of the SubTotal column (read-back only, never clicked)
  rowY0: number;      // y centre of the FIRST portal row
  rowStep: number;    // y delta between consecutive rows
  headerY: number;    // y of the column-header band (provenance / debugging)
}

/**
 * Vertical gap from the column-header baseline to the centre of the first row,
 * and the row pitch. Measured off the live 1200-wide capture (header y=333,
 * rows at 351/371/391/411). These are the only two magic numbers left, and both
 * are RELATIVE to an OCR-located header, so they survive a resolution change
 * that would break an absolute coordinate.
 */
const HEADER_TO_ROW0 = 18;
const ROW_STEP = 20;

/**
 * Anchor the grid on its column headers.
 *
 * Do NOT anchor on "Qty": Apple Vision reads that header as "Oty" (capital O)
 * at confidence 0.30 on this UI — matching it by text finds nothing. "Tech" and
 * "Unit Price" both come back at confidence 1.00, and the Qty column is the one
 * between them, so locate Qty POSITIONALLY rather than by its (misread) text.
 */
// Vision's confidence on these headers is NOT stable — "Unit Price" reported 1.00 on one
// capture and 0.50 on the next, of an identical screen. A high bar here doesn't buy
// correctness, it just makes calibration fail intermittently. Keep the bar low and lean on
// the geometric check (Tech and Unit Price must share a row) to reject a bad match.
const HEADER_MIN_CONF = 0.4;

function pickHeaderRow(boxes: OcrBox[]): { qtyX: number; price: OcrBox; headerY: number } {
  const prices = matchText(boxes, "Unit Price").filter((b) => b.conf >= HEADER_MIN_CONF);
  // The column immediately LEFT of Qty is "Tech" on the Labour portal but "Cost" on the Parts
  // portal — same position, different label. Anchoring on "Tech" alone silently never calibrates
  // the Parts grid. Accept either.
  const lefts = [...matchText(boxes, "Tech"), ...matchText(boxes, "Cost")].filter(
    (b) => b.conf >= HEADER_MIN_CONF
  );
  if (!prices.length || !lefts.length) {
    throw new Error(
      "Invoice grid not calibrated: could not find the 'Unit Price' header and its neighbouring " +
        "'Tech' (Labour) or 'Cost' (Parts) column. Is an invoice draft open with a line-item tab showing?"
    );
  }
  // Same header band: pick the closest aligned left/Unit-Price pair.
  let best: { left: OcrBox; price: OcrBox; dy: number } | null = null;
  for (const t of lefts) {
    for (const p of prices) {
      const dy = Math.abs(t.cy - p.cy);
      if (!best || dy < best.dy) best = { left: t, price: p, dy };
    }
  }
  if (!best || best.dy > 6) {
    throw new Error("Invoice grid not calibrated: the column headers are not aligned on one row.");
  }
  const headerY = Math.round((best.left.cy + best.price.cy) / 2);

  // The Qty header is whatever box sits between Tech and Unit Price on this band
  // (its text is unreliable, its position is not). Fall back to the midpoint.
  const between = boxes
    .filter(
      (b) =>
        Math.abs(b.cy - headerY) <= 5 &&
        b.cx > best!.left.cx + 4 &&
        b.cx < best!.price.cx - 4
    )
    .sort((a, b) => a.cx - b.cx);
  const qtyX = between.length
    ? Math.round(between[0].cx)
    : Math.round((best.left.cx + best.price.cx) / 2);

  return { qtyX, price: best.price, headerY };
}

/**
 * Derive the portal grid geometry from the CURRENT screen.
 * Call once per fill operation (cheap: one capture + one Vision pass, ~0.9s),
 * then reuse the returned geometry for every cell in that invoice.
 */
export async function calibrateGrid(boxes?: OcrBox[]): Promise<GridGeometry> {
  const found = boxes ?? (await ocrScreen(true));
  const { qtyX, price, headerY } = pickHeaderRow(found);

  // The Description column runs from the grid's left edge to just before Qty.
  // Click well inside it — not at its left border, where the row's expand /
  // Job-Lookup / Part-Lookup affordances live (clicking those opens a modal).
  const descX = Math.round(qtyX * 0.55);

  // SubTotal header is high-confidence and sits right of VAT. Used only to READ a row's
  // computed line total (qty x price), which is how we verify a Qty that OCR can't see.
  const stHeader = matchText(found, "SubTotal").find((b) => Math.abs(b.cy - headerY) <= 5);
  const subTotalX = stHeader ? Math.round(stHeader.cx) : Math.round(price.cx + 124);

  return {
    descX,
    qtyX,
    priceX: Math.round(price.cx),
    subTotalX,
    rowY0: headerY + HEADER_TO_ROW0,
    rowStep: ROW_STEP,
    headerY,
  };
}

/** y centre of portal row `i` (0-based). */
export const rowY = (g: GridGeometry, i: number): number => g.rowY0 + i * g.rowStep;

// --- read-back -------------------------------------------------------------

const money = (s: string): number | null => {
  const m = s.replace(/[£,\s]/g, "").match(/^-?\d+(\.\d+)?$/);
  return m ? parseFloat(s.replace(/[£,\s]/g, "")) : null;
};

export interface PortalRow {
  description: string;
  qty: string;
  unitPrice: string;
  subTotal: string;
}

/**
 * Read the entered line-item rows straight off the screen.
 *
 * This is what lets fill_invoice check its own work. The alternative — returning
 * a screenshot and asking the model to read it — costs a full LLM turn per cell,
 * which is precisely what made a 7-line invoice take half an hour.
 *
 * `count` rows are read from row 0 down. A cell that OCR can't see comes back as
 * "" so the caller can repair it (rather than silently accepting a blank line,
 * which the totals gate CANNOT catch when the price is also blank).
 */
export async function readPortalRows(
  g: GridGeometry,
  count: number,
  boxes?: OcrBox[]
): Promise<PortalRow[]> {
  const found = boxes ?? (await ocrScreen(true));
  const rows: PortalRow[] = [];

  for (let i = 0; i < count; i++) {
    const y = rowY(g, i);
    const band = found.filter((b) => Math.abs(b.cy - y) <= 6);

    // Description: everything left of the Tech/Qty columns, in reading order.
    const desc = band
      .filter((b) => b.cx < g.qtyX - 30 && b.conf >= 0.5)
      .sort((a, b) => a.cx - b.cx)
      .map((b) => b.text.trim())
      .join(" ")
      .trim();

    const nearest = (targetX: number): string => {
      const cands = band
        .filter((b) => Math.abs(b.cx - targetX) <= 22 && money(b.text) !== null)
        .sort((a, b) => Math.abs(a.cx - targetX) - Math.abs(b.cx - targetX));
      return cands.length ? cands[0].text.trim() : "";
    };

    rows.push({
      description: desc,
      // A lone "1" in the narrow Qty column often isn't detected by Vision at all — treat a
      // blank qty as UNKNOWN, not as wrong, and let the caller confirm it via subTotal.
      qty: nearest(g.qtyX),
      unitPrice: nearest(g.priceX),
      subTotal: nearest(g.subTotalX),
    });
  }
  return rows;
}

/** GA4 rounds half-up; JS toFixed rounds a half-penny DOWN. Use this for any money maths. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** GA4 Title-Cases committed descriptions and pads money; compare on meaning, not bytes. */
export const sameText = (a: string, b: string): boolean =>
  a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

export const sameNumber = (a: string, b: string): boolean => {
  const x = money(a);
  const y = money(b);
  return x !== null && y !== null && Math.abs(x - y) < 0.005;
};

export interface Totals {
  subTotal: number | null;
  vat: number | null;
  mot: number | null;
  total: number | null;
}

/**
 * Read the Totals panel via OCR. This is the correctness gate, evaluated
 * SERVER-SIDE so fill_invoice can verify itself instead of shipping a 250KB
 * screenshot back to the model and waiting a full turn for it to squint at it.
 *
 * Labels and their values sit on the same visual row, so each value is the
 * nearest numeric box to the right of its label.
 */
export async function readTotals(boxes?: OcrBox[]): Promise<Totals> {
  const found = boxes ?? (await ocrScreen(true));

  // CRITICAL: "SubTotal" and "VAT" are ALSO column headers in the line-item grid,
  // and the grid's copies sit to the LEFT. Searching the whole screen would read
  // the header band (no numbers on that row) and report every total as null — a
  // gate that silently never fires. Anchor on the "Totals" panel title and only
  // consider labels below it.
  const title = matchText(found, "Totals").filter((b) => b.conf >= 0.8).sort((a, b) => b.cy - a.cy)[0];
  if (!title) return { subTotal: null, vat: null, mot: null, total: null };
  const panel = found.filter((b) => b.cy > title.cy - 2 && b.cx > title.cx - 40);

  const valueRightOf = (label: string): number | null => {
    const hits = panel.filter((b) => b.text.trim().toLowerCase() === label.toLowerCase());
    if (!hits.length) return null;
    const lab = hits.sort((a, b) => a.cy - b.cy)[0];
    const sameRow = panel
      .filter((b) => Math.abs(b.cy - lab.cy) <= 5 && b.cx > lab.cx && money(b.text) !== null)
      .sort((a, b) => a.cx - b.cx);
    return sameRow.length ? money(sameRow[0].text) : null;
  };

  return {
    subTotal: valueRightOf("SubTotal"),
    vat: valueRightOf("VAT"),
    mot: valueRightOf("MOT"),
    total: valueRightOf("Total"),
  };
}

/**
 * Compare GA4's computed Total against the expected web total, to the penny.
 * Returns null when they agree, else a human-readable mismatch description.
 */
export function checkTotalsGate(t: Totals, expectedGross: number): string | null {
  if (t.total === null) return "could not read the Totals panel (OCR found no Total value)";
  const diff = Math.abs(t.total - expectedGross);
  if (diff < 0.005) return null;
  return `GA4 Total £${t.total.toFixed(2)} != expected £${expectedGross.toFixed(2)} (out by £${diff.toFixed(2)})`;
}
