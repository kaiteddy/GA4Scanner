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

import { toAbsoluteCoords, macClick, activateParallels, assertScreenUnlocked } from "../helpers.js";
import { vmSendKey, vmSendKeyCombo, vmSetClipboard, SCANCODES } from "../vm.js";
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

// GA4 intermittently EATS the first Ctrl+V in a freshly-focused field — observed live on
// the registration combo field (→ VRM Lookup runs on empty → no customer attaches) and on
// portal description cells (→ blank line description, invisible to the totals gate). The fix
// is a double-paste: paste, settle, paste again. pasteField does select-all→paste, so when the
// first paste already landed the second is idempotent; when it was eaten, the second lands.
// This is what makes fill_invoice reliable enough to run unattended.
async function pasteSticky(x: number, y: number, text: string, selectAll = true): Promise<void> {
  await pasteField({ x, y, text, selectAll });
  await sleep(150);
  await pasteField({ x, y, text, selectAll });
}

// Like pasteSticky, but for EDITABLE-COMBO and Lookup-autocomplete cells — the registration
// combo and the portal Description cells — where Ctrl+A does NOT reliably select the field.
// That was the shared root cause of two gate-invisible bugs seen live on the 07-07 backlog:
//   • the reg landing as "LT19 DHDLT19 DHD" — pasteSticky's second Ctrl+A didn't select, so the
//     paste APPENDED instead of replacing (VRM Lookup then ran on garbage → no customer); and
//   • line descriptions landing BLANK on multi-part invoices — the eaten first Ctrl+V, which a
//     single selectAll:false paste can't survive; the blank/uncommitted row then shoved the
//     following Qty/Price clicks onto the wrong cell (the observed "13.9" qty / £0 price).
// Fix: clear with Home → Shift+End → Delete (works where Ctrl+A doesn't), paste, repeat once.
// An eaten first paste still lands on the retry; a landed first paste is cleared before the
// retry so it can never double. Single-line cells only (Home/Shift+End select one line — do
// NOT use for the multi-line Description-tab box; that stays on pasteSticky/Ctrl+A).
//
// STILL DOUBLED LIVE on 2026-07-08 (reg landed "KN21 CVUKN21 CVU" on the very first invoice of
// that session) despite the fix above. Root cause: no settle delay between macClick() returning
// and the immediately-following Home keystroke. cliclick/prlctl are separate cross-process calls
// with no delivery confirmation — the click can still be in flight when Home fires, so on the
// 2nd loop iteration (field already has content from iteration 1) Home/Shift+End/Delete land as
// no-ops (event dropped before focus/cursor settled) while the trailing Ctrl+V still lands,
// APPENDING instead of replacing. Iteration 1 is unaffected only because an empty field can't
// visibly double. Fix: an explicit settle sleep after the click, before any keystroke — the same
// "settle after click, before acting" pattern selectDropdown() already relies on (dropdown.ts).
const CLICK_SETTLE_MS = 200;
async function pasteCombo(x: number, y: number, text: string): Promise<void> {
  await vmSetClipboard(text);
  const { absX, absY } = await toAbsoluteCoords(x, y);
  for (let i = 0; i < 2; i++) {
    await macClick(absX, absY);
    await activateParallels();
    await sleep(CLICK_SETTLE_MS);                  // let the click land before keystrokes race it
    await vmSendKey(SCANCODES.home);
    await vmSendKeyCombo([SCANCODES.shift, SCANCODES.end]);
    await vmSendKey(SCANCODES.delete);            // deletes the Home→End selection (or no-op if empty)
    await vmSendKeyCombo([SCANCODES.ctrl, SCANCODES.v]);
    await sleep(180);
  }
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
  jobLookupMagX: 31,           // Job Lookup magnifier on a labour row (click at (31, rowY))
  predefAddToDoc: [1090, 959], // "Add to Document" in the Predefined Jobs modal
  issueBtn: [155, 85],
  issueOnly: [752, 353],       // "Issue Only" tab in the Issue/Add-Payments dialog (proven live 07-07)
  // MOT Reminder interrupt dialogs — seen live 2026-07-08 on ~half of MOT-line invoices,
  // depending on that vehicle's existing-reminder state in GA4 (unknowable ahead of time).
  // Both variants' "decline" button sit in the y=545-558 band, which is BLANK background on
  // the real Issue/Add-Payments dialog (below its payment-method row, above the Payments grid
  // header) — so clicking these positions is a harmless no-op when neither dialog is showing.
  motReminderDeclineNew: [578, 558],      // "No" — "Would you like to set an MOT reminder?" (no existing reminder)
  motReminderDeclineUpdate: [606, 545],   // "Cancel" — "An existing reminder is due soon..." (untested live; see issueInvoice)
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
  // Customer Database picker (opened by the magnifier beside Acc Number). Coords confirmed
  // live 2026-07-06 attaching Bruck (BRU003) to a new-vehicle invoice (SF65 XDA).
  accMagnifier: [912, 113],
  custSearchField: [460, 359],
  custFirstRowPlus: [760, 409],
} as const;

