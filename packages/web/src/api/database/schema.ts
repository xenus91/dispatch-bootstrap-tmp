import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  doublePrecision,
  index,
} from "drizzle-orm/pg-core";

/**
 * Схема БД диспетчеризации контейнерных перевозок (MAX).
 * Применить: `bun run db:push` из packages/web.
 */

const now = () => new Date();

/** Сотрудники: admin / dispatcher / driver. Единый whitelist — доступ только по карточке. */
export const staff = pgTable(
  "staff",
  {
    id: serial("id").primaryKey(),
    /** admin | dispatcher | driver */
    role: text("role").notNull().default("driver"),
    fullName: text("full_name").notNull(),
    /** Нормализованный телефон, только цифры с кодом страны: 79268776118 */
    phone: text("phone").notNull().unique(),
    /** Заполняется только после активации через бота */
    maxUserId: text("max_user_id"),
    maxChatId: text("max_chat_id"),
    maxUsername: text("max_username"),
    /** pending | awaiting_approval | active | blocked */
    status: text("status").notNull().default("pending"),
    /** Причина блокировки: manual | inactive | expired */
    blockReason: text("block_reason"),
    /** Доступ действует до этой даты (окончание договора); null — бессрочно */
    accessUntil: timestamp("access_until", { withTimezone: true, mode: "date" }),
    /** Последнее действие в панели или боте — для автоприостановки неактивных */
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: "date" }),
    /** Подряд неверных кодов входа; при достижении лимита вход блокируется на время */
    loginFailures: integer("login_failures").notNull().default(0),
    loginLockedUntil: timestamp("login_locked_until", { withTimezone: true, mode: "date" }),
    /** Гос. номер тягача — для водителей */
    vehicle: text("vehicle"),
    note: text("note"),
    /** Когда субъект дал согласие на обработку персональных данных (ст. 9 152-ФЗ) */
    consentAt: timestamp("consent_at", { withTimezone: true, mode: "date" }),
    /** Версия текста согласия, под которую подписывался субъект */
    consentVersion: text("consent_version"),
    /**
     * Когда персональные данные субъекта были стёрты (ст. 15 152-ФЗ).
     * После этого карточка обезличена и хранится только для целостности истории.
     */
    erasedAt: timestamp("erased_at", { withTimezone: true, mode: "date" }),
    createdById: integer("created_by_id"),
    activatedAt: timestamp("activated_at", { withTimezone: true, mode: "date" }),
    blockedAt: timestamp("blocked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [index("staff_max_user_idx").on(t.maxUserId), index("staff_role_idx").on(t.role)],
);

/** Персональные одноразовые инвайты (deep-link payload у бота). */
export const invites = pgTable(
  "invites",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull().unique(),
    staffId: integer("staff_id").notNull(),
    createdById: integer("created_by_id"),
    /** Выбранный пресет в часах: 1 / 24 / 72 / 168 */
    ttlHours: integer("ttl_hours").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [index("invites_staff_idx").on(t.staffId)],
);

/** OTP-коды для входа в панель (доставляются ботом в личный чат MAX). */
export const otpCodes = pgTable(
  "otp_codes",
  {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id").notNull(),
    code: text("code").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [index("otp_staff_idx").on(t.staffId)],
);

/** Сессии панели (Bearer-токен в localStorage — работает и в iframe MAX). */
export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    token: text("token").notNull().unique(),
    staffId: integer("staff_id").notNull(),
    /** web — вход по коду в браузере, miniapp — из мини-приложения MAX */
    kind: text("kind").notNull().default("web"),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [index("sessions_staff_idx").on(t.staffId)],
);

/* ─────────────── справочники ─────────────── */

/** Клиенты (заказчики перевозок). */
export const clients = pgTable(
  "clients",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    inn: text("inn"),
    address: text("address"),
    contactName: text("contact_name"),
    phone: text("phone"),
    email: text("email"),
    comment: text("comment"),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [index("clients_name_idx").on(t.name)],
);

/** Пункты маршрута: терминалы, склады, места обработки. */
export const points = pgTable(
  "points",
  {
    id: serial("id").primaryKey(),
    /** terminal | warehouse | processing */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    contactName: text("contact_name"),
    phone: text("phone"),
    /** Режим работы / перерывы */
    schedule: text("schedule"),
    comment: text("comment"),
    /** Склад клиента — привязка к клиенту */
    clientId: integer("client_id"),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [index("points_kind_idx").on(t.kind), index("points_client_idx").on(t.clientId)],
);

/** Типы контейнеров: 20DC, 40HC … */
export const containerTypes = pgTable("container_types", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name"),
  sort: integer("sort").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
});

