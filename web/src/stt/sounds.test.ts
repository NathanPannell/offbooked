import { describe, expect, it } from "vitest";
import { soundKey, soundsAlike, soundsLikeJoined } from "./sounds";

describe("soundKey", () => {
  it("keeps the consonant sounds, voiced and unvoiced alike", () => {
    expect(soundKey("dew")).toBe(soundKey("due"));
    expect(soundKey("thought")).toBe("0T");
    expect(soundKey("knight")).toBe(soundKey("night"));
    expect(soundKey("Kind!")).toBe("KNT");
  });

  it("keeps which vowel a word starts with", () => {
    expect(soundKey("and")).toBe("ANT");
    expect(soundKey("into")).toBe("INT");
    expect(soundKey("you")).toBe("Y");
    expect(soundKey("")).toBe("");
  });
});

describe("soundsAlike", () => {
  it("hears the mishearings the speech model makes", () => {
    for (const [line, heard] of [
      ["dew", "due"],
      ["frailty", "prayalty"],
      ["the", "thy"],
      ["know", "no"],
      ["seems", "seams"],
      ["sun", "son"],
      ["solid", "salad"],
    ]) {
      expect(soundsAlike(line!, heard!), `${line} / ${heard}`).toBe(true);
    }
  });

  it("doesn't hear different words alike", () => {
    for (const [line, heard] of [
      ["and", "into"],
      ["madam", "mother"],
      ["be", "is"],
      ["love", "left"],
      ["a", "I"],
      ["an", "in"],
    ]) {
      expect(soundsAlike(line!, heard!), `${line} / ${heard}`).toBe(false);
    }
  });
});

describe("soundsLikeJoined", () => {
  it("hears two words said as one, a sound dropped at most", () => {
    expect(soundsLikeJoined("less", "than", "lesson")).toBe(true);
    expect(soundsLikeJoined("to", "morrow", "tomorrow")).toBe(true);
  });

  it("never swaps a sound, or drops a whole word", () => {
    expect(soundsLikeJoined("kin", "and", "king")).toBe(false);
    expect(soundsLikeJoined("mercy", "is", "mercy")).toBe(false);
    expect(soundsLikeJoined("summer", "by", "summer")).toBe(false);
    expect(soundsLikeJoined("into", "a", "and")).toBe(false);
  });
});
