/**
 * High-level invoice orchestration tools.
 *
 * WHY THESE EXIST: driving GA4 field-by-field from the LLM means a full model
 * turn (decide coords → tool call → wait → screenshot → interpret) sits between
 * every UI action — ~30-40 round-trips per invoice, the real reason a write-back
 * took ~20 minutes. The per-click path is already fast (~220ms); the LLM in the
 * loop was the ceiling. `fill_invoice` runs the ENTIRE deterministic data-entry
 * sequence server-side in ONE call, so the LLM is invoked once per invoice to
 * supply data and once to verify — not 30 times to place fields.
 *
 * SAFETY BOUNDARY: fill_invoice deliberately does NOT issue. It fills the draft
 * and returns a screenshot so the LLM can verify (a) the VRM-Lookup pulled the
 * right customer (Acc No) and (b) the Totals panel matches the web total to the
 * penny — THE correctness gate. Only then does the LLM call `issue_invoice`.
 * Automating past the gate would defeat the one check that catches a silently
 * mis-entered line. See create-invoice.md.
 *
 * Coordinates are image-space (1200-wide screenshot), the same space every other
 * tool uses; helpers map them to the live window. They are the values confirmed
 * on the 2026-07-06 live runs (90708 Knoller, 90709 Hammond).
 */

import { toAbsoluteCoords, macClick, assertScreenUnlocked } from "../helpers.js";
import { vmSendKey, SCANCODES } from "../vm.js";
import { pasteField } from "./paste.js";
import { selectDropdown } from "./dropdown.js";
import { screenshot } from "./screenshot.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function clickImg(x: number, y: number): Promise<void> {
  const { absX, absY } = await toAbsoluteCoords(x, y);
  await macClick(absX, absY);
}

async function pasteInto(x: number, y: number, text: string, selectAll = true): Promise<void> {
  await pasteField({ x, y, text, selectAll });
}

// --- Calibrated image-space coordinates (confirmed on 2026-07-06 live runs) ---
const C = {
  invoicesNav: [263, 50],
  newInvoice: [60, 141],
  regField: [160, 113],
  vrmLookup: [400, 113],
  ignoreBtn: [732, 577],       // "Open Document Exists" → Ignore (harmless click if dialog absent)
  mileage: [148, 247],
  tabDescription: [146, 316],
  tabLabour: [237, 316],
  tabParts: [329, 316],
  descBox: [400, 420],
  commitOff: [450, 470],       // neutral spot below portal rows to commit a row
  issueBtn: [155, 85],
  issueOnly: [749, 353],
  // Portal rows: first empty row Y, step per committed row (~21px)
  rowY0: 365,
  rowStep: 21,
  // Labour row cells
  labourDesc: 200, labourQty: 753, labourPrice: 799,
  // Parts row cells (Qty/Price align with Labour; Description shifts left)
  partsDesc: 186, partsQty: 753, partsPrice: 799,
  // Extras dropdowns (anchor) — right panel
  motAnchor: [1105, 709],
  motClassAnchor: [1120, 725],
  motStatusAnchor: [1120, 741],
} as const;

// Only options confirmed by a real click on 2026-07-06 are baked in. Others need
// calibration first (the playbook's extrapolated coords were for a different
// panel Y and must not be trusted blind) — requesting one throws rather than
// silently clicking the wrong row into a gate-passing invoice.
const MOT_TYPE_OPT: Record<string, [number, number]> = { "Full": [1097, 713] };
const MOT_CLASS_OPT: Record<string, [number, number]> = { "TYPE A - RETAIL": [1105, 719] };
const MOT_STATUS_OPT: Record<string, [number, number]> = { "Pass": [1098, 734] };

