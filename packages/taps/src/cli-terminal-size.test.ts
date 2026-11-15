import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("CLI terminal stdin keeps its own size and resize with redirected outputs", () => {
  const scratch = mkdtempSync(join(tmpdir(), "phoenix-terminal-"));
  const output = join(scratch, "result.json");
  const code = `
    import { execFileSync } from 'node:child_process';
    import { cliTap } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    import { CLI_STREAM, decodeCliControl, encodeCliControl } from ${JSON.stringify(import.meta.resolve("@phoenix/wire"))};
    let terminals;
    const resizes = [];
    await cliTap({
      connector: 'terminal-command', argv: ['terminal-command'], allowEnv: [],
      backend: { open(connection) {
        terminals = connection.meta.terminals;
        return {
          async write(frame) {
            if (frame.stream === CLI_STREAM.control) {
              const control = decodeCliControl(frame.bytes);
              if (control.type === 'resize') resizes.push(control);
            }
          },
          async *frames() {
            const resized = new Promise(resolve => process.once('SIGWINCH', () => setImmediate(resolve)));
            execFileSync('/bin/stty', ['rows', '41', 'cols', '97'], { stdio: [0, 'pipe', 'pipe'] });
            process.kill(process.pid, 'SIGWINCH');
            await resized;
            yield { dir: 'back', stream: CLI_STREAM.control, bytes: encodeCliControl({ type: 'exit', code: 0, signal: null }), last: true, at: 0n };
          },
          abort() {},
        };
      } },
    });
    process.stdout.write(JSON.stringify({ terminals, resizes }));
  `;
  const quote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'";
  const command = `stty rows 37 cols 91; ${quote(process.execPath)} --input-type=module -e ${quote(code)} > ${quote(output)} 2>&1`;
  try {
    const args = process.platform === "darwin" ? ["-q", "/dev/null", "/bin/sh", "-c", command] : ["-q", "-e", "-c", command, "/dev/null"];
    const child = spawnSync("/usr/bin/script", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
      terminals: { stdin: { columns: 91, rows: 37 }, stdout: null, stderr: null },
      resizes: [{ type: "resize", fd: 0, columns: 97, rows: 41 }],
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
