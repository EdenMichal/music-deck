/**
 * Undo and redo for the GM's removes in the Music Deck tab (a queue track, an ambient layer, an SFX pad).
 * It's this browser's own history: it isn't saved, and it's cleared on reload.
 */

export interface Step {
  /** What was done, for the footer and tooltips, e.g. `Removed "Tavern" from Deck A`. */
  label: string;
  undo(): Promise<unknown>;
  redo(): Promise<unknown>;
}

export const HISTORY_HOOK = "musicDeck.history";

export class History {
  #done: Step[] = [];
  #undone: Step[] = [];
  #busy = false;

  constructor(private readonly limit = 25, private readonly changed: () => void = () => {}) {}

  get canUndo(): boolean { return this.#done.length > 0; }
  get canRedo(): boolean { return this.#undone.length > 0; }
  /** The step Undo would reverse. */
  get nextUndo(): Step | undefined { return this.#done.at(-1); }
  /** The step Redo would repeat. */
  get nextRedo(): Step | undefined { return this.#undone.at(-1); }

  /** Record a step that has just been done. A new step clears what could be redone. */
  push(step: Step): void {
    this.#done.push(step);
    if (this.#done.length > this.limit) this.#done.shift();
    this.#undone = [];
    this.changed();
  }

  /** Reverse the latest step. False if there was nothing to undo, or it failed (the step is then dropped). */
  undo(): Promise<boolean> {
    return this.#run(this.#done, this.#undone, s => s.undo());
  }

  /** Repeat the latest undone step. */
  redo(): Promise<boolean> {
    return this.#run(this.#undone, this.#done, s => s.redo());
  }

  async #run(from: Step[], to: Step[], fn: (s: Step) => Promise<unknown>): Promise<boolean> {
    if (this.#busy) return false;
    const step = from.pop();
    if (!step) return false;
    this.#busy = true;
    try {
      await fn(step);
      to.push(step);
      return true;
    } catch (err) {
      console.warn("Music Deck | couldn't undo or redo", step.label, err);
      return false;
    } finally {
      this.#busy = false;
      this.changed();
    }
  }
}
