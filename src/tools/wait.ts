export const waitTool = {
  name: "wait",
  description:
    "Wait for a specified duration. Use after clicking buttons or navigating " +
    "to give Garage Assistant 4 / FileMaker time to load. " +
    "FileMaker can be slow — wait 1-3 seconds after navigation, longer for complex operations.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ms: {
        type: "number",
        description: "Milliseconds to wait. 1000 = 1 second. Typical: 500-3000ms.",
      },
    },
    required: ["ms"],
  },
};

export async function waitMs(args: { ms: number }) {
  const duration = Math.min(Math.max(args.ms, 100), 30000); // Clamp 100ms - 30s
  await new Promise((resolve) => setTimeout(resolve, duration));
  return {
    content: [
      {
        type: "text" as const,
        text: `Waited ${duration}ms`,
      },
    ],
  };
}
