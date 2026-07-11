/**
 * Execute commands inside the Windows VM via prlctl exec.
 * This bypasses macOS entirely - clicks and keystrokes go directly into Windows.
 */

import { exec, execWithInput, activateParallels } from "./helpers.js";

const VM_NAME = "Win11Manual";
const SCRIPTS_DIR = "C:\\GA4Scripts";

// VM screen resolution (Windows reports 1407x1134)
const VM_WIDTH = 1407;
const VM_HEIGHT = 1134;

// Screenshot image dimensions after resize
const IMG_WIDTH = 1200;
// prlctl capture gives 2814x2268 native (2x Retina), resized to 1200 wide:
const IMG_HEIGHT = Math.round(1200 * (2268 / 2814)); // ~967

/**
 * Convert screenshot image coordinates to Windows VM screen coordinates.
 */
export function imageToVmCoords(imgX: number, imgY: number): { vmX: number; vmY: number } {
  return {
    vmX: Math.round(imgX * (VM_WIDTH / IMG_WIDTH)),
    vmY: Math.round(imgY * (VM_HEIGHT / IMG_HEIGHT)),
  };
}

/** Run a PowerShell script inside the VM (in the interactive user session) */
export async function vmExecScript(scriptName: string, args: string = ""): Promise<string> {
  return exec("prlctl", [
    "exec", VM_NAME, "--current-user",
    "powershell", "-ExecutionPolicy", "Bypass",
    "-File", `${SCRIPTS_DIR}\\${scriptName}`,
    ...args.split(" ").filter(Boolean),
  ]);
}

/** Run a PowerShell command inside the VM (in the interactive user session) */
export async function vmExecCommand(command: string): Promise<string> {
  return exec("prlctl", [
    "exec", VM_NAME, "--current-user",
    "powershell", "-ExecutionPolicy", "Bypass",
    "-Command", command,
  ]);
}

/**
 * Set the VM's clipboard (shared with the interactive GA4 session — unlike
 * keystrokes sent via `prlctl exec`, which are session-isolated). This is the
 * deterministic path for exact text entry: paste can't scramble characters
 * the way per-key scancode typing can.
 *
 * PERF: the old path shelled into the guest (`prlctl exec ... Set-Clipboard`),
 * paying a full PowerShell cold-start — MEASURED at ~1000ms, every single paste.
 * Parallels' Shared Clipboard (verified on: `prlctl list -i` → "Shared clipboard
 * mode: on") already mirrors the Mac pasteboard into Windows, so `pbcopy` does
 * the same job in ~30ms. Verified live: pbcopy a marker, then Get-Clipboard in
 * the guest returned it on the first probe.
 *
 * The sync rides on the VM window being active, so activate first — which every
 * caller needs anyway before clicking/typing, and is a ~25ms cached no-op.
 * `pbcopy` takes the text on stdin, so it never touches a shell quoting layer:
 * apostrophes, ampersands and newlines pass through verbatim (the old
 * PowerShell path had to double every `'`).
 */
// Mac→guest sync is fast, but "how fast" can't be measured directly: the only
// guest-side probe (Get-Clipboard) costs ~700ms itself, which masks the very
// latency it would report (it synced 4/4 even with a 0ms sleep). So this is a
// deliberate guard rather than a measured floor. Every real caller inserts a
// click (~400ms) between vmSetClipboard and the Ctrl+V that consumes it, so
// this only has to cover a caller that pastes immediately.
const CLIPBOARD_SYNC_MS = 40;

export async function vmSetClipboard(text: string): Promise<void> {
  await activateParallels();
  await execWithInput("pbcopy", [], text);
  await new Promise((r) => setTimeout(r, CLIPBOARD_SYNC_MS));
}

/** Read the guest clipboard (slow: ~1s PowerShell). Used only to verify a sync. */
export async function vmGetClipboard(): Promise<string> {
  return (await vmExecCommand("Get-Clipboard")).replace(/\r/g, "").trim();
}

/**
 * Set the guest clipboard the slow-but-direct way, bypassing Mac↔VM sync.
 * Kept as a fallback for when Shared Clipboard is off or the sync is untrusted.
 */
