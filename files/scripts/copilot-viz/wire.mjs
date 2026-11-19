import { StringDecoder } from 'node:string_decoder';

export const PROTOCOL = 1;
// A source exceeding this ceiling needs a narrower history window, not an endless retry.
export const MAX_MESSAGE = 64 * 1024 * 1024;
export const HEARTBEAT_MS = 10_000;
export const unavailable = (message) => Object.assign(new Error(message), { status: 503 });

export function encodeMessage(message) {
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line) > MAX_MESSAGE) {
    throw Object.assign(new Error('Remote snapshot exceeds 64 MiB; reduce --since and restart copilot-viz.'), { permanent: true });
  }
  return line;
}

export function readMessages(stream, onMessage, onError) {
  const decoder = new StringDecoder('utf8');
  let parts = [];
  let size = 0;
  let failed = false;
  const fail = (e) => {
    if (failed) return;
    failed = true;
    parts = [];
    onError(e);
  };
  const data = (chunk) => {
    if (failed) return;
    let from = 0;
    for (;;) {
      const end = chunk.indexOf(10, from);
      const part = chunk.subarray(from, end < 0 ? chunk.length : end);
      size += part.length;
      if (size > MAX_MESSAGE) return fail(Object.assign(new Error('Remote message exceeds 64 MiB.'), { permanent: true }));
      parts.push(decoder.write(part));
      if (end < 0) return;
      try {
        const message = JSON.parse(parts.join(''));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Expected a JSON object.');
        onMessage(message);
        if (failed) return;
      } catch (e) {
        return fail(e);
      }
      parts = [];
      size = 0;
      from = end + 1;
      if (from === chunk.length) return;
    }
  };
  stream.on('data', data);
  stream.on('error', fail);
  return () => {
    failed = true;
    parts = [];
    stream.off('data', data);
    stream.off('error', fail);
  };
}
