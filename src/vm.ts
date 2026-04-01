/**
 * Execute commands inside the Windows VM via prlctl exec.
 * This bypasses macOS entirely - clicks and keystrokes go directly into Windows.
 */

import { exec } from "./helpers.js";

const VM_NAME = "Windows 11 (1)";
const SCRIPTS_DIR = "C:\\GA4Scripts";

// VM screen resolution (with --current-user, reports 1210x827 due to Retina scaling)
const VM_WIDTH = 1210;
const VM_HEIGHT = 827;

// Screenshot image dimensions after resize
const IMG_WIDTH = 1200;
// prlctl capture gives 2420x1654 native, resized to 1200 wide:
const IMG_HEIGHT = Math.round(1200 * (1654 / 2420)); // ~820

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
};
