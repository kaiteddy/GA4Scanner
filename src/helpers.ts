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

/**
 * Screenshots keep working when the Mac screen is locked (prlctl reads the VM
 * framebuffer), but clicks/keystrokes land on the lock screen — silently doing
 * nothing to GA4. Detect the lock up front so tools fail with an actionable
 * message instead of an AppleScript "Invalid index" error.
 *
 * PERF: this spawns python3 (~100ms). A full invoice entry fires 40-60 clicks/
 * keystrokes, and this used to run TWICE per click (once here, once inside
 * activateParallels) — ~200ms of pure lock-polling per action, ~10s+ per
 * invoice for a fact that changes maybe once a session. Cache it briefly:
 * still catches a mid-session lock within LOCK_CACHE_MS, but stops re-asking
 * six times a second.
 */
const LOCK_CACHE_MS = 3000;
let lockCache: { locked: boolean; at: number } | null = null;

export async function assertScreenUnlocked(): Promise<void> {
  if (lockCache && Date.now() - lockCache.at < LOCK_CACHE_MS) {
    if (lockCache.locked) {
      throw new Error(
        "Mac screen is LOCKED — clicks and keystrokes cannot reach GA4 (screenshots still work). " +
          "Ask the user to unlock the Mac, then retry."
      );
    }
    return;
  }
  try {
    const locked = await exec("python3", [
      "-c",
      "import Quartz; d = Quartz.CGSessionCopyCurrentDictionary(); print(bool(d and d.get('CGSSessionScreenIsLocked')))",
    ]);
    lockCache = { locked: locked === "True", at: Date.now() };
    if (lockCache.locked) {
      throw new Error(
        "Mac screen is LOCKED — clicks and keystrokes cannot reach GA4 (screenshots still work). " +
          "Ask the user to unlock the Mac, then retry."
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Mac screen is LOCKED")) throw e;
    // Lock probe itself failed (no python3?) — don't block on it, don't cache the failure.
  }
}

/**
 * PERF: the Parallels window essentially never moves mid-session (it's a
 * fixed console window), but every click was re-querying its position via a
 * fresh AppleScript call (~150-200ms). Cache it; a 30s TTL means at most one
 * extra lookup per half-minute of active work. If the window genuinely moves
 * (user drags it), the next click may be briefly off — call with
 * forceRefresh=true (or wait out the TTL) to recover.
 */
const WINDOW_CACHE_MS = 30000;
let windowCache: { info: WindowInfo; at: number } | null = null;

/** Get the Parallels VM window position and size */
export async function getParallelsWindow(forceRefresh = false): Promise<WindowInfo> {
  if (!forceRefresh && windowCache && Date.now() - windowCache.at < WINDOW_CACHE_MS) {
    return windowCache.info;
  }
  await assertScreenUnlocked();
  // Select the window BY NAME ("Win11Manual"), not "first window of prl_client_app".
  // "first window" is whichever Parallels window is topmost in z-order — if the small
  // Parallels "Control Center" panel (or any other Parallels dialog) ends up above the VM
  // console, "first window" silently returns ITS geometry. Every click then gets computed
  // against the wrong window's position/size and lands on/near Control Center instead of
  // GA4, while screenshots (a separate prlctl-capture path reading the VM framebuffer
  // directly) keep looking perfectly correct — so the failure is invisible until you
  // diagnose it via get_window_info. Naming the window makes this fail loudly instead.
  const script = `
tell application "System Events"
    set prl to first process whose name is "prl_client_app"
    try
        set w to first window of prl whose name is "Win11Manual"
    on error
        return "NOTFOUND"
    end try
    set wPos to position of w
    set wSize to size of w
    return ((item 1 of wPos) as text) & "," & ((item 2 of wPos) as text) & "," & ((item 1 of wSize) as text) & "," & ((item 2 of wSize) as text) & ",Win11Manual"
end tell`;
  let result: string;
  try {
    result = await osascript(script);
  } catch (e) {
    windowCache = null;
    throw new Error(
      "Parallels VM console window not found on the Mac (VM may be running headless after " +
        'its window was closed). Reopen it: Parallels menu bar → Window → "Win11Manual". ' +
        `Underlying error: ${e instanceof Error ? e.message.split("\n")[0] : e}`
    );
  }
  if (result.trim() === "NOTFOUND") {
    windowCache = null;
    throw new Error(
      'The "Win11Manual" Parallels window was not found (it may be minimized, or another ' +
        'Parallels panel like "Control Center" is covering/replacing it in the window list). ' +
        "Clicks would silently miss GA4 if we guessed — ask the user to click the Win11Manual " +
        "VM window on the Mac to bring it forward, then retry."
    );
  }
  const parts = result.split(",").map((s) => s.trim());
  const info: WindowInfo = {
    x: parseInt(parts[0], 10),
    y: parseInt(parts[1], 10),
    width: parseInt(parts[2], 10),
    height: parseInt(parts[3], 10),
    name: parts.slice(4).join(","),
  };
  windowCache = { info, at: Date.now() };
  return info;
}

/**
 * Screenshot image (1200 wide) maps to the Parallels window content area.
 * Native capture is 2814x2268 (2x Retina of 1407x1134 Windows logical resolution).
 * Resized to 1200 wide → height = 1200 * (2268/2814) ≈ 967.
 *
 * Parallels window: 1407 x 1172 macOS points.
 * Title bar ≈ 38pt, so content area = 1407 x 1134 (matches Windows logical res).
 */
const TITLE_BAR_HEIGHT = 38; // Parallels window title bar in Mac points
const IMG_WIDTH = 1200;

export async function toAbsoluteCoords(
  relX: number,
  relY: number
): Promise<{ absX: number; absY: number }> {
  const win = await getParallelsWindow();
  // The screenshot is resampled to IMG_WIDTH preserving the VM display aspect
  // ratio, and the window content area (width × height-titlebar) has that same
  // aspect ratio. So a single uniform scale applies to BOTH axes. Deriving it
  // from the live window width means it auto-adapts to any VM resolution
  // (previously a hardcoded IMG_HEIGHT broke clicks whenever the VM display
  // resolution changed).
  const scale = win.width / IMG_WIDTH;

  return {
    absX: Math.round(win.x + relX * scale),
    absY: Math.round(win.y + TITLE_BAR_HEIGHT + relY * scale),
  };
}

/**
 * Bring the Parallels VM window frontmost on the Mac.
 * REQUIRED before every cliclick / keystroke: cliclick clicks at absolute Mac
 * screen coordinates, so if any other app (e.g. Safari) is frontmost, the click
 * lands there instead of GA4. Keystroke injection likewise needs the VM window
 * active. This was the root cause of "flaky" clicks and lost keystrokes.
 */
const FRONTMOST_QUERY =
  "tell application \"System Events\" to get name of first process whose frontmost is true";

export async function activateParallels(): Promise<void> {
  await assertScreenUnlocked();
  // PERF fast path: within one invoice entry, Parallels is almost always
  // already frontmost from the previous action — the old code always paid
  // set-frontmost + sleep(200) + verify (~500ms) even then. One cheap check
  // first turns the common case into a single ~150ms osascript call.
  try {
    const front = await osascript(FRONTMOST_QUERY);
    if (front.trim() === "prl_client_app") return;
  } catch {
    // fall through to the slow retry path below
  }
  // Slow path: retry until Parallels is confirmed frontmost. Some machines
  // have apps (Mail/Safari notifications) that aggressively re-grab focus,
  // so a single activate + fixed sleep isn't enough — verify and retry.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await osascript(
        'tell application "System Events" to set frontmost of (first process whose name is "prl_client_app") to true'
      );
      await new Promise((r) => setTimeout(r, 200));
      const front = await osascript(FRONTMOST_QUERY);
      if (front.trim() === "prl_client_app") return;
    } catch {
      // System Events hiccup — retry
    }
  }
}

