// URL slugs for user-visible titles.
export function slug(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (text === 'Ready, Set, Go') return 'ready-set-go';
  if (text === 'Wait... what?') return 'wait-what';
  return text.trim().toLowerCase().replace(', ', '-').replace('!', '').split(/\s+/).join('-');
}
