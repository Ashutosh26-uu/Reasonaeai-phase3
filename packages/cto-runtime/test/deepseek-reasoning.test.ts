import type { CompatRule } from "@mastra/core/processors";
import { describe, expect, it } from "vitest";
import { deepseekReasoningEcho } from "../src/model/deepseek-reasoning.js";

type Prompt = Parameters<NonNullable<CompatRule["applyToPrompt"]>>[0]["prompt"];
type Part = Exclude<Prompt[number]["content"], string>[number];

const textPart: Part = { text: "read the workspace", type: "text" };
const toolCallPart: Part = {
  input: { path: "." },
  toolCallId: "call_1",
  toolName: "read",
  type: "tool-call",
};
const reasoningPart: Part = { text: "I will list it.", type: "reasoning" };

const userTurn: Prompt = [{ content: [textPart], role: "user" }];

const applyRule = (model: unknown, parts: Part[]) =>
  deepseekReasoningEcho.applyToPrompt?.({
    model,
    prompt: [...userTurn, { content: parts, role: "assistant" }],
  });

const assistantParts = (prompt: Prompt | undefined): Part[] => {
  const message = prompt?.[1];
  if (!message || typeof message.content === "string") {
    return [];
  }
  return message.content;
};

const partTypes = (prompt: Prompt | undefined): string[] =>
  assistantParts(prompt).map((part) => part.type);

describe("deepseek reasoning echo", () => {
  it("adds an empty reasoning part to a tool call that has none", () => {
    const rewritten = applyRule("deepseek/deepseek-flash", [toolCallPart]);

    expect(partTypes(rewritten)).toEqual(["reasoning", "tool-call"]);
    expect(assistantParts(rewritten)[0]).toEqual({
      text: "",
      type: "reasoning",
    });
  });

  it("matches a resolved DeepSeek model as well as a router id", () => {
    for (const model of [
      { modelId: "deepseek-flash", provider: "deepseek.chat" },
      { modelId: "deepseek-v4-flash", provider: "deepseek" },
      { modelId: "deepseek/deepseek-flash" },
      [{ model: "deepseek/deepseek-flash" }],
    ]) {
      expect(partTypes(applyRule(model, [toolCallPart]))).toEqual([
        "reasoning",
        "tool-call",
      ]);
    }
  });

  it("leaves a tool call that already carries reasoning alone", () => {
    expect(
      applyRule("deepseek/deepseek-flash", [reasoningPart, toolCallPart])
    ).toBeUndefined();
  });

  it("leaves models from other providers alone", () => {
    for (const model of [
      "openai/gpt-5",
      { modelId: "claude-sonnet-4-6", provider: "anthropic.messages" },
      { modelId: "qwen3-coder", provider: "alibaba.chat" },
    ]) {
      expect(applyRule(model, [toolCallPart])).toBeUndefined();
    }
  });

  it("covers an assistant turn without tool calls too", () => {
    expect(partTypes(applyRule("deepseek/deepseek-flash", [textPart]))).toEqual(
      ["reasoning", "text"]
    );
  });

  it("covers an assistant turn with no parts at all", () => {
    expect(partTypes(applyRule("deepseek/deepseek-flash", []))).toEqual([
      "reasoning",
    ]);
  });
});
