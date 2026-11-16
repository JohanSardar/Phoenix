import assert from "node:assert/strict";
import test from "node:test";
import { recognizeCommand, type CommandPlugin } from "./plugin-command.ts";

const plugins: CommandPlugin[] = [
  { connector: "mail", recognize: { commands: ["mailer"] }, read_only: ["mailer folder list", "mailer envelope list", "mailer message read --preview"] },
  { connector: "errors", recognize: { mcp_servers: ["errors-mcp"], commands: ["errs"] } },
  { connector: "calendar", recognize: { mcp_servers: ["cal"] } },
];

test("a plugin's command is that plugin's, with its argv and whether its read-only rules call it a read", () => {
  assert.deepEqual(recognizeCommand("mailer envelope list --page-size 5", plugins), { connector: "mail", argv: ["mailer", "envelope", "list", "--page-size", "5"], readOnly: true });
  assert.deepEqual(recognizeCommand("mailer message read --preview 12", plugins), { connector: "mail", argv: ["mailer", "message", "read", "--preview", "12"], readOnly: true });
  assert.deepEqual(recognizeCommand("mailer message read 12", plugins), { connector: "mail", argv: ["mailer", "message", "read", "12"], readOnly: false });
  assert.deepEqual(recognizeCommand("mailer message delete 12", plugins), { connector: "mail", argv: ["mailer", "message", "delete", "12"], readOnly: false });
  assert.deepEqual(recognizeCommand("errs issues --query 'is:unresolved level:error'", plugins), { connector: "errors", argv: ["errs", "issues", "--query", "is:unresolved level:error"], readOnly: false });
});

test("text piped or written into the command is its stdin", () => {
  assert.deepEqual(recognizeCommand("echo 'Hi there' | mailer message send", plugins), { connector: "mail", argv: ["mailer", "message", "send"], stdin: "Hi there\n", readOnly: false });
  assert.deepEqual(recognizeCommand("echo -n hi | mailer message send", plugins)?.stdin, "hi");
  assert.deepEqual(recognizeCommand("printf 'To: a@b.c\\nSubject: %s\\n\\n%s\\n' 'Lunch' 'Noon?' | mailer template send", plugins)?.stdin, "To: a@b.c\nSubject: Lunch\n\nNoon?\n");
  assert.deepEqual(recognizeCommand("mailer template send <<'EOF'\nTo: a@b.c\nSubject: $5 lunch\n\nNoon?\nEOF", plugins), { connector: "mail", argv: ["mailer", "template", "send"], stdin: "To: a@b.c\nSubject: $5 lunch\n\nNoon?\n", readOnly: false });
  assert.deepEqual(recognizeCommand("mailer template send <<EOF\nTo: a@b.c\nEOF\n", plugins)?.stdin, "To: a@b.c\n");
  assert.deepEqual(recognizeCommand("mailer template send <<-EOF\n\tTo: a@b.c\n\tEOF", plugins)?.stdin, "To: a@b.c\n");
});

test("a command no plugin recognizes, or one that cannot be taken apart exactly, belongs to no plugin", () => {
  for (const command of [
    "ls -la", "git status", "calendar list", "mailerx envelope list", "", "mailer envelope list | head -5", "mailer envelope list > out.txt",
    "cd mail && mailer envelope list", "mailer envelope list; ls", "mailer envelope list && echo done", "mailer message read $ID", "mailer message read \"$(cat id)\"",
    "cat body.txt | mailer message send", "echo hi | grep h | mailer message send", "echo -e 'a\\nb' | mailer message send", "mailer message send < body.txt",
    "mailer template send <<EOF\nTotal: $AMOUNT\nEOF", "mailer template send <<EOF\nno end", "mailer template send <<EOF\nhi\nEOF\nls", "echo hi | mailer message send <<EOF\nx\nEOF",
    "MAILER_CONFIG=x mailer envelope list", "/usr/local/bin/mailer envelope list", "echo mailer", "mailer envelope list &",
  ]) assert.equal(recognizeCommand(command, plugins), undefined, command);
});

test("the first plugin that recognizes a command takes it", () => {
  assert.equal(recognizeCommand("mailer folder list", [{ connector: "one", recognize: { commands: ["mailer"] } }, { connector: "two", recognize: { commands: ["mailer"] } }])?.connector, "one");
});
