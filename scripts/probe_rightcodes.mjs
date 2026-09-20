// Standalone provider smoke test; this is not the M5 application adapter.
// Run explicitly: node --env-file=.env.rightcodes.local scripts/probe_rightcodes.mjs --run
// Optional --responses-only checks generation independently of model-list permission.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

if (process.argv[2] !== '--run') {
  console.error('Use --run to authorize this invocation: 3 small model requests, no automatic retries.');
  process.exit(2);
}
if (process.argv.slice(3).some(arg => arg !== '--responses-only')) {
  throw new Error('Unknown probe option.');
}
const responsesOnly = process.argv.includes('--responses-only');

const key = process.env.AIRLINE_MODEL_API_KEY;
const base = process.env.AIRLINE_MODEL_BASE_URL?.replace(/\/$/, '');
const model = process.env.AIRLINE_MODEL;
if (!key || !base || !model) throw new Error('Missing local model configuration.');
const origin = new URL(base);
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash ||
    !['www.rightapi.ai', 'rightapi.ai', 'www.right.codes', 'right.codes'].includes(origin.hostname) ||
    origin.pathname !== '/codex/v1') throw new Error('Unexpected provider endpoint.');

const redact = value => String(value).replaceAll(key, '[REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]');
const report = {
  started_at: new Date().toISOString(), runtime: process.version, provider: 'rightcodes',
  base_url: base, requested_model: model, status: 'RUNNING',
  scope: 'Provider authentication, text/instructions, function-call round trip only; no airline business acceptance.',
  budget: {user_authorized_usd: 5, enforcement: 'User-reported provider key limit; not independently verified.', actual_cost_usd: null},
  request_limits: {generation_requests: 3, max_output_tokens_per_request: 512, timeout_ms: 45000, automatic_retries: 0},
  model_discovery: responsesOnly ? 'SKIPPED_EXPLICITLY' : 'REQUIRED',
  checks: [], requests: [],
};
const note = value => console.log(JSON.stringify(value));
const textOf = response => (response.output ?? []).filter(x => x.type === 'message')
  .flatMap(x => x.content ?? []).filter(x => x.type === 'output_text').map(x => x.text).join('').trim();
function check(name, passed, detail = {}) {
  report.checks.push({name, passed, ...detail});
  note({check: name, passed});
  if (!passed) throw new Error(`Check failed: ${name}`);
}

async function request(path, payload) {
  const started = performance.now();
  const entry = {method: payload ? 'POST' : 'GET', path, elapsed_ms: null};
  report.requests.push(entry);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(`${base}${path}`, {
      method: entry.method, redirect: 'error', signal: controller.signal,
      headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
      ...(payload ? {body: JSON.stringify(payload)} : {}),
    });
    entry.http_status = response.status;
    entry.request_id = response.headers.get('x-request-id');
    entry.content_type = response.headers.get('content-type');
    if (!response.body) throw new Error('Missing response body.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', bytes = 0, terminal = null;
    const streaming = entry.content_type?.includes('text/event-stream');
    if (streaming) entry.stream_event_counts = {};
    const consume = block => {
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      const event = JSON.parse(data);
      const eventType = typeof event.type === 'string' ? redact(event.type).slice(0, 120) : 'unknown';
      entry.stream_event_counts[eventType] = (entry.stream_event_counts[eventType] ?? 0) + 1;
      entry.last_stream_event = eventType;
      if (event.type === 'error' || event.type === 'response.failed' || event.error) {
        const message = typeof event.error === 'string' ? event.error
          : event.error?.message ?? event.response?.error?.message ?? event.message ?? event.code ?? 'unknown';
        throw new Error(`Provider stream error: ${redact(message).slice(0, 400)}`);
      }
      if (event.type === 'response.completed' || event.type === 'response.incomplete') terminal = event.response;
    };
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        entry.response_bytes = bytes;
        if (bytes > 2_000_000) throw new Error('Response exceeded probe size limit.');
        buffer += decoder.decode(value, {stream: true});
        if (streaming && response.ok) {
          buffer = buffer.replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            consume(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
          }
          if (terminal) { await reader.cancel(); break; }
        }
      }
      buffer += decoder.decode();
      if (streaming && response.ok && buffer.trim()) consume(buffer);
    } finally { await reader.cancel().catch(() => {}); }
    if (!response.ok) {
      let message = 'Non-JSON provider error';
      try {
        const data = JSON.parse(buffer);
        message = typeof data.error === 'string' ? data.error
          : data.error?.message ?? data.message ?? data.detail ?? 'JSON provider error without a recognized message';
      } catch {}
      throw new Error(`HTTP ${response.status}: ${redact(message).slice(0, 400)}`);
    }
    const result = streaming ? terminal : JSON.parse(buffer);
    if (!result) throw new Error('Stream ended without a terminal response.');
    if (payload) {
      entry.response_id = result.id;
      entry.returned_model = result.model;
      entry.response_status = result.status;
      const usage = result.usage;
      if (usage) entry.usage = {
        input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.total_tokens,
        cached_input_tokens: usage.input_tokens_details?.cached_tokens,
        reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
      };
      entry.output_types = (result.output ?? []).map(x => x.type);
      if (result.error || result.status !== 'completed') throw new Error(`Response not completed: ${result.status}`);
      if (result.model !== model) throw new Error(`Returned model mismatch: ${result.model}`);
    }
    return result;
  } catch (error) {
    entry.error = redact(`${error.name}: ${error.message}`).slice(0, 500);
    throw error;
  } finally {
    clearTimeout(timeout);
    entry.elapsed_ms = Math.round(performance.now() - started);
    note({request: path, status: entry.http_status, elapsed_ms: entry.elapsed_ms, response_status: entry.response_status});
  }
}

