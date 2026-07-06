/**
 * Execute commands inside the Windows VM via prlctl exec.
 * This bypasses macOS entirely - clicks and keystrokes go directly into Windows.
 */

import { exec } from "./helpers.js";

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
 * the way per-key scancode typing can. Single quotes are doubled for
 * PowerShell's single-quoted string escaping.
 */
export async function vmSetClipboard(text: string): Promise<void> {
  const escaped = text.replace(/'/g, "''");
  await vmExecCommand(`Set-Clipboard -Value '${escaped}'`);
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
