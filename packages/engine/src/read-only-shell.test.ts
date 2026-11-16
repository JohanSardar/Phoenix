import assert from "node:assert/strict";
import test from "node:test";
import { readsOnly } from "./read-only-shell.ts";

const root = "/Users/j/project";

test("a shell command that only reads files under the project runs on the copy", () => {
  for (const command of [
    "ls -la", "cat README.md", "head -n 40 src/a.ts | grep -n foo", "rg -n 'a|b' src", "find . -name '*.ts' -type f | wc -l",
    "sed -n '1,80p' docs/SPEC.md", "cd src && ls", "cat /Users/j/project/package.json", "grep -rn x . 2>/dev/null", "ls docs 2>&1 | head",
    "stat package.json; pwd", "tail -n 5 log.txt", "sort names.txt | uniq -c",
  ]) assert.equal(readsOnly(command, root), true, command);
});

test("anything else is not run on the copy", () => {
  for (const command of [
    "git status", "npm test", "ssh host ls", "curl https://x", "cat a > b", "echo x >> notes.md", "sed -i 's/a/b/' f", "sed -n 's/a/b/w out' f",
    "find . -delete", "find . -exec rm {} \\;", "sort -o out in", "uniq in out", "tail -f log", "rg --pre cat x", "cat $HOME/.ssh/id_rsa",
    "cat \"$(whoami)\"", "ls `pwd`", "cat ~/.zshrc", "cat /etc/passwd", "ls ../other", "cd .. && ls", "cd /tmp; ls", "ls &", "(ls)", "cat < f",
    "awk '{print}' f", "xargs cat", "ls |", "", "cat 'unterminated",
  ]) assert.equal(readsOnly(command, root), false, command);
});

test("a working directory outside the project is not run on the copy", () => {
  assert.equal(readsOnly("ls", root, "/Users/j/elsewhere"), false);
  assert.equal(readsOnly("cat ../README.md", root, "/Users/j/project/src"), true);
});

test("after cd and ;, a path must stay inside the copy from both folders", () => {
  assert.equal(readsOnly("cd src; ls", root), true);
  assert.equal(readsOnly("cd src; cat a.ts", root), true);
  assert.equal(readsOnly("cd src; cat ../README.md", root), false);
  assert.equal(readsOnly("cd src && cat ../README.md", root), true);
  assert.equal(readsOnly("cd /tmp; ls", root), false);
  assert.equal(readsOnly("cd src || ls", root), false);
});
