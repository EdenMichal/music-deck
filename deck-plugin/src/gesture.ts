/**
 * Dial 1's press rules: a plain press mutes; press + turn switches mode, at most once
 * per press. Stream Deck marks turns made while the dial is held with `pressed: true`, so the press
 * is only judged on release.
 */
export type DialMode = "fade" | "volume";

export const otherMode = (mode: DialMode): DialMode => (mode === "fade" ? "volume" : "fade");

export class PressTurn {
  #held = false;
  #switched = false;

  down(): void {
    this.#held = true;
    this.#switched = false;
  }

  /** "switch" the first time a held dial turns, "ignore" for the rest of that press, "turn" otherwise. */
  rotate(pressed: boolean): "turn" | "switch" | "ignore" {
    if (!pressed) return "turn";
    // A held turn can arrive without its dialDown, e.g. right after the plugin restarts.
    this.#held = true;
    if (this.#switched) return "ignore";
    this.#switched = true;
    return "switch";
  }

  /** "press" when the dial went down and up without turning. */
  up(): "press" | "none" {
    const press = this.#held && !this.#switched;
    this.#held = false;
    this.#switched = false;
    return press ? "press" : "none";
  }
}
