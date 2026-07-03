import { toAbsoluteCoords, macClick, macDoubleClick, macRightClick } from "../helpers.js";

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
  const { absX, absY } = await toAbsoluteCoords(args.x, args.y);
  const result = await macClick(absX, absY);
  return {
    content: [{ type: "text" as const, text: `Click at image (${args.x},${args.y}) → macOS (${absX},${absY}). ${result}` }],
  };
}

export async function doubleClick(args: { x: number; y: number }) {
  const { absX, absY } = await toAbsoluteCoords(args.x, args.y);
  const result = await macDoubleClick(absX, absY);
  return {
    content: [{ type: "text" as const, text: `Double-click at image (${args.x},${args.y}) → macOS (${absX},${absY}). ${result}` }],
  };
}

export async function rightClick(args: { x: number; y: number }) {
  const { absX, absY } = await toAbsoluteCoords(args.x, args.y);
  const result = await macRightClick(absX, absY);
  return {
    content: [{ type: "text" as const, text: `Right-click at image (${args.x},${args.y}) → macOS (${absX},${absY}). ${result}` }],
  };
}
