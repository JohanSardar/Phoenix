import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('S2: patched fx routes write_file to Phoenix instead of mutating its workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-fx-review-S2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'fx');
  await mkdir(source);
  const response = await fetch('https://codeload.github.com/vercel-labs/fx/tar.gz/481104fdbc247aab4e987e875402dc735e82642e');
  assert.equal(response.status, 200);
  const archive = join(root, 'fx.tar.gz');
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  execFileSync('tar', ['-xzf', archive, '-C', source, '--strip-components=1']);
  execFileSync('git', ['apply', resolve('recipes/fx/stand-in.patch')], { cwd: source });
  await writeFile(join(source, 'src/phoenix_review_S2.zig'), await readFile(new URL('./fx-resume-review-S2.zig', import.meta.url)));
  await writeFile(join(source, 'review-build-options.zig'), 'pub const libfx = false;\npub const app_version = "0.0.16";\npub const git_commit = "481104fdbc247aab4e987e875402dc735e82642e";\npub const update_channel = "stable";\n');
  await writeFile(join(source, 'review-test-paths.zig'), 'pub const product_exe = "/nonexistent-review-fx";\npub const source_root = "src";\n');
  await writeFile(join(source, 'review-session-options.zig'), 'pub const hooks = false;\npub const trace_dir = ".";\npub const src_dir = "src/core/session_manager";\n');
  await mkdir(join(root, 'stand-in'));
  await writeFile(join(root, 'helper.mjs'), 'process.stdout.write("0recorded write answer");\n');
  const run = spawnSync('zig', [
    'test', '-lc', '--test-filter', 'S2 Phoenix',
    '--dep', 'build_options', '--dep', 'test_paths', '--dep', 'session_manager',
    '-Mroot=src/phoenix_review_S2.zig', '-Mbuild_options=review-build-options.zig', '-Mtest_paths=review-test-paths.zig',
    '--dep', 'build_options=sm_options', '-Msession_manager=src/core/session_manager/api.zig', '-Msm_options=review-session-options.zig',
  ], { cwd: source, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PHOENIX_FX_TOOL_DIR: join(root, 'stand-in'), PHOENIX_FX_TOOL_HELPER: join(root, 'helper.mjs') } });
  assert.equal(run.status, 0, run.stderr || String(run.error));
});
