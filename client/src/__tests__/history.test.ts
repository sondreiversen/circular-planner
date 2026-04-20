import { History } from '../history';

describe('History', () => {
  function makeCmd(label: string, log: string[]) {
    return {
      label,
      do: () => log.push(`do:${label}`),
      undo: () => log.push(`undo:${label}`),
    };
  }

  test('push and undo executes undo callback', () => {
    const h = new History();
    const log: string[] = [];
    h.push(makeCmd('A', log));
    const cmd = h.undo();
    expect(cmd?.label).toBe('A');
    expect(log).toEqual(['undo:A']);
  });

  test('redo after undo re-executes do callback', () => {
    const h = new History();
    const log: string[] = [];
    h.push(makeCmd('A', log));
    h.undo();
    const cmd = h.redo();
    expect(cmd?.label).toBe('A');
    expect(log).toEqual(['undo:A', 'do:A']);
  });

  test('push after undo clears redo stack', () => {
    const h = new History();
    const log: string[] = [];
    h.push(makeCmd('A', log));
    h.undo();
    h.push(makeCmd('B', log));
    expect(h.canRedo()).toBe(false);
  });

  test('undo on empty stack returns null', () => {
    const h = new History();
    expect(h.undo()).toBeNull();
  });

  test('redo on empty stack returns null', () => {
    const h = new History();
    expect(h.redo()).toBeNull();
  });

  test('clear resets both stacks', () => {
    const h = new History();
    const log: string[] = [];
    h.push(makeCmd('A', log));
    h.clear();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });

  test('stack capped at 50 entries', () => {
    const h = new History();
    for (let i = 0; i < 60; i++) h.push({ label: `cmd${i}`, do: () => {}, undo: () => {} });
    // Only the last 50 should remain; undo 50 times should succeed
    let count = 0;
    while (h.canUndo()) { h.undo(); count++; }
    expect(count).toBe(50);
  });

  test('push during undo is ignored (executing guard)', () => {
    const h = new History();
    const log: string[] = [];
    let innerPushed = false;
    h.push({
      label: 'outer',
      do: () => {},
      undo: () => {
        // Attempt to push inside undo — must be ignored
        h.push({ label: 'inner', do: () => {}, undo: () => {} });
        innerPushed = true;
      },
    });
    h.undo();
    expect(innerPushed).toBe(true);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);
  });

  test('multiple undo/redo in sequence', () => {
    const h = new History();
    const log: string[] = [];
    h.push(makeCmd('A', log));
    h.push(makeCmd('B', log));
    h.push(makeCmd('C', log));
    h.undo(); // undo C
    h.undo(); // undo B
    h.redo(); // redo B
    expect(log).toEqual(['undo:C', 'undo:B', 'do:B']);
  });
});
