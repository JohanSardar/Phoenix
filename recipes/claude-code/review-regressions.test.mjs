import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const binary = spawnSync("which", ["claude"], { encoding: "utf8" }).stdout.trim().split("\n")[0];
const execute = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  child.once("error", reject);
  child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "phoenix-recipe-regression-"));
  for (const dir of ["home", "config", "workspace"]) await mkdir(join(root, dir));
  const model = createServer(async (request, response) => {
    for await (const bytes of request) void bytes;
    if (request.url.includes("count_tokens")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    response.setHeader("Content-Type", "text/event-stream");
    for (const [type, value] of [
      ["message_start", { message: { id: "msg_synthetic", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "synthetic review response" } }],
      ["content_block_stop", { index: 0 }],
      ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }],
      ["message_stop", {}],
    ]) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    response.end();
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  t.after(async () => { model.closeAllConnections(); model.close(); await rm(root, { recursive: true, force: true }); });
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "config"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_API_KEY: "synthetic-not-a-real-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}`,
  };
  const wrapper = join(root, "wrapper.mjs");
  await writeFile(wrapper, `import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") console.log(JSON.stringify({ loggedIn: true }));
else {
  const child = spawn(${JSON.stringify(binary)}, args, { stdio: "inherit" });
  child.on("exit", code => { process.exitCode = code; });
}
`);
  const recipe = (cwd, routes = "transcript", args = ["--bare"]) => execute(process.execPath, [
    join(repository, "recipes/claude-code/capture.mjs"), "--login-mode", "api-key",
    "--cwd", cwd, "--home", join(root, "store"), "--routes", routes,
    "--claude", JSON.stringify([process.execPath, wrapper]),
    "--phoenix", JSON.stringify([process.execPath, join(repository, "packages/cli/src/capture.ts")]),
    "--importer", JSON.stringify([process.execPath, join(repository, "packages/cli/src/import.ts")]),
    "--", ...args, "-p", "synthetic review request", "--model", "claude-sonnet-4-5",
  ], { cwd: repository, env });
  return { root, recipe };
}

test("S1: transcript import follows the CLI's canonical working directory", async t => {
  const { root, recipe } = await fixture(t);
  const linked = join(root, "linked-workspace");
  await symlink(join(root, "workspace"), linked);
  const direct = await recipe(await realpath(join(root, "workspace")));
  assert.match(direct.stdout, /"complete":true/, JSON.stringify(direct));
  const result = await recipe(linked);
  assert.match(result.stdout, /synthetic review response/);
  assert.match(result.stdout, /"complete":true/, JSON.stringify({ ...result, projects: await readdir(join(root, "config/projects")) }));
});
