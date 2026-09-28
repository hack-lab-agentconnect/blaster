// Live stdio smoke test for the MCP server: initialize, then tools/list, then a
// read-only tool call. Run with the server on the PATH via pnpm --filter.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Spawned directly through node + tsx rather than through `pnpm`, because a
// package-manager shim is not spawnable portably from a bare child process.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "node_modules/tsx/dist/cli.mjs",
    "packages/blaster-mcp/src/mcp/index.ts",
  ],
  cwd: process.cwd(),
  env: { ...process.env },
});

const client = new Client({ name: "blaster-smoke", version: "0.1.0" });
await client.connect(transport);

const listed = await client.listTools();
console.log("tools:", listed.tools.map((tool) => tool.name).join(", "));

const env = await client.callTool({ name: "blaster_env", arguments: {} });
console.log("blaster_env ->", JSON.stringify(env.structuredContent ?? env.content).slice(0, 220));

const profile = await client.callTool({
  name: "blaster_messaging_profile",
  arguments: { to: process.env.SMOKE_TO ?? "+353871234567" },
});
console.log("blaster_messaging_profile ->", JSON.stringify(profile.structuredContent ?? profile.content).slice(0, 220));

await client.close();
console.log("SMOKE OK");
