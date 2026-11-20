/**
 * model.mjs - the only module that talks to an LLM.
 *
 * Two providers:
 *   mock   deterministic scripted planner, zero network, zero API keys.
 *          This is the default and the mode the smoke test exercises.
 *   openai any OpenAI-compatible /chat/completions endpoint (real mode is
 *          opt-in through settings or ASSIST_MODEL_PROVIDER=openai).
 *
 * The rest of the app only ever sees:
 *   model.complete(messages, { tools, signal, onDelta })
 *     -> { content, toolCalls, finishReason, usage }
 * where toolCalls is [{ id, name, arguments }] with arguments already parsed.
 *
 * Streaming: when the caller passes an `onDelta` callback the real provider
 * asks for `stream: true`, parses the SSE `data:` frames as they arrive and
 * calls `onDelta({ text })` for every content delta before the call resolves.
 * Tool-call arguments also arrive as deltas; they are re-assembled by index and
 * returned in the same final shape as the non-streaming path. The mock emits
 * the same deltas (from its scripted answer) so the whole pipeline - provider
 * to agent to SSE to the browser - is exercised offline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { providerKind } from './providers.mjs';
import { createAnthropicClient } from './anthropic.mjs';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Opt-in wire capture: ASSIST_DEBUG_WIRE=1 appends every request and response
 * summary to <data>/wire.jsonl. Provider quirks (reasoning fields, tool-call
 * shapes) are impossible to diagnose from the outside, so this is the cheap
 * version of a packet capture. Never enabled by default.
 */
