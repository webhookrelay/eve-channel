import { defineChannel, POST, type Channel } from "eve/channels";
import { WebhookRelay } from "@webhookrelay/sdk";
import type {
  BucketAuth,
  CreateOutputParams,
  Headers,
  WebhookEvent,
} from "@webhookrelay/sdk";

export interface WebhookRelayChannelOptions {
  /** Bucket name (or id) used for incoming webhook delivery. */
  readonly bucket: string;
  /** Relay output name. Existing outputs are reused without modification. */
  readonly output?: string;
  /** Relay input name. Existing inputs are reused without modification. */
  readonly input?: string;
  /** HTTP path served by the Eve channel. */
  readonly path?: string;
  /** Optional shared secret for the Relay output and Eve route. */
  readonly sharedSecret?: string;
  /** Sends request lifecycle updates to this URL when set. */
  readonly progressUrl?: string;
}

export interface ProvisionWebhookRelayOptions extends WebhookRelayChannelOptions {
  /** Public URL of the Eve route, for example https://agent.example.com/webhookrelay. */
  readonly endpoint: string;
  /** Optional bucket-level authentication for the provider-facing input. */
  readonly bucketAuth?: BucketAuth;
  /** Response returned immediately to the webhook sender. */
  readonly response?: {
    readonly statusCode?: number;
    readonly body?: string;
  };
  /** Options applied only when the output is first created. */
  readonly outputOptions?: Pick<
    CreateOutputParams,
    "description" | "headers" | "retries" | "timeout" | "tls_verification"
  >;
  /** Reuse an injected SDK client, useful for tests or custom Relay endpoints. */
  readonly relay?: WebhookRelay;
}

export interface ProvisionWebhookRelayResult {
  readonly bucketId: string;
  readonly inputId: string;
  readonly outputId: string;
  readonly endpointUrl: string;
  readonly bucketCreated: boolean;
  readonly inputCreated: boolean;
  readonly outputCreated: boolean;
}

export type WebhookRelayProgressStatus =
  "accepted" | "running" | "completed" | "failed";

export interface WebhookRelayProgress {
  readonly status: WebhookRelayProgressStatus;
  readonly requestId: string;
  readonly sessionId?: string;
  readonly message?: string;
  readonly error?: string;
}

export interface WebhookRelayChannelState {
  progressUrl: string | null;
  requestId: string;
}

interface ChannelContext {
  state: WebhookRelayChannelState;
}

const DEFAULT_INPUT = "eve";
const DEFAULT_OUTPUT = "eve";
const DEFAULT_PATH = "/webhookrelay";

/**
 * Build an Eve channel that turns Relay output requests into Eve sessions.
 * Relay provisioning is deliberately separate because it needs the deployed
 * Eve URL; call {@link provisionWebhookRelay} once during setup/deploy.
 */
export function webhookRelayChannel(
  options: WebhookRelayChannelOptions,
): Channel<WebhookRelayChannelState> {
  const path = options.path ?? DEFAULT_PATH;

  return defineChannel<WebhookRelayChannelState, ChannelContext>({
    state: { progressUrl: null, requestId: "" },
    context(state) {
      return { state };
    },
    routes: [
      POST(path, async (request, { send, waitUntil }) => {
        const unauthorized = authorize(request, options.sharedSecret);
        if (unauthorized) return unauthorized;

        const payload = await readPayload(request);
        if (payload instanceof Response) return payload;

        const requestId =
          request.headers.get("x-webhook-relay-id") ?? crypto.randomUUID();
        const progressUrl =
          stringValue(payload, "progressUrl") ?? options.progressUrl ?? null;
        const continuationToken =
          stringValue(payload, "continuationToken") ?? `relay:${requestId}`;
        const message = messageFromPayload(payload);
        const context = stringArrayValue(payload, "context");

        const session = await send(
          { message, ...(context ? { context } : {}) },
          {
            auth: null,
            continuationToken,
            state: { progressUrl, requestId },
          },
        );

        if (progressUrl) {
          waitUntil(
            sendProgress(progressUrl, {
              requestId,
              sessionId: session.id,
              status: "accepted",
            }),
          );
        }

        return Response.json(
          {
            endpoint: "webhookrelay",
            ok: true,
            requestId,
            sessionId: session.id,
            continuationToken: session.continuationToken,
          },
          { status: 202 },
        );
      }),
    ],
    events: {
      async "turn.started"(_event, channel) {
        await report(channel.state, "running");
      },
      async "message.completed"(event, channel) {
        if (event.finishReason === "tool-calls" || event.message === null)
          return;
        await report(channel.state, "completed", { message: event.message });
      },
      async "turn.failed"(event, channel) {
        await report(channel.state, "failed", { error: event.message });
      },
      async "session.failed"(event, channel) {
        await report(channel.state, "failed", { error: event.message });
      },
    },
  });
}

