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
 * SAFETY BOUNDARY: fill_invoice deliberately does NOT issue. It fills the draft,
 * verifies its own work (reads the line grid back and checks the Totals gate), and
 * returns both a screenshot and a plain verdict. The LLM still confirms the one
 * thing it cannot: that VRM Lookup attached the right customer. Only then does it
 * call `issue_invoice`. See create-invoice.md.
 *
 * The gate is necessary but NOT sufficient on its own — a wrong description or a
 * £0.00 line still sums correctly — which is why the grid read-back exists.
 *
 * Coordinates are image-space (1200-wide screenshot). Static chrome (nav, buttons,
 * Extras panel) uses constants; anything inside the LINE-ITEM GRID is calibrated at
 * run time from the grid's own column headers, because the baked grid coordinates
 * silently drifted 14-19px when the guest resolution changed and turned every cell
 * click into a near-miss. See grid.ts.
 */

import { toAbsoluteCoords, macClick, macClickReliable, macDoubleClick, activateParallels, assertScreenUnlocked, invalidateWindowCache } from "../helpers.js";
import { vmSendKey, vmSendKeyCombo, vmSendKeyRepeat, vmSetClipboard, vmTypeText, SCANCODES } from "../vm.js";
import { pasteField } from "./paste.js";
import { selectDropdown } from "./dropdown.js";
import { screenshot } from "./screenshot.js";
import { clickTextBox, clearGroundingCache, ocrScreen, type ClickTextArgs, type OcrBox } from "./ocr.js";
import {
  calibrateGrid, rowY, readPortalRows, readTotals, checkTotalsGate,
  sameText, sameNumber, round2, type GridGeometry,
} from "./grid.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reliable (×2) click by default: GA4/FileMaker eats a single click as
// focus-activate, so buttons don't fire / fields don't enter edit mode until the
// second click. This was the shared root cause behind most of the workarounds in
// this file (eaten first Ctrl+V, reg doubling, keystrokes racing an unlanded
// click). See macClickReliable / [[ga4-doubleclick-editmode]].
async function clickImg(x: number, y: number): Promise<void> {
  const { absX, absY } = await toAbsoluteCoords(x, y);
  await macClickReliable(absX, absY);
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

// NOTE (07/10): the old `pasteCombo` lived here — a clear-then-paste x2 dance built to survive
// GA4 eating the first Ctrl+V, Ctrl+A failing to select a Lookup combo, and keystrokes racing an
// unlanded click. Every one of those symptoms traced back to the same cause: a single click never
// opens edit mode. `setCell` (double-click -> Home/Shift+End/Delete -> single paste) handles all
// of them in one path, so the double-paste is gone. See [[ga4-doubleclick-editmode]].

// Grounded click: locate an element by its visible TEXT (Apple Vision OCR) and click it, instead of
// a hardcoded coordinate that drifts with the guest resolution (nav tabs at y≈305 wandered; the
// Issue-dialog "Issue Only" button sat at a different Y than the constant). For stable TEXT targets
// only — tabs, VRM Lookup, Issue Only. See ocr.ts / [[ga4-ocr-grounding]]. Throws (not silent) if the
// text isn't found or is ambiguous, so a mis-locate fails loudly instead of clicking the wrong thing.
async function clickLabel(text: string, opts: Omit<ClickTextArgs, "text"> = {}): Promise<void> {
  await clickTextBox({ text, ...opts });
}

// --- Calibrated image-space coordinates (confirmed on 2026-07-06 live runs) ---
const C = {
  // NOTE: `invoicesNav: [263,50]` and `newInvoice: [60,141]` have been DELETED, not moved.
  // [263,50] falls between the "Invoices" and "Veh Sales" nav icons and landed on Veh Sales;
  // [60,141] is then that module's "New Sale" button, i.e. the pair silently created a used-car
  // SALE record instead of an invoice. Both are now grounded on their visible text and verified
  // after the click — see goToInvoicesView / newInvoiceDraft. Never re-add them.
  regField: [160, 113],
  regClearX: [256, 110],       // red X beside Registration — empties the combo (safe if already empty)
  vrmLookup: [400, 113],
  mileage: [148, 247],
  tabDescription: [146, 316],
  tabLabour: [237, 316],
  tabParts: [329, 316],
  descBox: [500, 520],         // mid text-area — a click near the box's top edge doesn't focus it (90721)
  commitOff: [450, 470],       // neutral spot below portal rows to commit a row
  issueBtn: [155, 85],
  issueOnly: [752, 353],       // "Issue Only" tab in the Issue/Add-Payments dialog (proven live 07-07)
  // MOT Reminder interrupt dialogs — seen live 2026-07-08 on ~half of MOT-line invoices,
  // depending on that vehicle's existing-reminder state in GA4 (unknowable ahead of time).
  // Both variants' "decline" button sit in the y=545-558 band, which is BLANK background on
  // the real Issue/Add-Payments dialog (below its payment-method row, above the Payments grid
  // header) — so clicking these positions is a harmless no-op when neither dialog is showing.
  motReminderDeclineNew: [578, 558],      // "No" — "Would you like to set an MOT reminder?" (no existing reminder)
  motReminderDeclineUpdate: [606, 545],   // "Cancel" — "An existing reminder is due soon..." (untested live; see issueInvoice)
  // NOTE: the portal-grid coordinates that used to live here (rowY0 365, rowStep 21,
  // labourQty 753, labourPrice 799, partsDesc 186 …) have been DELETED, not moved. They were
  // captured at a guest resolution that has since changed, leaving them 14-19px off — every
  // cell click landed just outside its target, which is what garbled registrations and
  // produced empty drafts while looking like "flaky input". Grid geometry is now derived at
  // run time from the grid's own column headers (grid.ts / calibrateGrid). Do not re-add
  // absolute row/column constants here: they cannot fail loudly.
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

/**
 * Set ONE portal cell: double-click into edit mode, clear it, PASTE, commit off-row.
 *
 * Every step here was chosen against a measured alternative on the live grid (07/10):
 *
 *  1. DOUBLE-click, not single. A single click is consumed as focus-activate: the cell never
 *     enters edit mode, the paste lands nowhere, and the keystrokes buffer to reappear in
 *     whatever cell opens next. [[ga4-doubleclick-editmode]] This is also what finally makes
 *     a plain Ctrl+V reliable, and it overrides a Predefined-Job's LOCKED price (90721),
 *     which pasting alone could never do.
 *
 *  2. Clear with Home → Shift+End → Delete. Measured over repeated replacements into a Lookup
 *     cell: this cleared 3/3 where Ctrl+A left the cell EMPTY on a long string (it doesn't
 *     select an editable combo) and a backspace burst left residue ("Belt Tensiomechanical
 *     Labour").
 *
 *  3. PASTE the text; do not type it. Typing is per-key and paced (~100ms/char → ~11.6s for a
 *     long part description). Batching the keys to fix that made the guest auto-repeat and
 *     drop characters — "Mechanical Labo", and a Ctrl+V that pasted seven times. A paste is
 *     ONE key combo regardless of length, and the clipboard now loads in ~40ms via pbcopy
 *     instead of ~1000ms via a PowerShell spawn in the guest.
 *
 * A single attempt still lands only ~5 times in 6 (a paste occasionally fails to replace).
 * That is NOT good enough on its own, and it is why enterLinesVerified reads the grid back
 * and repairs — do not call setCell for line data without that safety net.
 */
// Raised from 200/380 on 2026-07-10: in a degraded input session the double-click took longer
// than 200ms to actually open cell edit mode, so the clear/paste keys raced ahead, buffered in
// Parallels, and flushed into the NEXT cell — producing qty "1774"/"7771" corruption on 90728
// that the repair loop (same transport) couldn't beat. A longer settle lets edit mode engage
// before any key is sent. Costs ~0.5s/cell; correctness on real invoices is worth it.
const EDIT_SETTLE_MS = 700;
const COMMIT_SETTLE_MS = 500;

async function setCell(x: number, y: number, text: string): Promise<void> {
  await vmSetClipboard(text);                  // pbcopy → Parallels shared clipboard (~40ms)
  const { absX, absY } = await toAbsoluteCoords(x, y);
  await macDoubleClick(absX, absY);
  await sleep(EDIT_SETTLE_MS);                 // let edit mode open before keys race it
  await vmSendKey(SCANCODES.home);             // clear: select the whole line, delete it
  await vmSendKeyCombo([SCANCODES.shift, SCANCODES.end]);
  await vmSendKey(SCANCODES.delete);
  await vmSendKeyCombo([SCANCODES.ctrl, SCANCODES.v]);
  await clickImg(...C.commitOff);              // commit row + close any autocomplete
  await sleep(COMMIT_SETTLE_MS);
}

/**
 * Enter one portal line. Order matters: description FIRST and committed off-row before
 * Qty is touched (else the Qty click lands in the still-open autocomplete and its digit
 * is appended to the description — a corruption the totals gate cannot see), and price
 * LAST so it overwrites any rate GA4 auto-filled from a matched preset (£70 labour).
 */
async function enterPortalLine(g: GridGeometry, y: number, line: InvoiceLine): Promise<void> {
  await setCell(g.descX, y, line.description);
  await setCell(g.qtyX, y, line.qty);
  await setCell(g.priceX, y, line.unitPrice);
}

/**
 * Enter every line on the current tab, then READ THE GRID BACK and repair any cell that
 * didn't land. Repeats until the grid matches or we run out of passes.
 *
 * The totals gate is necessary but NOT sufficient: it cannot see a wrong or blank
 * DESCRIPTION (the money still adds up), and a £0.00 line hides in it entirely. Reading
 * the grid catches exactly those. Doing it server-side costs ~1.1s of OCR per pass
 * instead of one full LLM turn per cell.
 *
 * Returns the mismatches that survived, so the caller can refuse to issue.
 */
/**
 * Navigate to the Invoices module and CONFIRM we arrived.
 *
 * The old baked coordinate `invoicesNav: [263,50]` sits between the "Invoices" and "Veh Sales"
 * icons and actually landed on **Veh Sales** — after which `newInvoice: [60,141]` points at that
 * module's "New Sale" button. Creating a used-car sale record instead of an invoice is a silent,
 * expensive mistake, so ground the nav on its label and verify the landing page before any click
 * that CREATES a record.
 */
async function goToInvoicesView(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await clickLabel("Invoices", { near: { x: 254, y: 60 }, fresh: true });
    await sleep(1200);
    const boxes = await ocrScreen(true);
    if (boxes.some((b) => /invoices in progress/i.test(b.text))) return;
  }
  throw new Error(
    "Could not reach the Invoices module (the 'Invoices In Progress' list never appeared). " +
      "Refusing to click New — on the neighbouring Veh Sales module that button creates a " +
      "vehicle SALE record."
  );
}

/** Click "New Invoice" and confirm GA4 opened a numbered, unissued draft. */
async function newInvoiceDraft(): Promise<void> {
  await clickLabel("New Invoice", { fresh: true });
  await sleep(1800);
  const boxes = await ocrScreen(true);
  const header = boxes.find((b) => /invoice:\s*\d{4,}/i.test(b.text));
  const notIssued = boxes.some((b) => /not issued/i.test(b.text));
  if (!header || !notIssued) {
    throw new Error(
      "New Invoice did not open a numbered draft (no 'Invoice: <n> (Not Issued)' header). " +
        "Aborting before entering any data."
    );
  }
}

/**
 * Dismiss the modal "Warning - Open Document Exists" that VRM Lookup raises when the vehicle
 * already has an open pending document. Clicks "Ignore" (keep both) — the right choice when the
 * blocker is an unrelated stale shell. Silently returns if the dialog isn't showing.
 */
async function dismissOpenDocDialog(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const boxes = await ocrScreen(true);
    if (!boxes.some((b) => /open document exists/i.test(b.text))) return;   // gone (or never shown)

    // Adam, 07/10: always choose IGNORE — keep both documents. Delete+View destroys the draft we
    // just created (proven: it deleted pool draft 90732). NEVER press Return at this dialog: the
    // focus ring sits on Ignore but Return fires Delete+View.
    await clickLabel("Ignore", { fresh: true });
    await sleep(900);
  }
  throw new Error(
    "The 'Open Document Exists' dialog would not dismiss. Refusing to continue: every later step " +
      "would be reading a screen covered by a modal."
  );
}

