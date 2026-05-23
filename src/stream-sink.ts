import { attachCursorMeta } from "./cursor-meta.js";
import type { CursorMetaAccumulator } from "./cursor-meta.js";
import type { ChatCompletionChunk } from "./openai.js";
import { finishChunk, roleChunk, type StreamState } from "./stream.js";

export type ChatChunkWriter = (
  chunk: ChatCompletionChunk | "[DONE]",
  headers: Record<string, string>,
) => Promise<void>;

interface ChatStreamSink {
  begin(): Promise<void>;
  writeDelta(chunk: ChatCompletionChunk): Promise<void>;
  complete(): Promise<void>;
  fail(): Promise<void>;
}

const noopStreamSink: ChatStreamSink = {
  async begin() {},
  async writeDelta() {},
  async complete() {},
  async fail() {},
};

export class ChatCompletionStreamSink implements ChatStreamSink {
  private roleSent = false;
  private started = false;
  private closed = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly write: ChatChunkWriter,
    private readonly state: StreamState,
    private readonly cursorMeta: CursorMetaAccumulator,
  ) {}

  async begin(): Promise<void> {
    return this.enqueue(() => this.beginNow());
  }

  async writeDelta(chunk: ChatCompletionChunk): Promise<void> {
    return this.enqueue(() => this.writeDeltaNow(chunk));
  }

  async complete(): Promise<void> {
    return this.enqueue(() => this.completeNow());
  }

  async fail(): Promise<void> {
    return this.enqueue(() => this.failNow());
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.pending.catch(() => {}).then(operation);
    this.pending = run;
    return run;
  }

  private async beginNow(): Promise<void> {
    if (this.closed) return;
    if (this.roleSent) return;
    await this.emit(roleChunk(this.state));
    this.roleSent = true;
  }

  private async writeDeltaNow(chunk: ChatCompletionChunk): Promise<void> {
    if (this.closed) return;
    await this.beginNow();
    await this.emit(chunk);
  }

  private async completeNow(): Promise<void> {
    if (this.closed) return;
    await this.beginNow();
    await this.emit(finishChunk(this.state, "stop"));
    this.closed = true;
    await this.write("[DONE]", this.cursorMeta.headers());
  }

  private async failNow(): Promise<void> {
    if (this.closed) return;
    const hadStarted = this.started;
    try {
      if (!this.roleSent) await this.beginNow();
      if (hadStarted) {
        await this.emit(finishChunk(this.state, "stop"));
        await this.write("[DONE]", this.cursorMeta.headers());
      }
    } catch {
      /* client disconnected */
    } finally {
      this.closed = true;
    }
  }

  private async emit(chunk: ChatCompletionChunk): Promise<void> {
    this.cursorMeta.mergeFromStream(this.state);
    this.started = true;
    await this.write(
      attachCursorMeta(chunk, this.cursorMeta.snapshot()),
      this.cursorMeta.headers(),
    );
  }
}

export function createStreamSink(
  write: ChatChunkWriter | undefined,
  state: StreamState,
  cursorMeta: CursorMetaAccumulator,
): ChatStreamSink {
  return write
    ? new ChatCompletionStreamSink(write, state, cursorMeta)
    : noopStreamSink;
}