// Only options confirmed by a real click on 2026-07-06 are baked in. Others need
// calibration first (the playbook's extrapolated coords were for a different
// panel Y and must not be trusted blind) — requesting one throws rather than
// silently clicking the wrong row into a gate-passing invoice.
const MOT_TYPE_OPT: Record<string, [number, number]> = { "Full": [1097, 713] };
const MOT_CLASS_OPT: Record<string, [number, number]> = { "TYPE A - RETAIL": [1105, 719] };
const MOT_STATUS_OPT: Record<string, [number, number]> = { "Pass": [1098, 734] };

// Predefined Jobs (the "Job Lookup" magnifier on a labour row). Picking one of these instead
// of pasting makes the description EXACT (it's chosen from a list — cannot scramble the way a
// pasted string can) and brings a preset labour rate. Confirmed live 2026-07-07: the magnifier
// opens a modal listing the jobs; ">" adds a job to the Jobs Basket at a FIXED modal-row Y;
// "Add to Document" (C.predefAddToDoc) then commits it onto the invoice's current empty row.
// ELI has exactly two presets, both qty 1 @ £70.00 — override only when the web line differs.
// Keyed by lower-cased description for a case-insensitive match against the web line.
const PREDEFINED_JOB: Record<string, { addBtn: [number, number]; defQty: number; defPrice: number }> = {
  "diagnostic check": { addBtn: [980, 164], defQty: 1, defPrice: 70 },
  "mechanical labour": { addBtn: [980, 197], defQty: 1, defPrice: 70 },
  "mechanical labor": { addBtn: [980, 197], defQty: 1, defPrice: 70 },
};

