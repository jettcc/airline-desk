import { AppError, ensure } from '../server/errors.js';
export interface ModelResult {
  output: any[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  response_id?: string;
  model: string;
  elapsed_ms: number;
  attempts?: number;
}
export interface Model {
  mode: string;
  name: string;
  respond(
    input: any[],
    instructions: string,
    tools: any[],
    signal?: AbortSignal,
  ): Promise<ModelResult>;
}
export class ModelPool {
  private active = 0;
  private waiting: {
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  constructor(
    private limit = 3,
    private maxQueue = 12,
    private waitMs = 45000,
  ) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      ensure(this.waiting.length < this.maxQueue, 'MODEL_BUSY', 503);
      await new Promise<void>((resolve, reject) => {
        const item = {
          resolve,
          reject,
          timer: setTimeout(() => {
            this.waiting = this.waiting.filter((x) => x !== item);
            reject(new AppError('MODEL_QUEUE_TIMEOUT', 503));
          }, this.waitMs),
        };
        this.waiting.push(item);
      });
    } else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      } else this.active--;
    }
  }
}
export class RightCodesModel implements Model {
  mode = 'real';
  name = 'gpt-5.6-sol';
  private pool = new ModelPool();
  constructor(
    private key: string,
    private base: string,
    private transport: typeof fetch = fetch,
  ) {
    const u = new URL(base);
    ensure(
      u.protocol === 'https:' &&
        ['www.right.codes', 'right.codes', 'www.rightapi.ai', 'rightapi.ai'].includes(u.hostname) &&
        u.pathname.replace(/\/$/, '') === '/codex/v1' &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash,
      'INVALID_MODEL_ENDPOINT',
    );
  }
  async respond(
    input: any[],
    instructions: string,
    tools: any[],
    signal?: AbortSignal,
  ): Promise<ModelResult> {
    ensure(JSON.stringify(input).length < 80000, 'CONTEXT_LIMIT');
    return this.pool.run(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          signal?.throwIfAborted();
          const started = performance.now();
          const timeout = AbortSignal.timeout(45000),
            combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
          const response = await this.transport(this.base.replace(/\/$/, '') + '/responses', {
            method: 'POST',
            redirect: 'error',
            signal: combined,
            headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: this.name,
              stream: true,
              store: false,
              input,
              instructions,
              tools,
              tool_choice: 'required',
              parallel_tool_calls: false,
              max_output_tokens: 1400,
              reasoning: { effort: 'low' },
              include: ['reasoning.encrypted_content'],
            }),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new AppError(
              response.status === 402 || response.status === 429
                ? 'MODEL_QUOTA_OR_RATE_LIMIT'
                : 'MODEL_UNAVAILABLE',
              503,
            );
          }
          ensure(response.body, 'MODEL_EMPTY_RESPONSE', 503);
          const reader = response.body.getReader(),
            decoder = new TextDecoder();
          let buffer = '',
            bytes = 0,
            terminal: any = null;
          const consume = (block: string) => {
            const d = block
              .split('\n')
              .filter((x) => x.startsWith('data:'))
              .map((x) => x.slice(5).trimStart())
              .join('\n');
            if (!d || d === '[DONE]') return;
            let e;
            try {
              e = JSON.parse(d);
            } catch {
              throw new AppError('MODEL_INVALID_STREAM', 503);
            }
            if (e.type === 'error' || e.type === 'response.failed' || e.error) {
              const code = String(e.error?.code ?? e.response?.error?.code ?? e.code ?? '');
              throw new AppError(
                /quota|rate_limit|insufficient|billing|credit/i.test(code)
                  ? 'MODEL_QUOTA_OR_RATE_LIMIT'
                  : 'MODEL_STREAM_FAILED',
                503,
              );
            }
            if (e.type === 'response.completed' || e.type === 'response.incomplete')
              terminal = e.response;
          };
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.length;
              ensure(bytes < 2000000, 'MODEL_RESPONSE_LIMIT', 503);
              buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
              let at;
              while ((at = buffer.indexOf('\n\n')) >= 0) {
                consume(buffer.slice(0, at));
                buffer = buffer.slice(at + 2);
              }
            }
            buffer += decoder.decode();
            if (buffer.trim()) consume(buffer);
          } finally {
            await reader.cancel().catch(() => {});
          }
          ensure(terminal?.status === 'completed' && !terminal.error, 'MODEL_INCOMPLETE', 503);
          ensure(terminal.model === this.name, 'MODEL_MISMATCH', 503);
          ensure(Array.isArray(terminal.output), 'MODEL_INVALID_OUTPUT', 503);
          const usage = terminal.usage
            ? {
                input_tokens: terminal.usage.input_tokens,
                output_tokens: terminal.usage.output_tokens,
                total_tokens: terminal.usage.total_tokens,
              }
            : undefined;
          return {
            output: terminal.output,
            attempts: attempt + 1,
            usage,
            response_id: terminal.id,
            model: terminal.model,
            elapsed_ms: Math.round(performance.now() - started),
          };
        } catch (e) {
          const transient =
            e instanceof TypeError ||
            (e instanceof Error && e.name === 'TimeoutError') ||
            (e instanceof AppError && ['MODEL_INCOMPLETE', 'MODEL_STREAM_FAILED'].includes(e.code));
          if (attempt === 0 && transient && !signal?.aborted) continue;
          if (e instanceof AppError) throw e;
          throw new AppError(
            e instanceof Error && ['AbortError', 'TimeoutError'].includes(e.name)
              ? 'MODEL_TIMEOUT'
              : 'MODEL_CONNECTION_FAILED',
            503,
          );
        }
      }
      throw new AppError('MODEL_UNAVAILABLE', 503);
    });
  }
}
export class UnconfiguredModel implements Model {
  mode = 'unconfigured';
  name = '未配置模型';
  async respond(): Promise<ModelResult> {
    throw new AppError('MODEL_NOT_CONFIGURED', 503);
  }
}
/** Explicit local test double. Never used as a real-model acceptance substitute. */
export class ScriptedModel implements Model {
  mode = 'mock';
  name = '测试替身';
  constructor(
    private script: (
      input: any[],
    ) => { name: string; args: any } | Promise<{ name: string; args: any }>,
  ) {}
  async respond(input: any[]): Promise<ModelResult> {
    const c = await this.script(input);
    return {
      output: [
        {
          type: 'function_call',
          call_id: crypto.randomUUID(),
          name: c.name,
          arguments: JSON.stringify(c.args),
        },
      ],
      model: this.name,
      elapsed_ms: 0,
    };
  }
}
