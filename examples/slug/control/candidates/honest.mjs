// URL slugs for user-visible titles.
export function slug(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  return text.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
}
