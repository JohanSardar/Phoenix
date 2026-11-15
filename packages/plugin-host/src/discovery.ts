import { readdir, readFile, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { validate, type PluginDescriptor } from "@phoenix/formats";

export interface InstalledPlugin { directory: string; descriptor: PluginDescriptor }

export async function readPlugin(path: string): Promise<InstalledPlugin> {
  const file = await realpath(path);
  const result = validate("plugin", JSON.parse(await readFile(file, "utf8")));
  if (!result.ok) throw new Error(`Invalid plugin ${file}: ${result.errors.join("; ")}`);
  return { directory: dirname(file), descriptor: result.value };
}

export async function findPlugins(roots: string[]): Promise<InstalledPlugin[]> {
  const files = new Set<string>();
  const visit = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return; throw error; }
    if (entries.some((entry) => entry.name === "phoenix-plugin.json" && entry.isFile())) {
      files.add(await realpath(join(directory, "phoenix-plugin.json")));
      return;
    }
    if (depth === 0) return;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() || entry.isSymbolicLink()) await visit(join(directory, entry.name), entry.name.startsWith("@") ? depth : depth - 1);
    }
  };
  for (const root of roots) await visit(root, 1);
  return Promise.all([...files].map(readPlugin));
}
