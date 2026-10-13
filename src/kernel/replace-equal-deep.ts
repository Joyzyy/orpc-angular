export function replaceEqualDeep<T>(previous: unknown, next: T): T {
  if (previous === next) return next;

  if (Array.isArray(previous) && Array.isArray(next)) {
    let equalItems = 0;
    const copy = next.map((item, index) => {
      const shared = replaceEqualDeep(previous[index], item);
      if (shared === previous[index]) equalItems++;
      return shared;
    });
    return (
      equalItems === previous.length && copy.length === previous.length ? previous : copy
    ) as T;
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    const nextKeys = Object.keys(next);
    let equalItems = 0;
    const copy: Record<string, unknown> = {};
    for (const key of nextKeys) {
      copy[key] = replaceEqualDeep(previous[key], next[key]);
      if (copy[key] === previous[key] && key in previous) equalItems++;
    }
    return (
      equalItems === nextKeys.length && nextKeys.length === Object.keys(previous).length
        ? previous
        : copy
    ) as T;
  }

  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