function debugWire(entry) {
  if (!process.env.ASSIST_DEBUG_WIRE) return;
  try {
    const dir = env('ASSIST_DATA_DIR', path.resolve(process.cwd(), 'data'));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'wire.jsonl'), `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
  } catch {
    /* debugging must never break a turn */
  }
}

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * How much one answer in a bot's turn may write (1.5.16). The old 4096 cut
 * long fs_write calls off mid-way (ARGS_TRUNCATED: the bot wrote the file
 * again in parts, a wasted round) and a thinking model could spend it all
 * thinking. Each provider's documented ceiling, kept modest; a provider that
 * refuses it gets 4096 again (see withOutputFallback).
 */
const OUTPUT_TOKENS = {
  openai: 16384, anthropic: 16384, gemini: 16384, xai: 16384, moonshot: 16384, zhipu: 16384, openrouter: 16384,
  deepseek: 8192, qwen: 8192, minimax: 8192, hunyuan: 8192, siliconflow: 8192, groq: 8192, together: 8192, mistral: 8192, spark: 8192,
};
export function turnOutputTokens(provider) {
  return OUTPUT_TOKENS[String(provider || '').toLowerCase()] || 4096;
}

/** A 400 that says the output budget is too big: worth one more try at 4096. */
export function outputTooBig(err) {
  const m = String(err?.message || '');
  return /HTTP 400/.test(m) && /max_tokens|max_completion_tokens|max_output|maximum.{0,40}tokens|tokens.{0,40}(exceed|range|limit|too large|at most|less than)/i.test(m);
}

/**
 * Ask with the wider budget; when the provider refuses it, ask again with 4096
 * and remember that for this client (one wasted request per model, not per step).
 */
export async function withOutputFallback(client, opts, call) {
  const wanted = opts.maxTokens;
  if (!wanted || wanted <= 4096) return call(opts);
  if (client.outputCap && wanted > client.outputCap) return call({ ...opts, maxTokens: client.outputCap });
  try {
    return await call(opts);
  } catch (err) {
    if (!outputTooBig(err)) throw err;
    client.outputCap = 4096;
    return call({ ...opts, maxTokens: 4096 });
  }
}

export function createModel({ provider, baseUrl, apiKey, model, timeoutMs } = {}) {
  const chosen = (provider || env('ASSIST_MODEL_PROVIDER', 'mock')).toLowerCase();
  const cfg = {
    provider: chosen,
    baseUrl: baseUrl || env('ASSIST_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: apiKey || env('ASSIST_API_KEY', ''),
    model: model || env('ASSIST_MODEL', DEFAULT_MODEL),
    timeoutMs: timeoutMs || Number(env('ASSIST_MODEL_TIMEOUT_MS', '120000')),
  };

  if (chosen === 'mock') {
    return {
      ...cfg,
      // There is no model behind the mock; label it as what it is.
      model: 'scripted-planner',
      /** No tools needed: the mock reads keywords out of the transcript. */
      async complete(messages, opts = {}) {
        const result = mockComplete(messages);
        await emitMockDeltas(result.content, opts.onDelta);
        // A deterministic stand-in so the cost ledger has real numbers to add
        // up in tests and demos (roughly four characters per token).
        const promptTokens = Math.max(12, Math.ceil(messages.reduce((n, m) => n + String(m.content ?? '').length, 0) / 4));
        const completionTokens = Math.max(6, Math.ceil(String(result.content || '').length / 4));
        return {
          ...result,
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        };
      },
    };
  }

  // The provider catalogue decides the wire format: Claude speaks its own
  // protocol, everything else (/including unknown/custom names/) is assumed to
  // be OpenAI-compatible, which is what nearly every gateway exposes.
  const kind = providerKind(chosen);
  if (kind === 'anthropic') {
    const claude = createAnthropicClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: cfg.timeoutMs });
    const plain = claude.complete;
    claude.turnOutputTokens = turnOutputTokens('anthropic');
    claude.complete = (messages, opts = {}) => withOutputFallback(claude, opts, (o) => plain.call(claude, messages, o));
    return claude;
  }

  const client = {
    ...cfg,
    turnOutputTokens: turnOutputTokens(chosen),
    async complete(messages, opts = {}) {
      return withOutputFallback(client, opts, (o) => openAiComplete(cfg, messages, o));
    },
  };
  return client;
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

/**
 * Call the caller-supplied delta sink. A broken sink must never kill a turn
 * (the agent's sink emits on the event bus, which is already defensive; this is
 * belt and braces for anyone embedding the model client).
 */
function emitDelta(onDelta, text) {
  if (typeof onDelta !== 'function' || !text) return;
  try {
    onDelta({ text });
  } catch {
    /* ignore a broken consumer */
  }
}

function chunkText(text, size = 24) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * The mock streams its answer the same way a real provider would: several
 * deltas in order, yielding to the event loop between them so the SSE writes
 * actually flush between chunks. The smoke test asserts the ordering.
 */
async function emitMockDeltas(content, onDelta) {
  if (typeof onDelta !== 'function' || !content) return;
  for (const chunk of chunkText(String(content))) {
    emitDelta(onDelta, chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Real provider: OpenAI-compatible chat completions
// ---------------------------------------------------------------------------

function toWireMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const out = { role: 'assistant', content: m.content || null };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
      // DeepSeek (and other "thinking" models) require the assistant's
      // reasoning_content to be echoed back on the next request that follows a
      // tool result. Dropping it earns a 400:
      //   "The `reasoning_content` in the thinking mode must be passed back to the API."
      // We only ever carry this field when the provider produced one, so plain
      // OpenAI-compatible endpoints never see an unknown key.
      if (typeof m.reasoning_content === 'string' && m.reasoning_content) {
        out.reasoning_content = m.reasoning_content;
      }
      return out;
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content ?? '') };
    }
    return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') };
  });
}

async function openAiComplete(cfg, messages, opts = {}) {
  if (!cfg.apiKey) {
    throw new Error('ASSIST_API_KEY is required when ASSIST_MODEL_PROVIDER=openai');
  }

  const { tools, temperature = 0.2, maxTokens = 4096 } = opts;
  const body = {
    model: cfg.model,
    messages: toWireMessages(messages),
    temperature,
    max_tokens: maxTokens,
  };
  debugWire({ kind: 'request', model: cfg.model, messages: body.messages, tools: (tools || []).map((t) => t.function?.name) });
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  // Streaming is not a mode flag the app stores: it is simply "did the caller
  // ask for deltas?". That keeps one code path for callers that only want the
  // final message (e.g. the settings connection test).
  if (typeof opts.onDelta === 'function') {
    return openAiStream(cfg, body, opts);
  }
  return openAiJson(cfg, body, opts);
}

function requestSignal(cfg, signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Number(timeoutMs) || cfg.timeoutMs);
  // AbortSignal.any landed in Node 20.3; fall back to the plain timeout on
  // 20.0-20.2 so an early-20 runtime still works.
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Provider hiccups worth another try: rate limits and server-side errors. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_DELAYS_MS = [1500, 4000];

async function postChat(cfg, body, composed, { stream }) {
  // Retries happen before any reply byte is read, so a stream never repeats.
  for (let attempt = 0; ; attempt += 1) {
    const canRetry = attempt < RETRY_DELAYS_MS.length && !composed?.aborted;
    let res;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: stream ? 'text/event-stream' : 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: composed,
      });
    } catch (err) {
      if (canRetry && !composed?.aborted) {
        await waitFor(RETRY_DELAYS_MS[attempt], composed);
        continue;
      }
      // Surface a model error the agent loop can report instead of crashing a turn.
      throw new Error(`model request failed: ${err.message}`);
    }

    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    if (canRetry && RETRY_STATUS.has(res.status)) {
      await waitFor(RETRY_DELAYS_MS[attempt], composed);
      continue;
    }
    throw new Error(`model HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
}

