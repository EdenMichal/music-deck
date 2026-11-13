/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WARMUP_FRAMES, indexAudio, planRegions, sliceFor, wavRange } from "../src/audio-regions";

// 3 s of a 440 Hz tone, made with ffmpeg: fragmented and plain M4A (AAC), MP3 (LAME, with an Info frame), WAV.
const file = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe("indexAudio", () => {
  it("reads a fragmented M4A's AAC frames (as YouTube downloads are)", () => {
    const x = indexAudio(file("tone-frag.m4a"))!;
    expect(x).toMatchObject({ kind: "aac", sampleRate: 44100, channels: 2, objectType: 2, sfIndex: 4, samplesPerFrame: 1024 });
    if (x.kind !== "aac") throw new Error();
    expect(x.frames).toHaveLength(131); // ffprobe -count_packets
  });

  it("reads a plain M4A's sample table, and agrees with the fragmented one", () => {
    const plain = indexAudio(file("tone.m4a"))!, frag = indexAudio(file("tone-frag.m4a"))!;
    if (plain.kind !== "aac" || frag.kind !== "aac") throw new Error();
    expect(plain.frames).toHaveLength(131);
    expect(plain.frames.map(f => f.size)).toEqual(frag.frames.map(f => f.size));
  });

  it("reads an MP3's frames and keeps its Info frame apart", () => {
    const x = indexAudio(file("tone.mp3"))!;
    if (x.kind !== "mp3") throw new Error("not mp3");
    expect(x).toMatchObject({ sampleRate: 44100, samplesPerFrame: 1152 });
    expect(x.header).not.toBeNull();
    expect(x.frames).toHaveLength(116); // ffprobe -count_packets (the Info frame isn't a packet)
  });

  it("reads a WAV's format and samples", () => {
    const b = file("tone.wav");
    const x = indexAudio(b)!;
    if (x.kind !== "wav") throw new Error();
    expect(x).toMatchObject({ sampleRate: 22050, channels: 1, format: 1, bitsPerSample: 16 });
    const [ch] = wavRange(b, x, 1, 1.01);
    expect(ch).toHaveLength(221);
    // A 440 Hz sine: the sample 1 s in is sin(2π·440·1) ≈ 0, and the peak is under 1.
    expect(Math.abs(ch[0])).toBeLessThan(0.02);
    expect(Math.max(...ch.map(Math.abs))).toBeLessThan(1);
  });

  it("refuses what it can't cut", () => {
    expect(indexAudio(new TextEncoder().encode("OggS........ not supported"))).toBeNull();
  });
});

describe("sliceFor", () => {
  it("wraps AAC frames in ADTS headers, starting WARMUP_FRAMES early", () => {
    const b = file("tone-frag.m4a");
    const x = indexAudio(b)!;
    if (x.kind !== "aac") throw new Error();
    const { bytes, startTime } = sliceFor(b, x, 1, 2);
    const j0 = Math.floor(44100 / 1024) - WARMUP_FRAMES;
    expect(startTime).toBeCloseTo((j0 * 1024) / 44100, 9);
    expect([bytes[0], bytes[1] & 0xf6]).toEqual([0xff, 0xf0]);
    const firstLen = ((bytes[3] & 3) << 11) | (bytes[4] << 3) | (bytes[5] >> 5);
    expect(firstLen).toBe(x.frames[j0].size + 7);
  });

  it("puts the MP3's Info frame first, so the decoder trims it the way it does the whole file", () => {
    const b = file("tone.mp3");
    const x = indexAudio(b)!;
    if (x.kind !== "mp3") throw new Error();
    const { bytes } = sliceFor(b, x, 1, 2);
    expect(Array.from(bytes.subarray(0, x.header!.size))).toEqual(Array.from(b.subarray(x.header!.offset, x.header!.offset + x.header!.size)));
  });
});

describe("planRegions", () => {
  it("widens each cue for seams and ring-outs, clamps to the file and merges near neighbours", () => {
    const cues = [{ start: 0, end: 20 }, { start: 22, end: 30 }, { start: 367, end: 724 }];
    expect(planRegions(cues, 3638, 2, 4)).toEqual([[0, 34], [365, 728]]);
    expect(planRegions([{ start: 3630, end: 3638 }], 3638, 2, 4)).toEqual([[3628, 3638]]);
  });
});
