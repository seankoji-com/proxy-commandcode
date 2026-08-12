# Proxy CommandCode

A transparent reverse proxy that translates **OpenAI-compatible** requests (`/v1/chat/completions`) into CommandCode's internal endpoint (`/alpha/generate`), then returns responses in OpenAI format your editor understands.

Use any CommandCode model (including the Go plan) with **ZCode**, **9router**, **Cursor**, **Continue**, **Aider**, and any editor that supports custom OpenAI endpoints.

## Why

CommandCode has two API surfaces:

| Endpoint | Plan required |
|---|---|
| `/provider/v1/chat/completions` | Pro |
| `/provider/v1/messages` | Pro |
| `/alpha/generate` | **Any plan** (Go included) |

This proxy speaks the same envelope the official CLI uses, so it works on any plan.

## How it works

```
Editor → POST /v1/chat/completions (OpenAI format)
  → Proxy translates to CommandCode format
    → POST api.commandcode.ai/alpha/generate
  ← Proxy translates NDJSON stream back to OpenAI SSE/JSON
← Editor receives standard OpenAI response
```

## Quick start

```bash
git clone https://github.com/nasrulhadi/proxy-commandcode.git
cd proxy-commandcode
node server.js
# → listening on http://localhost:3456
```

Zero dependencies. Node.js 18+ only.

### Get your token

