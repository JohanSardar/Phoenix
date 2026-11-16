import { isAbsolute, relative, resolve } from "node:path";

const COMMANDS = new Set(["cat", "ls", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "find", "stat", "pwd", "cd", "sed", "sort", "uniq", "cut", "tr", "nl", "echo", "basename", "dirname", "realpath", "du", "true"]);
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const SED_PRINT = /^\s*(\d+|\$)?\s*(,\s*(\d+|\$)\s*)?p\s*$/;

type Word = { text: string; bare: boolean };
type Token = Word | { op: string };

function lex(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word: Word | undefined;
  const end = () => { if (word) tokens.push(word); word = undefined; };
  for (let at = 0; at < command.length; at++) {
    const c = command[at]!;
    if (c === "'") {
      const close = command.indexOf("'", at + 1);
      if (close < 0) return undefined;
      word = { text: (word?.text ?? "") + command.slice(at + 1, close), bare: false };
      at = close;
    } else if (c === '"') {
      let text = "";
      for (at++; command[at] !== '"'; at++) {
        if (at >= command.length || command[at] === "$" || command[at] === "`") return undefined;
        if (command[at] === "\\" && '"\\'.includes(command[at + 1] ?? "")) at++;
        text += command[at];
      }
      word = { text: (word?.text ?? "") + text, bare: false };
    } else if (c === "\\") {
      if (command[at + 1] === "\n") { at++; continue; }
      if (at + 1 >= command.length) return undefined;
      word = { text: (word?.text ?? "") + command[++at], bare: false };
    } else if (c === " " || c === "\t") end();
    else if ("|&;<>\n".includes(c)) {
      const fd = word?.bare && /^[12]$/.test(word.text) && command[at] === ">" ? word.text : "";
      if (fd) word = undefined; else end();
      let op = c === "\n" ? ";" : c;
      while (at + 1 < command.length && "|&<>".includes(command[at + 1]!) && op.length < 2) op += command[++at];
      tokens.push({ op: fd + op });
    } else if ("$`(){}#".includes(c)) return undefined;
    else word = { text: (word?.text ?? "") + c, bare: word ? word.bare : true };
  }
  end();
  return tokens;
}

/** Whether a shell command only reads files and folders under root, so it can run for real on a copy of them. */
export function readsOnly(command: string, root: string, cwd: string = root): boolean {
  const tokens = lex(command);
  const last = tokens?.at(-1);
  if (!tokens?.some(token => "text" in token) || (last && "op" in last && last.op !== ";")) return false;
  const under = (path: string) => { const rest = relative(root, path); return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest)); };
  if (!under(cwd)) return false;
  const commands: string[][] = [[]];
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    if ("text" in token) { commands.at(-1)!.push(token.text); continue; }
    if (["|", "&&", "||", ";"].includes(token.op)) { if (!commands.at(-1)!.length) return false; commands.push([]); continue; }
    const target = tokens[at + 1];
    if (!target || !("text" in target)) return false;
    if (/^[12]?>&$/.test(token.op) ? !/^[12]$/.test(target.text) : !(/^([12]?>>?|&>)$/.test(token.op) && target.text === "/dev/null")) return false;
    at++;
  }
  if (!commands.at(-1)!.length) commands.pop();
  for (const [name, ...args] of commands) {
    if (!COMMANDS.has(name!)) return false;
    const options = args.filter(arg => arg.startsWith("-") && arg !== "-");
    const operands = args.filter(arg => !options.includes(arg));
    const short = (letters: string) => options.some(option => !option.startsWith("--") && [...letters].some(letter => option.slice(1).includes(letter)));
    const long = (...names: string[]) => options.some(option => names.some(name => option === name || option.startsWith(`${name}=`)));
    if (name === "tail" && (short("fF") || long("--follow", "--retry"))) return false;
    if (name === "sort" && (short("o") || long("--output", "--compress-program"))) return false;
    if (name === "uniq" && operands.length > 1) return false;
    if (name === "rg" && long("--pre", "--pre-glob", "--search-zip")) return false;
    if (name === "find" && args.some(arg => FIND_ACTIONS.has(arg))) return false;
    if (name === "sed" && (!short("n") || short("ief") || long("--in-place", "--expression", "--file") || operands.length < 1 || !SED_PRINT.test(operands[0]!))) return false;
    for (const arg of [...operands, ...options.map(option => option.split("=").slice(1).join("="))]) {
      if (arg.startsWith("~")) return false;
      if ((isAbsolute(arg) || arg.split("/").includes("..")) && arg !== "/dev/null" && !under(resolve(cwd, arg))) return false;
    }
    if (name === "cd") { if (operands.length !== 1) return false; cwd = resolve(cwd, operands[0]!); }
  }
  return true;
}