let generations = 0;
async function generate(input, extra = {}) {
  if (++generations > 3) throw new Error('Probe generation request limit exceeded.');
  return request('/responses', {
    model, input, stream: true, store: false, max_output_tokens: 512,
    reasoning: {effort: 'low'}, include: ['reasoning.encrypted_content'], ...extra,
  });
}

try {
  if (!responsesOnly) {
    const models = await request('/models');
    const ids = (models.data ?? []).map(x => x.id);
    report.available_model_ids = ids;
    check('authentication_and_requested_model_listed', ids.includes(model));
  }

  const text = await generate([{role: 'user', content: 'Reply with USER_ONLY.'}], {
    instructions: 'Connectivity test. Regardless of the user message, reply with exactly AIRLINE_CONNECT_OK and nothing else.',
  });
  check('text_and_instructions', textOf(text) === 'AIRLINE_CONNECT_OK', {output_text: textOf(text)});

  const tools = [{
    type: 'function', name: 'get_probe_status', description: 'Read the current status of the local airline integration probe.',
    strict: true, parameters: {type: 'object', properties: {scope: {type: 'string', enum: ['airline']}}, required: ['scope'], additionalProperties: false},
  }];
  const input = [{role: 'user', content: 'Check the airline integration status with the provided tool. After the tool returns, reply with only the exact receipt value from its output.'}];
  const instructions = 'You are testing a read-only function-call round trip. Use the specified tool and then return its receipt exactly. Never invent a receipt.';
  const callResponse = await generate(input, {instructions, tools, tool_choice: {type: 'function', name: 'get_probe_status'}, parallel_tool_calls: false});
  const calls = callResponse.output.filter(x => x.type === 'function_call');
  check('structured_function_call', calls.length === 1 && calls[0].name === 'get_probe_status' && typeof calls[0].call_id === 'string');
  const call = calls[0];
  const args = JSON.parse(call.arguments);
  check('function_arguments', args.scope === 'airline' && Object.keys(args).length === 1);
  // Deliberately generated only after receiving the call, so the model must use the tool result.
  const receipt = `LOCAL_TOOL_${randomUUID()}`;
  const toolResult = {status: 'ok', scope: 'airline', receipt, simulated: true};
  const finalResponse = await generate([
    ...input, ...callResponse.output,
    {type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(toolResult)},
  ], {instructions, tools, tool_choice: 'none'});
  check('function_output_round_trip', textOf(finalResponse) === receipt, {
    tool: call.name, tool_arguments: args, expected_receipt: receipt, output_text: textOf(finalResponse),
  });
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = redact(`${error.name}: ${error.message}`).slice(0, 500);
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  report.generation_requests_attempted = generations;
  report.usage_totals = report.requests.reduce((a, r) => {
    if (r.usage) for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) a[field] += r.usage[field] ?? 0;
    return a;
  }, {input_tokens: 0, output_tokens: 0, total_tokens: 0});
  await mkdir(new URL('../evals/provider/', import.meta.url), {recursive: true});
  const filename = `rightcodes-${report.started_at.replaceAll(':', '-')}.json`;
  await writeFile(new URL(`../evals/provider/${filename}`, import.meta.url), redact(JSON.stringify(report, null, 2)) + '\n');
  note({status: report.status, error: report.error, usage: report.usage_totals, evidence: `evals/provider/${filename}`});
}