1. Go to [https://commandcode.ai/settings/billing](https://commandcode.ai/settings/billing)
2. Copy your `user_...` token
3. Use it as the API key in your editor

### Env vars

| Variable | Default |
|---|---|
| `PCMC_PORT` | `3456` |
| `PCMC_VERSION` | `0.41.1` |
| `PCMC_DEBUG` | off (set `1` to enable) |

### Enabling debug mode

**PowerShell:**
```
$env:PCMC_DEBUG="1"; node server.js
```

**Command Prompt:**
```
set PCMC_DEBUG=1 && node server.js
```

**macOS / Linux / WSL:**
```
PCMC_DEBUG=1 node server.js
```

When enabled, raw upstream responses are dumped to `dump/` for troubleshooting.

## Integration

### 9router

```json
{
  "commandcode": {
    "base_url": "http://localhost:3456/v1",
    "api_key": "user_xxxxxxxxxx",
    "models": ["deepseek/deepseek-v4-pro", "moonshotai/Kimi-K2.5"]
  }
}
```

### ZCode

Set custom OpenAI endpoint in settings:

- **Base URL**: `http://localhost:3456/v1`
- **API Key**: your `user_...` token
- **Model**: `deepseek/deepseek-v4-pro`

### Cursor

Settings → OpenAI API Key → Override Base URL: `http://localhost:3456/v1`

### Continue (VS Code)

```json
{
  "models": [{
    "title": "DeepSeek V4 Pro",
    "provider": "openai",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "user_xxxxxxxxxx",
    "model": "deepseek/deepseek-v4-pro"
  }]
}
```

### Aider

```bash
aider --openai-api-base http://localhost:3456/v1 \
      --openai-api-key user_xxxxxxxxxx \
      --model openai/deepseek/deepseek-v4-pro
```

### Other editors

Any editor with custom OpenAI endpoint support works the same way: point base URL to `http://localhost:3456/v1`, use your token as API key.

## Available models

Model availability depends on your CommandCode plan:

| Plan | Price/mo | Access |
|---|---|---|
| Go | $1 | Open-source + free + some premium (Luna, Grok, Muse Spark Contributor) |
| GOAT | $10 | Go + Muse Spark 1.2 |
| Pro | $20 | GOAT + full premium (GPT, Claude, Gemini) |

**Free models** (cost no credits):

| Model | Notes |
|---|---|
| `poolside/laguna-s-2.1-free` | Free while capacity lasts |
| `inclusionai/ling-3.0-flash-free` | Free until 2026-08-02 |

**Open-source — Go plan and above:**

| Model | Notes |
|---|---|
| `deepseek/deepseek-v4-pro` | |
| `deepseek/deepseek-v4-flash` | |
| `moonshotai/Kimi-K3` | |
| `moonshotai/Kimi-K2.7-Code` | |
| `moonshotai/Kimi-K2.7-Code-Highspeed` | |
| `moonshotai/Kimi-K2.6` | |
| `moonshotai/Kimi-K2.5` | |
| `zai-org/GLM-5.2` | |
| `zai-org/GLM-5.2-Fast` | |
| `zai-org/GLM-5.1` | |
| `zai-org/GLM-5` | |
| `MiniMaxAI/MiniMax-M3` | |
| `MiniMaxAI/MiniMax-M2.7` | |
| `MiniMaxAI/MiniMax-M2.5` | |
| `xiaomi/mimo-v2.5-pro` | |
| `xiaomi/mimo-v2.5` | |
| `Qwen/Qwen3.8-Max` | |
| `Qwen/Qwen3.7-Max` | |
| `Qwen/Qwen3.7-Plus` | |
| `Qwen/Qwen3.7-Flash` | |
| `Qwen/Qwen3.6-Max-Preview` | |
| `Qwen/Qwen3.6-Plus` | |
| `stepfun/Step-3.7-Flash` | |
| `stepfun/Step-3.5-Flash` | |
| `tencent/hy3-paid` | |
| `nvidia/nemotron-3-ultra-550b-a55b` | |
| `thinkingmachines/inkling` | |
| `thinkingmachines/inkling-small` | |

**Premium — Go plan and above:**

| Model | Notes |
|---|---|
| `gpt-5.6-luna` | 50% off until 2026-08-13 |
| `xai/grok-4.5` | |
| `meta/muse-spark-1.2-contributor` | ~95% off |

**GOAT plan and above:**

| Model | Notes |
|---|---|
| `meta/muse-spark-1.2` | |

**Premium — Pro plan and above:**

| Model | Notes |
|---|---|
| `gpt-5.6-sol` | |
| `gpt-5.6-terra` | 50% off until 2026-08-13 |
| `gpt-5.5` | |
| `claude-opus-5` | |
| `claude-sonnet-5` | |
| `google/gemini-3.6-flash` | |
| `sakana/fugu-ultra` | |

> [See all models](https://commandcode.ai/docs/reference/cli/models) → `cmd --list-models` for the current roster.

## Logs

All requests are logged to both terminal (colorized) and `proxy.log` (plain text):

```
[2026-07-09T09:10:06.092Z] [req] tencent/Hy3 | ::1 | sync | 232 bytes
[2026-07-09T09:10:07.137Z] [upstream] 200 OK | tencent/Hy3 | 1045ms
[2026-07-09T09:10:09.303Z] [done] tencent/Hy3 | 92 text / 0 tools | stop | 3211ms
```

**Color legend (terminal only):**
- `[req]` — cyan — incoming request with model, client IP, stream mode, byte size
- `[upstream]` — green — HTTP status, model, latency to CommandCode
- `[done]` — bold — text / reasoning / tool counts, finish reason, total duration
- `[error]` — yellow — upstream or internal errors

**Log fields:**
- `text` / `reasoning` — total characters of each type in the response
- `tools` — number of tool calls the model made
- `reason` — `stop` (finished) or `tool_calls` (waiting for tool results)

### Common errors

| Log | Fix |
|---|---|
| `[upstream] 401` | Token invalid. Get a fresh one from billing. |
| `[upstream] 400` | Request format mismatch. Check proxy version. |
| `[upstream] timeout` | Upstream took >5 min. Retry. |
| `[error] context length` | Prompt too large for model (e.g. ~520K tokens vs 256K max). Reduce messages or switch to a higher-context model. |
| `EADDRINUSE` | Proxy auto-kills the old process on start. |

## Disclaimer

This project is for educational and research purposes only. It uses CommandCode's internal `/alpha/generate` endpoint, which is undocumented and may change or be restricted at any time. Use at your own risk and in accordance with CommandCode's Terms of Service.

## License

MIT
