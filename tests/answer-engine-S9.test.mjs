import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModelRequest } from '../packages/answer/src/index.ts';

test('S9: ordinary function-tool schemas must not be mistaken for provider tools', () => {
  const refused = checkModelRequest('chat-completions', 'POST', '/v1/chat/completions',
    Buffer.from(JSON.stringify({
      model: 'review', messages: [{ role: 'user', content: 'Read the local settings file' }],
      tools: [{ type: 'function', function: { name: 'read_settings', parameters: {
        type: 'object', properties: { codeExecution: { type: 'boolean' } },
      } } }],
    })));
  assert.equal(refused, undefined,
    'a property name in a local function schema does not ask the provider to execute code');
});
