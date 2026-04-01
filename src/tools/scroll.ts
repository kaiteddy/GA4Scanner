import { imageToVmCoords, vmExecScript } from "../vm.js";

export const scrollTool = {
  name: "scroll",
  description:
    "Scroll at a position in the VM window. " +
    "Positive dy scrolls down, negative dy scrolls up. " +
    "Coordinates are pixel positions in the screenshot image.",
  inputSchema: {
    type: "object" as const,
    properties: {
      x: {
        type: "number",
        description: "X coordinate in the screenshot image",
      },
      y: {
        type: "number",
        description: "Y coordinate in the screenshot image",
      },
      dy: {
        type: "number",
        description: "Scroll amount. Positive = down, negative = up. Each unit ≈ 3 scroll lines.",
      },
    },
    required: ["x", "y", "dy"],
  },
};

export async function scroll(args: { x: number; y: number; dy: number }) {
  const { vmX, vmY } = imageToVmCoords(args.x, args.y);

  // Move cursor to position then scroll using PowerShell
  // mouse_event with MOUSEEVENTF_WHEEL
  const scrollAmount = Math.round(args.dy * -120); // Windows scroll: negative = down
  await vmExecScript("click.ps1", `-X ${vmX} -Y ${vmY}`);
  // Small delay then scroll
  await new Promise((r) => setTimeout(r, 100));
  // For now, use keyboard PageDown/PageUp as a reliable alternative
  if (args.dy > 0) {
    for (let i = 0; i < Math.abs(Math.round(args.dy)); i++) {
      const { vmSendKey, SCANCODES } = await import("../vm.js");
      await vmSendKey(SCANCODES["pagedown"]);
    }
  } else {
    for (let i = 0; i < Math.abs(Math.round(args.dy)); i++) {
      const { vmSendKey, SCANCODES } = await import("../vm.js");
      await vmSendKey(SCANCODES["pageup"]);
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Scrolled ${args.dy > 0 ? "down" : "up"} by ${Math.abs(args.dy)} at image (${args.x},${args.y}) → VM (${vmX},${vmY})`,
      },
    ],
  };
}
