import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { markSession } from "@phoenix/capture";

const USAGE = "Usage: phoenix mark [--recipe <recipe.yaml>] [--session <session-file>] [--at <line>] [--cwd <folder>] [--mcp-config <file>] [--plugin <dir> ...] [--note <text>] [--home <dir>]";

export async function runMarkCommand(args: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
    recipe: { type: "string" }, session: { type: "string" }, at: { type: "string" }, cwd: { type: "string" }, "mcp-config": { type: "string" },
    plugin: { type: "string", multiple: true }, note: { type: "string" }, home: { type: "string" },
  } });
  const recipe = v.recipe ?? process.env.PHOENIX_RECIPE;
  if (positionals.length || !recipe) throw new Error(`${USAGE}\nName the harness's recipe with --recipe or PHOENIX_RECIPE.`);
  const plugins = v.plugin ?? process.env.PHOENIX_PLUGINS?.split(":").filter(Boolean) ?? [];
  const mcpConfig = v["mcp-config"] ?? process.env.PHOENIX_MCP_CONFIG;
  const { mark, directory } = await markSession({
    home: resolve(v.home ?? process.env.PHOENIX_HOME ?? join(homedir(), ".phoenix")), recipe, ...(v.cwd ? { cwd: v.cwd } : {}),
    ...(v.session ? { session: v.session } : {}), ...(v.at !== undefined ? { at: Number(v.at) } : {}), ...(v.note ? { note: v.note } : {}),
    ...(mcpConfig ? { mcpConfig } : {}), plugins,
  });
  const world = mark.world.files === "saved" ? mark.world : { files: "not saved: marked after the fact", services: "not saved: marked after the fact" };
  process.stdout.write(JSON.stringify({ mark: mark.id, directory, session: mark.session.path, line: mark.line, world, next: `phoenix moment create --mark ${directory} --id <id> --check <check.yaml> <out-dir>` }) + "\n");
  return 0;
}
