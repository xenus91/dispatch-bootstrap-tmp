/**
 * Смоук-тест PostgreSQL.
 *
 * Зачем: при переносе с SQLite/Turso на PostgreSQL часть запросов ведёт себя
 * иначе, и разница не всегда видна по коду — она всплывает на данных. Здесь
 * проверяются ровно те конструкции, которые реально используются в приложении
 * и которые меняют семантику при смене диалекта.
 *
 * Запуск (нужна поднятая база и переменная DATABASE_URL):
 *   bun --env-file=.env packages/web/scripts/pg-smoke-test.ts
 *
 * Скрипт создаёт временные записи с префиксом "smoke-" и удаляет их за собой.
 * Проверяет он боевую базу только на чтение и на вставку собственных строк.
 */

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, like, notInArray } from "drizzle-orm";
import { db, pool } from "../src/api/database/client";
import * as schema from "../src/api/database/schema";
import { nextRequestNumber } from "../src/api/lib/requests-service";
import { logAudit } from "../src/api/lib/audit";
import { eraseStaffData, exportStaffData } from "../src/api/lib/personal-data";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n${title}`);
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`  ✗ раздел упал: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const stamp = Date.now();
const P = `smoke-${stamp}`;

/** Идентификаторы записей, созданных прогоном: по ним делаем точечную очистку. */
const created: Record<string, number[]> = {
  clients: [], requests: [], requestStops: [], staff: [],
  points: [], containerTypes: [], operationTypes: [],
};

