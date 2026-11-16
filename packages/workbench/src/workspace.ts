import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { validate, type HarnessContract } from "@phoenix/formats";
import { treeDigest } from "@phoenix/runner";

const run = promisify(execFile);

export interface WorkspaceState {
  phoenix_workspace: 1;
  name: string;
  harness: { source: string; repo: string; path: string; git: boolean; branch?: string };
  base: string;
  moments: string;
  settings: string;
}

export interface Candidate { digest: string; directory: string; commit: string; changes: Change[] }
export interface Change { path: string; status: "modified" | "added" | "deleted" }

export async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  return (await run("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } })).stdout;
}

export function harnessPath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some(p => !p || p === "." || p === ".."))
    throw new Error(`Path is not inside the harness tree: ${path}`);
  return path;
}

export const isEditable = (contract: HarnessContract, path: string): boolean => contract.editable.some(glob => matchesGlob(path, glob));

async function save(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

export async function createWorkspace(options: { home: string; name: string; harness: string; moments: string; settings: string; base?: string }): Promise<WorkspaceState> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.name)) throw new Error("Workspace names use letters, digits, dot, dash and underscore");
  const root = join(options.home, "workspaces", options.name);
  try { await lstat(root); throw new Error(`Workspace already exists: ${options.name}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const source = await realpath(options.harness);
  await mkdir(join(options.home, "workspaces"), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(options.home, "workspaces", `.${options.name}-`));
  let worktree: string | undefined;
  try {
    let harness: WorkspaceState["harness"], base: string;
    const top = await git(source, ["rev-parse", "--show-toplevel"]).then(s => s.trim(), () => undefined);
    if (top) {
      const repo = await realpath(top);
      base = (await git(repo, ["rev-parse", "--verify", `${options.base ?? "HEAD"}^{commit}`])).trim();
      const branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      await git(repo, ["worktree", "add", "--detach", join(root, "tree"), base]);
      worktree = repo;
      harness = { source, repo, path: relative(repo, source).split(sep).join("/"), git: true, ...(branch !== "HEAD" ? { branch } : {}) };
    } else {
      if (options.base) throw new Error("A harness outside git has no base commit to choose");
      await cp(source, join(stage, "tree"), { recursive: true, verbatimSymlinks: true, filter: path => basename(path) !== ".git" });
      await git(join(stage, "tree"), ["init", "-q"]);
      await git(join(stage, "tree"), ["add", "-A"]);
      await git(join(stage, "tree"), ["commit", "-q", "--no-verify", "-m", "Phoenix workspace base"]);
      base = (await git(join(stage, "tree"), ["rev-parse", "HEAD"])).trim();
      harness = { source, repo: join(root, "tree"), path: "", git: false };
    }
    const state: WorkspaceState = { phoenix_workspace: 1, name: options.name, harness, base, moments: await realpath(options.moments), settings: await realpath(options.settings) };
    await save(join(stage, "workspace.json"), state);
    if (top) {
      for (const name of await readdir(stage)) await rename(join(stage, name), join(root, name));
      await rm(stage, { recursive: true });
    } else await rename(stage, root);
    await contractOf(root, state);
    return state;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (worktree) await git(worktree, ["worktree", "remove", "--force", join(root, "tree")]).catch(() => {});
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function openWorkspace(home: string, name: string): Promise<{ root: string; state: WorkspaceState; tree: string; contract: HarnessContract }> {
  const root = join(home, "workspaces", name);
  const state = JSON.parse(await readFile(join(root, "workspace.json"), "utf8")) as WorkspaceState;
  if (state.phoenix_workspace !== 1) throw new Error(`Unsupported workspace version: ${state.phoenix_workspace}`);
  return { root, state, tree: join(root, "tree", state.harness.path), contract: await contractOf(root, state) };
}

async function contractOf(root: string, state: WorkspaceState): Promise<HarnessContract> {
  const spec = `${state.base}:${state.harness.path ? state.harness.path + "/" : ""}phoenix.harness.yaml`;
  const text = await git(join(root, "tree"), ["show", spec]).catch(() => { throw new Error("The base tree has no phoenix.harness.yaml"); });
  const contract = validate("harness", parse(text));
  if (!contract.ok) throw new Error(`Invalid harness contract: ${contract.errors.join("; ")}`);
  const inside = relative(join(root, "tree", state.harness.path), state.moments);
  const momentsInTree = !inside.startsWith("..") && !isAbsolute(inside);
  const sourceInside = relative(state.harness.source, state.moments);
  if (momentsInTree || (!sourceInside.startsWith("..") && !isAbsolute(sourceInside))) {
    const prefix = momentsInTree ? inside : sourceInside;
    const files = await listFiles(state.moments);
    const matched = files.map(file => [prefix, file].filter(Boolean).join("/")).filter(path => isEditable(contract.value, path));
    if (matched.length) throw new Error(`The harness contract's editable globs match moment bundle paths: ${matched.slice(0, 5).join(", ")}`);
  }
  return contract.value;
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(directory, path)); else files.push(path);
  }
  return files;
}

