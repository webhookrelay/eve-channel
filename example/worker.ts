import {
  provisionWebhookRelay,
  startWebhookRelayWorker,
} from "@webhookrelay/eve-channel";

const configured = await provisionWebhookRelay({
  bucket: process.env.RELAY_BUCKET ?? "eve-demo",
  delivery: "private-pull",
  sharedSecret: process.env.RELAY_SHARED_SECRET,
});

const worker = startWebhookRelayWorker({
  bucket: configured.bucketId,
  output: configured.outputId,
  endpoint: process.env.EVE_LOCAL_URL ?? "http://127.0.0.1:2000/webhookrelay",
  sharedSecret: process.env.RELAY_SHARED_SECRET,
  onError: (error) => console.error("[eve-worker]", error),
});

console.log(`Listening for Relay webhooks in ${configured.bucketId}`);
await worker.done;