/** Типы операций на остановке и действия водителя внутри них. */
export const operationTypes = pgTable("operation_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** JSON: виды пунктов, где операция допустима; пусто — любые */
  pointKindsJson: text("point_kinds_json").notNull().default("[]"),
  /** JSON: OperationAction[] */
  actionsJson: text("actions_json").notNull().default("[]"),
  /** JSON: доп. кнопки водителя на остановке (photo/comment/geo/late/failure) */
  extraActionsJson: text("extra_actions_json").notNull().default("[]"),
  sort: integer("sort").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
});

/** Типы заявок — шаблоны маршрута. */
export const requestTypes = pgTable("request_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  sort: integer("sort").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
});

/** Остановки шаблона маршрута. */
export const requestTypeStops = pgTable(
  "request_type_stops",
  {
    id: serial("id").primaryKey(),
    requestTypeId: integer("request_type_id").notNull(),
    seq: integer("seq").notNull(),
    /** «Склад клиента №1» */
    label: text("label").notNull(),
    pointKind: text("point_kind").notNull(),
    operationTypeId: integer("operation_type_id").notNull(),
    optional: boolean("optional").notNull().default(false),
  },
  (t) => [index("rts_type_idx").on(t.requestTypeId)],
);

/** Заявки: тип, клиент, контейнер и маршрут из остановок (request_stops). */
export const requests = pgTable(
  "requests",
  {
    id: serial("id").primaryKey(),
    /** Человекочитаемый номер: З-2026-0001 */
    number: text("number").notNull().unique(),
    requestTypeId: integer("request_type_id").notNull(),
    clientId: integer("client_id").notNull(),
    containerNo: text("container_no").notNull(),
    containerTypeId: integer("container_type_id").notNull(),
    /** Вес груза, тонн */
    cargoWeightT: doublePrecision("cargo_weight_t").notNull(),
    comment: text("comment"),

    /** new | assigned | accepted | in_progress | done | cancelled */
    status: text("status").notNull().default("new"),
    driverId: integer("driver_id"),
    createdById: integer("created_by_id"),
    /** Тестовый рейс администратора на самого себя */
    isTest: boolean("is_test").notNull().default(false),

    /** Переопределение «напомнить за N мин до прибытия». null → глобальная настройка */
    reminderMinutes: integer("reminder_minutes"),
    /** id последнего отправленного водителю сообщения с карточкой — для актуализации кнопок */
    driverMessageId: text("driver_message_id"),
    /** Текущая (первая непройденная) остановка */
    currentStopId: integer("current_stop_id"),

    assignedAt: timestamp("assigned_at", { withTimezone: true, mode: "date" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    cancelReason: text("cancel_reason"),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [
    index("requests_status_idx").on(t.status),
    index("requests_driver_idx").on(t.driverId),
    index("requests_client_idx").on(t.clientId),
  ],
);

/** Остановки маршрута заявки. */
export const requestStops = pgTable(
  "request_stops",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id").notNull(),
    seq: integer("seq").notNull(),
    pointId: integer("point_id").notNull(),
    operationTypeId: integer("operation_type_id").notNull(),
    /** JSON: OperationSnapshot — копия операции на момент создания заявки */
    operationSnapshotJson: text("operation_snapshot_json").notNull(),
    plannedArrivalAt: timestamp("planned_arrival_at", { withTimezone: true, mode: "date" }),
    arrivedAt: timestamp("arrived_at", { withTimezone: true, mode: "date" }),
    doneAt: timestamp("done_at", { withTimezone: true, mode: "date" }),
    /** JSON: DoneAction[] — отмеченные водителем действия */
    doneActionsJson: text("done_actions_json").notNull().default("[]"),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true, mode: "date" }),
    lateAlertAt: timestamp("late_alert_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [index("stops_request_idx").on(t.requestId)],
);

/** История статусов и событий по заявке. */
export const statusHistory = pgTable(
  "status_history",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id").notNull(),
    /** статус или служебное событие: created | assigned | reassigned | updated | cancelled | alert_late ... */
    status: text("status").notNull(),
    /** driver | dispatcher | system */
    actorKind: text("actor_kind").notNull().default("driver"),
    actorId: integer("actor_id"),
    actorName: text("actor_name"),
    comment: text("comment"),
    latitude: text("latitude"),
    longitude: text("longitude"),
    /** Остановка маршрута и действие, к которым относится событие */
    stopId: integer("stop_id"),
    actionKey: text("action_key"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [index("history_request_idx").on(t.requestId)],
);

/** Вложения от водителя (фото ТН, акты). */
export const attachments = pgTable(
  "attachments",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id").notNull(),
    historyId: integer("history_id"),
    uploadedById: integer("uploaded_by_id"),
    /** image | video | file | audio */
    kind: text("kind").notNull().default("image"),
    fileName: text("file_name"),
    /** Токен вложения MAX (может истечь) */
    maxToken: text("max_token"),
    /** Временная ссылка MAX */
    maxUrl: text("max_url"),
    /** Постоянная ссылка в хранилище (Tigris) */
    storedUrl: text("stored_url"),
    sizeBytes: integer("size_bytes"),
    stopId: integer("stop_id"),
    actionKey: text("action_key"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [index("attachments_request_idx").on(t.requestId)],
);

/** Тревоги: «Возможно опоздание» / «Срыв заявки». */
export const alerts = pgTable(
  "alerts",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id").notNull(),
    /** late | failure | security | no_contact | stop_late */
    type: text("type").notNull(),
    stopId: integer("stop_id"),
    message: text("message"),
    raisedById: integer("raised_by_id"),
    raisedByName: text("raised_by_name"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "date" }),
    acknowledgedById: integer("acknowledged_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [index("alerts_request_idx").on(t.requestId), index("alerts_ack_idx").on(t.acknowledgedAt)],
);

/** Журнал попыток доступа/регистрации — для раздела «Сотрудники». */
export const accessEvents = pgTable(
  "access_events",
  {
    id: serial("id").primaryKey(),
    /** invite_ok | invite_invalid | phone_mismatch | stranger | blocked_attempt | otp_sent | otp_failed | login_ok | name_rejected */
    kind: text("kind").notNull(),
    staffId: integer("staff_id"),
    phone: text("phone"),
    maxUserId: text("max_user_id"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [index("access_kind_idx").on(t.kind)],
);

/** Глобальные настройки key-value. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
});

/** Лог исходящих сообщений бота (и очередь режима заглушки). */
export const botOutbox = pgTable(
  "bot_outbox",
  {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id"),
    maxUserId: text("max_user_id"),
    text: text("text").notNull(),
    payloadJson: text("payload_json"),
    /** stub | sent | failed */
    state: text("state").notNull().default("stub"),
    error: text("error"),
    maxMessageId: text("max_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [index("outbox_staff_idx").on(t.staffId)],
);

/** Диалоговое состояние бота (ожидание комментария/фото по конкретной заявке). */
export const botState = pgTable("bot_state", {
  maxUserId: text("max_user_id").primaryKey(),
  staffId: integer("staff_id"),
  /** idle | awaiting_contact | awaiting_name_confirm | awaiting_comment | awaiting_photo */
  step: text("step").notNull().default("idle"),
  requestId: integer("request_id"),
  inviteId: integer("invite_id"),
  dataJson: text("data_json"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
});

/**
 * Уже обработанные события MAX — защита от двойной обработки (повтор вебхука,
 * два опрашивающих процесса, перезапуск во время обработки). Чистится через 3 дня.
 */
export const processedUpdates = pgTable("processed_updates", {
  key: text("key").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
});

/**
 * Журнал доставки событий MAX.
 *
 * `processed_updates` отвечает на вопрос «это событие уже обрабатывали?» и
 * повторы там молча отбрасываются — для диагностики этого мало. Здесь
 * фиксируется каждое входящее событие и его исход: обработано, отброшено как
 * дубль, отклонено по секрету или с ошибкой.
 *
 * Чистится планировщиком (14 дней).
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: serial("id").primaryKey(),
    /** Тип события MAX: message_created, message_callback, bot_started … */
    updateType: text("update_type"),
    /** Исход: processed | duplicate | bad_secret | bad_json | failed */
    outcome: text("outcome").notNull(),
    /** Идентификатор пользователя MAX, если удалось определить */
    maxUserId: text("max_user_id"),
    /** Текст ошибки при неуспешной обработке */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [
    index("webhook_events_created_idx").on(t.createdAt),
    index("webhook_events_outcome_idx").on(t.outcome),
  ],
);

/**
 * Журнал административных действий.
 *
 * `access_events` закрывает входы и отказы; этот журнал — действия сотрудников
 * с правами администратора: создание и правка карточек, блокировки, смена
 * настроек, подписка на вебхук, выгрузка и стирание персональных данных.
 * Нужен для разбора инцидентов и как доказательство применения мер защиты
 * (ст. 19 152-ФЗ, требования к журналированию).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    /** Кто совершил действие */
    actorId: integer("actor_id"),
    /** ФИО и роль на момент действия — чтобы запись оставалась читаемой
     *  даже после обезличивания карточки сотрудника */
    actorName: text("actor_name"),
    actorRole: text("actor_role"),
    /** Код действия: staff.create, staff.update, staff.erase, settings.update,
     *  webhook.subscribe, webhook.rotate_secret … */
    action: text("action").notNull(),
    /** На что подействовали: staff / settings / webhook / request */
    targetType: text("target_type"),
    /** Идентификатор объекта (для сотрудника — его id) */
    targetId: text("target_id"),
    /** Что именно изменилось */
    detail: text("detail"),
    /** IP-адрес, с которого выполнено действие */
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => [
    index("audit_log_created_idx").on(t.createdAt),
    index("audit_log_actor_idx").on(t.actorId),
    index("audit_log_action_idx").on(t.action),
  ],
);