/**
 * Enter the registration and confirm it landed EXACTLY, before the slow VRM lookup runs on it.
 * A garbled reg doesn't fail loudly — VRM Lookup just finds nothing, no customer attaches, and
 * you discover it minutes later staring at an empty draft.
 *
 * Three hard-won rules, each from a live failure (07/10):
 *  • DO NOT double-click this field. It is an editable COMBO with a ▼ dropdown; a double-click
 *    opens the LIST, so the following clear/paste keys go to the list instead of the field.
 *    Across retries focus drifts into Make/Model and corrupts the vehicle block (seen live:
 *    Registration="V", Make/Model="$"). Use the reliable ×2 single click.
 *  • DO NOT press Escape to close the autocomplete: in FileMaker, Escape REVERTS the field,
 *    wiping what you just pasted.
 *  • DO NOT clear with Ctrl+A (can't select the combo) — use the field's own red X clear
 *    button, then paste into a known-empty field so a surviving old value can't be appended
 *    to (the classic "LT19 DHDLT19 DHD").
 *
 * Commits with Tab, not an off-row click: the reg lives in the top panel, where C.commitOff
 * would land in the History portal.
 */
const squashReg = (s: string) => s.replace(/\s+/g, "").toUpperCase();

// The reg we PASTE is always the correct literal, so the field holds the right glyphs — but Vision
// routinely misreads the read-back (letter O ↔ digit 0 aborted the EO15 KVR fill on 90730). Collapse
// the glyph pairs OCR confuses to one canonical char on BOTH sides so the verify checks "did the paste
// land", not "can Vision tell O from 0". Safe here precisely because the source value can't be wrong.
const regKey = (s: string) =>
  squashReg(s)
    .replace(/[O0DQ]/g, "0")
    .replace(/[I1L]/g, "1")
    .replace(/[S5]/g, "5")
    .replace(/[B8]/g, "8")
    .replace(/[Z2]/g, "2")
    .replace(/[G6]/g, "6");

