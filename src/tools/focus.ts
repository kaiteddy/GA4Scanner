import { vmExecScript } from "../vm.js";

export const focusWindowTool = {
  name: "focus_window",
  description:
    "Bring Garage Assistant 4 to the front inside the Windows VM. " +
    "Use this if GA4 is behind other windows inside Windows.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function focusWindow() {
  try {
    const result = await vmExecScript("focus_ga4.ps1");
    return {
      content: [{ type: "text" as const, text: `Focus result: ${result}` }],
    };
  } catch {
    return {
      content: [{ type: "text" as const, text: "Attempted to focus GA4 window" }],
    };
  }
}
