import { posix } from "node:path";

const NETWORK = new Set(["curl", "wget", "gh", "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "nc", "ncat", "npx", "pnpx", "bunx", "uvx", "pipx"]);
const NETWORK_SUBCOMMANDS = new Map<string, readonly string[]>([
  ["git", ["fetch", "pull", "push", "clone", "ls-remote"]],
  ["npm", ["install", "i", "ci", "add", "update", "upgrade", "publish"]],
  ["pnpm", ["install", "i", "add", "update", "up", "upgrade", "dlx", "publish"]],
  ["yarn", ["install", "add", "upgrade", "up", "dlx", "publish"]],
  ["bun", ["install", "i", "add", "update", "x", "publish"]],
  ["pip", ["install", "download"]],
  ["pip3", ["install", "download"]],
  ["uv", ["sync", "add", "pip", "tool"]],
  ["brew", ["install", "upgrade", "update", "fetch"]],
  ["apt", ["install", "update", "upgrade"]],
  ["apt-get", ["install", "update", "upgrade"]],
  ["cargo", ["install", "fetch", "update", "add", "publish"]],
  ["go", ["get", "install"]],
]);
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const WRAPPERS = new Set(["sudo", "env", "exec", "time", "nohup", "nice", "xargs", "timeout", "then", "do", "else", "elif", "if", "while", "until", "!", "builtin", "command"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

function commandsIn(line: string): string[][] {
  const parts: string[][] = [[]];
  let word: string | undefined, quote = "";
  const end = () => { if (word !== undefined) parts.at(-1)!.push(word); word = undefined; };
  for (let at = 0; at < line.length; at++) {
    const c = line[at]!;
    if (quote && c === quote) quote = "";
    else if (quote && !(quote === '"' && (c === "\x60" || (c === "$" && line[at + 1] === "(")))) word += c;
    else if (!quote && (c === "'" || c === '"')) { quote = c; word ??= ""; }
    else if (!quote && c === "\\") word = (word ?? "") + (line[++at] ?? "");
    else if (!quote && (c === " " || c === "\t")) end();
    else if (quote || ";&|\n(){}\x60".includes(c) || (c === "$" && line[at + 1] === "(")) { quote = ""; end(); parts.push([]); if (c === "$") at++; }
    else word = (word ?? "") + c;
  }
  end();
  return parts.map(words => {
    let at = 0;
    for (;;) {
      while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!)) at++;
      if (!WRAPPERS.has(words[at] ?? "")) break;
      const wrapper = words[at++];
      if (wrapper === "command" && /^-[vV]$/.test(words[at] ?? "")) return [];
      while (at < words.length && words[at]!.startsWith("-")) at++;
      if (wrapper === "timeout" && /^\d/.test(words[at] ?? "")) at++;
    }
    const [name, ...args] = words.slice(at);
    return name === undefined ? [] : [name.slice(name.lastIndexOf("/") + 1), ...args];
  }).filter(words => words.length);
}

function needsNetwork([name, ...args]: string[]): boolean {
  if (NETWORK.has(name!)) return true;
  const subcommands = NETWORK_SUBCOMMANDS.get(name!);
  if (!subcommands) return false;
  if (name === "yarn" && args.every(arg => arg.startsWith("-"))) return true;
  for (let at = 0; at < args.length; at++) {
    if (name === "git" && GIT_VALUED.has(args[at]!)) { at++; continue; }
    if (!args[at]!.startsWith("-")) return subcommands.includes(args[at]!);
  }
  return false;
}

/**
 * Whether a shell line can run for real in the box, on the copy of the project's files laid out at root.
 * It can unless it calls a command that reaches the network, calls one of commands (the plugins' own commands, which
 * their working copies answer), runs from a folder outside root, or names a path outside root that the box doesn't
 * have: one in home, one written with ~ or $HOME, or one that climbs out of root with "..".
 */
export function runsOnCopy(command: string, root: string, options: { cwd?: string; home?: string; commands?: readonly string[] } = {}): boolean {
  const inside = (path: string) => path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
  let here = posix.resolve(root, options.cwd ?? root);
  if (!command.trim() || !inside(here)) return false;
  if (/(^|[\s=:'"(])~(?=$|[\s/'":;|&)])/.test(command) || /\$\{?HOME\b/.test(command)) return false;
  const { home } = options;
  if (home) for (let at = command.indexOf(home); at >= 0; at = command.indexOf(home, at + 1)) {
    const path = /^[^\s'";|&()<>\x60]*/.exec(command.slice(at))![0];
    if ((path === home || path[home.length] === "/") && !inside(posix.normalize(path))) return false;
  }
  for (const words of commandsIn(command)) {
    const [name, ...args] = words;
    if (needsNetwork(words) || options.commands?.includes(name!)) return false;
    const flag = SHELLS.has(name!) ? args.findIndex(arg => !arg.startsWith("-") || /^-[a-z]*c[a-z]*$/.test(arg)) : -1;
    if (flag >= 0 && args[flag]!.startsWith("-") && args[flag + 1] !== undefined && !runsOnCopy(args[flag + 1]!, root, { ...options, cwd: here })) return false;
    for (const word of args.flatMap(arg => arg.split(/[=<>]/)))
      if (!word.startsWith("/") && word.split("/").includes("..") && !inside(posix.resolve(here, word))) return false;
    if (name === "cd" && args[0] && !args[0].startsWith("-")) here = posix.resolve(here, args[0]);
    if (!inside(here)) return false;
  }
  return true;
}
