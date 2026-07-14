import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const lightning = createOpenAICompatible({
  name: "lightning",
  baseURL: "https://lightning.ai/api/v1",
  apiKey: process.env.LIGHTNING_API_KEY ?? process.env.LIGTNING_API_KEY,
  // Lightning's GPT endpoint uses the newer OpenAI completion field.
  transformRequestBody(body) {
    const { max_tokens, ...rest } = body;
    return {
      ...rest,
      ...(max_tokens === undefined
        ? {}
        : { max_completion_tokens: max_tokens }),
    };
  },
});

export default defineAgent({
  model: lightning(
    process.env.LIGHTNING_MODEL ?? "openai/gpt-5.4-mini-2026-03-17",
  ),
  reasoning: "low",
});
