# `@webhookrelay/eve-channel`

An Eve message layer backed by Webhook Relay. It turns a Relay webhook into a
durable Eve session, while Relay owns the public input, sender response,
throttling, retries, and output delivery.

```text
Provider → Relay input → Relay output (retry/throttle) → Eve channel → model
                                      └─ optional progressUrl ← Eve events
```

## Quick start

```bash
npm install eve ai zod @ai-sdk/openai-compatible @webhookrelay/sdk \
  @webhookrelay/eve-channel
```

Create `agent/channels/webhookrelay.ts`:

```ts
import { webhookRelayChannel } from "@webhookrelay/eve-channel";

export default webhookRelayChannel({
  bucket: process.env.RELAY_BUCKET ?? "eve-demo",
  sharedSecret: process.env.RELAY_SHARED_SECRET,
  progressUrl: process.env.PROGRESS_URL,
});
```

After deploying Eve, provision Relay once:

```ts
import { provisionWebhookRelay } from "@webhookrelay/eve-channel";

const relay = await provisionWebhookRelay({
  bucket: "eve-demo",
  endpoint: "https://your-eve-app.example.com/webhookrelay",
  sharedSecret: process.env.RELAY_SHARED_SECRET,
});

console.log(relay.endpointUrl); // give this URL to the webhook provider
```

Then send a message-shaped webhook:

```bash
curl -X POST "$RELAY_INPUT_URL" \
  -H 'content-type: application/json' \
  -d '{"message":"Summarize order 42", "progressUrl":"https://example.com/progress"}'
```

The output is find-or-create and never modified after creation, so configure
durability and throttling for it in Webhook Relay and those settings survive
restarts. A Relay HTTP output retries when Eve is unavailable; once Eve returns
`202`, Eve owns the durable session and progress callbacks report its lifecycle.

## Example

The complete Lightning-backed Eve app is in [`example/`](example/). Copy
`.env.example` to `example/.env`, set `RELAY_API_KEY`, `EVE_PUBLIC_URL`, and the
model key, then run:

```bash
cd example
npm install
npm run dev
# in another shell
npm run provision
```

The model example uses Lightning's OpenAI-compatible endpoint, maps Eve/AI
SDK's `max_tokens` request to Lightning's `max_completion_tokens`, and accepts
both `LIGHTNING_API_KEY` and the existing `LIGTNING_API_KEY` spelling.

## API notes

- `webhookRelayChannel()` adds `POST /webhookrelay` by default.
- JSON `message`, `context`, `continuationToken`, and `progressUrl` fields are
  understood. Other JSON is passed to Eve as a formatted webhook message.
- `sharedSecret` checks `Authorization: Bearer ...` on the Eve route and adds
  the same header to a newly-created Relay output.
- Existing buckets, inputs, and outputs are reused. A conflicting existing
  output destination fails loudly instead of being changed.

## Development

```bash
npm test
npm run typecheck
npm run build
```

MIT License.
