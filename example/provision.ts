import { provisionWebhookRelay } from "@webhookrelay/eve-channel";

const publicUrl = process.env.EVE_PUBLIC_URL;
if (!publicUrl)
  throw new Error("Set EVE_PUBLIC_URL to the deployed Eve app URL");

const result = await provisionWebhookRelay({
  bucket: process.env.RELAY_BUCKET ?? "eve-demo",
  endpoint: new URL("/webhookrelay", publicUrl).toString(),
  sharedSecret: process.env.RELAY_SHARED_SECRET,
});

console.log(JSON.stringify(result, null, 2));
console.log(`Send webhooks to: ${result.endpointUrl}`);