export async function vmSetClipboardViaGuest(text: string): Promise<void> {
  const escaped = text.replace(/'/g, "''");
  await vmExecCommand(`Set-Clipboard -Value '${escaped}'`);
}

/**
 * KEYSTROKE TRANSPORT — why this is deliberately "slow".
 *
 * `prlctl send-key-event --json` accepts an array of press/release events on stdin and
 * delivers them all in ONE ~100ms spawn, versus ~100ms PER EVENT for the flag form. It
 * genuinely delivers (verified with a NumLock oracle), and it looked like a ~100x win.
 *
 * It is NOT SAFE for text entry, proven live on 2026-07-10 against a GA4 Lookup cell:
 *   • typing "Mechanical Labour" with no inter-event delay committed "Mechanical Labo" —
 *     trailing keys dropped;
 *   • a batched Ctrl+V pasted its clipboard SEVEN times ("Castrol…Castrol…Castrol…"), i.e.
 *     the guest saw Ctrl held down and AUTO-REPEATED it;
 *   • adding the per-event `delay` field (which prlctl does honour) didn't fix it — it
 *     produced empty cells and garbage like "Mechanical Labocccc".
 * Events fired back-to-back arrive faster than the guest's keyboard handler retires them,
 * so a press whose release hasn't landed yet reads as a held key. The old spawn-per-event
 * pacing was never wasted overhead — it WAS the inter-key delay.
 *
 * So: keep the paced, one-spawn-per-event path for correctness. The speed comes from not
 * needing many keystrokes at all — text goes in via a single clipboard PASTE (length
 * independent), which is only reliable now because setCell double-clicks the cell into
 * edit mode first. See setCell in tools/invoice.ts.
 *
 * `vmSendKeyEvents` is kept for the one safe case: a burst of taps of the SAME key where
 * an extra repeat is harmless and idempotent (clearing a field with backspace).
 */
export interface KeyEvent { scancode: number; event: "press" | "release"; delay?: number }

const MAX_EVENTS_PER_BATCH = 400;

/** Batched, paced key events in one spawn. Only safe for idempotent taps — see the note above. */
export async function vmSendKeyEvents(events: KeyEvent[]): Promise<void> {
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_BATCH) {
    const chunk = events.slice(i, i + MAX_EVENTS_PER_BATCH);
    await execWithInput("prlctl", ["send-key-event", VM_NAME, "--json"], JSON.stringify(chunk));
  }
}

/** Send a key scancode to the VM's virtual keyboard */
export async function vmSendKey(scancode: number): Promise<void> {
  await exec("prlctl", [
    "send-key-event", VM_NAME,
    "--scancode", String(scancode),
    "--event", "press",
  ]);
  await new Promise((r) => setTimeout(r, 50));
  await exec("prlctl", [
    "send-key-event", VM_NAME,
    "--scancode", String(scancode),
    "--event", "release",
  ]);
}

/** Send a key combo (e.g., Ctrl+A) */
export async function vmSendKeyCombo(scancodes: number[]): Promise<void> {
  // Press all modifiers
  for (const sc of scancodes.slice(0, -1)) {
    await exec("prlctl", ["send-key-event", VM_NAME, "--scancode", String(sc), "--event", "press"]);
    await new Promise((r) => setTimeout(r, 30));
  }
  // Press and release the main key
  const mainKey = scancodes[scancodes.length - 1];
  await exec("prlctl", ["send-key-event", VM_NAME, "--scancode", String(mainKey), "--event", "press"]);
  await new Promise((r) => setTimeout(r, 50));
  await exec("prlctl", ["send-key-event", VM_NAME, "--scancode", String(mainKey), "--event", "release"]);
  // Release modifiers in reverse
  for (const sc of scancodes.slice(0, -1).reverse()) {
    await exec("prlctl", ["send-key-event", VM_NAME, "--scancode", String(sc), "--event", "release"]);
    await new Promise((r) => setTimeout(r, 30));
  }
}

/**
 * Tap the same key `times` times, paced, in one spawn.
 *
 * Safe to batch ONLY because the callers use it to CLEAR a field with backspace: an extra
 * repeat on an already-empty field is a no-op, and a dropped one is caught by the read-back.
 * The 25ms delay keeps the guest from seeing the key as held (a held backspace auto-repeats
 * unbounded, which is what ate whole cells during the 07/10 experiments).
 */
const TAP_DELAY_MS = 25;

export async function vmSendKeyRepeat(scancode: number, times: number): Promise<void> {
  const evs: KeyEvent[] = [];
  for (let i = 0; i < times; i++) {
    evs.push(
      { scancode, event: "press", delay: TAP_DELAY_MS },
      { scancode, event: "release", delay: TAP_DELAY_MS }
    );
  }
  await vmSendKeyEvents(evs);
}

/**
 * Read the guest's live NumLock state from SESSION 1.
 *
 * MUST use `--current-user`: a plain `prlctl exec` runs as SYSTEM in session 0, whose
 * keyboard LED state is not the interactive user's — and whose PowerShell stdout is not even
 * captured. `--current-user` runs as the console user in session 1 (same session as GA4) and
 * returns output. Returns null if unreadable (don't act on an unknown state).
 */
