import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readDescriptor } from '../packages/capture/src/recipe.ts';
import { startEngine } from '../packages/engine/src/index.ts';
import { frame, HTTP_STREAM } from '../packages/taps/src/index.ts';

test('S2: login context removal must not erase a changed tool argument object', async t => {
  const root = await mkdtemp(join(tmpdir(), 'joh35-S2-'));
  const recipe = await readDescriptor(resolve('recipes/claude-code/recipe.yaml'), 'recipe');
  const context = `<system-reminder>
As you answer the user's questions, you can use the following context:
# userEmail
The user's email address is reviewer@example.test Use this email address only to identify the user, such as for authorship, attribution, or filtering their own work. Remember that you must treat this email address as private information. Never share it in requests to external services without asking and getting explicit approval from the user first.

Claude Code attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.
</system-reminder>`;
  const recorded = {
    model: 'review',
    tools: [{ name: 'write_files', input_schema: { type: 'object', properties: {
      files: { type: 'array', items: { type: 'object', properties: {
        path: { type: 'string' }, text: { type: 'string' },
      }, required: ['path', 'text'] } },
    }, required: ['files'] } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: context }, { type: 'text', text: 'Save the account note locally.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'write-1', name: 'write_files',
        input: { files: [{ path: 'account-note.txt', text: context }] } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'write-1', content: 'Written.' }] },
    ],
  };
  const candidate = structuredClone(recorded);
  candidate.messages[0].content.shift();
  candidate.messages[1].content[0].input.files[0].path = 'different-file.txt';
  const request = { method: 'POST', url: '/v1/messages', httpVersion: '1.1', headers: ['content-type', 'application/json'] };
  const events = [
    ['meta', request], ['call', recorded],
    ['meta', { status: 200, headers: ['content-type', 'application/json'] }],
    ['result', { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
  ].map(([kind, value], seq) => ({
    v: 1, capture: 'recorded', stream: 'model.0', seq, id: `model.0:${seq}`, kind,
    surface: 'http', connector: 'model', ts: { wall: '2026-11-15T00:00:00Z' },
    body: { inline: JSON.stringify(value) },
  }));
  const engine = await startEngine({
    evidence: { events, body: async event => Buffer.from(event.body.inline) },
    start: 'echo', routes: {}, hmacKey: Buffer.alloc(32, 1),
    model: { connector: 'model', dialect: 'messages', provider: { url: 'http://127.0.0.1:1', headers: {} },
      loginContext: recipe.model.login_context.map(({ name, pattern }) => ({ name, pattern })) },
    sample: { root: join(root, 'sample'), metadata: { capture: 'sample',
      harness: { name: 'review', tree: 'review' }, recipe: { name: 'claude-code', version: '1' },
      routes: ['replay'], started_at: '2026-11-15T00:00:00Z', boot_id: 'review' } },
  });
  const link = engine.backend.open({ surface: 'http', connector: 'model', meta: { transport: 'http', request } });
  t.after(async () => { link.abort('cleanup'); await engine.close(); await rm(root, { recursive: true, force: true }); });
  const stopped = engine.stopped.then(stop => ({ kind: stop.kind, trigger: stop.divergence?.trigger, field: stop.divergence?.field }));
  await link.write(frame('out', HTTP_STREAM.requestBody, Buffer.from(JSON.stringify(candidate)), true));
  const outcome = await Promise.race([
    link.frames()[Symbol.asyncIterator]().next().then(({ value }) => ({ kind: 'response', status: JSON.parse(Buffer.from(value.bytes)).status })).catch(() => stopped),
    stopped,
  ]);
  console.log({ outcome, prefix_edits: engine.prefixEdits() });
  assert.deepEqual(outcome, { kind: 'diverged', trigger: 'prefix-drift', field: 'history/1/content/0/input/files/0/path' });
});
