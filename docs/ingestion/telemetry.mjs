const events = [];

export function track(eventType, details = {}) {
  const event = {
    eventType,
    occurredAt: new Date().toISOString(),
    ...details,
  };
  events.push(event);
  globalThis.dispatchEvent?.(new CustomEvent('parcel-ingestion-telemetry', { detail: event }));
  return event;
}

export function telemetrySnapshot() {
  return events.map(event => ({ ...event }));
}

export function clearTelemetry() {
  events.length = 0;
}