/** Click at macOS screen coordinates using cliclick (activates Parallels first) */
export async function macClick(absX: number, absY: number): Promise<string> {
  await activateParallels();
  await exec("cliclick", ["c:" + absX + "," + absY]);
  return `Clicked at macOS (${absX}, ${absY})`;
}

/**
 * Click RELIABLY: two separate single clicks at the same spot with a settle gap.
 *
 * WHY: In GA4 (FileMaker in Parallels) a single click frequently does NOTHING —
 * it is consumed as a window/field focus-activate event, so buttons don't fire
 * and fields don't enter edit mode. Proven 07/09 with a clean discriminator:
 * single-click a field + type "111" → nothing appears; then double-click + type
 * "222" → the field shows "111222" (the first click never opened edit mode, so
 * the keystrokes buffered and only flushed once the second click opened it).
 * This is the real cause of the session's "dropped clicks", "input lag", and
 * "doubled reg/mileage" — NOT time-based lag. click_menu_button already relied
 * on this ("first click does nothing, second opens the menu"); this generalizes
 * it to every click.
 *
 * Two separate `c:` clicks (not a `dc:` double-click event) are used on purpose:
 * they deliver single-click SEMANTICS to the control (no word-select / open-
 * record side effects), while the throwaway first click covers the eaten
 * activation. The first click being consumed makes the pair land as one
 * effective click; if the control was already warm, the second lands on the
 * same spot (re-focus / re-select — harmless for fields, buttons, list rows).
 * For a genuine toggle where a second same-spot click would undo the first,
 * call macClick directly (the click tool exposes this via `single: true`).
 */
export async function macClickReliable(absX: number, absY: number): Promise<string> {
  await activateParallels();
  await exec("cliclick", ["c:" + absX + "," + absY]);
  await new Promise((r) => setTimeout(r, 250));
  await activateParallels();
  await exec("cliclick", ["c:" + absX + "," + absY]);
  await new Promise((r) => setTimeout(r, 150));
  return `Clicked (reliable ×2) at macOS (${absX}, ${absY})`;
}

/** Double-click at macOS screen coordinates using cliclick (activates Parallels first) */
export async function macDoubleClick(absX: number, absY: number): Promise<string> {
  await activateParallels();
  await exec("cliclick", ["dc:" + absX + "," + absY]);
  return `Double-clicked at macOS (${absX}, ${absY})`;
}

/** Right-click at macOS screen coordinates using cliclick (activates Parallels first) */
export async function macRightClick(absX: number, absY: number): Promise<string> {
  await activateParallels();
  await exec("cliclick", ["rc:" + absX + "," + absY]);
  return `Right-clicked at macOS (${absX}, ${absY})`;
}
