import { provisionWebhookRelay } from "@webhookrelay/eve-channel";

const publicUrl = process.env.EVE_PUBLIC_URL;
const delivery = process.env.RELAY_DELIVERY ?? "private-pull";
if (delivery === "http" && !publicUrl)
  throw new Error("Set EVE_PUBLIC_URL when RELAY_DELIVERY=http");

const result = await provisionWebhookRelay({
  bucket: process.env.RELAY_BUCKET ?? "eve-demo",
  delivery: delivery as "http" | "private-pull",
  ...(publicUrl
    ? { endpoint: new URL("/webhookrelay", publicUrl).toString() }
    : {}),
  sharedSecret: process.env.RELAY_SHARED_SECRET,
});

console.log(JSON.stringify(result, null, 2));
console.log(`Send webhooks to: ${result.endpointUrl}`);
