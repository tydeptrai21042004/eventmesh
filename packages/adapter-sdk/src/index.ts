import type { SignedEvent, TranscriptExport } from "@eventmesh/core";

export type AdapterValidation = { ok: true } | { ok: false; reason: string };

/**
 * Deliberately small application boundary. EventMesh owns evidence transport;
 * an adapter owns only application semantics and deterministic final-state
 * derivation. It must not introduce wallet, routing, escrow, or consensus logic.
 */
export interface EventMeshAdapter<TState = unknown> {
  name: string;
  eventTypes: readonly string[];
  validateEvent(event: SignedEvent): AdapterValidation;
  deriveFinalState(transcript: TranscriptExport): TState;
}

export function validateTranscriptWithAdapter<TState>(
  transcript: TranscriptExport,
  adapter: EventMeshAdapter<TState>
): { ok: boolean; errors: string[]; finalState?: TState } {
  const errors: string[] = [];
  const allowed = new Set(adapter.eventTypes);
  for (const { event } of transcript.events) {
    if (!allowed.has(event.type)) {
      errors.push(`Adapter ${adapter.name} does not support event type ${event.type}`);
      continue;
    }
    const result = adapter.validateEvent(event);
    if (!result.ok) errors.push(`Event ${event.sequence}: ${result.reason}`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors, finalState: adapter.deriveFinalState(transcript) };
}
