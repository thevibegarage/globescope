// Some providers hand out short-lived, token-signed image URLs. For those, the
// URL stored at ingest is already stale by the time anyone looks at the camera,
// so the source registers a resolver that mints a fresh one on demand.
const resolvers = new Map();

export function registerResolver(sourceId, fn) {
  resolvers.set(sourceId, fn);
}

export function hasResolver(sourceId) {
  return resolvers.has(sourceId);
}

/** Fresh URL for this camera, or its stored one when the source needs no resolver. */
export async function resolveImageUrl(cam) {
  const fn = resolvers.get(cam.source);
  if (!fn) return cam.image_url;
  try {
    return (await fn(cam)) || cam.image_url;
  } catch {
    return cam.image_url;
  }
}
