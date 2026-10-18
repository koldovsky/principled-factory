// Minimal JSON-schema-like validator: type, required, properties, additionalProperties, items, enum, minItems,
// minLength, minimum. Returns a list of error strings; empty means valid.
export function validate(value, schema, at = '$') {
  const errors = [];
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t) => t === type || (t === 'integer' && Number.isInteger(value)) || (t === 'number' && type === 'number'));
    if (!ok) return [`${at}: expected ${types.join('|')}, got ${type}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${schema.enum.join(', ')}`);
  if (type === 'string' && schema.minLength && value.trim().length < schema.minLength) errors.push(`${at}: must not be empty`);
  if (type === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be ≥ ${schema.minimum}`);
  if (type === 'array') {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items, `${at}[${i}]`)));
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}.${key}: is required`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validate(value[key], sub, `${at}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in (schema.properties ?? {}))) errors.push(`${at}.${key}: is not allowed`);
    } else if (typeof schema.additionalProperties === 'object') {
      for (const [key, v] of Object.entries(value)) {
        if (!(key in (schema.properties ?? {}))) errors.push(...validate(v, schema.additionalProperties, `${at}.${key}`));
      }
    }
  }
  return errors;
}

export function assertValid(value, schema, what) {
  const errors = validate(value, schema);
  if (errors.length) {
    const error = new Error(`invalid ${what}:\n  ${errors.join('\n  ')}`);
    error.code = 'INVALID';
    error.errors = errors;
    throw error;
  }
  return value;
}
