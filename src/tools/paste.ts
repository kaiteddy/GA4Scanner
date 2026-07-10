import { toAbsoluteCoords, macClickReliable, activateParallels } from "../helpers.js";
import { vmSetClipboard, vmSendKeyCombo, SCANCODES } from "../vm.js";

export const pasteFieldTool = {
  name: "paste_field",
  description:
    "Click a field and paste exact text into it in ONE call (clipboard-set + click + " +
    "select-all + paste). Deterministic — reproduces any characters, can't scramble like " +
    "per-key typing. Prefer this over separate click/press_key calls for exact-text entry " +
    "(descriptions, registrations, prices): it does the same thing in one round-trip instead " +
    "of four, which matters because each round-trip pays Parallels-activation overhead.",
  inputSchema: {
    type: "object" as const,
    properties: {
      x: { type: "number", description: "X coordinate in the screenshot image (pixels from left edge)" },
      y: { type: "number", description: "Y coordinate in the screenshot image (pixels from top edge)" },
      text: { type: "string", description: "The exact text to paste" },
      selectAll: {
        type: "boolean",
        description: "Select all existing content before pasting (Ctrl+A). Default true — set " +
          "false to paste at the cursor into an empty/new field without clearing it.",
      },
    },
    required: ["x", "y", "text"],
  },
};

export async function pasteField(args: { x: number; y: number; text: string; selectAll?: boolean }) {
  const selectAll = args.selectAll !== false;
  await vmSetClipboard(args.text);
  const { absX, absY } = await toAbsoluteCoords(args.x, args.y);
  // Reliable (×2) click: a single click often only focus-activates the field
  // without entering edit mode, so the paste lands nowhere. The second click
  // is what actually opens the field for input. (See macClickReliable.)
  await macClickReliable(absX, absY);
  // macClickReliable already activated Parallels; activateParallels() below is a
  // cached no-op in the common case (see helpers.ts fast path) so this stays cheap.
  await activateParallels();
  if (selectAll) {
    await vmSendKeyCombo([SCANCODES.ctrl, SCANCODES.a]);
  }
  await vmSendKeyCombo([SCANCODES.ctrl, SCANCODES.v]);
  return {
    content: [
      {
        type: "text" as const,
        text: `Pasted "${args.text}" at image (${args.x},${args.y})${selectAll ? " (select-all first)" : ""}.`,
      },
    ],
  };
}
