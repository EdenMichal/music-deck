import { describe, expect, it } from "vitest";
import { encodePath } from "../src/ui/peaks";

describe("encodePath", () => {
  it("encodes a plain path", () => {
    expect(encodePath("music/Vibe Music/Tense Expedition.mp3")).toBe("music/Vibe%20Music/Tense%20Expedition.mp3");
  });

  it("leaves a path Foundry already encoded as it is, instead of encoding it twice", () => {
    expect(encodePath("music/Vibe%20Music/Tense%20Expedition.mp3")).toBe("music/Vibe%20Music/Tense%20Expedition.mp3");
  });

  it("handles names with characters that need encoding", () => {
    expect(encodePath("music/Rock & Roll/Track #1.mp3")).toBe("music/Rock%20%26%20Roll/Track%20%231.mp3");
    expect(encodePath("music/Rock%20%26%20Roll/Track%20%231.mp3")).toBe("music/Rock%20%26%20Roll/Track%20%231.mp3");
  });

  it("keeps a stray % that isn't an escape", () => {
    expect(encodePath("music/100% Epic.mp3")).toBe("music/100%25%20Epic.mp3");
  });
});