const REG_ATTEMPTS = 5;

async function setRegistrationVerified(reg: string): Promise<void> {
  let saw = "";
  for (let attempt = 0; attempt < REG_ATTEMPTS; attempt++) {
    // Transport choice. The paste path (Mac clipboard → Parallels shared-clipboard agent →
    // Ctrl+V) is fast but depends on the clipboard AGENT, which can be unready for ~a minute
    // right after a VM restart — on 2026-07-10 the reg landed "Required" (empty) on every early
    // try for exactly this reason (NOT coordinate drift: the screenshot is always resampled to
    // 1200px, so the field's image coords are resolution-stable and the baked C.regField is
    // correct). So after two paste failures, TYPE the reg instead: vmTypeText uses
    // prlctl send-key-event, a Parallels-native path straight to the interactive desktop that
    // doesn't touch the clipboard agent at all.
    const typeIt = attempt >= 2;
    if (!typeIt) await vmSetClipboard(reg);
    await clickImg(...C.regClearX);              // red X: empty the field first (safe if empty)
    await sleep(300);
    await clickImg(...C.regField);               // reliable ×2 single click — NOT a double-click
    await sleep(EDIT_SETTLE_MS);
    if (typeIt) {
      await vmTypeText(reg);                     // key injection — independent of clipboard sync
    } else {
      await vmSendKeyCombo([SCANCODES.ctrl, SCANCODES.v]);   // paste into the now-empty field
    }
    await sleep(150);
    await vmSendKey(SCANCODES.tab);              // commit (no Escape — it would revert)
    await sleep(600);

    const boxes = await ocrScreen(true);
    // Read the whole field band, not a single box: mid-edit, Vision can split "YX63 AKF" into
    // "YX63" + "AKF", so matching any ONE box would spuriously fail. Drop the "Registration"
    // label, then compare both each box and the left-to-right concatenation.
    const band = boxes
      .filter((b) => Math.abs(b.cy - C.regField[1]) <= 10 && b.cx < 300 && b.conf >= 0.4)
      .filter((b) => !/^registration$/i.test(b.text.trim()))
      .sort((a, b) => a.cx - b.cx);
    const joined = band.map((b) => b.text).join("");
    saw = band.map((b) => b.text).join(" ") || "(nothing)";
    if (regKey(joined) === regKey(reg) || band.some((b) => regKey(b.text) === regKey(reg))) return;
    // Ride out a still-settling input path (clipboard agent / key delivery) after a restart,
    // backing off a little more each round, before the next attempt.
    await sleep(400 * (attempt + 1));
  }
  throw new Error(
    `Registration '${reg}' did not land cleanly after ${REG_ATTEMPTS} attempts (field reads "${saw}") — ` +
      `refusing to run VRM Lookup on a garbled/empty value: it would silently attach no customer and ` +
      `leave an empty draft. If the VM was just restarted, input can be unstable for ~a minute — retry shortly.`
  );
}

