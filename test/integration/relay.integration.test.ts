import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WebhookRelay,
  type Bucket,
  type Input,
  type Output,
  type WebhookLog,
} from "@webhookrelay/sdk";

const describeLive = process.env.RELAY_API_KEY ? describe : describe.skip;
const hasCredentials = Boolean(process.env.RELAY_API_KEY);
const BUCKET_NAME = "e2e-eve-agent";
const BUCKET_DESCRIPTION = "Managed by eve-agent Relay integration tests";
const EVENT_COUNT = 24;

const relay = hasCredentials
  ? new WebhookRelay({ timeoutMs: 15_000 })
  : (undefined as unknown as WebhookRelay);
let bucket: Bucket;
let input: Input;
let output: Output;

describeLive("Webhook Relay durable delivery", () => {
  beforeAll(async () => {
    const existing = await relay.buckets.findByName(BUCKET_NAME);
    if (existing) {
      if (existing.description !== BUCKET_DESCRIPTION) {
        throw new Error(
          `Refusing to replace existing bucket ${BUCKET_NAME} without the CI marker description`,
        );
      }
      await deleteBucket(existing.id);
    }

    bucket = await relay.buckets.create({
      name: BUCKET_NAME,
      description: BUCKET_DESCRIPTION,
      stream: true,
    });
    input = await relay.inputs.create(bucket.id, {
      name: "e2e",
      status_code: 202,
    });
    output = await relay.request<Output>(
      "POST",
      `/v1/buckets/${bucket.id}/outputs`,
      {
        body: {
          name: "e2e",
          destination: "http://localhost",
          internal: true,
          durability: { enabled: true, schedule: "seconds" },
        },
      },
    );
    expect(output.durability).toEqual(
      expect.objectContaining({ enabled: true, schedule: "seconds" }),
    );
  });

  afterAll(async () => {
    if (bucket?.id) await deleteBucket(bucket.id);
  });

  it("polls sequential webhooks one by one without loss", async () => {
    const markers = Array.from(
      { length: 8 },
      (_, index) => `sequential-${index}`,
    );
    const received: string[] = [];

    for (const marker of markers) {
      await sendWebhook(marker);
      received.push(await pollOne());
    }

    expect(received).toEqual(markers);
  });

  it("drains a burst exactly once", async () => {
    const markers = Array.from(
      { length: EVENT_COUNT },
      (_, index) => `burst-${index}`,
    );
    await Promise.all(markers.map(sendWebhook));

    const received = await pollMany(markers.length);
    expect(new Set(received).size).toBe(markers.length);
    expect(received.sort()).toEqual(markers.sort());
  });

  it("recovers after a consumer failure and does not miss remaining durable events", async () => {
    const markers = Array.from(
      { length: 10 },
      (_, index) => `failure-${index}`,
    );
    await Promise.all(markers.map(sendWebhook));

    const receivedBeforeFailure: string[] = [];
    const firstPoller = relay.webhooks.poll({
      bucket: bucket.id,
      output: output.id,
      limit: 1,
      intervalMs: 100,
      maxAge: "10m",
    });

    try {
      for await (const event of firstPoller) {
        receivedBeforeFailure.push(markerFrom(event));
        if (receivedBeforeFailure.length === 3) {
          throw new Error("simulated consumer failure");
        }
      }
    } catch (error) {
      expect(error).toEqual(new Error("simulated consumer failure"));
    } finally {
      firstPoller.stop();
    }

    const receivedAfterRecovery = await pollMany(
      markers.length - receivedBeforeFailure.length,
    );
    const received = [...receivedBeforeFailure, ...receivedAfterRecovery];

    expect(new Set(received).size).toBe(markers.length);
    expect(received.sort()).toEqual(markers.sort());
  });
});

async function sendWebhook(marker: string): Promise<void> {
  const response = await fetch(relay.inputs.endpointUrl(input), {
    method: "POST",
    headers: { "content-type": "application/json", "x-eve-agent-test": "1" },
    body: JSON.stringify({ marker }),
  });
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
}

async function pollOne(): Promise<string> {
  const events = await pollMany(1);
  return events[0];
}

async function pollMany(count: number): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const received: string[] = [];
  const poller = relay.webhooks.poll({
    bucket: bucket.id,
    output: output.id,
    limit: 1,
    intervalMs: 100,
    maxAge: "10m",
    signal: controller.signal,
  });

  try {
    for await (const event of poller) {
      received.push(markerFrom(event));
      if (received.length === count) return received;
    }
  } finally {
    clearTimeout(timeout);
    poller.stop();
  }

  throw new Error(
    `Timed out after receiving ${received.length}/${count} events`,
  );
}

function markerFrom(event: WebhookLog): string {
  const body = JSON.parse(event.body ?? "{}") as { marker?: string };
  if (!body.marker)
    throw new Error(`Webhook ${event.id} did not contain a marker`);
  return body.marker;
}

async function deleteBucket(bucketId: string): Promise<void> {
  const full = await relay.buckets.get(bucketId);
  for (const item of full.outputs ?? [])
    await relay.outputs.delete(bucketId, item.id);
  for (const item of full.inputs ?? [])
    await relay.inputs.delete(bucketId, item.id);
  await relay.buckets.delete(bucketId);
}