export interface InvoiceLine { description: string; qty: string; unitPrice: string }
export interface InvoiceMot { type: string; classOption: string; status: string }
export interface FillInvoicePayload {
  reg: string;
  mileage: number | string;
  jobDescription?: string;
  labour?: InvoiceLine[];
  parts?: InvoiceLine[];
  mot?: InvoiceMot;
  onOpenDoc?: "ignore" | "skip";
}

export const fillInvoiceTool = {
  name: "fill_invoice",
  description:
    "Create ONE GA4 invoice draft and fill it end-to-end in a single call — New Invoice, " +
    "VRM Lookup (reg), mileage, all labour + parts lines, MOT Extras (optional), and the " +
    "Description — then return a screenshot of the finished draft. Does NOT issue: the caller " +
    "MUST verify from the returned screenshot that (1) the customer Acc No is correct and " +
    "(2) the Totals panel matches the web total to the penny, THEN call issue_invoice. This " +
    "collapses ~30 field-by-field round-trips into one server-side sequence. Assumes GA4 is " +
    "open and the screen unlocked. Registration and every text/number field are pasted " +
    "(deterministic — never scrambles). MOT currently supports only the confirmed ELI option " +
    "set (type Full, class 'TYPE A - RETAIL', status Pass); other options error out until " +
    "their popup coordinates are calibrated.",
  inputSchema: {
    type: "object" as const,
    properties: {
      reg: { type: "string", description: "Vehicle registration for VRM Lookup, e.g. 'BJ15 YTU'" },
      mileage: { type: ["number", "string"], description: "Odometer reading" },
      jobDescription: { type: "string", description: "Optional free-text work summary for the Description tab" },
      labour: {
        type: "array",
        description: "Labour lines",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            qty: { type: "string", description: "Quantity as a string, e.g. '1'" },
            unitPrice: { type: "string", description: "Unit price as a string, e.g. '124.00'" },
          },
          required: ["description", "qty", "unitPrice"],
        },
      },
      parts: {
        type: "array",
        description: "Parts lines (free-text; part number left blank)",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            qty: { type: "string" },
            unitPrice: { type: "string" },
          },
          required: ["description", "qty", "unitPrice"],
        },
      },
      mot: {
        type: "object",
        description: "Optional MOT via the Extras panel. Omit for non-MOT invoices.",
        properties: {
          type: { type: "string", description: "MOT type, e.g. 'Full'" },
          classOption: { type: "string", description: "Pricing tier, e.g. 'TYPE A - RETAIL'" },
          status: { type: "string", description: "Result, e.g. 'Pass'" },
        },
        required: ["type", "classOption", "status"],
      },
      onOpenDoc: {
        type: "string",
        enum: ["ignore", "skip"],
        description: "How to handle the 'Open Document Exists' warning after VRM Lookup. " +
          "'ignore' (default) clicks Ignore to keep both (correct when the blocking doc is an " +
          "unrelated stale pending invoice). 'skip' does not click (use if you've confirmed no " +
          "dialog appears).",
      },
    },
    required: ["reg", "mileage"],
  },
};

