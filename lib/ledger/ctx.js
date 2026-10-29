/** Optional Cordis lookup. Never use ctx.llm / ctx.tokenMeter without inject. */
export function getService(ctx, name) {
  if (!ctx || typeof ctx.get !== "function") return undefined;
  return ctx.get(name);
}

/**
 * Read one session event by sequence number across DSH versions.
 *
 * DSH 0.1.5 removed the public `session.events` accessor in favour of
 * `session.eventAt(seq)`; earlier releases only exposed the event array.
 * Both shapes are read here so one plugin build spans the rename.
 */
export function sessionEvent(session, seq) {
  if (!session) return undefined;
  if (typeof session.eventAt === "function") return session.eventAt(seq);
  const events = session.events;
  if (Array.isArray(events)) return events[seq];
  return events?.[seq];
}

/** Whether this session exposes the 0.1.5+ event accessor. */
export function hasEventAccessor(session) {
  return typeof session?.eventAt === "function";
}
