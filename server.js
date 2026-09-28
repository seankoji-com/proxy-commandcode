/**
 * Proxy: OpenAI /v1/chat/completions → CommandCode /alpha/generate
 *
 * seankoji-com fork — see "Fork changes" in README.md for what differs from
 * nasrulhadi/proxy-commandcode.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = Number(process.env.PCMC_PORT || 3456);
const HOST = 'api.commandcode.ai';
const PATH = '/alpha/generate';
// Floor used when npm is unreachable. PCMC_VERSION pins it and disables the
// npm lookup; otherwise the gateway's stale-version rejection is avoided by
// tracking the published CLI version.
const DEFAULT_CC_VERSION = '1.66.0';
const PINNED_VERSION = process.env.PCMC_VERSION || '';
const VERSION_REFRESH_MS = 6 * 60 * 60 * 1000;
const DEBUG = process.env.PCMC_DEBUG === '1';
// With no system prompt the gateway substitutes the ~7.3K-token `cmd` agent
// prompt (CLI tools, commit rules, taste file), which costs tokens on every call
// and makes the model act as a coding agent. A blank system is rejected by some
// models, so always send a real one.
const DEFAULT_SYSTEM = (process.env.PCMC_DEFAULT_SYSTEM || '').trim() || 'You are a helpful assistant.';

let ccVersion = PINNED_VERSION || DEFAULT_CC_VERSION;

const TTY = process.stdout.isTTY;
const C = TTY
  ? { reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m' }
  : { reset: '', cyan: '', green: '', yellow: '', dim: '', bold: '' };

function writeLog(level, msg) {
  const ts = `[${new Date().toISOString()}]`;
  const colors = { req: C.cyan, upstream: C.green, done: C.bold, error: C.yellow };
  const c = colors[level] || C.reset;
  const tag = level ? `[${c}${level}${C.reset}] ` : '';
  process.stdout.write(`${C.dim}${ts}${C.reset} ${tag}${msg}\n`);
}
const logReq = (...a) => writeLog('req', a.join(' '));
const logUp = (...a) => writeLog('upstream', a.join(' '));
const logDone = (...a) => writeLog('done', a.join(' '));
const logErr = (...a) => writeLog('error', a.join(' '));
const log = (...a) => writeLog('', a.join(' '));

function refreshVersion() {
  if (PINNED_VERSION) return;
  https.get('https://registry.npmjs.org/command-code/latest', { timeout: 10000 }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      try {
        const v = JSON.parse(body).version;
        if (/^\d+\.\d+\.\d+$/.test(v) && v !== ccVersion) { log(`CC version ${ccVersion} -> ${v} (npm)`); ccVersion = v; }
      } catch { logErr(`npm version lookup: unparseable response (keeping ${ccVersion})`); }
    });
  }).on('error', e => logErr(`npm version lookup failed: ${netError(e)} (keeping ${ccVersion})`))
    .on('timeout', function () { this.destroy(new Error('timeout')); });
}

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 10, timeout: 300000 });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };

function sse(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

const STATIC_CONFIG = {
  workingDir: '', environment: 'linux', structure: [], isGitRepo: false,
  currentBranch: '', mainBranch: 'main', gitStatus: '', recentCommits: [],
};

// ── OpenAI → CommandCode body ────────────────────────────────────────────────

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p && p.type === 'text').map(p => p.text).join('');
  return content == null ? '' : String(content);
}

function parseArgs(args) {
  if (args && typeof args === 'object') return args;
  try { return JSON.parse(args || '{}'); } catch { return {}; }
}

function imagePart(url) {
  const m = /^data:([^;,]+)[;,]/.exec(url || '');
  return m ? { type: 'image', image: url, mediaType: m[1] } : { type: 'image', image: url };
}

function transform(oaiBody) {
  const model = oaiBody.model || 'deepseek/deepseek-v4-pro';
  let systemText = '';
  const messages = [];

  const toolNameMap = {};
  for (const m of oaiBody.messages || []) {
    if (m.role === 'assistant' && m.tool_calls)
      for (const tc of m.tool_calls) if (tc.id && tc.function?.name) toolNameMap[tc.id] = tc.function.name;
  }

  for (const m of oaiBody.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      systemText += (systemText ? '\n\n' : '') + textOf(m.content);
      continue;
    }
    if (m.role === 'tool') {
      const part = {
        type: 'tool-result', toolCallId: m.tool_call_id, toolName: toolNameMap[m.tool_call_id] || 'unknown',
        output: { type: 'text', value: textOf(m.content) },
      };
      // Consecutive tool results merge into one role:"tool" message.
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'tool') prev.content.push(part);
      else messages.push({ role: 'tool', content: [part] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      const text = textOf(m.content);
      if (text) parts.push({ type: 'text', text });
      if (m.tool_calls) for (const tc of m.tool_calls) if (tc.type === 'function' && tc.function)
        parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input: parseArgs(tc.function.arguments) });
      messages.push({ role: 'assistant', content: parts });
      continue;
    }
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const p of m.content) {
        if (p.type === 'text') parts.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url') parts.push(imagePart(p.image_url?.url));
      }
      messages.push({ role: m.role, content: parts });
    } else messages.push({ role: m.role, content: [{ type: 'text', text: textOf(m.content) }] });
  }

  const tools = (oaiBody.tools || []).map(t => ({
    name: t.function?.name || t.name, description: t.function?.description || t.description || '',
    input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
  }));

  const params = {
    model, system: systemText.trim() ? systemText : DEFAULT_SYSTEM, messages, tools: tools.length > 0 ? tools : undefined,
    max_tokens: oaiBody.max_completion_tokens || oaiBody.max_tokens || 32000,
    // The gateway rejects stream:false; always stream upstream and buffer here.
    stream: true,
  };
  if (typeof oaiBody.temperature === 'number') params.temperature = oaiBody.temperature;

  return JSON.stringify({
    config: { ...STATIC_CONFIG, date: new Date().toISOString().slice(0, 10) },
    memory: '', taste: null, skills: null, permissionMode: 'standard', params,
  });
}

// ── NDJSON → OpenAI helpers ──────────────────────────────────────────────────

function toOpenAIUsage(u) {
  if (!u) return undefined;
  const prompt = u.inputTokens ?? u.raw?.prompt_tokens ?? 0;
  const completion = u.outputTokens ?? u.raw?.completion_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.totalTokens ?? prompt + completion,
    prompt_tokens_details: { cached_tokens: u.cachedInputTokens ?? u.inputTokenDetails?.cacheReadTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: u.reasoningTokens ?? u.outputTokenDetails?.reasoningTokens ?? 0 },
  };
}

function toFinishReason(r, hasTools) {
  if (r === 'length') return 'length';
  if (r === 'tool-calls' || hasTools) return 'tool_calls';
  if (r === 'content-filter') return 'content_filter';
  return 'stop';
}

// Connect failures surface as AggregateError with an empty message.
function netError(e) {
  if (e.message) return e.message;
  const inner = (e.errors || []).map(x => `${x.code || ''} ${x.address || ''}`.trim()).filter(Boolean);
  return [e.code || e.name || 'network error', ...inner].join(' ');
}

function errorText(evt) {
  return evt.error?.message || evt.message || JSON.stringify(evt.error ?? evt);
}

// Reads NDJSON lines off the upstream response and hands each parsed event to
// onEvent. Buffers partial lines across chunks without a size cap.
function readEvents(proxyRes, onEvent, onEnd) {
  let buf = '';
  proxyRes.setEncoding('utf8');
  proxyRes.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (DEBUG) log(`[debug] ${line}`);
      let evt; try { evt = JSON.parse(line); } catch { continue; }
      onEvent(evt);
    }
  });
  proxyRes.on('end', () => {
    const line = buf.trim();
    if (line) { try { onEvent(JSON.parse(line)); } catch {} }
    onEnd();
  });
}

// ── response handler ─────────────────────────────────────────────────────────

function sendError(res, status, message, type = 'upstream_error') {
  if (res.headersSent) return;
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type } }));
}

function handleUpstreamResponse(proxyRes, res, model, isStream, t0) {
  if (proxyRes.statusCode >= 400) {
    res.writeHead(proxyRes.statusCode, { ...CORS, 'Content-Type': 'application/json' });
    proxyRes.pipe(res);
    return;
  }

  const genId = 'chatcmpl-' + crypto.randomUUID();
  const created = Math.floor(Date.now() / 1000);
  let text = '', reasoning = '', errorMsg = '', usage, finishRaw;
  const toolCalls = [];
  const toolById = new Map();

  const done = (reason) => logDone(`${model} | ${text.length} text / ${reasoning.length} reasoning / ${toolCalls.length} tools | ${reason} | ${Date.now() - t0}ms`);

  if (!isStream) {
    readEvents(proxyRes, evt => {
      switch (evt.type) {
        case 'error': errorMsg = errorMsg || errorText(evt); break;
        case 'text-delta': text += evt.text || ''; break;
        case 'reasoning-delta': reasoning += evt.text || ''; break;
        case 'tool-input-start': {
          const tc = { id: evt.id, type: 'function', function: { name: evt.toolName, arguments: '' } };
          toolCalls.push(tc); toolById.set(evt.id, tc); break;
        }
        case 'tool-input-delta': { const tc = toolById.get(evt.id); if (tc && evt.delta) tc.function.arguments += evt.delta; break; }
        case 'tool-call': {
          const id = evt.id ?? evt.toolCallId;
          if (!toolById.has(id)) {
            const tc = { id, type: 'function', function: { name: evt.toolName, arguments: JSON.stringify(evt.input ?? {}) } };
            toolCalls.push(tc); toolById.set(id, tc);
          }
          break;
        }
        case 'finish-step': finishRaw = evt.finishReason; usage = evt.usage || usage; break;
        case 'finish': finishRaw = evt.finishReason || finishRaw; usage = evt.totalUsage || usage; break;
      }
    }, () => {
      if (errorMsg) { logErr(`${model} | ${errorMsg}`); sendError(res, 502, errorMsg); return; }
      const reason = toFinishReason(finishRaw, toolCalls.length > 0);
      const message = { role: 'assistant', content: text || null };
      if (reasoning) message.reasoning_content = reasoning;
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: genId, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: reason }],
        usage: toOpenAIUsage(usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
      done(reason);
    });
  } else {
    let roleSent = false, toolIdx = -1;
    const base = () => ({ id: genId, object: 'chat.completion.chunk', created, model });
    const write = (chunk) => {
      if (res.writableEnded) return;
      if (!res.headersSent) res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(sse(chunk));
    };
    const delta = (d) => {
      if (!roleSent) { roleSent = true; d = { role: 'assistant', ...d }; }
      write({ ...base(), choices: [{ index: 0, delta: d, finish_reason: null }] });
    };

    readEvents(proxyRes, evt => {
      if (errorMsg || res.writableEnded) return;
      switch (evt.type) {
        case 'error':
          errorMsg = errorText(evt);
          logErr(`${model} | ${errorMsg}`);
          // Before any output, a real HTTP error lets LiteLLM fail over.
          if (!res.headersSent) sendError(res, 502, errorMsg);
          else { res.write(sse({ error: { message: errorMsg, type: 'upstream_error' } })); res.end(); }
          break;
        case 'text-delta': if (evt.text) { text += evt.text; delta({ content: evt.text }); } break;
        case 'reasoning-delta': if (evt.text) { reasoning += evt.text; delta({ reasoning_content: evt.text }); } break;
        case 'tool-input-start':
          toolIdx = toolCalls.length;
          toolCalls.push({ id: evt.id, name: evt.toolName });
          toolById.set(evt.id, toolIdx);
          delta({ tool_calls: [{ index: toolIdx, id: evt.id, type: 'function', function: { name: evt.toolName, arguments: '' } }] });
          break;
        case 'tool-input-delta': {
          const idx = toolById.get(evt.id) ?? toolIdx;
          if (evt.delta && idx >= 0) delta({ tool_calls: [{ index: idx, function: { arguments: evt.delta } }] });
          break;
        }
        case 'tool-call': {
          const id = evt.id ?? evt.toolCallId;
          if (!toolById.has(id)) {
            const idx = toolCalls.length;
            toolCalls.push({ id, name: evt.toolName });
            toolById.set(id, idx);
            delta({ tool_calls: [{ index: idx, id, type: 'function', function: { name: evt.toolName, arguments: JSON.stringify(evt.input ?? {}) } }] });
          }
          break;
        }
        case 'finish-step': finishRaw = evt.finishReason; usage = evt.usage || usage; break;
        case 'finish': finishRaw = evt.finishReason || finishRaw; usage = evt.totalUsage || usage; break;
      }
    }, () => {
      if (errorMsg || res.writableEnded) return;
      const reason = toFinishReason(finishRaw, toolCalls.length > 0);
      if (!roleSent) delta({ content: '' });
      write({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: reason }] });
      const u = toOpenAIUsage(usage);
      if (u) write({ ...base(), choices: [], usage: u });
      res.write('data: [DONE]\n\n'); res.end();
      done(reason);
    });
  }

  proxyRes.on('error', e => {
    logErr(`[upstream stream] ${netError(e)}`);
    if (!res.headersSent) sendError(res, 502, netError(e));
    else if (!res.writableEnded) res.end();
  });
}

// ── main ─────────────────────────────────────────────────────────────────────

function handleRequest(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Max-Age': '86400' }); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ccVersion }));
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'POST /v1/chat/completions', type: 'not_found' } }));
    return;
  }

  const auth = req.headers['authorization'] || '';
  const chunks = []; let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > 10 * 1024 * 1024) { req.destroy(); sendError(res, 413, 'request body over 10MB', 'invalid_request_error'); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    const body = Buffer.concat(chunks).toString('utf8');
    let oai; try { oai = JSON.parse(body); } catch { sendError(res, 400, 'Invalid JSON', 'invalid_request_error'); return; }
    const model = oai.model || '-', isStream = oai.stream === true;
    const t0 = Date.now();
    logReq(`${model} | ${req.socket.remoteAddress || '-'} | ${isStream ? 'stream' : 'sync'} | ${size} bytes`);

    let upstream;
    try { upstream = transform(oai); } catch (e) { sendError(res, 400, `transform error: ${e.message}`, 'invalid_request_error'); return; }

    const pr = https.request({
      hostname: HOST, path: PATH, method: 'POST', agent, timeout: 300000,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(upstream), 'Authorization': auth,
        'x-command-code-version': ccVersion, 'x-cli-environment': 'production', 'x-session-id': crypto.randomUUID(),
      },
    }, proxyRes => {
      const ok = proxyRes.statusCode >= 200 && proxyRes.statusCode < 300;
      logUp(`${proxyRes.statusCode} ${ok ? 'OK' : 'ERR'} | ${model} | ${Date.now() - t0}ms`);
      handleUpstreamResponse(proxyRes, res, model, isStream, t0);
    });
    pr.setTimeout(300000, () => { logErr('[upstream] timeout'); pr.destroy(new Error('upstream timeout')); });
    pr.on('error', e => {
      logErr(`[upstream] ${netError(e)}`);
      if (!res.headersSent) sendError(res, e.message === 'upstream timeout' ? 504 : 502, netError(e));
      else if (!res.writableEnded) res.end();
    });
    res.on('close', () => { if (!res.writableFinished) pr.destroy(); });
    pr.end(upstream);
  });
}

module.exports = { transform, toOpenAIUsage, toFinishReason };

if (require.main === module) {
  log(`proxy-commandcode | listening :${PORT} | upstream ${HOST}${PATH} | CC ${ccVersion}${PINNED_VERSION ? ' (pinned)' : ''} | debug ${DEBUG ? 'on' : 'off'}`);
  refreshVersion();
  setInterval(refreshVersion, VERSION_REFRESH_MS).unref();

  const server = http.createServer(handleRequest);
  server.timeout = 300000; server.keepAliveTimeout = 120000;
  server.listen(PORT, () => log(`listening on http://0.0.0.0:${PORT}`));
  const shutdown = (sig) => {
    log(`${sig}: shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
