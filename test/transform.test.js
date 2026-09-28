const test = require('node:test');
const assert = require('node:assert/strict');
const { transform, toOpenAIUsage, toFinishReason } = require('../server.js');

test('builds the strict envelope and always streams upstream', () => {
  const body = JSON.parse(transform({ model: 'zai-org/GLM-5.2', stream: false, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }));
  for (const k of ['workingDir', 'date', 'environment', 'structure', 'isGitRepo', 'currentBranch', 'mainBranch', 'gitStatus', 'recentCommits'])
    assert.ok(k in body.config, `config.${k}`);
  assert.equal(body.memory, '');
  assert.equal(body.params.stream, true);
  assert.equal(body.params.max_tokens, 100);
  assert.deepEqual(body.params.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
});

test('maps system/developer to params.system', () => {
  const body = JSON.parse(transform({ messages: [
    { role: 'system', content: 'a' }, { role: 'developer', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: 'q' },
  ] }));
  assert.equal(body.params.system, 'a\n\nb');
  assert.equal(body.params.messages.length, 1);
});

test('tool calls carry object input and tool results merge into one message', () => {
  const body = JSON.parse(transform({ messages: [
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'get', arguments: '{"city":"Sydney"}' } },
      { id: 'c2', type: 'function', function: { name: 'get', arguments: 'not json' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
    { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: 'rain' }] },
  ] }));
  const [, assistant, tool] = body.params.messages;
  assert.deepEqual(assistant.content[0].input, { city: 'Sydney' });
  assert.deepEqual(assistant.content[1].input, {});
  assert.equal(body.params.messages.length, 3);
  assert.deepEqual(tool.content.map(p => [p.toolCallId, p.toolName, p.output.value]), [['c1', 'get', 'sunny'], ['c2', 'get', 'rain']]);
});

test('images use the ModelMessage image part', () => {
  const body = JSON.parse(transform({ messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ] }] }));
  assert.deepEqual(body.params.messages[0].content[0], { type: 'image', image: 'data:image/png;base64,AAAA', mediaType: 'image/png' });
});

test('usage maps to OpenAI shape', () => {
  assert.deepEqual(toOpenAIUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 4, reasoningTokens: 2 }), {
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 },
  });
  assert.equal(toOpenAIUsage(undefined), undefined);
});

test('finish reasons', () => {
  assert.equal(toFinishReason('length', false), 'length');
  assert.equal(toFinishReason('tool-calls', false), 'tool_calls');
  assert.equal(toFinishReason('stop', true), 'tool_calls');
  assert.equal(toFinishReason(undefined, false), 'stop');
});