/**
 * Confirm a tab actually switched before typing into whatever is showing.
 *
 * A tab click can be silently swallowed (GA4 eats clicks as focus-activate). On 07/10 a
 * Labour→Parts switch didn't take and the first parts description was typed straight over
 * labour row 1, replacing "Diagnostic Check" with "Front Discs". The totals gate could not
 * see it (the money still added up). The active tab is identifiable by its column headers:
 * only Parts has a "Part Number" column; only Labour has "Tech" without it.
 */
async function assertTabActive(tab: "Labour" | "Parts"): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const boxes = await ocrScreen(true);
    // Vision renders this header as "•Part Number" at confidence ~0.30 (a bullet glyph gets
    // prepended and drags the score down). Requiring high confidence here made the guard fire
    // on a tab that HAD switched. Match loosely; the header band position is the real signal.
    const inHeaderBand = (b: OcrBox) => b.cy > 320 && b.cy < 345;
    const hasPartNumber = boxes.some((b) => inHeaderBand(b) && /part\s*number/i.test(b.text));
    const hasCost = boxes.some((b) => inHeaderBand(b) && /^cost$/i.test(b.text.trim()));
    const hasTech = boxes.some((b) => inHeaderBand(b) && /^tech$/i.test(b.text.trim()));

    // Assert POSITIVELY. "Not Parts" is not the same as "is Labour": the History tab has neither
    // set of headers, and an absence-only check let a failed tab switch sail through (90731).
    const isParts = hasPartNumber || hasCost;
    const isLabour = hasTech && !isParts;
    if (tab === "Parts" ? isParts : isLabour) return;

    await clickLabel(tab, { fresh: true });
    await sleep(700);
  }
  throw new Error(
    `Could not switch to the ${tab} tab (its column headers never appeared). Refusing to type ` +
      `into the wrong portal — this silently corrupts the other tab's rows.`
  );
}

