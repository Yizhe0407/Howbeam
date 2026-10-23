import { describe, expect, it } from 'vitest';
import { reorderById } from '@/lib/editor/dnd';

describe('reorderById', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const getId = (item: { id: string }) => item.id;

  it('moves the active item to the hovered position', () => {
    expect(reorderById(items, 'a', 'c', getId)?.map(getId)).toEqual(['b', 'c', 'a']);
  });

  it('ignores no-op and stale drop targets', () => {
    expect(reorderById(items, 'a', 'a', getId)).toBeNull();
    expect(reorderById(items, 'a', undefined, getId)).toBeNull();
    expect(reorderById(items, 'missing', 'b', getId)).toBeNull();
  });
});
