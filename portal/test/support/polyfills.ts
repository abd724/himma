// jsdom does not provide the encoding, stream, or Fetch API globals React
// Router v7 relies on; bridge them from Node. Encoding and streams must land
// before undici (Node's own fetch implementation) loads — hence the require.
import { Blob, File } from 'node:buffer';
import { ReadableStream, TransformStream, WritableStream } from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';
import { MessagePort } from 'node:worker_threads';

// NOTE: never bridge MessageChannel from node:worker_threads — a constructed
// channel holds the Node event loop open (React's scheduler would build one)
// and Jest stops exiting. The bare MessagePort CLASS is safe: undici only
// needs it for type checks and no port instance is ever created.
const target = globalThis as Record<string, unknown>;
target['TextEncoder'] ??= TextEncoder;
target['TextDecoder'] ??= TextDecoder;
target['ReadableStream'] ??= ReadableStream;
target['WritableStream'] ??= WritableStream;
target['TransformStream'] ??= TransformStream;
target['Blob'] ??= Blob;
target['File'] ??= File;
target['MessagePort'] ??= MessagePort;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const undici = require('undici') as Record<string, unknown>;

for (const name of ['fetch', 'FormData', 'Headers', 'Request', 'Response']) {
  target[name] ??= undici[name];
}
