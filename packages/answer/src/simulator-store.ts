import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "@phoenix/store";
import { canonicalJson } from "@phoenix/wire";

export class SimulatorStore {
  readonly #root: string;
  constructor(root: string) { this.#root = root; }

  async get(key: string): Promise<unknown | undefined> {
    try { return JSON.parse(await readFile(join(this.#root, digest(key).slice(7) + ".json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async put(key: string, value: unknown): Promise<unknown> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const temp = join(this.#root, `.${randomUUID()}.tmp`);
    const target = join(this.#root, digest(key).slice(7) + ".json");
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(canonicalJson(value));
      await file.sync();
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    } finally { await file.close(); }
    try {
      try { await link(temp, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const dir = await open(this.#root, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temp); }
    return this.get(key);
  }
}