export async function readGuestNumLock(): Promise<boolean | null> {
  try {
    const out = (
      await exec("prlctl", [
        "exec", VM_NAME, "--current-user",
        "powershell", "-NoProfile", "-Command", "[console]::NumberLock",
      ])
    ).replace(/\r/g, "").trim();
    if (/^true$/i.test(out)) return true;
    if (/^false$/i.test(out)) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Guarantee guest NumLock is OFF before any keystroke transport runs. THE fix for the
 * corruption class root-caused 2026-07-11.
 *
 * WHY: the nav-cluster scancodes this module sends — home=71 (0x47), end=79 (0x4F), arrows,
 * insert=82, del=83 — are the NUMERIC-KEYPAD keys. With NumLock ON they type digits
 * ("7","1","8","2"…) instead of moving the caret, so setCell's clear-sequence
 * (Home → Shift+End → Delete) never clears the cell and every paste APPENDS. That is the
 * entire "qty 1 → 7771", "price 99.00 → 777799.40", duplicated-description garbling we chased
 * for days — the glyphs are always 7s/1s because 0x47=KP7 and 0x4F=KP1. Windows/VMs boot with
 * NumLock ON, which is why it "came back" after every restart and toggled in waves. With
 * NumLock OFF the same scancodes are Home/End and the existing code is correct.
 *
 * Toggle via scancode 69 (NumLock itself — a NON-extended, unambiguous key) over the same
 * send-key-event channel that reaches GA4 (verified: flips True→False). Read-verify after.
 * Throws rather than proceed into guaranteed corruption if it can't be turned off.
 */
export async function ensureNumLockOff(): Promise<void> {
  const before = await readGuestNumLock();
  if (before === true) {
    await vmSendKey(69); // NumLock press+release toggles it
    await new Promise((r) => setTimeout(r, 150));
    const after = await readGuestNumLock();
    if (after === true) {
      throw new Error(
        "Guest NumLock is ON and would not turn OFF — keypad scancodes (Home/End) would type " +
          "digits and corrupt every field. Aborting before touching data. Press NumLock on the " +
          "guest keyboard (or check the send-key-event channel) and retry."
      );
    }
  }
  // The prlctl-exec NumLock read above briefly blanks the `prlctl capture` framebuffer (~1-2s);
  // settle so the caller's first OCR sees a fully-painted frame (ocrScreen also retries, this
  // just avoids the wasted captures).
  await new Promise((r) => setTimeout(r, 1200));
}

// Keyboard scan codes (US keyboard)
export const SCANCODES: Record<string, number> = {
  escape: 1, esc: 1,
  "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
  backspace: 14, delete: 14,
  tab: 15,
  enter: 28, return: 28,
  ctrl: 29, control: 29,
  shift: 42, lshift: 42,
  rshift: 54,
  alt: 56,
  space: 57,
  capslock: 58,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64,
  f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
  numlock: 69, scrolllock: 70,
  home: 71, up: 72, pageup: 73,
  left: 75, right: 77,
  end: 79, down: 80, pagedown: 81,
  insert: 82, del: 83,
  // Letters (US layout) — needed for combos like ctrl+f, ctrl+a
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36,
  k: 37, l: 38, m: 50, n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20,
  u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  // Common punctuation (unshifted key positions)
  minus: 12, equals: 13, semicolon: 39, quote: 40, backtick: 41,
  backslash: 43, comma: 51, period: 52, slash: 53,
  leftbracket: 26, rightbracket: 27,
};

/**
 * Map a printable character to its US-keyboard scancode + whether Shift is held.
 * Used by vmTypeText to inject text one keystroke at a time via send-key-event
 * (the only keyboard channel that reliably reaches GA4). Unsupported chars are
 * skipped by the caller.
 */
const SHIFT = 42;
export const CHAR_SCANCODES: Record<string, { sc: number; shift: boolean }> = (() => {
  const m: Record<string, { sc: number; shift: boolean }> = {};
  const add = (ch: string, sc: number, shift = false) => { m[ch] = { sc, shift }; };
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (const ch of letters) { add(ch, SCANCODES[ch]); add(ch.toUpperCase(), SCANCODES[ch], true); }
  const digits = "0123456789";
  const digitShift = ")!@#$%^&*(";
  for (let i = 0; i < 10; i++) { add(digits[i], SCANCODES[digits[i]]); add(digitShift[i], SCANCODES[digits[i]], true); }
  add(" ", 57);
  const punct: [string, number, string][] = [
    ["-", 12, "_"], ["=", 13, "+"], ["[", 26, "{"], ["]", 27, "}"],
    [";", 39, ":"], ["'", 40, '"'], ["`", 41, "~"], ["\\", 43, "|"],
    [",", 51, "<"], [".", 52, ">"], ["/", 53, "?"],
  ];
  for (const [base, sc, shifted] of punct) { add(base, sc); add(shifted, sc, true); }
  return m;
})();

/**
 * Type text into GA4 by injecting one keystroke per character via
 * prlctl send-key-event (Parallels-native — reaches the interactive desktop,
 * unlike clipboard/SendKeys run through `prlctl exec`, which is session-isolated).
 * The target field must already be focused (click it first). Unsupported
 * characters are silently skipped.
 */
export async function vmTypeText(text: string): Promise<void> {
  // Paced, one key at a time. Batching this into a single call LOOKED ~100x faster but
  // silently dropped and repeated characters in GA4's Lookup cells (see the transport note
  // above) — it fails in exactly the way that survives the totals gate. Text should go in
  // via vmSetClipboard + Ctrl+V instead; this stays for the few short, literal cases where
  // a paste can't be used (and where its cost is a handful of characters, not 40).
  for (const ch of text) {
    const entry = CHAR_SCANCODES[ch];
    if (!entry) continue;
    if (entry.shift) {
      await vmSendKeyCombo([SHIFT, entry.sc]);
    } else {
      await vmSendKey(entry.sc);
    }
  }
}