function waitFor(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Non-streaming `/chat/completions` (kept for compatibility and for tests). */
async function openAiJson(cfg, body, { signal, timeoutMs } = {}) {
  const res = await postChat(cfg, body, requestSignal(cfg, signal, timeoutMs), { stream: false });
  const json = await res.json();
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const toolCalls = (msg.tool_calls || []).map((call) => ({
    id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
    name: call.function?.name || '',
    arguments: toolArgs(call.function?.arguments),
  }));

  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    toolCalls,
    reasoningContent: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '',
    finishReason: choice.finish_reason || 'stop',
    usage: json.usage || null,
  };
}

/**
 * True streaming: POST with `stream: true`, read the body as it arrives and
 * turn each SSE line into a delta.
 *
 * What the wire actually looks like (OpenAI-compatible):
 *   data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}
 *   data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}
 *   data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1",
 *            "type":"function","function":{"name":"fs_list","arguments":""}}]}}]}
 *   data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,
 *            "function":{"arguments":"{\"path\":"}}]}}]}
 *   data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
 *   data: [DONE]
 *
 * Notes on the parser: SSE accepts CRLF or LF, and one frame can be split
 * across TCP chunks (or several frames can arrive in one chunk), so we buffer
 * bytes and parse complete lines. TextDecoder with stream:true keeps multi-byte
 * UTF-8 characters whole when a chunk boundary falls inside one.
 */
async function openAiStream(cfg, body, { signal, timeoutMs, onDelta }) {
  const res = await postChat(
    cfg,
    { ...body, stream: true },
    requestSignal(cfg, signal, timeoutMs),
    { stream: true },
  );

  if (!res.body) throw new Error('model response had no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = ''; // DeepSeek thinking models: delta.reasoning_content
  let finishReason = 'stop';
  let usage = null;
  const calls = new Map(); // index -> {id, name, arguments}
  let sawDone = false;

  const handleData = (payload) => {
    const trimmed = payload.trim();
    if (!trimmed) return;
    if (trimmed === '[DONE]') {
      sawDone = true;
      return;
    }
    let json;
    try {
      json = JSON.parse(trimmed);
    } catch {
      // A provider that emits non-JSON keep-alive text must not break the turn.
      return;
    }
    if (json?.error) {
      throw new Error(`model stream error: ${json.error.message || JSON.stringify(json.error)}`);
    }
    if (json?.usage) usage = json.usage;
    const choice = json?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    // Thinking models stream the chain of thought before the answer. It is not
    // shown to the user, but it must be kept: the next request has to echo it
    // back when a tool call was involved.
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
    } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
      reasoning += delta.reasoning;
    }

    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      emitDelta(onDelta, delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const index = Number.isInteger(part.index) ? part.index : 0;
        const entry = calls.get(index) || { id: '', name: '', arguments: '' };
        if (part.id) entry.id = part.id;
        if (part.function?.name) entry.name = part.function.name;
        if (typeof part.function?.arguments === 'string') {
          // Arguments arrive in fragments; concatenate in order.
          entry.arguments += part.function.arguments;
        }
        calls.set(index, entry);
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  const pumpLines = () => {
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue; // comment / event: / heartbeat
      handleData(line.slice(5));
    }
  };

  try {
    while (!sawDone) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      pumpLines();
    }
    // Flush a trailing frame that had no final newline and any buffered UTF-8.
    buffer += decoder.decode();
    pumpLines();
    if (buffer.startsWith('data:')) handleData(buffer.slice(5));
  } catch (err) {
    // Preserve the abort/type so the agent can report it, but keep the prefix
    // consistent with the non-streaming path.
    throw err instanceof Error && /^model /.test(err.message)
      ? err
      : new Error(`model stream failed: ${err.message}`);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, entry]) => ({
      id: entry.id || `call_${index}`,
      name: entry.name || '',
      arguments: toolArgs(entry.arguments),
    }))
    .filter((call) => call.name);

  debugWire({
    kind: 'stream-result',
    content: content.slice(0, 200),
    contentLength: content.length,
    reasoningLength: reasoning.length,
    reasoningHead: reasoning.slice(0, 120),
    toolCalls: toolCalls.map((call) => call.name),
    finishReason,
  });
  return { content, toolCalls, reasoningContent: reasoning, finishReason, usage };
}

/**
 * A tool call's arguments. When the text does not parse - the model ran out of
 * output and the JSON was cut off - say so instead of passing {} (which made a
 * long page arrive "empty" and the bot retry the same thing).
 */
export function toolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return { __truncated: true, __length: raw.length };
  }
}

function safeParseJson(raw, fallback) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Mock provider - a scripted planner, not a language model
// ---------------------------------------------------------------------------

