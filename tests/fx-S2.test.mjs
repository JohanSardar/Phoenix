import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function nativeLine(row) {
  const prefix = JSON.stringify(row).slice(0, -1);
  let crc = 0xffffffff;
  for (const byte of Buffer.from(prefix)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  return prefix + ',"crc":"' + ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0') + '"}\n';
}

test('S2: native import preserves its valid prefix before a torn UTF-8 tail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-fx-S2-'));
  try {
    const header = { v: 1, seq: 1, ts: 1794700800000, kind: 'session_created' };
    const prefix = nativeLine({ ...header, id: 'generated-session', workspace: directory, role: 'root', host: 'acp' })
      + nativeLine({ ...header, seq: 2, kind: 'turn_started', turn: 1 })
      + nativeLine({ ...header, seq: 3, kind: 'item', turn: 1, type: 'user', data: { text: 'generated harmless prefix', images: [] } });
    const source = join(directory, 'log.jsonl');
    await writeFile(source, Buffer.concat([
      Buffer.from(prefix + '{"v":1,"seq":4,"ts":1794700800000,"kind":"item","turn":1,"type":"assistant","data":{"text":"'),
      Buffer.from([0xe2, 0x82]),
    ]));
    const result = spawnSync(process.execPath, [resolve('packages/cli/src/import.ts'),
      '--home', join(directory, 'home'), '--recipe', resolve('recipes/fx/recipe.yaml'), source], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    const imported = JSON.parse(result.stdout);
    assert.equal(imported.complete, false);
    const events = (await readFile(join(imported.capture, imported.segment), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(event => event.op === 'fx.user' && JSON.parse(event.body.inline).text === 'generated harmless prefix'),
      'a torn UTF-8 tail must not erase earlier CRC-valid native records');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
