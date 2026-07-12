/**
 * Minimal incremental Server-Sent Events decoder.
 *
 * Feed raw network chunks; complete events are yielded as { event, data }.
 * Handles LF and CRLF framing, multi-line data fields, comment lines, and
 * events split across chunk boundaries. Fields other than `event` and `data`
 * (`id`, `retry`) are ignored because agent providers do not use them.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseDecoder {
  private buffer = "";
  private readonly textDecoder = new TextDecoder();

  /** Decode one network chunk and return every event completed by it. */
  decode(chunk: Uint8Array): SseEvent[] {
    this.buffer += this.textDecoder.decode(chunk, { stream: true });
    return this.drainCompleteEvents();
  }

  /** Flush any trailing bytes at end of stream. */
  finish(): SseEvent[] {
    this.buffer += this.textDecoder.decode();
    const events = this.drainCompleteEvents();
    const remainder = this.buffer.trim();
    this.buffer = "";
    if (!remainder) return events;
    const trailing = parseEventBlock(remainder);
    return trailing ? [...events, trailing] : events;
  }

  private drainCompleteEvents(): SseEvent[] {
    const events: SseEvent[] = [];
    for (;;) {
      const boundary = findEventBoundary(this.buffer);
      if (!boundary) break;
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const parsed = parseEventBlock(block);
      if (parsed) events.push(parsed);
    }
    return events;
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseEventBlock(block: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    let value = separator === -1 ? "" : rawLine.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return undefined;
  return { event, data: data.join("\n") };
}

/**
 * Read a streaming fetch Response body as SSE events.
 * The caller owns response validation; this throws only on read failures.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseEvent, void, void> {
  const decoder = new SseDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        for (const event of decoder.decode(value)) yield event;
      }
    }
    for (const event of decoder.finish()) yield event;
  } finally {
    reader.releaseLock();
  }
}