/**
 * The mock plays a fixed "plan" per intent. It works out which step of the
 * plan it is on by counting tool results that arrived after the last user
 * message, which is exactly the information a real model would get from the
 * transcript. Deterministic by construction: same transcript, same next call.
 *
 * Intents are ordered; the first match wins. The plans deliberately avoid
 * anything that needs the network so the whole demo works offline.
 */

const INTENTS = [
  { id: 'handoff', re: /\b(hand\s?off|delegate to|ask the (researcher|ops)|message the|send (it )?to the)\b/i },
  { id: 'routine', re: /\b(routine|schedule|recurr|every \d+ (minutes?|hours?)|cron)\b/i },
  { id: 'skill', re: /(\bsave\b.{0,30}\bskill\b)|(\bas a skill\b)|(\bskill\b.{0,20}\bsave\b)/i },
  { id: 'outside', re: /\b(outside (of )?the workspace|beyond the workspace|external file|wherever you like)\b/i },
  { id: 'shell', re: /\b(shell|terminal|run (the )?command|execute (a )?command|\bcmd\b)\b|(运行|执行|跑)[^。，,]{0,6}(命令|指令)|命令行/i },
  { id: 'memory', re: /\b(remember|memory|memorise|memorize|note that|keep in mind)\b|记住|记一下|别忘了/i },
  { id: 'read', re: /\b(read|open|cat|show me)\b.{0,40}(file|welcome|readme|note)|(读|打开)[^。，,]{0,10}(文件|welcome|readme|笔记)/i },
  { id: 'files', re: /\b(list|ls\b|what'?s in|workspace|directory|folder)\b|工作区|(列出|有哪些)[^。，,]{0,8}文件/i },
  // The four things the empty chat suggests (1.5.32): each plays a short scripted
  // run in demo mode, so a new user sees the product work before adding a key.
  { id: 'demo_tidy', re: /下载文件夹|整理[^。]{0,8}(文件夹|下载)/ },
  { id: 'demo_daily', re: /(每天|每周|每个工作日)[^。]{0,12}(给我|提醒|简报|发)|提醒我/ },
  { id: 'demo_write', re: /帮我写|写一封|写一份|起草/ },
  { id: 'demo_research', re: /上网查|查一下|搜一下|查查|查资料/ },
];

/** The line agent.mjs adds to a routine's turn (ROUTINE_TURN_LINE there; the smoke test checks they match). */
const ROUTINE_TURN_LINE = 'This turn runs one of your scheduled tasks (a routine): do what its instruction says.';

/** Said at the end of every scripted demo (1.5.32). */
const DEMO_END = '这是演示脚本。接入模型后，你可以用自己的话说任何事。';

function detectIntent(text) {
  for (const intent of INTENTS) {
    if (intent.re.test(text)) return intent.id;
  }
  return 'chat';
}

/** Pull "every 30 minutes" or a raw five-field cron expression out of free text. */
function extractSchedule(text) {
  const interval = text.match(/every\s+(\d+)\s*(minutes?|hours?)/i);
  if (interval) {
    const unit = interval[2].toLowerCase().startsWith('h') ? 'hours' : 'minutes';
    return `every ${interval[1]} ${unit}`;
  }
  const cron = text.match(/((?:\*|\d+(?:[-,/]\d+)*)\s+){4}(?:\*|\d+(?:[-,/]\d+)*)/);
  if (cron) return cron[0].replace(/\s+/g, ' ').trim();
  return 'every 30 minutes';
}

function extractSkillName(text) {
  // "save this as a skill called inbox-triage: ..." -> "inbox-triage"
  const match = text.match(/skill\s*(?:called|named|:)?\s*["“']?([a-z0-9][a-z0-9 _-]{0,60})/i);
  if (!match) return 'workspace-sweep';
  const cleaned = match[1]
    .split(/[:.,\n]/)[0]
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join(' ');
  return cleaned.length >= 3 ? cleaned : 'workspace-sweep';
}

function extractFileName(text) {
  const match = text.match(/([a-zA-Z0-9._/-]+\.(?:md|txt|json|mjs|js|csv|log))/);
  return match ? match[1] : 'welcome.md';
}

function extractBotId(text) {
  const match = text.match(/\b(researcher|ops|chief)\b/i);
  return match ? match[1].toLowerCase() : 'researcher';
}

/** One-line summary the model would have produced, used as the turn's answer. */
function shortQuote(text, max = 90) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}...` : oneLine;
}

/**
 * Build the plan for an intent. Each step is either
 *   { tool, args }            -> ask the runtime to call a tool
 *   { content }               -> plain assistant text, ends the turn
 */
function mockPlan(text, botName) {
  const intent = detectIntent(text);
  // A Chinese message gets Chinese words back (BUG-04: a new user's first sight was English).
  const zh = /[\u4e00-\u9fff]/.test(String(text || ''));
  const say = (cn, en) => (zh ? cn : en);

  switch (intent) {
    case 'handoff':
      return [
        {
          tool: 'bot_message',
          args: {
            botId: extractBotId(text),
            text: 'Quick task: read welcome.md in the shared workspace and reply with the three most important lines.',
          },
        },
        {
          tool: 'task_finish',
          args: { summary: `Handed the task to ${extractBotId(text)} and relayed its reply back to you.` },
        },
      ];

    case 'routine':
      return [
        {
          tool: 'routine_create',
          args: {
            name: 'Scheduled check-in',
            instruction: 'Read welcome.md and summarise the three most important lines.',
            schedule: extractSchedule(text),
            enabled: true,
          },
        },
        {
          tool: 'routine_list',
          args: {},
        },
        {
          tool: 'task_finish',
          args: { summary: 'Created the routine and confirmed it appears in the schedule.' },
        },
      ];

    case 'skill':
      return [
        {
          tool: 'skill_save',
          args: {
            name: extractSkillName(text),
            description: 'Inspect the shared workspace and produce a short, skimmable status note.',
            when_to_use: 'When someone asks for a quick read on what is in the workspace right now.',
            steps: [
              'Call fs_list on the workspace root.',
              'Call fs_read on the two most relevant files.',
              'Write the summary to notes/status.md with fs_write.',
              'Call task_finish with the path you wrote.',
            ],
            validation: 'notes/status.md exists and is shorter than 40 lines.',
            output: 'A markdown note at notes/status.md plus a one-line summary in chat.',
            approval_notes: 'Writing inside the workspace is LOW risk; nothing outside it is touched.',
            body: [
              '# Workspace sweep',
              '',
              'A small procedure for turning "what is going on in here" into a note somebody can read.',
              '',
              '1. List the workspace, newest files first.',
              '2. Read the two files that look most load-bearing.',
              '3. Write `notes/status.md` with sections: What changed / What is blocked / Next step.',
              '4. Finish with a one-line summary that names the file you wrote.',
            ].join('\n'),
          },
        },
        {
          tool: 'task_finish',
          args: { summary: `Saved "${extractSkillName(text)}" to the shared skill library.` },
        },
      ];

    case 'outside':
      // Deliberately crosses the workspace boundary: this is the HIGH-risk path
      // the approval boundary exists for. The tool refuses to run until a human
      // says yes.
      return [
        {
          tool: 'fs_write',
          args: {
            path: path.join('..', 'outside-note.md'),
            content: [
              '# Note written outside the shared workspace',
              '',
              `Request: ${shortQuote(text, 160)}`,
              '',
              'This file lives outside workspace/, so writing it needed a human approval.',
              '',
            ].join('\n'),
          },
        },
        {
          tool: 'task_finish',
          args: { summary: 'Wrote the note outside the workspace once it was approved.' },
        },
      ];

    case 'demo_tidy': {
      const dir = '演示/下载';
      const files = ['周报-11月.docx', '发票-11月.pdf', '截图-1118.png', 'Lamplit-Setup.exe'];
      // Moving files is the step a human approves: one node script (the same on Windows and Linux).
      const move = `node -e "const fs=require('fs'),p=require('path');const d='${dir}';const m={'.png':'图片','.docx':'文档','.pdf':'文档','.exe':'安装包'};for(const f of fs.readdirSync(d)){const t=m[p.extname(f)];if(t===undefined)continue;fs.mkdirSync(p.join(d,t),{recursive:true});fs.renameSync(p.join(d,f),p.join(d,t,f));}console.log('分好了')"`;
      return [
        { tool: 'task_plan', args: { goal: '整理下载文件夹（演示）', steps: ['在工作区放一个演示用的「下载」文件夹', '看看里面有什么，按类型分好', '你同意后移动：截图 → 图片，周报和发票 → 文档，安装包 → 安装包'] } },
        ...files.map((f) => ({ tool: 'fs_write', args: { path: `${dir}/${f}`, content: '（演示文件，可以删掉）\n' } })),
        { tool: 'task_step', args: { step: 1, status: 'done', note: `放好了 ${files.length} 个演示文件：${dir}` } },
        { tool: 'fs_list', args: { path: dir } },
        { tool: 'task_step', args: { step: 2, status: 'done', note: '图片 1 个、文档 2 个、安装包 1 个' } },
        { say: '打算这样分：截图-1118.png → 图片；周报-11月.docx、发票-11月.pdf → 文档；Lamplit-Setup.exe → 安装包。移动文件要你同意，下面这张卡就是在问你（命令就是做这件事的一小段脚本）。', tool: 'shell', args: { command: move, timeoutMs: 15000 } },
        // The checklist closes itself when its last step is done (a task_end here only got NO_TASK back).
        { tool: 'task_step', args: { step: 3, status: 'done', note: '移进了 图片 / 文档 / 安装包' } },
        { tool: 'task_finish', args: { summary: `在工作区建了「${dir}」，放了 4 个演示文件，按类型分进 图片、文档、安装包。移动文件这一步先问了你：同意了就已经分好，拒绝了文件就原样不动。真用的时候，它整理的是你自己的下载文件夹，同样先给你看打算怎么动。${DEMO_END}` } },
      ];
    }

    case 'demo_daily':
      return [
        { tool: 'routine_create', args: { name: '早间简报（演示）', instruction: '看一下这台电脑的磁盘空间够不够，有异常就提醒我。', schedule: '0 8 * * *', enabled: false } },
        { tool: 'routine_list', args: {} },
        { tool: 'task_finish', args: { summary: `建好了一个定时任务「早间简报（演示）」：每天 08:00 跑一次。演示里先不打开，免得每天给你发演示消息；在右上角工作面板的「任务」页签里能看到它，可以启用、改时间或删掉。接入模型后，它每天会真的去查、真的写简报。${DEMO_END}` } },
      ];

    case 'demo_write':
      return [
        {
          tool: 'fs_write',
          args: {
            path: '演示/请假邮件.md',
            content: ['主题：明天下午请半天假', '', '王经理您好：', '', '我明天（周四）下午需要去医院复查，想请半天假，下午 1 点后离开。手头的周报今天下班前发您，有急事可以打我电话。', '', '谢谢！', '', '小林', ''].join('\n'),
          },
        },
        { tool: 'task_finish', args: { summary: `写好了一封请假邮件，存在 演示/请假邮件.md，点开就能看、能复制。接入模型后，它会按你说的情况、你要的语气来写，写完也能直接帮你发。${DEMO_END}` } },
      ];

    case 'demo_research':
      return [
        {
          content: [
            '演示模式不联网，这一条没法真的去查。接入模型后，它会这样做：打开几个网页查最新的信息，挑出 3 个，分别说优缺点和价格，每条后面附上出处链接，最后给一句建议。',
            '',
            '比如你问「适合新手的 AI 写作工具」，回答会长这样：',
            '1. 某工具 A：上手最快，中文好；免费版每天有次数限制。（出处：官网定价页）',
            '2. 某工具 B：……',
            '',
            `点下面的「接入真实模型」，填一个 DeepSeek 密钥就能真的查。${DEMO_END}`,
          ].join('\n'),
        },
      ];

    case 'shell':
      // A request about the disk looks at the disk (1.5.41: a routine 「看磁盘」 ran `node --version`).
      if (/磁盘|硬盘|空间|\bdisk\b/i.test(text)) {
        const disk = `node -e "const s=require('fs').statfsSync(process.cwd());const g=(n)=>(n/1073741824).toFixed(1);console.log('free '+g(s.bavail*s.bsize)+' GB of '+g(s.blocks*s.bsize)+' GB')"`;
        return [
          { tool: 'shell', args: { command: disk, timeoutMs: 15000 } },
          { tool: 'task_finish', args: { summary: say(`看了这块磁盘还剩多少空间，结果在上面。（演示模式：命令是写好的，接入模型后它会按你的话来查）`, 'Checked how much space is left on this disk; the result is above. (Demo mode: the command is scripted.)') } },
        ];
      }
      return [
        { tool: 'shell', args: { command: 'node --version', timeoutMs: 15000 } },
        {
          tool: 'task_finish',
          args: { summary: say('在工作区里运行了 `node --version`，结果在上面。', 'Ran `node --version` inside the shared workspace and reported the output.') },
        },
      ];

    case 'memory':
      return [
        { tool: 'memory_write', args: { text } },
        {
          tool: 'task_finish',
          args: { summary: say('记下了，下次聊天我还记得。', 'Saved that to my memory. I will still have it in the next conversation.') },
        },
      ];

    case 'read':
      return [
        { tool: 'fs_read', args: { path: extractFileName(text) } },
        {
          tool: 'task_finish',
          args: { summary: say(`读了工作区里的 ${extractFileName(text)}，要点在上面。`, `Read ${extractFileName(text)} from the shared workspace and summarised it above.`) },
        },
      ];

    case 'files':
      return [
        { tool: 'fs_list', args: { path: '.' } },
        {
          tool: 'fs_write',
          args: {
            path: path.join('notes', 'plan.md'),
            content: [
              '# Plan',
              '',
              '1. Inspect the shared workspace (done).',
              '2. Write this note so the other bots can see what I did.',
              '3. Save a memory entry so this survives the conversation.',
              '',
            ].join('\n'),
          },
        },
        { tool: 'memory_write', args: { text: `Ran a workspace sweep: ${shortQuote(text, 120)}` } },
        {
          tool: 'task_finish',
          args: {
            summary: say('看了工作区里的文件，写了 notes/plan.md，也记进了笔记。', 'Listed the shared workspace, wrote notes/plan.md, and saved a memory entry about it.'),
          },
        },
      ];

    default:
      return [
        {
          content: zh
            ? `我是${botName === 'the assistant' ? '助理' : botName}，现在是演示模式（还没接入真实模型），回答是写好的脚本。\n\n` +
              '可以点这几个试试，每个都会真的做一遍：\n' +
              '- 整理下载文件夹：建一个演示文件夹，列任务清单，移动前先问你\n' +
              '- 每天提醒我：建一个定时任务\n' +
              '- 写一份东西：写一封请假邮件存进工作区\n' +
              '- 上网查资料：看看接入模型后会怎么回答\n\n' +
              '到 设置 → 模型 接入真实模型后，我就能听懂任何话。'
            : `I'm ${botName}, working out of the shared workspace. ` +
              'Ask me to read or list files, remember something, run a shell command, save a skill, ' +
              'create a routine, or hand a task to another bot - those all go through real tools and the approval boundary.',
        },
      ];
  }
}

