import { z } from "zod";
import { desc, gte } from "drizzle-orm";
import { adminOnly, authed, randomToken } from "../lib/auth";
import { base } from "../core/app";
import { CONSENT_VERSION, SETTINGS_DEFAULTS } from "../lib/domain";
import { securitySettings } from "../lib/access";
import { getSetting, getSettings, setSetting } from "../lib/settings";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  getBotInfo,
  getWebhookSecret,
  isStubMode,
  listSubscriptions,
  maxConfig,
  subscribeWebhookWithSecret,
  unsubscribeWebhook,
  WEBHOOK_SECRET_SETTING,
} from "../max/client";
import { longPollingEnabled } from "../max/polling";

import { schedulerHeartbeat } from "../lib/scheduler";
import { clientIp, logAudit } from "../lib/audit";
import { checkWebhookEndpoint } from "../lib/webhook-check";

export const settings = {
  /**
   * Публичные настройки — без авторизации.
   * Нужны странице политики обработки ПДн (ст. 18.1 152-ФЗ): субъект должен
   * видеть, кто именно является оператором, ДО того, как даст согласие.
   * Отдаём только название компании — никаких технических параметров.
   */
  public: base.handler(async () => ({
    companyName: (await getSetting("companyName")) || SETTINGS_DEFAULTS.companyName,
    consentVersion: CONSENT_VERSION,
  })),

  /** Настройки читает любой авторизованный (нужны для отображения времени/названия). */
  get: authed.handler(async () => {
    const map = await getSettings();
    return {
      reminderMinutes: Number.parseInt(map.reminderMinutes ?? "60", 10) || 60,
      stopLateMinutes: Number.parseInt(map.stopLateMinutes ?? "30", 10) || 30,
      alertEscalateMinutes: Number.parseInt(map.alertEscalateMinutes ?? "15", 10) || 15,
      timezone: map.timezone ?? SETTINGS_DEFAULTS.timezone,
      companyName: map.companyName ?? SETTINGS_DEFAULTS.companyName,
    };
  }),

  /** Политика доступа: ручной допуск, сроки сеансов, автоприостановка. */
  security: adminOnly.handler(() => securitySettings()),

  updateSecurity: adminOnly
    .input(
      z.object({
        requireApproval: z.boolean(),
        webSessionHours: z.number().int().min(1).max(720),
        miniAppSessionDays: z.number().int().min(1).max(365),
        inactivityDays: z.number().int().min(0).max(365),
      }),
    )
    .handler(async ({ input }) => {
      await setSetting("requireApproval", input.requireApproval ? "1" : "0");
      await setSetting("webSessionHours", String(input.webSessionHours));
      await setSetting("miniAppSessionDays", String(input.miniAppSessionDays));
      await setSetting("inactivityDays", String(input.inactivityDays));
      return securitySettings();
    }),

  update: adminOnly
    .input(
      z.object({
        reminderMinutes: z.number().min(5).max(2880).optional(),
        stopLateMinutes: z.number().min(5).max(1440).optional(),
        alertEscalateMinutes: z.number().min(1).max(720).optional(),
        timezone: z.string().min(3).optional(),
        companyName: z.string().min(1).optional(),
      }),
    )
    .handler(async ({ input }) => {
      if (input.stopLateMinutes !== undefined) {
        await setSetting("stopLateMinutes", String(input.stopLateMinutes));
      }
      if (input.reminderMinutes !== undefined) {
        await setSetting("reminderMinutes", String(input.reminderMinutes));
      }
      if (input.alertEscalateMinutes !== undefined) {
        await setSetting("alertEscalateMinutes", String(input.alertEscalateMinutes));
      }
      if (input.timezone) await setSetting("timezone", input.timezone);
      if (input.companyName) await setSetting("companyName", input.companyName.trim());
      return getSettings();
    }),

  /** Диагностика связи с MAX: токен, /me, активные подписки на webhook. */
  integration: adminOnly.handler(async () => {
    const base = {
      stub: isStubMode(),
      hasToken: maxConfig.hasToken,
      baseUrl: maxConfig.baseUrl,
      botUsername: maxConfig.botUsername,
      webhookSecretSet: !!maxConfig.webhookSecret,
      longPolling: longPollingEnabled(),
      scheduler: await schedulerHeartbeat(),
    };
    if (isStubMode()) {
      return { ...base, bot: null, subscriptions: [] as { url: string; time: number | null }[], error: null };
    }
    try {
      const [bot, subs] = await Promise.all([getBotInfo(), listSubscriptions()]);
      return {
        ...base,
        bot: bot ? { userId: bot.user_id, name: bot.first_name, username: bot.username ?? null } : null,
        subscriptions: (subs.subscriptions ?? []).map((s) => ({ url: s.url, time: s.time ?? null })),
        error: null,
      };
    } catch (err) {
      return {
        ...base,
        bot: null,
        subscriptions: [] as { url: string; time: number | null }[],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }),

  /**
   * Проверить, что вебхук действительно доступен снаружи.
   *
   * Проверка идёт С СЕРВЕРА: тот же путь, каким придёт событие от MAX. Запрос
   * уходит на собственный адрес с корректным секретом и пустым телом — ожидаем
   * ответ 200. Дополнительно снимается сертификат: MAX требует, чтобы он был
   * выдан доверенным центром, а имя домена совпадало с CN/SAN.
   */
  checkWebhook: adminOnly
    .input(z.object({ url: z.string().url() }))
    .handler(async ({ input }) => {
      if (isStubMode()) {
        return {
          ok: false,
          error: "Режим без бота MAX: проверка недоступна.",
          status: null,
          responseMs: null,
          cert: null,
          checkedFrom: "external",
          hint: "Задайте MAX_BOT_TOKEN — без него бот не работает.",
        };
      }
      const result = await checkWebhookEndpoint(input.url, await getWebhookSecret());
      return result;
    }),

  /**
   * Ротация секрета вебхука.
   *
   * Новый секрет сохраняется в настройках базы — так его можно сменить без
   * правки .env и без пересборки образа. После сохранения подписка
   * пересоздаётся с новым секретом: иначе MAX продолжит присылать события со
   * старым секретом, а приложение будет их отклонять.
   */
  rotateWebhookSecret: adminOnly.handler(async ({ context }) => {
    if (isStubMode()) return { ok: false, error: "Режим без бота MAX: ротация недоступна." };
    const secret = randomToken(32);
    await setSetting(WEBHOOK_SECRET_SETTING, secret);
    await logAudit({
      actor: context.user,
      action: "webhook.rotate_secret",
      targetType: "webhook",
      detail: "Секрет вебхука заменён",
      ip: clientIp(context.headers),
    });
    // Переподписка с новым секретом — чтобы MAX начал присылать события сразу.
    const url = `${(process.env.WEBSITE_URL ?? "").replace(/\/+$/, "")}/api/webhooks/max`;
    if (url.startsWith("http")) {
      try {
        await subscribeWebhookWithSecret(url, secret);
      } catch (err) {
        return {
          ok: false,
          error: `Секрет обновлён, но переподписка не удалась: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }
    return { ok: true, error: null };
  }),

  /**
   * Журнал доставки событий MAX: сколько пришло, сколько обработано, сколько
   * отброшено как дубли, сколько отклонено по секрету.
   */
  webhookStats: adminOnly.handler(async () => {
    const since24 = new Date(Date.now() - 24 * 3_600_000);
    const since7d = new Date(Date.now() - 7 * 86_400_000);
    const [recent, week, last] = await Promise.all([
      db.select().from(schema.webhookEvents).where(gte(schema.webhookEvents.createdAt, since24)),
      db.select().from(schema.webhookEvents).where(gte(schema.webhookEvents.createdAt, since7d)),
      db.select().from(schema.webhookEvents).orderBy(desc(schema.webhookEvents.id)).limit(1),
    ]);
    const count = (rows: typeof recent, outcome: string) => rows.filter((r) => r.outcome === outcome).length;

    // По часам за сутки — видно, когда события перестали приходить.
    const byHour = new Map<string, number>();
    for (const row of recent) {
      const key = row.createdAt.toISOString().slice(0, 13);
      byHour.set(key, (byHour.get(key) ?? 0) + 1);
    }

    return {
      last24h: {
        total: recent.length,
        processed: count(recent, "processed"),
        duplicate: count(recent, "duplicate"),
        badSecret: count(recent, "bad_secret"),
        badJson: count(recent, "bad_json"),
        failed: count(recent, "failed"),
      },
      last7d: {
        total: week.length,
        processed: count(week, "processed"),
        duplicate: count(week, "duplicate"),
        failed: count(week, "failed"),
      },
      byHour: [...byHour.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, count]) => ({
        hour,
        count,
      })),
      lastEvent: last[0]
        ? {
            at: last[0].createdAt,
            updateType: last[0].updateType,
            outcome: last[0].outcome,
            error: last[0].error,
          }
        : null,
    };
  }),

  /**
   * Подписать бота на вебхук по публичному HTTPS-адресу.
   * MAX требует валидный сертификат (в т.ч. Минцифры) и ответ 200 за 30 секунд.
   */
  subscribeWebhook: adminOnly
    .input(z.object({ url: z.string().url() }))
    .handler(async ({ input }) => {
      if (isStubMode()) return { ok: false, error: "Режим без бота MAX: подписка недоступна." };
      if (!input.url.startsWith("https://")) {
        return { ok: false, error: "MAX принимает только HTTPS-адреса." };
      }
      try {
        await subscribeWebhookWithSecret(input.url, await getWebhookSecret());
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),

  /**
   * Снять подписку. Нужно, если адрес устарел или если события должны
   * приходить через long polling (MAX отдаёт их только одним способом).
   */
  unsubscribeWebhook: adminOnly
    .input(z.object({ url: z.string().min(1) }))
    .handler(async ({ input }) => {
      if (isStubMode()) return { ok: false, error: "Режим без бота MAX: подписка недоступна." };
      try {
        await unsubscribeWebhook(input.url);
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
};
