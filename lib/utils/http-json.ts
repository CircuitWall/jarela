export interface CappedResponseText {
  text: string;
  bytesRead: number;
  truncated: boolean;
}

// Node's fetch decodes correctly labelled gzip responses. Some upstreams
// omit Content-Encoding, so detect and decode raw gzip bodies as a fallback.
export async function readResponseTextCapped(
  res: Response,
  maxBytes: number,
): Promise<CappedResponseText> {
  if (!res.body) {
    const text = await res.text();
    const bytes = new TextEncoder().encode(text);
    return {
      text: new TextDecoder().decode(bytes.subarray(0, maxBytes)),
      bytesRead: Math.min(bytes.length, maxBytes),
      truncated: bytes.length > maxBytes,
    };
  }

  const sourceReader = res.body.getReader();
  const prefix: Uint8Array[] = [];
  let prefixBytes = 0;
  let sourceDone = false;
  while (prefixBytes < 2) {
    const next = await sourceReader.read();
    if (next.done) {
      sourceDone = true;
      break;
    }
    if (next.value.byteLength === 0) continue;
    prefix.push(next.value);
    prefixBytes += next.value.byteLength;
  }

  const signature = new Uint8Array(2);
  let signatureBytes = 0;
  for (const chunk of prefix) {
    const take = Math.min(signature.length - signatureBytes, chunk.byteLength);
    signature.set(chunk.subarray(0, take), signatureBytes);
    signatureBytes += take;
    if (signatureBytes === signature.length) break;
  }
  const isGzip = signatureBytes === 2 && signature[0] === 0x1f && signature[1] === 0x8b;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of prefix) controller.enqueue(chunk);
      if (sourceDone) controller.close();
    },
    async pull(controller) {
      const next = await sourceReader.read();
      if (next.done) controller.close();
      else if (next.value) controller.enqueue(next.value);
    },
    cancel(reason) {
      return sourceReader.cancel(reason);
    },
  });
  const gunzip = new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
  const decoded = isGzip ? source.pipeThrough(gunzip) : source;
  const reader = decoded.getReader();
  const limit = Math.max(0, Math.floor(maxBytes));
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value.byteLength) continue;
      const remaining = limit - bytesRead;
      const kept = Math.min(remaining, next.value.byteLength);
      if (kept > 0) chunks.push(next.value.subarray(0, kept));
      bytesRead += kept;
      if (kept < next.value.byteLength) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } catch (error) {
    if (isGzip) throw new Error("Gzip response could not be decompressed.", { cause: error });
    throw error;
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytesRead);
  return { text: new TextDecoder().decode(bytes), bytesRead, truncated };
}

export async function readResponseText(res: Response): Promise<string> {
  return (await readResponseTextCapped(res, Number.MAX_SAFE_INTEGER)).text;
}

export async function readJsonResponse<T>(res: Response): Promise<T> {
  return JSON.parse(await readResponseText(res)) as T;
}