/** Parse "You are <name>," out of the system prompt so replies feel bot-specific. */
function botNameFromMessages(messages) {
  const system = messages.find((m) => m.role === 'system');
  if (!system || typeof system.content !== 'string') return 'the assistant';
  const match = system.content.match(/You are\s+([A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff _-]{0,30})[,.，。]/);
  return match ? match[1].trim() : 'the assistant';
}

/**
 * The agent appends a group section to the system prompt with a deliberately
 * machine-readable first line:
 *   Group id: <id> (you are the coordinator|a member; your bot id is <id>).
 * The mock keys off it so group turns can be demonstrated and tested offline.
 * (A real model just reads the prose underneath.)
 */
function groupFromMessages(messages) {
  const system = messages.find((m) => m.role === 'system');
  if (!system || typeof system.content !== 'string') return null;
  const match = system.content.match(
    /Group id: (\S+) \(you are (the coordinator|a member); your bot id is (\S+?)\)/,
  );
  if (!match) return null;
  const membersLine = system.content.split('\n').find((line) => line.startsWith('You are in the group chat'));
  // "Members: Chief (chief) - ...; Researcher (researcher) - ..."
  const ids = membersLine ? [...membersLine.matchAll(/\(([a-z0-9][a-z0-9._-]*)\)/gi)].map((m) => m[1]) : [];
  const self = membersLine ? new RegExp(`(?:Members:\\s*|;\\s*)([^;()]+?)\\s*\\(${match[3].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`).exec(membersLine) : null;
  return {
    id: match[1],
    role: match[2] === 'the coordinator' ? 'coordinator' : 'member',
    selfId: match[3],
    selfName: self ? self[1].trim() : '',
    others: ids.filter((id) => id !== match[3]),
  };
}

