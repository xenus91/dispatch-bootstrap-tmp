import type { RouterClient } from "@orpc/server";
import { createApp } from "./core/app";
import { ping } from "./routes/ping";
import { auth } from "./routes/auth";
import { staff } from "./routes/staff";
import { requests } from "./routes/requests";
import { settings } from "./routes/settings";
import { clients } from "./routes/clients";
import { points } from "./routes/points";
import { containerTypes } from "./routes/container-types";
import { operationTypes } from "./routes/operation-types";
import { requestTypes } from "./routes/request-types";
import { notifications } from "./routes/notifications";
import { sessions } from "./routes/sessions";
import { mountCron } from "./cron";
import { ensureSeedAdmin } from "./lib/auth";
import { startScheduler } from "./lib/scheduler";
import { getWebhookSecret } from "./max/client";
import { claimUpdate } from "./max/dedupe";
import { handleUpdate, recordDelivery } from "./max/webhook";
import { longPollingEnabled, startLongPolling } from "./max/polling";
import type { MaxUpdate } from "./max/types";

// API features are oRPC procedures, one file per feature in ./routes/,
// composed into this router — typed end-to-end via the clients
// (web: src/web/lib/api.ts, mobile: lib/api.ts).
export const router = {
  ping,
  auth,
  staff,
  requests,
  settings,
  sessions,
  clients,
  points,
  containerTypes,
  operationTypes,
  requestTypes,
  notifications,
};

export type AppRouter = typeof router;
/** Typed client for the router — used by the web and mobile api clients. */
export type AppRouterClient = RouterClient<AppRouter>;

const app = createApp(router);
mountCron(app);

/** MAX Bot API webhook — subscribed via POST /subscriptions (platform-api2.max.ru). */
app.post("/api/webhooks/max", async (c) => {
  const secret = await getWebhookSecret();
  if (secret) {
    const got = c.req.header("X-Max-Bot-Api-Secret");
    if (got !== secret) {
      await recordDelivery(null, "bad_secret", null, "не совпал X-Max-Bot-Api-Secret");
      return c.json({ ok: false, error: "bad secret" }, 401);
    }
  }
  let update: MaxUpdate;
  try {
    update = (await c.req.json()) as MaxUpdate;
  } catch {
    await recordDelivery(null, "bad_json", null, "тело запроса не разобрано");
    return c.json({ ok: false, error: "bad json" }, 400);
  }
  const userId = update.user?.user_id ? String(update.user.user_id) : null;

  // MAX retries on non-2xx: answer fast, never fail the delivery on our bug.
  // claimUpdate отсекает повторную доставку того же события (ретраи MAX, второй инстанс).
  claimUpdate(update)
    .then(async (fresh) => {
      if (!fresh) {
        await recordDelivery(update.update_type, "duplicate", userId, null);
        return;
      }
      try {
        await handleUpdate(update);
        await recordDelivery(update.update_type, "processed", userId, null);
      } catch (err) {
        await recordDelivery(
          update.update_type,
          "failed",
          userId,
          err instanceof Error ? err.message : String(err),
        );
        console.error("[max webhook] handler failed", err);
      }
    })
    .catch((err) => {
      console.error("[max webhook] handler failed", err);
    });
  return c.json({ ok: true });
});

void ensureSeedAdmin().catch((err) => console.error("[seed admin]", err));
startScheduler();

// Разработка/тестирование без публичного HTTPS: события бота забираем long polling.
// В продакшене — только вебхук (MAX_LONG_POLLING не выставляем).
if (longPollingEnabled()) startLongPolling();

export default app;
