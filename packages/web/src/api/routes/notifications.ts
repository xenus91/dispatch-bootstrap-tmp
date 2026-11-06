import { z } from "zod";
import { dispatcherOnly } from "../lib/auth";
import { currentNotifyEvents, getNotifyPrefs, saveNotifyPrefs } from "../lib/route";
import { NOTIFY_GROUP_LABELS } from "../lib/route-def";

export const notifications = {
  /** Личные настройки уведомлений текущего диспетчера/админа и каталог событий. */
  get: dispatcherOnly.handler(async ({ context }) => {
    return {
      prefs: await getNotifyPrefs(context.user.id),
      events: await currentNotifyEvents(),
      groups: NOTIFY_GROUP_LABELS,
      inBot: context.user.status === "active" && !!context.user.maxUserId,
    };
  }),

  save: dispatcherOnly
    .input(
      z.object({
        muted: z.boolean(),
        scope: z.enum(["all", "mine"]),
        events: z.record(z.string().max(64), z.boolean()),
      }),
    )
    .handler(async ({ input, context }) => saveNotifyPrefs(context.user.id, input)),
};
