import type { PluginDescriptor } from "@phoenix/formats";
import { isReadOnly } from "@phoenix/answer";
import { lex } from "./read-only-shell.ts";

export type CommandPlugin = Pick<PluginDescriptor, "connector" | "recognize" | "read_only">;
export interface RecognizedCommand { connector: string; argv: string[]; stdin?: string; readOnly: boolean }

const HEREDOC = /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_][A-Za-z0-9_]*))[ \t]*\n/;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'" };

function heredoc(command: string): { line: string; stdin?: string } | undefined {
  const opened = HEREDOC.exec(command);
  if (!opened) return command.includes("<<") ? undefined : { line: command };
  const [, strip, single, double, bare] = opened;
  const delimiter = single ?? double ?? bare!;
  const lines = command.slice(opened.index + opened[0].length).split("\n");
  const end = lines.findIndex(line => (strip ? line.replace(/^\t+/, "") : line) === delimiter);
  if (end < 0 || lines.slice(end + 1).some(line => line.trim())) return undefined;
  const body = lines.slice(0, end).map(line => strip ? line.replace(/^\t+/, "") : line);
  if (bare && body.some(line => /[$`\\]/.test(line))) return undefined;
  return { line: command.slice(0, opened.index), stdin: body.map(line => line + "\n").join("") };
}

function printed([name, ...args]: string[]): string | undefined {
  if (name === "echo") {
    const plain = args[0] === "-n" ? args.slice(1) : args;
    if (plain[0]?.startsWith("-")) return undefined;
    return plain.join(" ") + (args[0] === "-n" ? "" : "\n");
  }
  if (name !== "printf" || args[0] === undefined || args[0].startsWith("-")) return undefined;
  const [format, ...values] = args;
  let out = "", at = 0;
  do {
    for (let i = 0; i < format.length; i++) {
      const c = format[i]!, next = format[i + 1];
      if (c === "\\" && next !== undefined && Object.hasOwn(ESCAPES, next)) { out += ESCAPES[next]; i++; }
      else if (c === "%" && next === "%") { out += "%"; i++; }
      else if (c === "%" && next === "s") { out += values[at++] ?? ""; i++; }
      else if (c === "%" || c === "\\") return undefined;
      else out += c;
    }
  } while (at < values.length && format.includes("%s"));
  return out;
}

/**
 * Which plugin a shell command line belongs to, as the argv and stdin that plugin's command would get, and whether
 * the plugin's read-only rules call it a read. It reads only the command line, so it works on a session's past
 * commands as well as new ones. A command it cannot take apart exactly (expansions, redirections, chains, or a
 * pipe into anything but the plugin's command) belongs to no plugin.
 */
export function recognizeCommand(command: string, plugins: readonly CommandPlugin[]): RecognizedCommand | undefined {
  const split = heredoc(command);
  const tokens = split && lex(split.line.trimEnd());
  if (!tokens) return undefined;
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if ("text" in token) segments.at(-1)!.push(token.text);
    else if (token.op === "|" && segments.at(-1)!.length) segments.push([]);
    else return undefined;
  }
  const argv = segments.at(-1)!;
  const plugin = plugins.find(p => argv[0] !== undefined && p.recognize.commands?.includes(argv[0]));
  if (!plugin || segments.length > 2 || (segments.length === 2 && split!.stdin !== undefined)) return undefined;
  const stdin = segments.length === 2 ? printed(segments[0]!) : split!.stdin;
  if (segments.length === 2 && stdin === undefined) return undefined;
  const readOnly = isReadOnly({ read_only: (plugin.read_only ?? []).map(op => ({ op, source: "plugin" as const })) }, "cli", argv[0]!, { argv });
  return { connector: plugin.connector, argv, ...(stdin === undefined ? {} : { stdin }), readOnly };
}
