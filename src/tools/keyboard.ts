import { vmSendKey, vmSendKeyCombo, vmTypeText, SCANCODES } from "../vm.js";
import { activateParallels } from "../helpers.js";

export const typeTextTool = {
  name: "type_text",
  description:
    "Type text into the currently focused field in Garage Assistant 4. " +
    "Click on a field first to focus it, then use this to type. " +
    "For special keys (Tab, Enter, etc.) use press_key instead.",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: {
        type: "string",
        description: "The text to type",
      },
    },
    required: ["text"],
  },
};

export const pressKeyTool = {
  name: "press_key",
  description:
    "Press a key or key combination. Use for navigation and shortcuts.\n" +
    "Common keys: return, tab, escape, delete, space, up, down, left, right\n" +
    "Common combos: ctrl+a (select all), ctrl+c (copy), ctrl+v (paste), ctrl+s (save), ctrl+f (find)\n" +
    "Note: In Windows, use ctrl (not cmd) for shortcuts.",
  inputSchema: {
    type: "object" as const,
    properties: {
      key: {
        type: "string",
        description:
          "Key to press. Examples: 'return', 'tab', 'escape', 'delete', 'space', " +
          "'up', 'down', 'left', 'right', 'f1'-'f12'. " +
          "For combos use '+': 'ctrl+a', 'ctrl+shift+s', 'alt+f4'",
      },
      repeat: {
        type: "number",
        description: "Number of times to press the key. Default: 1",
      },
    },
    required: ["key"],
  },
};

export async function typeText(args: { text: string }) {
  // Inject one keystroke per character via prlctl send-key-event. This is the
  // only keyboard channel that reaches GA4 (clipboard/SendKeys via `prlctl exec`
  // run in an isolated session and never reach the interactive desktop).
  // Activate the Parallels window first so keystrokes route to the VM; the
  // caller must have already clicked the target field to focus it.
  await activateParallels();
  await vmTypeText(args.text);
  return {
    content: [{ type: "text" as const, text: `Typed: "${args.text}" via key injection.` }],
  };
}

export async function pressKey(args: { key: string; repeat?: number }) {
  const count = args.repeat || 1;
  const parts = args.key.split("+").map((p) => p.trim().toLowerCase());

  for (let i = 0; i < count; i++) {
    if (parts.length === 1) {
      const sc = SCANCODES[parts[0]];
      if (sc) {
        await vmSendKey(sc);
      } else {
        return {
          content: [{ type: "text" as const, text: `Unknown key: ${parts[0]}. Available: ${Object.keys(SCANCODES).join(", ")}` }],
          isError: true,
        };
      }
    } else {
      const scancodes = parts.map((p) => SCANCODES[p]);
      if (scancodes.some((s) => s === undefined)) {
        const unknown = parts.filter((p) => !SCANCODES[p]);
        return {
          content: [{ type: "text" as const, text: `Unknown keys: ${unknown.join(", ")}` }],
          isError: true,
        };
      }
      await vmSendKeyCombo(scancodes as number[]);
    }
  }

  return {
    content: [{ type: "text" as const, text: `Pressed: ${args.key}${count > 1 ? ` (×${count})` : ""}` }],
  };
}
