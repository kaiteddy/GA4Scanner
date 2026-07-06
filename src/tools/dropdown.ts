import { toAbsoluteCoords, macClick, activateParallels } from "../helpers.js";

/**
 * FileMaker value-list popups here are small (~5.6 image-px per row) and,
 * critically, DON'T reliably close the instant an option is clicked — the
 * 2026-07-06 run repeatedly had the next click (meant for the following
 * field) land inside a still-open popup instead, silently changing the
 * wrong dropdown. Splitting "open" / "select" / "move on" across separate
 * click calls made that race easy to hit. Collapsing all three into one
 * call with a mandatory settle delay after the selection makes the race
 * structurally impossible rather than relying on remembering to wait.
 */
const SETTLE_MS = 900;

export const selectDropdownTool = {
  name: "select_dropdown",
  description:
    "Open a FileMaker dropdown/popup and select an option, as ONE call. Opens at " +
    "(anchorX, anchorY), waits for the popup to render, clicks (optionX, optionY) for the " +
    "target row, then waits again before returning so the popup is guaranteed closed before " +
    "your next action. Use this instead of separate click calls for any Extras dropdown " +
    "(MOT/Class/Status/Tester) — a bare click-then-click sequence can hit the still-open " +
    "popup instead of the next field.",
  inputSchema: {
    type: "object" as const,
    properties: {
      anchorX: { type: "number", description: "X of the dropdown field to click to open it" },
      anchorY: { type: "number", description: "Y of the dropdown field to click to open it" },
      optionX: { type: "number", description: "X of the target option row once the popup is open" },
      optionY: { type: "number", description: "Y of the target option row once the popup is open" },
    },
    required: ["anchorX", "anchorY", "optionX", "optionY"],
  },
};

export async function selectDropdown(args: { anchorX: number; anchorY: number; optionX: number; optionY: number }) {
  const anchor = await toAbsoluteCoords(args.anchorX, args.anchorY);
  await macClick(anchor.absX, anchor.absY);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const option = await toAbsoluteCoords(args.optionX, args.optionY);
  await macClick(option.absX, option.absY);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return {
    content: [
      {
        type: "text" as const,
        text: `Opened dropdown at (${args.anchorX},${args.anchorY}), selected option at (${args.optionX},${args.optionY}), settled ${SETTLE_MS}ms.`,
      },
    ],
  };
}

/**
 * FileMaker's own dropdown toolbar buttons (Delete ▾, etc.) intermittently
 * don't respond to a single click — observed twice in one session: first
 * click does nothing, second click (same coordinates, no state change in
 * between) opens the menu. Rather than re-discover this by trial each time,
 * always send two clicks with a settle gap.
 */
export const clickMenuButtonTool = {
  name: "click_menu_button",
  description:
    "Click a FileMaker toolbar dropdown button (e.g. Delete ▾) that opens a menu. These " +
    "sometimes don't respond to a single click for no visible reason (observed repeatedly) — " +
    "this sends two clicks with a settle gap, which reliably opens the menu.",
  inputSchema: {
    type: "object" as const,
    properties: {
      x: { type: "number", description: "X coordinate of the menu button" },
      y: { type: "number", description: "Y coordinate of the menu button" },
    },
    required: ["x", "y"],
  },
};

export async function clickMenuButton(args: { x: number; y: number }) {
  const { absX, absY } = await toAbsoluteCoords(args.x, args.y);
  await macClick(absX, absY);
  await new Promise((r) => setTimeout(r, 500));
  await activateParallels();
  await macClick(absX, absY);
  await new Promise((r) => setTimeout(r, 500));
  return {
    content: [{ type: "text" as const, text: `Double-clicked menu button at (${args.x},${args.y}) to open it.` }],
  };
}
