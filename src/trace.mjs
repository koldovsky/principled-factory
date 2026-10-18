// Tracing (principle 6.1): spans shaped after the OpenTelemetry GenAI conventions, one JSONL file per run.
// Content (prompts, tool arguments) is not captured unless the factory config opts in.
import crypto from 'node:crypto';
import path from 'node:path';
import { appendJsonLine, readJsonLines } from './util.mjs';
import { runDir } from './store.mjs';

export const traceFile = (store, runId) => path.join(runDir(store, runId), 'trace.jsonl');

export async function span(store, runId, name, kind, attributes, fn, parentId = null) {
  const spanId = crypto.randomBytes(8).toString('hex');
  const start = Date.now();
  let status = 'ok';
  let extra = {};
  try {
    const result = await fn({ spanId, set: (attrs) => { extra = { ...extra, ...attrs }; } });
    return result;
  } catch (error) {
    status = 'error';
    extra['error.message'] = error.message;
    throw error;
  } finally {
    appendJsonLine(traceFile(store, runId), {
      name, kind, spanId, parentId, runId, start: new Date(start).toISOString(), durationMs: Date.now() - start, status,
      attributes: { 'gen_ai.operation.name': kind, ...attributes, ...extra },
    });
  }
}

export function readTrace(store, runId) {
  return readJsonLines(traceFile(store, runId));
}
