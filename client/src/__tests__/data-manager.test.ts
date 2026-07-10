import { PlannerConfig, PlannerData } from '../types';

// Mock api-client entirely so we never touch fetch/DOM/toast — DataManager
// only needs `api.put` to be an observable, controllable async function.
jest.mock('../api-client', () => ({
  api: { put: jest.fn() },
}));

import { api } from '../api-client';
import { DataManager } from '../data-manager';

const mockPut = api.put as jest.Mock;

function makeConfig(): PlannerConfig {
  return {
    plannerId: 1,
    title: 'Test',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    isOwner: true,
    permission: 'owner',
    isPublic: false,
  };
}

/** Build minimal-but-valid PlannerData with one lane whose name identifies which payload this is. */
function makeData(tag: string): PlannerData {
  return {
    lanes: [
      {
        id: `lane-${tag}`,
        name: `lane-${tag}`,
        order: 0,
        color: '#ffffff',
        activities: [],
      },
    ],
  };
}

/** A promise plus externally-callable resolve/reject, for controlling exactly when a mocked `api.put` settles. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function laneNameSentTo(callIndex: number): string {
  const body = mockPut.mock.calls[callIndex][1] as { lanes: Array<{ name: string }> };
  return body.lanes[0].name;
}

describe('DataManager', () => {
  beforeEach(() => {
    mockPut.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('scheduleSave debounces multiple calls into a single PUT with the latest data', async () => {
    jest.useFakeTimers();
    mockPut.mockResolvedValue({ success: true, updated_at: 't1' });
    const dm = new DataManager(makeConfig());

    dm.scheduleSave(makeData('a'));
    jest.advanceTimersByTime(400);
    dm.scheduleSave(makeData('b'));
    jest.advanceTimersByTime(799);
    expect(mockPut).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);

    // Let the microtask queue (the async save()) drain under fake timers.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(laneNameSentTo(0)).toBe('lane-b');
  });

  test('isDirty() is true while a debounce timer is pending and false once the save succeeds', async () => {
    jest.useFakeTimers();
    mockPut.mockResolvedValue({ success: true, updated_at: 't1' });
    const dm = new DataManager(makeConfig());

    expect(dm.isDirty()).toBe(false);
    dm.scheduleSave(makeData('a'));
    expect(dm.isDirty()).toBe(true);

    jest.advanceTimersByTime(800);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(dm.isDirty()).toBe(false);
  });

  test('save() while a PUT is in flight stashes the latest data instead of firing a second concurrent PUT', async () => {
    const first = deferred<{ success: boolean; updated_at?: string }>();
    mockPut.mockReturnValueOnce(first.promise);
    const dm = new DataManager(makeConfig());

    // Kick off the first save; it starts the PUT and is now "in flight".
    const p1 = dm.save(makeData('a'));
    expect(mockPut).toHaveBeenCalledTimes(1);

    // Two more saves arrive while the first is still in flight — neither should
    // fire a new PUT; only the latest payload should be remembered. These calls
    // take the early-return "stash and wait" path, so they settle on their own
    // without waiting on the in-flight PUT — safe to await directly.
    await dm.save(makeData('b'));
    await dm.save(makeData('c'));
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(dm.isDirty()).toBe(true);

    // Prepare the follow-up PUT triggered once the in-flight one resolves.
    const second = deferred<{ success: boolean; updated_at?: string }>();
    mockPut.mockReturnValueOnce(second.promise);

    first.resolve({ success: true, updated_at: 't1' });

    // Let the in-flight save's continuation (and its "finally" follow-up-save
    // kickoff) run, WITHOUT awaiting p1 itself yet — p1 won't settle until the
    // follow-up save (chained inside performSave's finally) also settles, and
    // that follow-up is waiting on `second`, which we haven't resolved yet.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The follow-up save (with the latest stashed data, "c") should now have fired.
    expect(mockPut).toHaveBeenCalledTimes(2);
    expect(laneNameSentTo(1)).toBe('lane-c');
    // Not yet resolved, so still dirty/saving.
    expect(dm.isDirty()).toBe(true);

    second.resolve({ success: true, updated_at: 't2' });
    await p1;

    expect(mockPut).toHaveBeenCalledTimes(2);
    expect(dm.isDirty()).toBe(false);
  });

  test('a failed save emits "error" and leaves isDirty() true', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockPut.mockRejectedValueOnce(new Error('Request failed: 500'));
    const dm = new DataManager(makeConfig());
    const errorHandler = jest.fn();
    dm.on('error', errorHandler);

    await dm.save(makeData('a'));

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(dm.isDirty()).toBe(true);
    consoleSpy.mockRestore();
  });

  test('a conflict error (409) emits "conflict" instead of "error"', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockPut.mockRejectedValueOnce(new Error('conflict: planner modified elsewhere'));
    const dm = new DataManager(makeConfig());
    const conflictHandler = jest.fn();
    const errorHandler = jest.fn();
    dm.on('conflict', conflictHandler);
    dm.on('error', errorHandler);

    await dm.save(makeData('a'));

    expect(conflictHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
