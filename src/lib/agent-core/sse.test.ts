import { describe, expect, it } from "vitest";
import { SseDecoder, readSseStream } from "./sse";

const encoder = new TextEncoder();

function streamOf(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

describe("SseDecoder", () => {
  it("decodes a single complete event", () => {
    const decoder = new SseDecoder();
    const events = decoder.decode(encoder.encode("event: ping\ndata: {}\n\n"));
    expect(events).toEqual([{ event: "ping", data: "{}" }]);
  });

  it("defaults the event name to message", () => {
    const decoder = new SseDecoder();
    expect(decoder.decode(encoder.encode("data: hello\n\n"))).toEqual([
      { event: "message", data: "hello" }
    ]);
  });

  it("joins multi-line data fields with newlines", () => {
    const decoder = new SseDecoder();
    expect(decoder.decode(encoder.encode("data: a\ndata: b\n\n"))).toEqual([
      { event: "message", data: "a\nb" }
    ]);
  });

  it("handles CRLF framing", () => {
    const decoder = new SseDecoder();
    expect(decoder.decode(encoder.encode("event: x\r\ndata: 1\r\n\r\n"))).toEqual([
      { event: "x", data: "1" }
    ]);
  });

  it("ignores comment lines and events without data", () => {
    const decoder = new SseDecoder();
    expect(decoder.decode(encoder.encode(": keep-alive\n\nevent: only\n\n"))).toEqual([]);
  });

  it("buffers events split across chunks, including inside multibyte characters", () => {
    const decoder = new SseDecoder();
    const bytes = encoder.encode("data: 日本語テキスト\n\n");
    const first = decoder.decode(bytes.slice(0, 9));
    const second = decoder.decode(bytes.slice(9));
    expect(first).toEqual([]);
    expect(second).toEqual([{ event: "message", data: "日本語テキスト" }]);
  });

  it("flushes a trailing block without a terminator on finish", () => {
    const decoder = new SseDecoder();
    expect(decoder.decode(encoder.encode("data: tail"))).toEqual([]);
    expect(decoder.finish()).toEqual([{ event: "message", data: "tail" }]);
  });
});

describe("readSseStream", () => {
  it("yields events across chunk boundaries", async () => {
    const stream = streamOf(["data: one\n\nda", "ta: two\n\n"]);
    const seen: string[] = [];
    for await (const event of readSseStream(stream)) seen.push(event.data);
    expect(seen).toEqual(["one", "two"]);
  });

  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const iterator = readSseStream(streamOf(["data: x\n\n"]), controller.signal);
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });
});
