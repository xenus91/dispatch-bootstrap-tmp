import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Клиент PostgreSQL.
 *
 * Раньше здесь был libSQL/Turso (SQLite в облаке за пределами РФ). С 1 июля 2025 г.
 * ч. 5 ст. 18 152-ФЗ прямо запрещает записывать персональные данные граждан РФ
 * в базы, расположенные за пределами России, поэтому база перенесена на
 * PostgreSQL на VPS в РФ.
 *
 * Пул один на процесс: приложение работает в одном инстансе, и несколько пулов
 * — верный путь к исчерпанию соединений на стороне PostgreSQL.
 */

/** Нужно ли шифрование соединения. Для контейнерной БД внутри одной сети — нет,
 *  для внешнего управляемого PostgreSQL — да. */
function sslConfig() {
  const flag = (process.env.DATABASE_SSL ?? "").toLowerCase();
  if (flag === "disable" || flag === "false" || flag === "0") return undefined;
  if (flag === "require" || flag === "true" || flag === "1") return { rejectUnauthorized: true };
  // По умолчанию: включаем TLS, если сервер его требует (node-postgres умеет
  // это через sslmode=require в строке подключения).
  return undefined;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL не задан — приложение не может подключиться к базе.");
}

export const pool = new Pool({
  connectionString,
  max: Number.parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: sslConfig(),
});

/** Имя пула в логах Postgres — чтобы видеть, чей это соединение. */
pool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error("[db] ошибка соединения:", err instanceof Error ? err.message : err);
  });
});

export const db = drizzle(pool, { schema });

/** Аккуратно закрыть пул при остановке процесса. */
export async function closeDb() {
  await pool.end();
}
