import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModelRequest } from '../packages/answer/src/index.ts';

test('S5: the model route must block provider-run Google Search', () => {
  const refused = checkModelRequest('generate-content', 'POST',
    '/v1beta/models/gemini-4-hydrogen:generateContent', Buffer.from(JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Search the web for current news' }] }],
      tools: [{ googleSearch: {} }],
    })));
  assert.equal(refused?.trigger, 'live-world',
    'an inference endpoint must not turn the real provider into a live-world escape route');
});