export async function changes(root: string, state: WorkspaceState): Promise<Change[]> {
  const tree = join(root, "tree");
  const scope = state.harness.path || ".";
  const strip = (path: string) => state.harness.path ? path.slice(state.harness.path.length + 1) : path;
  const result: Change[] = [];
  const diff = (await git(tree, ["diff", "--name-status", "-z", "--no-renames", state.base, "--", scope])).split("\0").filter(Boolean);
  for (let i = 0; i < diff.length; i += 2) result.push({ path: strip(diff[i + 1]!), status: diff[i] === "D" ? "deleted" : diff[i] === "A" ? "added" : "modified" });
  for (const path of (await git(tree, ["ls-files", "--others", "--exclude-standard", "-z", "--", scope])).split("\0").filter(Boolean)) result.push({ path: strip(path), status: "added" });
  return result.sort((a, b) => a.path < b.path ? -1 : 1);
}

export async function freezeCandidate(root: string, state: WorkspaceState, contract: HarnessContract): Promise<Candidate> {
  const tree = join(root, "tree");
  const found = await changes(root, state);
  const refused: string[] = [];
  for (const change of found) {
    try { harnessPath(change.path); } catch { refused.push(`${change.path} (escapes the tree)`); continue; }
    if (!isEditable(contract, change.path)) { refused.push(`${change.path} (not editable)`); continue; }
    if (change.status !== "deleted") {
      const full = join(tree, state.harness.path, change.path);
      const stat = await lstat(full);
      if (!stat.isFile()) { refused.push(`${change.path} (${stat.isSymbolicLink() ? "symlink" : "not a regular file"})`); continue; }
      const real = await realpath(full);
      if (relative(await realpath(join(tree, state.harness.path)), real).startsWith("..")) refused.push(`${change.path} (escapes the tree)`);
    }
  }
  if (refused.length) throw new Error(`Replay refused; these changed paths are outside the editable set: ${refused.join(", ")}`);
  const full = (path: string) => [state.harness.path, path].filter(Boolean).join("/");
  const index = join(root, `.index-${process.pid}`);
  const env = { GIT_INDEX_FILE: index };
  let commit = state.base;
  try {
    if (found.length) {
      await git(tree, ["read-tree", state.base], env);
      for (const change of found) {
        if (change.status === "deleted") { await git(tree, ["update-index", "--force-remove", "--", full(change.path)], env); continue; }
        const hash = (await git(tree, ["hash-object", "-w", "--", full(change.path)])).trim();
        const mode = (await lstat(join(tree, full(change.path)))).mode & 0o100 ? "100755" : "100644";
        await git(tree, ["update-index", "--add", "--cacheinfo", `${mode},${hash},${full(change.path)}`], env);
      }
      const written = (await git(tree, ["write-tree"], env)).trim();
      commit = (await git(tree, ["commit-tree", written, "-p", state.base, "-m", `Phoenix candidate: ${found.map(c => c.path).join(", ")}`])).trim();
    }
  } finally { await rm(index, { force: true }); }
  await git(tree, ["update-ref", `refs/phoenix/candidates/${commit}`, commit]);
  const directory = await exportTree(root, tree, commit, state.harness.path);
  return { digest: await treeDigest(directory), directory, commit, changes: found };
}

export async function exportTree(root: string, tree: string, commit: string, path: string): Promise<string> {
  const directory = join(root, "trees", commit);
  if (await lstat(directory).then(() => true, () => false)) return directory;
  await mkdir(join(root, "trees"), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(root, "trees", ".export-"));
  await run("sh", ["-c", 'git archive "$1" | tar -x -C "$2"', "sh", path ? `${commit}:${path}` : commit, stage], { cwd: tree });
  await rename(stage, directory);
  return directory;
}

export function resolveInTree(tree: string, path: string): string {
  const target = resolve(tree, path);
  const inside = relative(tree, target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error(`Path is not inside the harness tree: ${path}`);
  return harnessPath(inside.split(sep).join("/"));
}
