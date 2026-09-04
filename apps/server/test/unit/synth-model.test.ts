import { describe, it, expect, afterEach } from "vitest";
import { config } from "../../src/core/platform/config.ts";

const SAVE = { synth: process.env.GALEED_SYNTH_MODEL, api: process.env.ANTHROPIC_MODEL };
afterEach(() => {
  if (SAVE.synth == null) delete process.env.GALEED_SYNTH_MODEL; else process.env.GALEED_SYNTH_MODEL = SAVE.synth;
  if (SAVE.api == null) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = SAVE.api;
});

describe("config().synthModel (M17 right-size)", () => {
  it("usa GALEED_SYNTH_MODEL quando setado", () => {
    process.env.GALEED_SYNTH_MODEL = "claude-sonnet-4-6";
    expect(config().synthModel).toBe("claude-sonnet-4-6");
  });
  it("sem a env, cai no fallback apiModel (não quebra)", () => {
    delete process.env.GALEED_SYNTH_MODEL;
    const c = config();
    expect(c.synthModel).toBe(c.apiModel);
  });
});
