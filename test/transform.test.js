const test = require('node:test');
const assert = require('node:assert/strict');
const { transform, toOpenAIUsage, toFinishReason, handleRequest } = require('../server.js');
const { EventEmitter } = require('node:events');

test('builds the strict envelope and always streams upstream', () => {
  const body = JSON.parse(transform({ model: 'zai-org/GLM-5.2', stream: false, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }));
  for (const k of ['workingDir', 'date', 'environment', 'structure', 'isGitRepo', 'currentBranch', 'mainBranch', 'gitStatus', 'recentCommits'])
    assert.ok(k in body.config, `config.${k}`);
  assert.equal(body.memory, '');
  assert.equal(body.params.stream, true);
  assert.equal(body.params.max_tokens, 100);
  assert.deepEqual(body.params.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
});

test('sends a default system prompt when none or a blank one is given', () => {
  for (const messages of [
    [{ role: 'user', content: 'q' }],
    [{ role: 'system', content: '  ' }, { role: 'user', content: 'q' }],
  ]) {
    const body = JSON.parse(transform({ messages }));
    assert.equal(body.params.system, 'You are a helpful assistant.');
  }
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

test('transform rejects null, arrays, and non-array messages', () => {
  assert.throws(() => transform(null), /body must be a JSON object/);
  assert.throws(() => transform([]), /body must be a JSON object/);
  assert.throws(() => transform({ messages: 'not-an-array' }), /messages must be an array/);
});

test('handleRequest rejects null body with 400', async () => {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/v1/chat/completions';
  req.headers = {};

  let status = null;
  let responseData = '';
  const res = {
    writeHead(code, headers) { status = code; },
    end(data) { responseData = data; },
  };

  handleRequest(req, res);
  req.emit('data', Buffer.from('null'));
  req.emit('end');

  assert.equal(status, 400);
  assert.match(responseData, /Request body must be a JSON object/);
});

test('handleRequest rejects non-array messages with 400', async () => {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/v1/chat/completions';
  req.headers = {};

  let status = null;
  let responseData = '';
  const res = {
    writeHead(code, headers) { status = code; },
    end(data) { responseData = data; },
  };

  handleRequest(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ messages: 'invalid' })));
  req.emit('end');

  assert.equal(status, 400);
  assert.match(responseData, /messages must be an array/);
});