/**
 * Locate a form label on screen.
 *
 * Vision often glues a neighbouring border glyph onto the label — "Sundries" comes back as
 * `"Sundries ("` at confidence 0.50 — so an exact string match silently fails on the real UI.
 * Strip punctuation, match exactly if we can, else accept a UNIQUE prefix match. Where a label
 * legitimately appears twice ("MOT" in both the Extras panel and the Totals panel) the topmost
 * wins, which is the Extras one.
 */
const normLabel = (s: string) => s.replace(/[^a-z0-9& .]/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();

async function findLabel(label: string, boxes?: OcrBox[]): Promise<OcrBox> {
  const found = (boxes ?? (await ocrScreen(true))).filter((b) => b.conf >= 0.4);
  const want = normLabel(label);

  const exact = found.filter((b) => normLabel(b.text) === want);
  if (exact.length) return exact.sort((a, b) => a.cy - b.cy)[0];

  const prefix = found.filter((b) => normLabel(b.text).startsWith(want));
  if (prefix.length) return prefix.sort((a, b) => a.cy - b.cy)[0];

  throw new Error(`Field label '${label}' not found on screen.`);
}

/**
 * Set an Extras-panel numeric field (Sundries / Lubricants / Paint & Mat.) by its LABEL.
 * The value box sits immediately to the right of the label on the same row; grounding on
 * the label keeps this working across resolutions.
 */
async function setExtrasField(label: string, value: string): Promise<void> {
  const lab = await findLabel(label);
  await setCell(Math.round(lab.cx + 70), Math.round(lab.cy), value);
}

/**
 * Set the three MOT dropdowns in the Extras panel, grounding each on its own label.
 *
 * These are tiny popup lists (~7px rows). Opening one is a click on the VALUE BOX (right of
 * the label), and the option rows appear just below it. Rather than trust absolute option
 * coordinates, we open the list, OCR it, and click the option BY ITS TEXT — the same grounding
 * used everywhere else. A wrong MOT Class yields a different-but-self-consistent fee, which the
 * totals gate cannot reliably catch, so this must not be guessed.
 */
async function setMotExtras(mot: InvoiceMot): Promise<void> {
  const rows: Array<[string, string]> = [
    ["MOT", mot.type],
    ["MOT Class", mot.classOption],
    ["MOT Status", mot.status],
  ];
  for (const [label, option] of rows) {
    const lab = await findLabel(label);
    // Value box sits right of the label; click it to open the popup list.
    await clickImg(Math.round(lab.cx + 75), Math.round(lab.cy));
    await sleep(700);
    await clickLabel(option, { fresh: true });   // choose the row by its visible text
    await sleep(500);
    await clickImg(...C.commitOff);              // close/commit, then let the panel settle
    await sleep(500);
  }
}

/**
 * Set a top-panel field (Mileage) found by its label, committing with Tab rather than an
 * off-row click (C.commitOff lands in the History portal, not on this form).
 */
async function setLabelledField(label: string, value: string, dx = 100): Promise<void> {
  // Verify + retry. Immediately after VRM Lookup / an Open-Document dialog, GA4 is still
  // redrawing and the first double-click gets eaten — the paste then goes nowhere and the
  // field silently stays "Required". A blank mileage does NOT block the fill or the totals
  // gate, so it would ship an invoice with no odometer reading (seen on 90729 and 90731).
  for (let attempt = 0; attempt < 3; attempt++) {
    // The label can be MISSING on the first look — a modal (Open-Document warning) or a mid-redraw
    // frame hides it. Treat that as "retry", not "fail": throwing here aborted a run whose form was
    // perfectly fine a second later.
    let lab: OcrBox;
    try {
      lab = await findLabel(label);
    } catch {
      await sleep(900);
      continue;
    }
    const { absX, absY } = await toAbsoluteCoords(Math.round(lab.cx + dx), Math.round(lab.cy));
    await vmSetClipboard(value);
    await macDoubleClick(absX, absY);
    await sleep(EDIT_SETTLE_MS);
    await vmSendKey(SCANCODES.home);
    await vmSendKeyCombo([SCANCODES.shift, SCANCODES.end]);
    await vmSendKey(SCANCODES.delete);
    await vmSendKeyCombo([SCANCODES.ctrl, SCANCODES.v]);
    await vmSendKey(SCANCODES.tab);
    await sleep(400);

    const boxes = await ocrScreen(true);
    // The verify OCR frame can miss the label for the SAME transient reason the pre-type lookup
    // can (mid-redraw / a lingering modal) — throwing here aborted a fill whose value had in fact
    // committed (90728, mileage typed fine but the verify frame dropped the "Mileage" label).
    // Treat a missing label as "couldn't confirm this pass" and retry, not as a hard failure.
    let lab2: OcrBox;
    try {
      lab2 = await findLabel(label, boxes);
    } catch {
      await sleep(600);
      continue;
    }
    const landed = boxes.some(
      (b) =>
        Math.abs(b.cy - lab2.cy) <= 8 &&
        b.cx > lab2.cx &&
        b.cx < lab2.cx + 160 &&
        b.text.replace(/[^0-9]/g, "") === value.replace(/[^0-9]/g, "")
    );
    if (landed) return;
  }
  throw new Error(`Field '${label}' did not accept the value '${value}' after 3 attempts.`);
}

const MAX_REPAIR_PASSES = 4;

async function enterLinesVerified(
  g: GridGeometry,
  lines: InvoiceLine[],
  label: string
): Promise<string[]> {
  for (let i = 0; i < lines.length; i++) {
    await enterPortalLine(g, rowY(g, i), lines[i]);
  }

  let problems: string[] = [];
  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    const actual = await readPortalRows(g, lines.length);
    problems = [];

    for (let i = 0; i < lines.length; i++) {
      const want = lines[i];
      const got = actual[i];
      const y = rowY(g, i);

      if (!sameText(got.description, want.description)) {
        problems.push(`${label} row ${i + 1} description: got "${got.description}" want "${want.description}"`);
        await setCell(g.descX, y, want.description);
      }
      if (!sameNumber(got.unitPrice, want.unitPrice)) {
        problems.push(`${label} row ${i + 1} price: got "${got.unitPrice}" want "${want.unitPrice}"`);
        await setCell(g.priceX, y, want.unitPrice);
      }

      // Qty: Vision frequently cannot see a lone "1" in the narrow Qty column, so a blank read
      // is UNKNOWN, not wrong. Confirm it through the row's computed SubTotal (qty x price),
      // which is wide, right-aligned and reliably detected. Only if THAT disagrees — or if the
      // subtotal itself is unreadable and qty is visibly wrong — do we touch the cell. Without
      // this, every qty-1 line reported a false mismatch and blocked issuing.
      const wantSub = round2(parseFloat(want.qty) * parseFloat(want.unitPrice));
      const subOk = got.subTotal !== "" && sameNumber(got.subTotal, wantSub.toFixed(2));
      const qtyReadOk = got.qty !== "" && sameNumber(got.qty, want.qty);

      if (!subOk && !qtyReadOk) {
        problems.push(
          `${label} row ${i + 1} qty: got "${got.qty || "(unreadable)"}" want "${want.qty}" ` +
            `(row subtotal read "${got.subTotal || "(unreadable)"}", expected ${wantSub.toFixed(2)})`
        );
        await setCell(g.qtyX, y, want.qty);
      }
    }
    if (!problems.length) return [];   // clean read — nothing to repair
  }
  return problems;   // survived every repair pass; caller must not issue
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
  /** Extras-panel Sundries amount, e.g. "3.50". NOT a parts line. */
  sundries?: string;
  /** Web invoice gross total. Supplied => the totals gate is enforced server-side. */
  expectedGross?: number;
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
      sundries: {
        type: "string",
        description: "Sundries amount for the Extras panel, e.g. '3.50'. Sundries/Lubricants/" +
          "Paint & Mat. belong in Extras, NOT as a Parts line.",
      },
      expectedGross: {
        type: "number",
        description: "The web invoice's gross total, e.g. 514.92. When supplied, the totals gate " +
          "is enforced SERVER-SIDE and the result says plainly whether it is safe to issue.",
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
  invalidateWindowCache(); // re-measure the VM window once (its size can change across a restart)
  clearGroundingCache();   // re-verify element positions once at the current resolution, then reuse

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
    await goToInvoicesView();
    await newInvoiceDraft();
  }

  // 2. Registration. This single field has produced more failed fills than the rest of the
  //    form combined: eaten first Ctrl+V (VRM Lookup then runs on an EMPTY field and attaches
  //    no customer), Ctrl+A failing to select the combo so the paste APPENDS ("LT19 DHDLT19
  //    DHD"), and stray buffered keystrokes prefixing it ("7LJ17 GZT", 07/10) — each ending in
  //    "No data for this VRM" and an empty draft.
  //
  //    setCell's double-click → backspace-clear → typed entry defeats all three, and the reg
  //    is short enough that batched typing costs ~0.1s. Then VERIFY it before spending the
  //    slow DVLA lookup on a garbled string.
  await setRegistrationVerified(p.reg);

  // 3. VRM Lookup (fills vehicle + customer) — FileMaker's DVLA call is genuinely slow; this
  //    wait is the hard floor of the sequence and is not safe to trim much further.
  await clickLabel("VRM Lookup"); await sleep(2200);

  // 4. Dismiss "Open Document Exists" if present.
  //    Do NOT blind-click a fixed position here. The old constant [732,577] is ~52px below the
  //    real Ignore button, and this dialog is MODAL: a miss doesn't "harmlessly land in the
  //    History portal", it does nothing and every subsequent action in this fill is swallowed
  //    by the modal. Detect the dialog, then click its button by name.
  if (p.onOpenDoc !== "skip") await dismissOpenDocDialog();

  // 5. Mileage. Grounded on its label — the baked [148,247] sat ~8px below the field, so the
  //    value went nowhere and the field stayed "Required" (which does NOT block the fill, it
  //    just quietly ships an invoice with no odometer reading).
  await setLabelledField("Mileage", String(p.mileage));

  // Steps 6-11 (line items, extras, MOT, description, gate) are factored out so a fill that
  // died AFTER the vehicle header was populated can be resumed WITHOUT redoing the reg + VRM
  // Lookup (which would re-fire the DVLA call and the Open-Document dialog on an already-
  // attached vehicle). See fillLines.
  return await fillLines(p);
}

