import type { Context, Hono } from "hono";
import { runSchedulerTick } from "./lib/scheduler";

/**
 * «Будильник» планировщика. Раз в минуту его дёргает сам процесс через публичный адрес
 * (самопинг, см. lib/scheduler.ts), при желании — и внешний cron.
 * GET/POST /api/cron/tick?key=<CRON_SECRET> (или заголовок X-Cron-Secret).
 */
const cronSecret = () => process.env.CRON_SECRET || process.env.MAX_WEBHOOK_SECRET || "";

export function mountCron(app: Hono) {
  const handler = async (c: Context) => {
    const secret = cronSecret();
    const got = c.req.header("X-Cron-Secret") ?? c.req.query("key");
    if (!secret || got !== secret) return c.json({ ok: false, error: "unauthorized" }, 401);
    const started = Date.now();
    await runSchedulerTick(c.req.query("src") === "self" ? "self" : "cron");
    return c.json({ ok: true, ms: Date.now() - started });
  };
  app.get("/api/cron/tick", handler);
  app.post("/api/cron/tick", handler);
}
