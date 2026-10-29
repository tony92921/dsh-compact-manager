/**
 * Canonical Schemastery wire envelope.
 *
 * DSH serializes a registered settings schema with `schema.toJSON()`. The
 * canonical form is `{ uid, refs }`: `refs` maps a node id to that node's
 * shallow JSON, and a parent references a child node by id (see
 * `schemastery/lib/index.mjs` `toJSON`). The plugin deliberately does not
 * depend on schemastery, so the envelope is built here from the same field
 * table the schema uses.
 *
 * `lib/ledger.test.js` proves the result round-trips through the real library
 * (rehydrate -> validate -> simplify) whenever one is resolvable.
 */

/**
 * Build the canonical envelope for a flat object schema.
 *
 * @param fields - `{ key: { type, meta } }` leaf descriptors, in display order.
 * @param rootMeta - metadata for the root object node.
 * @returns `{ uid, refs }` with the root node as `uid`.
 */
export function buildObjectEnvelope(fields, rootMeta = { default: {} }) {
  const refs = {};
  const dict = {};
  let id = 0;
  for (const [key, node] of Object.entries(fields)) {
    id += 1;
    refs[String(id)] = { type: node.type, meta: { ...node.meta } };
    dict[key] = id;
  }
  const rootId = id + 1;
  refs[String(rootId)] = { type: "object", meta: { ...rootMeta }, dict };
  return { uid: rootId, refs };
}

/** Resolve an envelope into `{ key: { type, meta } }` for comparison. */
export function flattenObjectEnvelope(envelope) {
  const root = envelope?.refs?.[String(envelope?.uid)];
  if (!root || root.type !== "object") return {};
  const fields = {};
  for (const [key, ref] of Object.entries(root.dict ?? {})) {
    const node = envelope.refs[String(ref)];
    if (node) fields[key] = { type: node.type, meta: { ...node.meta } };
  }
  return fields;
}