/**
 * Fill the line items, Extras, MOT and Description of the draft ALREADY OPEN and already
 * carrying its vehicle/customer/mileage, then evaluate the totals gate. Split out of
 * fillInvoice so a half-filled draft (header done, lines not) can be completed in place.
 */
export async function fillLines(p: FillInvoicePayload) {
  // Bring Parallels frontmost + confirm the Mac isn't locked BEFORE the first OCR — a resume
  // entry point can be called with GA4 backgrounded, and a capture of a stale/black frame makes
  // the very first clickLabel("Labour") fail with "no on-screen text matches".
  await assertScreenUnlocked();
  invalidateWindowCache();
  clearGroundingCache();

  // 6. Labour lines.
  //    Coordinates are CALIBRATED from the grid's own column headers, not baked in: the
  //    hardcoded constants (qty x=753, price x=799, rowY0=365) were captured at an older
  //    guest resolution and are 14-19px off the live one, so every cell click landed just
  //    outside its target. That — not "input lag" — is why this tool garbled the reg and
  //    returned empty drafts, and why invoices ended up hand-driven. See grid.ts.
  //
  //    The Predefined-Jobs picker is no longer used. It bought an exact description, but
  //    typing is now batched (~0.1s for any string) so it can't scramble either, and the
  //    picker's preset LOCKED the price — the override was the single most failure-prone
  //    step in this file. One uniform path, verified by reading the grid back.
  const problems: string[] = [];
  let g: GridGeometry | null = null;

  if (p.labour?.length) {
    await clickLabel("Labour"); await sleep(700);
    // Confirm the tab actually switched. Right after VRM Lookup the tab click is often eaten
    // and we stay on History — calibrateGrid then throws with a confusing "headers not found"
    // (90731), or worse, a click could land on whatever tab IS showing.
    await assertTabActive("Labour");
    g = await calibrateGrid();
    problems.push(...(await enterLinesVerified(g, p.labour, "Labour")));
  }

  // 7. Parts lines. Re-calibrate: the Parts grid is a different portal (its Description
  //    column starts further left), and the tab click must be CONFIRMED to have landed —
  //    a silently-ignored Labour→Parts switch once sent a parts description into labour
  //    row 1, overwriting "Diagnostic Check" with "Front Discs" (07/10).
  if (p.parts?.length) {
    await clickLabel("Parts"); await sleep(700);
    await assertTabActive("Parts");
    g = await calibrateGrid();
    problems.push(...(await enterLinesVerified(g, p.parts, "Parts")));
  }

  // 7b. Sundries / Lubricants / Paint & Mat. go in the Extras panel, NOT as a Parts line
  //     (Adam, 06/07 — they must land in GA4's own Extras fields for the Sage export).
  if (p.sundries) {
    await setExtrasField("Sundries", p.sundries);
  }

  // 8. MOT Extras (optional).
  //    Anchors are GROUNDED on the Extras labels, not baked: the old constants (motAnchor
  //    [1105,709], class [1120,725], status [1120,741]) sit ~85px BELOW the real rows (MOT y≈623,
  //    Class ≈637, Status ≈653) — they would have opened the Sundries/Lubricants fields instead,
  //    and a wrong MOT Class still produces a self-consistent fee, so the totals gate would not
  //    necessarily catch it.
  if (p.mot) {
    await setMotExtras(p.mot);
    // MOT Tester left as GA4's carried-over default (DB | Dec = Dec Buckley at ELI).
  }

  // 9. Description (optional) — paste works here; GA4 will Title-Case on commit. "Description"
  //    appears as BOTH the tab and a portal column header, so ground with a `near` hint to the
  //    tab. The box only focuses on a click LOW in the text area (a click near its top is a
  //    no-op — proven on 90721), hence C.descBox is mid-box, not the top edge.
  if (p.jobDescription) {
    await clickLabel("Description", { near: { x: 146, y: 305 } }); await sleep(600);
    await pasteSticky(...C.descBox, p.jobDescription);
    await sleep(300);
  }

  // 10. End on the Parts tab so the returned screenshot shows the parts portal +
  //     the Extras + Totals panels together (the gate the caller must verify).
  await clickLabel("Parts"); await sleep(500);

  // 11. Evaluate the correctness gate HERE, server-side, rather than shipping a screenshot
  //     back and spending an LLM turn squinting at it. The caller still gets the screenshot
  //     (customer/Acc-No is a judgement call the model should make), but the arithmetic and
  //     the line-by-line read-back are decided in-process.
  //
  //     NOTE the gate's blind spot: a matching Total does NOT prove the lines are right (a
  //     wrong description or a swapped £0.00 line still sums correctly). `problems` is the
  //     grid read-back, and it is the check that catches those. Both must be clean.
  const shot = await screenshot();
  const totals = await readTotals();
  const gateError = p.expectedGross !== undefined
    ? checkTotalsGate(totals, p.expectedGross)
    : null;

  const verdict: string[] = [];
  verdict.push(
    `Totals: SubTotal ${fmt(totals.subTotal)}  VAT ${fmt(totals.vat)}  ` +
      `MOT ${fmt(totals.mot)}  Total ${fmt(totals.total)}`
  );
  if (p.expectedGross !== undefined) {
    verdict.push(gateError ? `GATE FAIL — ${gateError}` : `GATE PASS — matches expected £${p.expectedGross.toFixed(2)} to the penny`);
  } else {
    verdict.push("GATE NOT CHECKED — no expectedGross supplied; verify the Totals panel yourself before issuing.");
  }
  if (problems.length) {
    verdict.push(`LINE MISMATCHES (${problems.length}) — these survived ${MAX_REPAIR_PASSES} repair passes:`);
    verdict.push(...problems.map((s) => `  • ${s}`));
  } else {
    verdict.push("Lines: read back from the grid and all match.");
  }
  const safe = !gateError && !problems.length;
  verdict.push(
    safe
      ? "SAFE TO ISSUE (still confirm the customer Acc No in the screenshot)."
      : "DO NOT ISSUE — fix the problems above first."
  );

  return {
    content: [
      ...(shot.content as any[]),
      { type: "text" as const, text: verdict.join("\n") },
    ],
  };
}

const fmt = (n: number | null): string => (n === null ? "?" : `£${n.toFixed(2)}`);

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
  invalidateWindowCache();
  clearGroundingCache();   // the Issue dialog is a fresh screen — don't reuse the draft's cache
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
  // Issue Only — grounded (its Y varies with the dialog position, so a constant misses) AND
  // double-clicked: a single click only SELECTS the tab without firing the issue (proven on 90721,
  // where two single clicks left it Not-Issued and a double-click issued it).
  await clickLabel("Issue Only", { doubleClick: true }); await sleep(2000);
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
