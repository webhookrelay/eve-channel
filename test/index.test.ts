import { describe, expect, it, vi } from "vitest";

import { provisionWebhookRelay, webhookRelayChannel } from "../src/index.js";

function fakeRelay(overrides: Record<string, unknown> = {}) {
  const bucket = {
    id: "bucket-1",
    name: "eve-demo",
    inputs: [],
    outputs: [],
  };

  return {
    buckets: {
      findByName: vi.fn().mockResolvedValue(overrides.bucket ?? undefined),
      list: vi.fn().mockResolvedValue([bucket]),
      create: vi.fn().mockResolvedValue(bucket),
      get: vi.fn().mockResolvedValue(overrides.fullBucket ?? bucket),
    },
    inputs: {
      create: vi.fn().mockResolvedValue({ id: "input-1", name: "eve" }),
      endpointUrl: vi
        .fn()
        .mockReturnValue("https://hooks.webhookrelay.com/input-1"),
    },
    outputs: {
      create: vi
        .fn()
        .mockResolvedValue({
          id: "output-1",
          name: "eve",
          destination: "https://agent.example.com/webhookrelay",
        }),
    },
  } as any;
}

describe("provisionWebhookRelay", () => {
  it("creates the bucket, input, and output with stable defaults", async () => {
    const relay = fakeRelay();

    const result = await provisionWebhookRelay({
      bucket: "eve-demo",
      endpoint: "https://agent.example.com/webhookrelay",
      relay,
      sharedSecret: "secret",
    });

    expect(result).toMatchObject({
      bucketId: "bucket-1",
      inputId: "input-1",
      outputId: "output-1",
      bucketCreated: true,
      inputCreated: true,
      outputCreated: true,
    });
    expect(relay.buckets.create).toHaveBeenCalledWith({ name: "eve-demo" });
    expect(relay.inputs.create).toHaveBeenCalledWith("bucket-1", {
      name: "eve",
      status_code: 202,
      body: "accepted",
    });
    expect(relay.outputs.create).toHaveBeenCalledWith("bucket-1", {
      name: "eve",
      destination: "https://agent.example.com/webhookrelay",
      headers: { authorization: ["Bearer secret"] },
    });
  });

  it("reuses existing resources and does not overwrite output settings", async () => {
    const relay = fakeRelay({
      bucket: {
        id: "bucket-1",
        name: "eve-demo",
      },
      fullBucket: {
        id: "bucket-1",
        name: "eve-demo",
        inputs: [{ id: "input-1", name: "eve" }],
        outputs: [
          {
            id: "output-1",
            name: "eve",
            destination: "https://agent.example.com/webhookrelay",
            throttle: { rate: 1 },
            durability: { enabled: true },
          },
        ],
      },
    });

    const result = await provisionWebhookRelay({
      bucket: "eve-demo",
      endpoint: "https://agent.example.com/webhookrelay",
      relay,
    });

    expect(result).toMatchObject({
      bucketCreated: false,
      inputCreated: false,
      outputCreated: false,
      inputId: "input-1",
      outputId: "output-1",
    });
    expect(relay.outputs.create).not.toHaveBeenCalled();
  });

  it("refuses to silently retarget an existing output", async () => {
    const relay = fakeRelay({
      bucket: { id: "bucket-1", name: "eve-demo" },
      fullBucket: {
        id: "bucket-1",
        name: "eve-demo",
        inputs: [],
        outputs: [
          {
            id: "output-1",
            name: "eve",
            destination: "https://old.example.com",
          },
        ],
      },
    });

    await expect(
      provisionWebhookRelay({
        bucket: "eve-demo",
        endpoint: "https://agent.example.com/webhookrelay",
        relay,
      }),
    ).rejects.toThrow("refusing to overwrite it");
  });
});

describe("webhookRelayChannel", () => {
  it("authenticates, starts an Eve session, and reports acceptance", async () => {
    const channel = webhookRelayChannel({
      bucket: "eve-demo",
      sharedSecret: "secret",
    });
    const route = channel.routes[0];
    if (route.method !== "POST") throw new Error("expected POST route");
    const send = vi.fn().mockResolvedValue({
      id: "session-1",
      continuationToken: "webhookrelay:relay:req-1",
    });
    const waitUntil = vi.fn();

    const response = await route.handler(
      new Request("https://agent.example.com/webhookrelay", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-webhook-relay-id": "req-1",
        },
        body: JSON.stringify({ message: "Summarize order 42" }),
      }),
      { send, waitUntil } as any,
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      ok: true,
      sessionId: "session-1",
    });
    expect(send).toHaveBeenCalledWith(
      { message: "Summarize order 42" },
      expect.objectContaining({
        auth: null,
        continuationToken: "relay:req-1",
        state: { progressUrl: null, requestId: "req-1" },
      }),
    );
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("rejects requests with an invalid shared secret", async () => {
    const channel = webhookRelayChannel({
      bucket: "eve-demo",
      sharedSecret: "secret",
    });
    const route = channel.routes[0];
    if (route.method !== "POST") throw new Error("expected POST route");
    const response = await route.handler(
      new Request("https://agent.example.com/webhookrelay", { method: "POST" }),
      { send: vi.fn() } as any,
    );

    expect(response.status).toBe(401);
  });
});
