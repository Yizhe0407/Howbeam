/** `items[index]`, failing the test when there is no such item. */
export function itemAt<T>(items: ArrayLike<T>, index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Expected an item at index ${index}, but there are ${items.length}.`);
  return item;
}

type Tuple<T, N extends number, Items extends T[] = []> = Items['length'] extends N ? Items : Tuple<T, N, [...Items, T]>;

/** The first `count` items, failing the test when there are fewer. */
export function firstItems<T, N extends number>(items: ArrayLike<T>, count: N): Tuple<T, N> {
  return Array.from({ length: count }, (_, index) => itemAt(items, index)) as Tuple<T, N>;
}

/** `record[key]`, failing the test when there is no such key. */
export function valueAt<T>(record: Readonly<Record<string, T>>, key: string): T {
  const value = record[key];
  if (value === undefined) throw new Error(`Expected a value for "${key}".`);
  return value;
}
