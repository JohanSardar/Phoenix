import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("CLI shim forwards terminal Ctrl-C to the real command", { skip: process.platform !== "darwin" }, () => {
  const entry = fileURLToPath(new URL("../../cli/src/capture.ts", import.meta.url));
  const code = "import os, signal, sys\nsignal.signal(signal.SIGINT, lambda *_: print('SIGINT_RECEIVED', flush=True))\nprint('INPUT_READY', flush=True)\nsys.stdin.readline()\n";
  const driver = `import os, pty, sys
pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
output = b''
sent = False
while True:
    try:
        data = os.read(master, 65536)
    except OSError:
        break
    if not data:
        break
    output += data
    if not sent and b'INPUT_READY' in output:
        sent = True
        os.write(master, b'\\x03done\\n')
_, status = os.waitpid(pid, 0)
os.write(1, output)
sys.exit(os.waitstatus_to_exitcode(status))
`;
  const child = spawnSync("python3", ["-c", driver, process.execPath, entry, "cli-shim", "interactive", "python3", "-c", code], {
    env: { ...process.env, PHOENIX_COLLECTOR: "/nonexistent/phoenix-review.sock" }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /INPUT_READY/);
  assert.match(child.stdout, /SIGINT_RECEIVED/, "the user's Ctrl-C must interrupt the command, not disappear into an unowned PTY");
});
