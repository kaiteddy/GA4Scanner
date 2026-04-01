import { imageToVmCoords, vmExecScript } from "../vm.js";

const coordProps = {
  x: { type: "number", description: "X coordinate in the screenshot image (pixels from left edge of screenshot)" },
  y: { type: "number", description: "Y coordinate in the screenshot image (pixels from top edge of screenshot)" },
} as const;

export const clickTool = {
  name: "click",
  description:
    "Click at a position in Garage Assistant 4. Coordinates are pixel positions in the screenshot image (1200px wide). Always take a screenshot first to identify coordinates.",
  inputSchema: {
    type: "object" as const,
    properties: coordProps,
    required: ["x", "y"],
  },
};

export const doubleClickTool = {
  name: "double_click",
  description: "Double-click at a position. Useful for opening records, selecting words in text fields. Coordinates are pixel positions in the screenshot image.",
  inputSchema: {
    type: "object" as const,
    properties: coordProps,
    required: ["x", "y"],
  },
};

export const rightClickTool = {
  name: "right_click",
  description: "Right-click at a position. Opens context menus. Coordinates are pixel positions in the screenshot image.",
  inputSchema: {
    type: "object" as const,
    properties: coordProps,
    required: ["x", "y"],
  },
};

export async function click(args: { x: number; y: number }) {
  const { vmX, vmY } = imageToVmCoords(args.x, args.y);
  const result = await vmExecScript("click.ps1", `-X ${vmX} -Y ${vmY}`);
  return {
    content: [{ type: "text" as const, text: `Click at image (${args.x},${args.y}) → VM (${vmX},${vmY}). ${result}` }],
  };
}

export async function doubleClick(args: { x: number; y: number }) {
  const { vmX, vmY } = imageToVmCoords(args.x, args.y);
  const result = await vmExecScript("doubleclick.ps1", `-X ${vmX} -Y ${vmY}`);
  return {
    content: [{ type: "text" as const, text: `Double-click at image (${args.x},${args.y}) → VM (${vmX},${vmY}). ${result}` }],
  };
}

export async function rightClick(args: { x: number; y: number }) {
  const { vmX, vmY } = imageToVmCoords(args.x, args.y);
  const result = await vmExecScript("rightclick.ps1", `-X ${vmX} -Y ${vmY}`);
  return {
    content: [{ type: "text" as const, text: `Right-click at image (${args.x},${args.y}) → VM (${vmX},${vmY}). ${result}` }],
  };
}
