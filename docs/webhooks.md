# Webhooks

hl-crm-db sends events to your HTTPS endpoints, signed so you can check they came from your workspace.

## Two ways to get events

- **Subscriptions:** register a webhook with `events`, for example `["deal.*", "contact.created"]`. Patterns are `*`, `<object>.*`, `*.<action>` or an exact type.
- **Automations:** a rule like "when a deal is created with amount > 10,000, send webhook `whk_…`". Register the webhook with no `events` if it is only used by automations. A `send_webhook` step in a scheduled or requested run (which has no triggering event), or inside `for_each`, sends a payload of type `automation.run` with the current record and `data.run`. See [automations.md](automations.md).

Event types: `<object>.created`, `<object>.updated`, `<object>.archived`, `<object>.restored` for every object (custom objects too), `<object>.merged` (contacts, accounts, leads, custom objects; `data.merged` lists the merged IDs, and the duplicates each get `<object>.archived` with `data.merged_into`), `<object>.erased` (contacts, leads, custom objects: the record's values were removed for good, so erase your copy; deliveries made earlier for that record have their stored payload blanked, and one not yet sent is never sent), `deal.stage_changed`, `lead.converted`, `schema.*`, `automation.paused` (an automation paused itself after repeated failures), and `webhook.test`. Bulk changes send one event per record.

**Webhook or an automation's `http_request`?** A webhook delivers our event, signed, retried for about 22 hours, logged per delivery and replayable: use it for receivers you control. An automation's `http_request` step calls someone else's API in the shape it expects (any method, your own JSON body and headers, a write-only secret header), once per run, unsigned and not retried, and later steps can use its reply. Both go through the same outbound guard below. See [automations.md](automations.md#http_request).

## Payload

```json
{
  "id": "evt_01JB…",
  "type": "deal.created",
  "occurred_at": "2026-11-01T19:30:00.000Z",
  "object": "deal",
  "record_id": "deal_01JB…",
  "actor": { "type": "user", "id": "usr_01JB…", "surface": "ops-mcp" },
  "causation_depth": 0,
  "automation_id": null,
  "data": { "after": { "name": "Big one", "amount": 50000 } },
  "record": { "id": "deal_01JB…", "name": "Big one", "amount": 50000, "owner": "usr_…", "…": "…" },
  "automation": { "id": "auto_01JB…", "name": "Big deal alert" }
}
```

`record` is the record as it was when the event was processed, so a receiving agent can act without another lookup. `data` holds the changed values (`before` and `after` for updates). Restricted fields show as `"[restricted]"` unless the webhook was granted them with `include_restricted`. Rules for that:

- Turning `include_restricted` on needs a key with the `restricted:read` permission, and cannot be done through MCP. Use the API.
- On a webhook that receives restricted values, changing the `url` or `events` also needs `restricted:read`, and cannot be done through MCP. Otherwise someone without it (or a prompt-injected agent) could point the endpoint at a URL of their own.
- Replaying a delivery that carries restricted values needs `restricted:read` too, because the replay goes to the webhook's current URL, and cannot be done through MCP either.
- Granted values are stored encrypted and merged in when the delivery is sent. They are never in the delivery log.

## Verifying signatures

Signatures follow [Standard Webhooks](https://www.standardwebhooks.com/). Any of its libraries works. By hand, in Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, headers, rawBody) {
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // reject replays older than 5 minutes
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = Buffer.from(`v1,${createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64")}`);
  return headers["webhook-signature"].split(" ").some((s) => {
    const b = Buffer.from(s);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}
```

Use the raw request body, before any JSON parsing. Deliveries are **at-least-once**: the same event can arrive more than once, for example after a retry or a worker restart. Deduplicate on `webhook-id`: retries of one delivery keep the same ID.

## Secrets

The secret (`whsec_…`) is returned when you create the webhook through the API, and from `GET /v1/webhooks/{id}/secret`. It is never shown through MCP. `POST /v1/webhooks/{id}/rotate-secret` issues a new one; the old one keeps signing alongside it for `overlap_hours` (default 24), so the header carries two signatures until then.

## Delivery, retries and the log

- Return any 2xx within 10 seconds. Redirects are not followed.
- Failures are retried 8 times over about 22 hours, then the delivery is marked `dead`.
- After 10 failures in a row the endpoint is paused for 10 minutes.
- `GET /v1/webhooks/{id}/deliveries` shows every delivery with status, attempts, last status code and last error, and payload. `POST /v1/webhook-deliveries/{id}/replay` queues a new copy (202).
- `last_error` is a status code (`HTTP 500`) or a short error class (`timed out after 10s`, `network error (ECONNREFUSED)`, or a blocked-address message). It never contains the response body.
- `POST /v1/webhooks/{id}/test` queues a signed `webhook.test` event and returns **202** with the delivery. The worker sends it within about a second, so read the result from `GET /v1/webhook-deliveries/{id}` (the `poll` field in the response has the path). A test is one attempt: a failure is final, and it is sent even if the endpoint is disabled or paused. A failed test does not count toward the endpoint's `consecutive_failures` or pause its real deliveries. At most 5 tests can wait per endpoint.

## Events that fail before they reach a webhook

An event is first processed inside the server: automations run and deliveries are queued. If that step fails, the event is retried with backoff (6 attempts in all over about 4 hours) and then dead-lettered instead of being dropped. List them with `GET /v1/events?status=dead`; `status` can also be `pending` or `processed`. A dead event's automations and webhooks did not run, and it is not retried again. Events, runs and finished deliveries are deleted after 90 days.

## Allowed destinations

Only `https://` URLs on public addresses, with no credentials in the URL. Refused:

- Loopback, private (10/8, 172.16/12, 192.168/16), link-local, carrier-grade NAT (100.64/10), documentation, benchmarking, multicast and reserved ranges, and the other IPv4 and IPv6 special-purpose ranges (including 6to4, Teredo and local-use NAT64).
- IPv6 addresses that carry one of those IPv4 addresses.
- Cloud metadata addresses (AWS, GCP, Azure and similar).
- Host names ending in `.localhost`, `.internal` or `.local`.

Every address a name resolves to is checked after DNS resolution (5-second timeout), and the connection goes to the checked address. Redirects are not followed. Self-hosters who need internal targets can set `WEBHOOK_ALLOW_INSECURE_TARGETS=true` (allows `http://` and private addresses; metadata addresses stay blocked).
