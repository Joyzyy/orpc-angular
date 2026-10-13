import { describe, expect, it } from 'vitest';
import { replaceEqualDeep } from './replace-equal-deep';

describe('replaceEqualDeep', () => {
  it('returns the previous value when nothing changed', () => {
    const previous = { a: 1, list: [{ id: 1 }, { id: 2 }], nested: { x: null } };
    const next = structuredClone(previous);

    expect(replaceEqualDeep(previous, next)).toBe(previous);
  });

  it('keeps unchanged subtrees and replaces only the changed path', () => {
    const previous = {
      list: [
        { id: 1, text: 'a' },
        { id: 2, text: 'b' },
      ],
      meta: { page: 1 },
    };
    const next = {
      list: [
        { id: 1, text: 'a' },
        { id: 2, text: 'B' },
      ],
      meta: { page: 1 },
    };

    const result = replaceEqualDeep(previous, next);

    expect(result).toEqual(next);
    expect(result).not.toBe(previous);
    expect(result.list[0]).toBe(previous.list[0]);
    expect(result.list[1]).not.toBe(previous.list[1]);
    expect(result.meta).toBe(previous.meta);
  });

  it('detects added, removed and appended entries', () => {
    const previous = { list: [1, 2], a: 1 };

    expect(replaceEqualDeep(previous, { list: [1, 2, 3], a: 1 }).list).toEqual([1, 2, 3]);
    expect(replaceEqualDeep(previous, { list: [1], a: 1 }).list).toEqual([1]);
    expect(replaceEqualDeep(previous, { list: [1, 2] })).toEqual({ list: [1, 2] });
    expect(replaceEqualDeep(previous, { list: [1, 2], a: 1, b: undefined })).not.toBe(previous);
  });

  it('never shares across shape changes', () => {
    expect(replaceEqualDeep({ a: 1 }, [1])).toEqual([1]);
    expect(replaceEqualDeep([1], { 0: 1 })).toEqual({ 0: 1 });
    expect(replaceEqualDeep(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});