/**
 * A group turn. The coordinator says one thing, hands a short ask to one
 * teammate (who answers in the group with group_post), then finishes. A member
 * answers in the group and replies privately to the coordinator.
 */
function mockGroupPlan(group, botName, text) {
  // A Chinese request gets Chinese back (1.5.32: the group demo answered in English).
  const zh = /[\u4e00-\u9fff]/.test(String(text || ''));
  const say = (cn, en) => (zh ? cn : en);
  if (group.role === 'coordinator' && group.others.length) {
    return [
      {
        tool: 'group_post',
        args: { group: group.id, text: say(`收到：${shortQuote(text, 60).replace(/[。.！!？?…]+$/, '')}。我问问大家。`, `On it: ${shortQuote(text, 60)}. I will check with the team.`) },
      },
      {
        tool: 'bot_message',
        args: {
          botId: group.others[0],
          text: say(`群里在做：${shortQuote(text, 80).replace(/[。.！!？?…]+$/, '')}。说一句你的看法。`, `The group is working on: ${shortQuote(text, 80)}. One short opinion, please.`),
        },
      },
      { tool: 'task_finish', args: { summary: say(`在群里回了话，也请 ${group.others[0]} 说了看法。`, `Posted in the group and pulled in ${group.others[0]} for a second opinion.`) } },
    ];
  }

  const bare = (t) => shortQuote(String(t || ''), 60).replace(/[。.！!？?…]+$/, '');
  const spoken =
    group.role === 'coordinator'
      ? say(`收到：${bare(text)}。我在群里跟进。`, `On it: ${bare(text)}. I am following this up in the group.`)
      : say(`我是${group.selfName || '这位成员'}。收到了；我的看法要等接入模型后才说得出来（现在是演示模式）。`, `I am ${group.selfName || botName}. Picked up the group task: ${bare(text)}.`);
  return [
    { tool: 'group_post', args: { group: group.id, text: spoken } },
    { tool: 'task_finish', args: { summary: say(`在群里说了：${shortQuote(spoken, 70)}`, `Posted in the group: ${shortQuote(spoken, 70)}`) } },
  ];
}

