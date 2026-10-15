import { describe, expect, it } from "vitest";
import hosted from "./hosted-model.json";
import { hostedFiles, STT_MODELS } from "./models";

describe("hosted speech model", () => {
  const model = STT_MODELS["moonshine-tiny"]!;

  it("serves every file the dtype mix needs, and only those", () => {
    const paths = model.hosted!.files.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        "config.json",
        "generation_config.json",
        "onnx/decoder_model_merged_quantized.onnx",
        "onnx/encoder_model_fp16.onnx",
        "preprocessor_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
      ].sort(),
    );
    expect(hosted.files.map((f) => f.path).sort()).toEqual(paths);
  });

  it("pins every file", () => {
    for (const file of hosted.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.size).toBeGreaterThan(0);
    }
    expect(hosted.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(hosted.dir).toContain(hosted.revision.slice(0, 7));
  });

  it("maps dtypes to transformers.js file names", () => {
    expect(hostedFiles({ encoder_model: "fp16", decoder_model_merged: "q8" }).map((f) => f.path)).toContain("onnx/encoder_model_fp16.onnx");
    expect(model.downloadMb).toBeGreaterThan(35);
    expect(model.downloadMb).toBeLessThan(50);
  });
});
