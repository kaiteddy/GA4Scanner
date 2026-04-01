import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Run a shell command and return stdout */
export async function exec(
  cmd: string,
  args: string[],
  options?: { input?: string; maxBuffer?: number }
): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    maxBuffer: 50 * 1024 * 1024, // 50MB for screenshots
    ...options,
  });
  return stdout.trim();
}

/** Run osascript with the given AppleScript */
export async function osascript(script: string): Promise<string> {
  return exec("osascript", ["-e", script]);
}

export interface WindowInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
}

/** Get the Parallels VM window position and size */
export async function getParallelsWindow(): Promise<WindowInfo> {
  const script = `
tell application "System Events"
    set prl to first process whose name is "prl_client_app"
    set w to first window of prl
    set wName to name of w
    set wPos to position of w
    set wSize to size of w
    return ((item 1 of wPos) as text) & "," & ((item 2 of wPos) as text) & "," & ((item 1 of wSize) as text) & "," & ((item 2 of wSize) as text) & "," & wName
end tell`;
  const result = await osascript(script);
  const parts = result.split(",").map((s) => s.trim());
  return {
    x: parseInt(parts[0], 10),
    y: parseInt(parts[1], 10),
    width: parseInt(parts[2], 10),
    height: parseInt(parts[3], 10),
    name: parts.slice(4).join(","),
  };
}

/**
 * The screenshot image is resized to 1200px wide (from native 2420px = 2x Retina).
 * The VM screen maps to the Parallels window content area (below the title bar).
 *
 * Coordinate mapping:
 *   Screenshot image (1200 wide) → VM native (2420 wide) → Mac screen
 *   imageX → vmX = imageX * (2420/1200) → screenX = win.x + vmX/2
 *   imageY → vmY = imageY * (1654/1200*aspect) → screenY = win.y + TITLE_BAR + vmY/2
 *
 * Simplified: the screenshot at 1200px = exactly the VM at 1210px Mac points (close enough).
 * So image coordinates ≈ VM window content coordinates directly.
 */
const TITLE_BAR_HEIGHT = 38; // Parallels window title bar in Mac points

export async function toAbsoluteCoords(
  relX: number,
  relY: number
): Promise<{ absX: number; absY: number }> {
  const win = await getParallelsWindow();
  // Image is 1200px wide, VM content area is ~1210 Mac points wide
  // Scale factor is ~1.008, close enough to 1:1 for clicking
  const scaleX = win.width / 1200;
  const vmHeight = win.height - TITLE_BAR_HEIGHT; // 827
  // Image height at 1200 wide: 1200 * (1654/2420) = 820, close to 827
  const imageHeight = 1200 * (1654 / 2420);
  const scaleY = vmHeight / imageHeight;

  return {
    absX: Math.round(win.x + relX * scaleX),
    absY: Math.round(win.y + TITLE_BAR_HEIGHT + relY * scaleY),
  };
}