// Enter one portal line (labour or parts) by PASTE, with the scramble fix: the Description cell
// is a Lookup autocomplete, so we paste it then COMMIT off-row to close the autocomplete BEFORE
// touching Qty — otherwise the Qty click lands in the still-open Description field and the qty
// digit is appended to the description ("Diagnostic Check" -> "Diagnostic Check1"), a mismatch
// the totals gate cannot see. Root-caused + fixed live 2026-07-07. Qty/Price are plain numeric
// cells (paste then commit). Single-paste throughout — the commit-between-cells step removes the
// focus race that the old double-paste was masking, so double-paste is no longer needed here.
async function pastePortalLine(
  descX: number, qtyX: number, priceX: number, y: number,
  line: InvoiceLine,
): Promise<void> {
  // Description via pasteCombo (clear-then-paste ×2) so it can't land blank or double — the
  // multi-part scramble fix. Commit off-row to close the autocomplete BEFORE touching Qty,
  // else the Qty click lands in the still-open Description field and its digit is appended to
  // the description. Qty/Price also via pasteCombo: the same eaten-first-Ctrl+V can blank a
  // numeric cell, and once the description reliably commits the row stays aligned so these land
  // in the right cells (double-paste of a numeric cell is idempotent — safe).
  await pasteCombo(descX, y, line.description);
  await clickImg(...C.commitOff); await sleep(400);   // commit desc + close autocomplete
  await pasteCombo(qtyX, y, line.qty);
  await pasteCombo(priceX, y, line.unitPrice);
  await clickImg(...C.commitOff); await sleep(400);
}

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
  // "new" (default): create a fresh draft via New Invoice (GA4 assigns the next number).
  // "current": fill the draft ALREADY OPEN on screen, skipping New Invoice. This is how the
  // number-pool worker fills a PRE-RESERVED blank draft in place so it keeps its reserved
  // number — the caller must have navigated to/opened that exact draft first.
  startFrom?: "new" | "current";
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
    "open and the screen unlocked. Labour lines whose description matches a Predefined Job " +
    "(ELI: 'Diagnostic Check', 'Mechanical Labour') are added via the Job Lookup picker — exact " +
    "description (chosen from a list, cannot scramble) at the preset rate, with qty/price " +
    "overridden only if the web line differs. Other labour + all parts are pasted, committing " +
    "the description off-row BEFORE qty so the qty digit can't leak into the description (the " +
    "old gate-invisible scramble). Registration and line descriptions use a clear-then-paste " +
    "(Home/Shift+End/Delete, ×2) that survives the eaten-first-Ctrl+V (blank) AND the combo that " +
    "Ctrl+A can't select (the reg 'LT19 DHDLT19 DHD' doubling). If the vehicle is new to GA4, VRM " +
    "Lookup pulls the vehicle but leaves the customer blank " +
    "(Acc No 'Auto Generate') — call attach_customer(surname) after, then verify. MOT currently " +
    "supports only the confirmed ELI option set (type Full, class 'TYPE A - RETAIL', status " +
    "Pass); other options error out until their popup coordinates are calibrated.",
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
      startFrom: {
        type: "string",
        enum: ["new", "current"],
        description: "'new' (default) creates a fresh draft via New Invoice — GA4 assigns the " +
          "next number. 'current' fills the draft ALREADY OPEN on screen (skips New Invoice) so " +
          "it keeps its number — used by the number-pool worker to fill a pre-reserved blank " +
          "draft in place. With 'current' the caller MUST have opened that exact draft first.",
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

  // 1. Ensure Invoices view, then New Invoice — UNLESS filling a draft already open
  //    (startFrom "current": the pool worker has opened the pre-reserved blank draft, and a
  //    New Invoice here would grab a different number, defeating the reservation).
  if ((p.startFrom ?? "new") === "new") {
    await clickImg(...C.invoicesNav); await sleep(1200);
    await clickImg(...C.newInvoice); await sleep(1500);
  }

  // 2. Registration — pasteCombo: typing scrambles this combo (it autocompletes against known
  //    regs), its first Ctrl+V is often eaten, AND Ctrl+A doesn't select it (so pasteSticky
  //    doubled it to "LT19 DHDLT19 DHD"). pasteCombo's Home/Shift+End/Delete clear + double
  //    paste is the reliable path.
  await pasteCombo(...C.regField, p.reg);
  await sleep(300);

  // 3. VRM Lookup (fills vehicle + customer) — FileMaker's DVLA call is genuinely slow; this
  //    wait is the hard floor of the sequence and is not safe to trim much further.
  await clickImg(...C.vrmLookup); await sleep(2200);

  // 4. Dismiss "Open Document Exists" if present. Clicking Ignore's position is
  //    harmless when no dialog is up (lands in the History portal).
  if (p.onOpenDoc !== "skip") { await clickImg(...C.ignoreBtn); await sleep(600); }

  // 5. Mileage
  await pasteInto(...C.mileage, String(p.mileage));
  await vmSendKey(SCANCODES.tab);
  await sleep(250);

  // 6. Labour lines. Prefer the Predefined-Jobs fast path (exact description, no paste, no
  //    scramble, preset rate); fall back to the paste path for anything not in the preset list.
  if (p.labour?.length) {
    await clickImg(...C.tabLabour); await sleep(600);
    let y = C.rowY0;
    for (const l of p.labour) {
      const preset = PREDEFINED_JOB[l.description.trim().toLowerCase()];
      if (preset) {
        await clickImg(C.jobLookupMagX, y);  await sleep(900);   // open Predefined Jobs modal
        await clickImg(...preset.addBtn);    await sleep(400);   // ">" -> Jobs Basket
        await clickImg(...C.predefAddToDoc); await sleep(900);   // "Add to Document" -> line on row
        // The preset lands qty 1 @ £70.00 — override only the cells the web line differs on.
        const qtyDiff   = parseFloat(l.qty) !== preset.defQty;
        const priceDiff = parseFloat(l.unitPrice) !== preset.defPrice;
        if (qtyDiff)   await pasteField({ x: C.labourQty,   y, text: l.qty });
        if (priceDiff) await pasteField({ x: C.labourPrice, y, text: l.unitPrice });
        if (qtyDiff || priceDiff) { await clickImg(...C.commitOff); await sleep(350); }
      } else {
        await pastePortalLine(C.labourDesc, C.labourQty, C.labourPrice, y, l);
      }
      y += C.rowStep;
    }
  }

  // 7. Parts lines (free-text; no preset list — always the paste path)
  if (p.parts?.length) {
    await clickImg(...C.tabParts); await sleep(600);
    let y = C.rowY0;
    for (const pt of p.parts) {
      await pastePortalLine(C.partsDesc, C.partsQty, C.partsPrice, y, pt);
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
    await clickImg(...C.tabDescription); await sleep(600);
    await pasteSticky(...C.descBox, p.jobDescription);
    await sleep(300);
  }

  // 10. End on the Parts tab so the returned screenshot shows the parts portal +
  //     the Extras + Totals panels together (the gate the caller must verify).
  await clickImg(...C.tabParts); await sleep(500);
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
  // Issue → normally opens the "Issue Invoice / Add Payments" dialog directly, but on an
  // MOT-line invoice it can FIRST interrupt with an MOT-reminder prompt — seen live 2026-07-08,
  // and unpredictable ahead of time (depends on that vehicle's existing-reminder state in GA4,
  // not the invoice content). The old code blindly clicked Issue Only's fixed coords next, which
  // land on the reminder dialog instead and do nothing — every MOT invoice with a reminder
  // prompt needed a manual redo (Bloom, Richards, Yellon all hit this on the 07-08 backlog).
  //
  // Two variants observed:
  //  (a) no existing reminder → "Would you like to set an MOT reminder?" [No/Yes(Auto)/Yes(Edit)].
  //      Declining ("No") is expected to let the same Issue script continue straight into
  //      Issue/Add-Payments (this is the behavior confirmed for "Yes (Auto)" on Richards/Yellon —
  //      both proceeded directly to the dialog with no extra click needed).
  //  (b) an existing reminder is "due soon" → "...update the existing MOT reminder?" [Cancel/Ok].
  //      Only "Ok" was exercised live (Bloom) — it opened a full Vehicle-Reminders EDITOR
  //      (Update Reminder → Close), a separate sub-form this function does not attempt to drive
  //      blindly (mis-clicking inside a live reminder-date editor is a worse failure mode than
  //      just not automating it). "Cancel" is UNTESTED — declining is assumed to skip the update
  //      and continue the script, matching variant (a), but this is inferred, not confirmed.
  //
  // Both decline-button coordinates sit on blank background of the real Issue/Add-Payments
  // dialog (see C.motReminderDecline* comments), so clicking both unconditionally is a harmless
  // no-op whenever neither prompt is actually showing — no dialog-detection needed.
  await clickImg(...C.issueBtn); await sleep(1200);
  await clickImg(...C.motReminderDeclineNew);    await sleep(500);
  await clickImg(...C.motReminderDeclineUpdate); await sleep(500);
  // Defensive re-click: covers the case where a reminder interrupt consumed the first Issue
  // click without auto-continuing into Issue/Add-Payments (e.g. if "Cancel" doesn't behave like
  // "No" above, or the Vehicle-Reminders editor opened and was left showing). If Issue/Add-
  // Payments is already open this is a no-op — clicking Issue again is blocked by that modal.
  await clickImg(...C.issueBtn); await sleep(1500);
  await clickImg(...C.issueOnly); await sleep(2000);  // Issue Only (no print/email/payment)
  return screenshot();
}

export const attachCustomerTool = {
  name: "attach_customer",
  description:
    "Attach a customer to the invoice draft currently open in GA4 via the Customer Database " +
    "picker. Use when VRM Lookup pulled the vehicle but left the customer blank (Acc No shows " +
    "'Auto Generate') — typically a vehicle new to GA4. Opens the picker beside Acc No, searches " +
    "the given text, and selects the FIRST match, then returns a screenshot. Search by SURNAME, " +
    "not the web account number (web account codes are frequently wrong — GA4's own account is " +
    "authoritative). The caller MUST verify from the screenshot that the right customer attached " +
    "(name + Acc No) before issuing; if the surname is common and the first match is wrong, " +
    "re-run with a more specific search term.",
  inputSchema: {
    type: "object" as const,
    properties: {
      search: { type: "string", description: "Customer search text — a surname, e.g. 'Bruck'" },
    },
    required: ["search"],
  },
};

export async function attachCustomer(args: { search: string }) {
  await assertScreenUnlocked();
  await clickImg(...C.accMagnifier); await sleep(1200);        // open Customer Database picker
  await pasteSticky(...C.custSearchField, args.search);
  await sleep(200);
  await vmSendKey(SCANCODES.enter); await sleep(1200);         // run the search (filters the list)
  await clickImg(...C.custFirstRowPlus); await sleep(1000);    // "+" on the first match selects it
  return screenshot();
}