/** Ensure the Relay bucket, public input, and Eve HTTP output exist. */
export async function provisionWebhookRelay(
  options: ProvisionWebhookRelayOptions,
): Promise<ProvisionWebhookRelayResult> {
  const relay = options.relay ?? new WebhookRelay();
  const endpoint = validUrl(options.endpoint, "endpoint");
  const inputName = options.input ?? DEFAULT_INPUT;
  const outputName = options.output ?? DEFAULT_OUTPUT;
  const response = options.response ?? {};

  let bucket = await relay.buckets.findByName(options.bucket);
  if (!bucket) {
    const buckets = await relay.buckets.list();
    bucket = buckets.find((candidate) => candidate.id === options.bucket);
  }

  let bucketCreated = false;
  if (!bucket) {
    bucket = await relay.buckets.create({
      name: options.bucket,
      ...(options.bucketAuth ? { auth: options.bucketAuth } : {}),
    });
    bucketCreated = true;
  }

  const fullBucket = await relay.buckets.get(bucket.id);
  let input = fullBucket.inputs?.find(
    (candidate) => candidate.name === inputName,
  );
  let inputCreated = false;
  if (!input) {
    input = await relay.inputs.create(bucket.id, {
      name: inputName,
      status_code: response.statusCode ?? 202,
      body: response.body ?? "accepted",
    });
    inputCreated = true;
  }

  const outputDestination = endpoint;
  let output = fullBucket.outputs?.find(
    (candidate) => candidate.name === outputName,
  );
  let outputCreated = false;
  if (output) {
    if (output.destination && output.destination !== outputDestination) {
      throw new Error(
        `Relay output "${outputName}" already points to ${output.destination}; refusing to overwrite it.`,
      );
    }
  } else {
    const headers = mergeOutputHeaders(
      options.outputOptions?.headers,
      options.sharedSecret,
    );
    output = await relay.outputs.create(bucket.id, {
      name: outputName,
      destination: outputDestination,
      ...(headers ? { headers } : {}),
      ...(options.outputOptions?.description
        ? { description: options.outputOptions.description }
        : {}),
      ...(options.outputOptions?.retries !== undefined
        ? { retries: options.outputOptions.retries }
        : {}),
      ...(options.outputOptions?.timeout !== undefined
        ? { timeout: options.outputOptions.timeout }
        : {}),
      ...(options.outputOptions?.tls_verification !== undefined
        ? { tls_verification: options.outputOptions.tls_verification }
        : {}),
    });
    outputCreated = true;
  }

  return {
    bucketId: bucket.id,
    inputId: input.id,
    outputId: output.id,
    endpointUrl: relay.inputs.endpointUrl(input),
    bucketCreated,
    inputCreated,
    outputCreated,
  };
}

function authorize(request: Request, sharedSecret?: string): Response | null {
  if (!sharedSecret) return null;
  if (request.headers.get("authorization") === `Bearer ${sharedSecret}`)
    return null;
  return Response.json({ error: "Unauthorized", ok: false }, { status: 401 });
}

async function readPayload(
  request: Request,
): Promise<Record<string, unknown> | string | Response> {
  const text = await request.text();
  if (!text) return "";
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return text;
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return text;
  } catch {
    return Response.json(
      { error: "Invalid JSON body", ok: false },
      { status: 400 },
    );
  }
}

function messageFromPayload(payload: Record<string, unknown> | string): string {
  if (typeof payload === "string") return payload || "Webhook received.";
  const message = stringValue(payload, "message");
  if (message) return message;

  const cleaned = Object.fromEntries(
    Object.entries(payload).filter(
      ([key]) => !["progressUrl", "continuationToken", "context"].includes(key),
    ),
  );
  return `Webhook received:\n${JSON.stringify(cleaned, null, 2)}`;
}

function stringValue(
  payload: Record<string, unknown> | string,
  key: string,
): string | undefined {
  if (typeof payload === "string") return undefined;
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayValue(
  payload: Record<string, unknown> | string,
  key: string,
): string[] | undefined {
  if (typeof payload === "string") return undefined;
  const value = payload[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

async function report(
  state: WebhookRelayChannelState,
  status: Exclude<WebhookRelayProgressStatus, "accepted">,
  extra: Pick<WebhookRelayProgress, "message" | "error"> = {},
): Promise<void> {
  if (!state.progressUrl) return;
  await sendProgress(state.progressUrl, {
    requestId: state.requestId,
    status,
    ...extra,
  });
}

async function sendProgress(
  url: string,
  progress: WebhookRelayProgress,
): Promise<void> {
  try {
    const response = await fetch(validUrl(url, "progressUrl"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...progress, at: new Date().toISOString() }),
    });
    if (!response.ok) {
      console.error(
        `[Webhook Relay] progress update failed: HTTP ${response.status}`,
      );
    }
  } catch (error) {
    console.error("[Webhook Relay] progress update failed", error);
  }
}

function mergeOutputHeaders(
  headers: Headers | undefined,
  sharedSecret: string | undefined,
): Headers | undefined {
  const result = headers ? { ...headers } : {};
  if (sharedSecret) result.authorization = [`Bearer ${sharedSecret}`];
  return Object.keys(result).length > 0 ? result : undefined;
}

function validUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
}

export type { WebhookEvent };
