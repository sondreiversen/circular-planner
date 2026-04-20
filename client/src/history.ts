/**
 * Command-object history stack for undo/redo.
 * Capped at MAX_STACK entries.
 */

export interface HistoryCommand {
  label: string;
  do: () => void;
  undo: () => void;
}

const MAX_STACK = 50;

export class History {
  private undoStack: HistoryCommand[] = [];
  private redoStack: HistoryCommand[] = [];
  /** Set to true while executing undo/redo so push() is ignored. */
  private executing = false;

  push(cmd: HistoryCommand): void {
    if (this.executing) return;
    this.undoStack.push(cmd);
    if (this.undoStack.length > MAX_STACK) this.undoStack.shift();
    // A new action invalidates the redo branch
    this.redoStack = [];
  }

  undo(): HistoryCommand | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    this.executing = true;
    try {
      cmd.undo();
    } finally {
      this.executing = false;
    }
    this.redoStack.push(cmd);
    return cmd;
  }

  redo(): HistoryCommand | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    this.executing = true;
    try {
      cmd.do();
    } finally {
      this.executing = false;
    }
    this.undoStack.push(cmd);
    return cmd;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
}