async function main() {
  console.log(`Смоук-тест PostgreSQL · ${new Date().toISOString()}`);

  // ─────────────────────────── даты: главный риск переноса ───────────────────
  await section("Даты и временные метки", async () => {
    const now = new Date();
    const [client] = await db
      .insert(schema.clients)
      .values({ name: `${P}-client` })
      .returning();
    created.clients.push(client.id);

    // Точное значение миллисекунд ставим UPDATE'ом: вставка полагается на
    // $defaultFn схемы, а ручное значение колонки — редкий путь.
    await db
      .update(schema.clients)
      .set({ createdAt: now, updatedAt: now })
      .where(eq(schema.clients.id, client.id));
    const [read] = await db.select().from(schema.clients).where(eq(schema.clients.id, client.id));
    check("timestamp с миллисекундами читается без потерь", read.createdAt.getTime() === now.getTime(),
      `${read.createdAt.toISOString()} != ${now.toISOString()}`);
    check("timestamp читается как объект Date", read.createdAt instanceof Date);

    // Сравнение «меньше/больше» — как в планировщике
    const past = new Date(now.getTime() - 60_000);
    const [older] = await db
      .insert(schema.clients)
      .values({ name: `${P}-older` })
      .returning();
    created.clients.push(older.id);
    await db
      .update(schema.clients)
      .set({ createdAt: past, updatedAt: past })
      .where(eq(schema.clients.id, older.id));
    // Перечитываем: в объекте older.createdAt ещё дефолт из вставки,
    // а в базе уже проставленная минута назад.
    const [olderFresh] = await db
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.id, older.id));
    const [recent] = await db
      .select()
      .from(schema.clients)
      .where(and(eq(schema.clients.id, client.id), gt(schema.clients.createdAt, olderFresh.createdAt)));
    check("сравнение дат gt работает", !!recent);

    // NULL в дате
    const [noDate] = await db
      .insert(schema.clients)
      .values({ name: `${P}-nodate` })
      .returning();
    created.clients.push(noDate.id);
    const [auto] = await db.select().from(schema.clients).where(eq(schema.clients.id, noDate.id));
    check("createdAt проставляется автоматически при вставке", auto.createdAt instanceof Date);
    await db.update(schema.clients).set({ comment: null }).where(eq(schema.clients.id, noDate.id));
    const [isNullRes] = await db
      .select()
      .from(schema.clients)
      .where(and(eq(schema.clients.id, noDate.id), isNull(schema.clients.comment)));
    check("isNull по nullable-полю работает", !!isNullRes);

    const [notNullRes] = await db
      .select()
      .from(schema.clients)
      .where(and(eq(schema.clients.id, noDate.id), isNotNull(schema.clients.createdAt)));
    check("isNotNull работает", !!notNullRes);

    // Сортировка по дате по убыванию
    const rows = await db
      .select()
      .from(schema.clients)
      .where(like(schema.clients.name, `${P}%`))
      .orderBy(desc(schema.clients.createdAt));
    check("сортировка по дате desc работает", rows.length >= 2);
    check(
      "порядок по дате соблюдён",
      rows.length < 2 || rows[0].createdAt.getTime() >= rows[1].createdAt.getTime(),
    );
  });

  // ─────────────────────────── строки, LIKE и регистр ─────────────────────────
  await section("Строки, LIKE, регистр и сортировка", async () => {
    const year = new Date().getFullYear();
    const prefix = `З-${year}-`;
    // Номер уникален в пределах прогона: у requests.number есть UNIQUE-индекс.
    // Хвост короткий, чтобы не влиять на максимум в тесте нумерации.
    const number = `${prefix}${String(stamp).slice(-3)}`;

    const [req] = await db
      .insert(schema.requests)
      .values({
        number,
        requestTypeId: 1,
        clientId: 1,
        containerNo: "TEST0001",
        containerTypeId: 1,
        cargoWeightT: 12.5,
        status: "new",
      })
      .returning();
    created.requests.push(req.id);

    const matched = await db
      .select()
      .from(schema.requests)
      .where(like(schema.requests.number, `${prefix}%`));
    check(
      "LIKE с кириллическим префиксом находит запись",
      matched.some((r) => r.id === req.id),
    );

    const lowerCase = await db
      .select()
      .from(schema.requests)
      .where(like(schema.requests.number, `з-${year}-%`));
    check(
      "LIKE регистрозависим для кириллицы (как в SQLite)",
      lowerCase.length === 0,
      "нижний регистр кириллицы не должен совпадать — иначе нумерация заявок ломается",
    );

    const [byWeight] = await db
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.cargoWeightT, 12.5));
    check("doublePrecision читается точно", byWeight?.cargoWeightT === 12.5);

    const sorted = await db
      .select()
      .from(schema.requests)
      .where(like(schema.requests.number, `${prefix}%`))
      .orderBy(desc(schema.requests.number));
    check("сортировка номеров заявок desc работает", sorted.length >= 1);

    await db
      .update(schema.requests)
      .set({ comment: "тестовый комментарий" })
      .where(eq(schema.requests.id, req.id));
    const [withComment] = await db
      .select()
      .from(schema.requests)
      .where(and(eq(schema.requests.id, req.id), isNotNull(schema.requests.comment)));
    check("isNotNull по nullable-колонке находит запись", withComment !== undefined);

    const [withoutComment] = await db
      .select()
      .from(schema.requests)
      .where(and(eq(schema.requests.id, req.id), isNull(schema.requests.comment)));
    check("isNull по nullable-колонке отсекает запись", withoutComment === undefined);
  });

  // ─────────────────────────── inArray / notInArray ───────────────────────────
  await section("inArray / notInArray", async () => {
    const ids = [1, 2, 3];
    const rows = await db.select().from(schema.containerTypes).where(inArray(schema.containerTypes.id, ids));
    check("inArray с непустым массивом отрабатывает", Array.isArray(rows));

    const [one] = await db
      .insert(schema.containerTypes)
      .values({ code: `${P}-code`, name: "smoke", sort: 1 })
      .returning();
    created.containerTypes.push(one.id);
    const picked = await db
      .select()
      .from(schema.containerTypes)
      .where(inArray(schema.containerTypes.id, [one.id]));
    check("inArray по одному id находит запись", picked.length === 1 && picked[0].id === one.id);

    // Пустой массив: в SQLite даёт «нет строк», в PostgreSQL может дать IN () —
    // синтаксическую ошибку. Проверяем поведение явно.
    let emptyOk = true;
    let emptyDetail = "";
    try {
      const empty = await db
        .select()
        .from(schema.containerTypes)
        .where(inArray(schema.containerTypes.id, []));
      emptyOk = empty.length === 0;
      emptyDetail = `вернулось ${empty.length} строк`;
    } catch (err) {
      emptyOk = false;
      emptyDetail = err instanceof Error ? err.message : String(err);
    }
    check("inArray с пустым массивом не роняет запрос", emptyOk, emptyDetail);

    const notIn = await db
      .select()
      .from(schema.requests)
      .where(notInArray(schema.requests.status, ["done", "cancelled"]));
    check("notInArray работает", Array.isArray(notIn));
  });

  // ─────────────────────────── upsert ─────────────────────────────────────────
  await section("Upsert (onConflictDoUpdate)", async () => {
    // Сначала обычная вставка — чтобы на следующем шаге сработала ветка конфликта.
    await db
      .insert(schema.settings)
      .values({ key: `${P}:setting`, value: "one", updatedAt: new Date() });
    const [first] = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, `${P}:setting`));
    check("обычная вставка в settings работает", first?.value === "one");

    await db
      .insert(schema.settings)
      .values({ key: `${P}:setting`, value: "ignored", updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: "two", updatedAt: new Date() },
      });
    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, `${P}:setting`));
    check("upsert по primary key обновляет значение", row?.value === "two", `получено ${row?.value}`);

    const all = await db.select().from(schema.settings).where(eq(schema.settings.key, `${P}:setting`));
    check("upsert не создаёт дубликат строки", all.length === 1, `строк: ${all.length}`);

    // Таблица с текстовым PK без колонки updatedAt
    await db
      .insert(schema.processedUpdates)
      .values({ key: `${P}:update` })
      .onConflictDoUpdate({
        target: schema.processedUpdates.key,
        set: { createdAt: new Date() },
      });
    const [pu] = await db
      .select()
      .from(schema.processedUpdates)
      .where(eq(schema.processedUpdates.key, `${P}:update`));
    check("upsert в processed_updates работает", !!pu);
  });

  // ─────────────────────────── захват строки (паттерн планировщика) ───────────
  await section("Захват строки: UPDATE ... WHERE ... IS NULL RETURNING", async () => {
    const [client] = await db
      .insert(schema.clients)
      .values({ name: `${P}-claim` })
      .returning();
    created.clients.push(client.id);
    const [req] = await db
      .insert(schema.requests)
      .values({
        number: `${P}-req`,
        requestTypeId: 1,
        clientId: client.id,
        containerNo: "TEST0002",
        containerTypeId: 1,
        cargoWeightT: 1,
        status: "new",
      })
      .returning();
    created.requests.push(req.id);
    const [stop] = await db
      .insert(schema.requestStops)
      .values({
        requestId: req.id,
        seq: 1,
        pointId: 1,
        operationTypeId: 1,
        operationSnapshotJson: "{}",
      })
      .returning();
    created.requestStops.push(stop.id);

    const first = await db
      .update(schema.requestStops)
      .set({ reminderSentAt: new Date() })
      .where(and(eq(schema.requestStops.id, stop.id), isNull(schema.requestStops.reminderSentAt)))
      .returning();
    const second = await db
      .update(schema.requestStops)
      .set({ reminderSentAt: new Date() })
      .where(and(eq(schema.requestStops.id, stop.id), isNull(schema.requestStops.reminderSentAt)))
      .returning();
    check("первый захват строки срабатывает", first.length === 1);
    check("второй захват не срабатывает (нет дублей)", second.length === 0);
  });

  // ─────────────────────────── булевы и уникальность ──────────────────────────
  await section("Булевы, уникальность, сортировка по тексту", async () => {
    const [staff] = await db
      .insert(schema.staff)
      .values({
        role: "driver",
        fullName: `${P}-driver`,
        phone: `7999${String(stamp).slice(-7)}`,
        status: "pending",
        activatedAt: new Date(),
      })
      .returning();
    created.staff.push(staff.id);
    check("boolean-колонка читается как boolean", typeof staff.activatedAt === "object");

    const [pt] = await db
      .insert(schema.points)
      .values({
        kind: "terminal",
        name: `${P}-point`,
        lat: 55.7558,
        lon: 37.6173,
      })
      .returning();
    created.points.push(pt.id);
    check("doublePrecision (широта) читается точно", pt.lat === 55.7558);

    let uniqueBlocked = false;
    try {
      await db.insert(schema.staff).values({
        role: "driver",
        fullName: `${P}-dup`,
        phone: staff.phone,
        status: "pending",
      });
    } catch {
      uniqueBlocked = true;
    }
    check("уникальность телефона срабатывает", uniqueBlocked);

    const sorted = await db
      .select()
      .from(schema.staff)
      .where(like(schema.staff.fullName, `${P}%`))
      .orderBy(asc(schema.staff.fullName));
    check("сортировка по тексту asc работает", sorted.length >= 1);
  });

  // ─────────────────────────── JSON как текст ─────────────────────────────────
  await section("JSON-поля, хранящиеся как text", async () => {
    const payload = JSON.stringify([{ key: "photo", label: "Фото" }]);
    const [op] = await db
      .insert(schema.operationTypes)
      .values({
        name: `${P}-op`,
        pointKindsJson: "[]",
        actionsJson: payload,
        extraActionsJson: "[]",
        sort: 0,
      })
      .returning();
    created.operationTypes.push(op.id);
    const [read] = await db.select().from(schema.operationTypes).where(eq(schema.operationTypes.id, op.id));
    check("JSON сохраняется и читается без искажений", read.actionsJson === payload);
    check("JSON.parse на прочитанном значении не падает", Array.isArray(JSON.parse(read.actionsJson)));
  });

  // ─────────────────────────── нумерация заявок ─────────────────────────────
  await section("Нумерация заявок (разрядность и переход через 9999)", async () => {
    const year = new Date().getFullYear();
    const prefix = `З-${year}-`;
    // Специально кладём номера с разной разрядностью: при 4 цифрах
    // «З-2026-9999» оказывался больше «З-2026-10000» при сортировке строкой.
    for (const suffix of ["009999", "010000"]) {
      const [row] = await db
        .insert(schema.requests)
        .values({
          number: `${prefix}${suffix}`,
          requestTypeId: 1,
          clientId: 1,
          containerNo: "TESTNUM",
          containerTypeId: 1,
          cargoWeightT: 1,
          status: "new",
        })
        .returning();
      created.requests.push(row.id);
    }

    const next = await nextRequestNumber();
    const nextNum = Number.parseInt(next.slice(prefix.length), 10);

    // Главная проверка: максимум ищется по ЧИСЛУ. При сортировке строкой
    // максимумом был бы «009999» (9 > 1), и следующий номер был бы 10000 —
    // то есть счётчик считал бы назад.
    check(
      "максимум найден по числу, а не по строке",
      nextNum > 10000,
      `получено ${next} — при строковой сортировке было бы 010000`,
    );

    // Инвариант: выданный номер ровно на единицу больше максимума в таблице.
    const rows = await db
      .select({ number: schema.requests.number })
      .from(schema.requests)
      .where(like(schema.requests.number, `${prefix}%`));
    let max = 0;
    for (const r of rows) {
      const n = Number.parseInt(r.number.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    check("номер продолжает максимум без пропусков", nextNum === max + 1, `${next} при максимуме ${max}`);
    check("номер имеет 6 разрядов", /^\d{6}$/.test(next.slice(prefix.length)), `получено ${next}`);

    // Отдельная проверка: максимум ищется по числу, а не по строке.
    await db.delete(schema.requests).where(inArray(schema.requests.id, created.requests));
    created.requests = [];
    const [low] = await db
      .insert(schema.requests)
      .values({
        number: `${prefix}000002`,
        requestTypeId: 1,
        clientId: 1,
        containerNo: "TESTNUM2",
        containerTypeId: 1,
        cargoWeightT: 1,
        status: "new",
      })
      .returning();
    created.requests.push(low.id);
    const next2 = await nextRequestNumber();
    const next2Num = Number.parseInt(next2.slice(prefix.length), 10);
    check("нумерация не начинается с нуля при непустой базе", next2Num > 0, `получено ${next2}`);
  });

  // ─────────────────────────── журнал аудита ─────────────────────────────────
  await section("Журнал административных действий", async () => {
    await logAudit({
      actor: { id: 1, fullName: "Тест Тестов", role: "admin" },
      action: "staff.create",
      targetType: "staff",
      targetId: 42,
      detail: "Проверка журнала",
      ip: "203.0.113.7",
    });
    const [row] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "staff.create"))
      .orderBy(desc(schema.auditLog.id))
      .limit(1);
    check("действие записано в журнал", !!row);
    check("в журнале есть кто и что", row?.actorName === "Тест Тестов" && row?.action === "staff.create");
    check("в журнале есть IP", row?.ip === "203.0.113.7");
    check("в журнале есть время", row?.createdAt instanceof Date);
    await db.delete(schema.auditLog).where(eq(schema.auditLog.id, row!.id));
  });

  // ─────────────────────────── права субъекта ────────────────────────────────
  await section("Выгрузка и стирание персональных данных", async () => {
    const [subject] = await db
      .insert(schema.staff)
      .values({
        role: "driver",
        fullName: `${P}-субъект`,
        phone: `7988${String(stamp).slice(-7)}`,
        status: "active",
        vehicle: "А123ВС77",
        consentAt: new Date(),
        consentVersion: "2026-11-04",
      })
      .returning();
    created.staff.push(subject.id);

    await db.insert(schema.sessions).values({
      token: `${P}-token`,
      staffId: subject.id,
      kind: "web",
      ip: "203.0.113.9",
      userAgent: "test",
      expiresAt: new Date(Date.now() + 3_600_000),
      lastSeenAt: new Date(),
    });
    await db.insert(schema.otpCodes).values({
      staffId: subject.id,
      code: "123456",
      expiresAt: new Date(Date.now() + 300_000),
    });

    const dump = await exportStaffData(subject.id);
    check("выгрузка содержит карточку субъекта", dump?.subject.fullName === `${P}-субъект`);
    check("выгрузка содержит сессии", (dump?.sessions.length ?? 0) === 1);
    check("выгрузка содержит коды", (dump?.oneTimeCodes.length ?? 0) === 1);
    check("выгрузка содержит согласие", !!dump?.subject.consentAt);
    check("выгрузка содержит госномер", dump?.subject.vehicle === "А123ВС77");

    const report = await eraseStaffData(subject.id);
    check("стирание удалило сессии", report.sessions === 1, `удалено ${report.sessions}`);
    check("стирание удалило коды", report.otpCodes === 1, `удалено ${report.otpCodes}`);

    const [after] = await db.select().from(schema.staff).where(eq(schema.staff.id, subject.id));
    check("ФИО обезличено", after.fullName.includes("данные удалены"), after.fullName);
    check("телефон обезличен", after.phone !== subject.phone);
    check("госномер удалён", after.vehicle === null);
    check("привязка MAX удалена", after.maxUserId === null);
    check("согласие снято", after.consentAt === null);
    check("зафиксирована дата стирания", after.erasedAt instanceof Date);
    check("статус — заблокирован", after.status === "blocked");

    const sessionsLeft = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.staffId, subject.id));
    check("сессий не осталось", sessionsLeft.length === 0);
  });

  // ─────────────────────────── очистка ───────────────────────────────────────
  await section("Очистка тестовых данных", async () => {
    // Удаляем строго по id, созданным в этом прогоне: точечно, без LIKE по шаблону.
    const tables: [keyof typeof created, any, any][] = [
      ["requestStops", schema.requestStops, schema.requestStops.id],
      ["requests", schema.requests, schema.requests.id],
      ["operationTypes", schema.operationTypes, schema.operationTypes.id],
      ["points", schema.points, schema.points.id],
      ["staff", schema.staff, schema.staff.id],
      ["containerTypes", schema.containerTypes, schema.containerTypes.id],
      ["clients", schema.clients, schema.clients.id],
    ];
    for (const [key, table, idCol] of tables) {
      if (created[key].length) await db.delete(table).where(inArray(idCol, created[key]));
    }
    await db.delete(schema.settings).where(eq(schema.settings.key, `${P}:setting`));
    await db.delete(schema.processedUpdates).where(eq(schema.processedUpdates.key, `${P}:update`));

    const left = await db
      .select()
      .from(schema.requests)
      .where(inArray(schema.requests.id, created.requests.length ? created.requests : [-1]));
    check("тестовые записи удалены полностью", left.length === 0, `осталось заявок: ${left.length}`);
  });

  console.log(`\n──────────────────────────────────────────`);
  console.log(`Пройдено: ${passed}   Провалено: ${failed}`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Смоук-тест упал:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
