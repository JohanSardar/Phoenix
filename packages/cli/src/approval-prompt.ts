import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export const phoenixHome = (home: string | undefined): string => resolve(home ?? process.env.PHOENIX_HOME ?? join(homedir(), ".phoenix"));
export const approver = (who: string | undefined): string => who ?? userInfo().username;

export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); }
  finally { rl.close(); }
}