export async function fillInvoice(p: FillInvoicePayload) {
  await assertScreenUnlocked();

  // Validate MOT options up front — fail before touching GA4, not mid-entry.
  if (p.mot) {
    if (!MOT_TYPE_OPT[p.mot.type]) throw new Error(`Unsupported MOT type '${p.mot.type}' (calibrated: ${Object.keys(MOT_TYPE_OPT).join(", ")})`);
    if (!MOT_CLASS_OPT[p.mot.classOption]) throw new Error(`Unsupported MOT class '${p.mot.classOption}' (calibrated: ${Object.keys(MOT_CLASS_OPT).join(", ")})`);
    if (!MOT_STATUS_OPT[p.mot.status]) throw new Error(`Unsupported MOT status '${p.mot.status}' (calibrated: ${Object.keys(MOT_STATUS_OPT).join(", ")})`);
  }

  // 1. Ensure Invoices view, then New Invoice
  await clickImg(...C.invoicesNav); await sleep(1500);
  await clickImg(...C.newInvoice); await sleep(2000);

  // 2. Registration (paste — typing scrambles this combo field)
  await pasteInto(...C.regField, p.reg);
  await sleep(300);

  // 3. VRM Lookup (fills vehicle + customer)
  await clickImg(...C.vrmLookup); await sleep(2500);

  // 4. Dismiss "Open Document Exists" if present. Clicking Ignore's position is
  //    harmless when no dialog is up (lands in the History portal).
  if (p.onOpenDoc !== "skip") { await clickImg(...C.ignoreBtn); await sleep(800); }

  // 5. Mileage
  await pasteInto(...C.mileage, String(p.mileage));
  await vmSendKey(SCANCODES.tab);
  await sleep(300);

  // 6. Labour lines
  if (p.labour?.length) {
    await clickImg(...C.tabLabour); await sleep(900);
    let y = C.rowY0;
    for (const l of p.labour) {
      await pasteInto(C.labourDesc, y, l.description);
      await pasteInto(C.labourQty, y, l.qty);
      await pasteInto(C.labourPrice, y, l.unitPrice);
      await clickImg(...C.commitOff); await sleep(500);
      y += C.rowStep;
    }
  }

  // 7. Parts lines
  if (p.parts?.length) {
    await clickImg(...C.tabParts); await sleep(900);
    let y = C.rowY0;
    for (const pt of p.parts) {
      await pasteInto(C.partsDesc, y, pt.description);
      await pasteInto(C.partsQty, y, pt.qty);
      await pasteInto(C.partsPrice, y, pt.unitPrice);
      await clickImg(...C.commitOff); await sleep(500);
      y += C.rowStep;
    }
  }

  // 8. MOT Extras (optional) — select_dropdown = open+select+settle atomically
  if (p.mot) {
    const [tx, ty] = MOT_TYPE_OPT[p.mot.type];
    await selectDropdown({ anchorX: C.motAnchor[0], anchorY: C.motAnchor[1], optionX: tx, optionY: ty });
    const [cx, cy] = MOT_CLASS_OPT[p.mot.classOption];
    await selectDropdown({ anchorX: C.motClassAnchor[0], anchorY: C.motClassAnchor[1], optionX: cx, optionY: cy });
    const [sx, sy] = MOT_STATUS_OPT[p.mot.status];
    await selectDropdown({ anchorX: C.motStatusAnchor[0], anchorY: C.motStatusAnchor[1], optionX: sx, optionY: sy });
    // MOT Tester left as GA4's carried-over default (DB | Dec = Dec Buckley at ELI).
  }

  // 9. Description (optional) — paste works here; GA4 will Title-Case on commit.
  if (p.jobDescription) {
    await clickImg(...C.tabDescription); await sleep(900);
    await pasteInto(...C.descBox, p.jobDescription);
    await sleep(300);
  }

  // 10. End on the Parts tab so the returned screenshot shows the parts portal +
  //     the Extras + Totals panels together (the gate the caller must verify).
  await clickImg(...C.tabParts); await sleep(700);
  return screenshot();
}

export const issueInvoiceTool = {
  name: "issue_invoice",
  description:
    "Issue the invoice draft currently open in GA4 via Issue → Issue Only (no print, no email, " +
    "no payment), then return a screenshot. Call ONLY after verifying from fill_invoice's " +
    "screenshot that the customer and the Totals gate are correct — this is irreversible and " +
    "locks the GA4 number. The issued number equals the draft number shown in fill_invoice's " +
    "header (GA4 does not renumber on issue).",
  inputSchema: { type: "object" as const, properties: {} },
};

export async function issueInvoice() {
  await assertScreenUnlocked();
  await clickImg(...C.issueBtn); await sleep(1500);   // Issue → opens Issue/Add Payments dialog
  await clickImg(...C.issueOnly); await sleep(1500);  // Issue Only
  return screenshot();
}