/**
 * What the demo answers (1.5.45): a message another machine wrapped for a group
 * member (the group's recent lines, then 「现在要你回答的话：…」) is only its last line.
 * The recent lines set off a scripted demo (「@管家 你好」 ran a command, 1.5.44 test).
 */
export function demoAsk(text) {
  const t = String(text ?? '');
  const m = /现在要你回答的话?[：:]\s*([\s\S]*)$/.exec(t);
  return m ? m[1].trim() : t;
}

/** The scripted run for a message in demo mode (tests read it). */
export const demoPlan = (text, botName = '助理') => mockPlan(text, botName);

function mockComplete(messages) {
  const lastUserIndex = messages.reduce(
    (acc, m, i) => (m.role === 'user' ? i : acc),
    -1,
  );
  const userText = lastUserIndex >= 0 ? demoAsk(messages[lastUserIndex].content) : '';
  const toolResultsSinceUser =
    lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1).filter((m) => m.role === 'tool').length : 0;

  const botName = botNameFromMessages(messages);
  // A plain "talk to the group" message has no other intent: answer in the group.
  const group = groupFromMessages(messages);
  const plan =
    group && detectIntent(userText) === 'chat'
      ? mockGroupPlan(group, botName, userText)
      : mockPlan(userText, botName);
  // A scheduled task in demo mode (1.5.33): its instruction must not set off the
  // four scripted demos (「立即运行」 made a second routine, a briefing wrote a leave email).
  const system = messages.find((m) => m.role === 'system');
  // The runtime's own check of a reply (「（系统核对）…」) is not a new request: the demo
  // took its 「执行…命令」 for one and ran `node --version` (1.5.41 test, 「立即运行」).
  if (/^（系统核对）/.test(userText)) {
    return { content: '（演示模式）更正一下：这一轮没有真的运行任何命令，演示脚本只是说明它会怎么做。', toolCalls: [], finishReason: 'stop' };
  }
  if (typeof system?.content === 'string' && system.content.includes(ROUTINE_TURN_LINE) && toolResultsSinceUser === 0 && /^demo_/.test(detectIntent(userText))) {
    // Not 「跑了一次」: nothing ran, and the runtime's check rightly asked about it.
    return { content: '（演示模式）定时任务的指令收到了。演示模式下它不会真的去查；接入模型后，它会按指令真的去做，结果发在这里。', toolCalls: [], finishReason: 'stop' };
  }
  const step0 = plan[Math.min(toolResultsSinceUser, plan.length - 1)];
  // A step that was refused or not allowed: the closing line says so (1.5.33: it said 「运行了」 anyway).
  const results = lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1).filter((m) => m.role === 'tool').map((m) => String(m.content ?? '')) : [];
  // (The checklist's own bookkeeping - NO_TASK, BAD_STEP - is not a step the human refused.)
  const failed = results.find((r) => /"error"|denied|not granted|NOT_GRANTED|拒绝|没有权限/i.test(r) && !/NO_TASK|BAD_STEP|BAD_TASK/.test(r));
  const step = step0?.tool === 'task_finish' && failed
    ? { tool: 'task_finish', args: { summary: /denied|拒绝/i.test(failed) ? '你拒绝了那一步，所以没有做；别的都没动。（演示模式）' : '有一步没做成（这个助手没有这项能力，或者被挡下了），所以没有完成；别的都没动。（演示模式）' } }
    : step0;

  // Ran out of scripted steps without a task_finish: emit a plain closing line
  // so the loop terminates instead of spinning.
  if (toolResultsSinceUser >= plan.length) {
    return {
      content: 'That is everything I had planned for this task.',
      toolCalls: [],
      finishReason: 'stop',
    };
  }

  if (step.content !== undefined) {
    return { content: step.content, toolCalls: [], finishReason: 'stop' };
  }

  return {
    content: step.say || '',
    toolCalls: [
      {
        id: `call_${toolResultsSinceUser}_${step.tool}`,
        name: step.tool,
        arguments: step.args || {},
      },
    ],
    finishReason: 'tool_calls',
  };
}
