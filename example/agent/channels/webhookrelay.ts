import { webhookRelayChannel } from "@webhookrelay/eve-channel";

export default webhookRelayChannel({
  bucket: process.env.RELAY_BUCKET ?? "eve-demo",
  sharedSecret: process.env.RELAY_SHARED_SECRET,
  progressUrl: process.env.PROGRESS_URL,
});
