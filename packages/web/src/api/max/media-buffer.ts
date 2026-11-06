import type { MaxAttachment, MaxUpdate } from "./types";

/**
 * Буфер входящих медиа: альбом или серия фото приходит отдельными сообщениями,
 * а ответить нужно один раз. Сообщения одного пользователя копятся, пока между
 * ними меньше DEBOUNCE_MS, затем пачка обрабатывается целиком.
 * Состояние в globalThis — переживает hot-reload, как и long polling.
 */

export const MEDIA_TYPES = ["image", "photo", "video", "file"];
const IGNORED_TYPES = ["inline_keyboard", "contact", "location", "share", "sticker"];

export interface MediaItem {
  type: string;
  token: string | null;
  url: string | null;
  fileName: string | null;
  size: number | null;
}

export interface MediaBatch {
  maxUserId: string;
  items: MediaItem[];
  captions: string[];
  /** Сообщения без распознанных файлов (неизвестный тип вложения) */
  unknown: number;
}

type Flush = (batch: MediaBatch) => Promise<void>;

interface Pending {
  batch: MediaBatch;
  timer: ReturnType<typeof setTimeout> | null;
}

const g = globalThis as unknown as { __maxMediaBuffer?: Map<string, Pending>; __maxMediaFlush?: Flush };
const buffers = (g.__maxMediaBuffer ??= new Map());

export const debounceMs = () => Number(process.env.MAX_MEDIA_DEBOUNCE_MS ?? 2500);

/** Вложения сообщения, включая пересланные (message.link.message.body.attachments). */
export function messageAttachments(update: MaxUpdate): MaxAttachment[] {
  const own = update.message?.body?.attachments ?? [];
  const linked =
    (update.message as { link?: { message?: { attachments?: MaxAttachment[]; body?: { attachments?: MaxAttachment[] } } } })
      ?.link?.message;
  return [...own, ...(linked?.body?.attachments ?? linked?.attachments ?? [])];
}

/** Медиа из сообщения; неизвестные типы пишутся в лог, чтобы видеть, что шлёт клиент MAX. */
export function extractMedia(attachments: MaxAttachment[]): { items: MediaItem[]; unknownTypes: string[] } {
  const items: MediaItem[] = [];
  const unknownTypes: string[] = [];
  for (const a of attachments) {
    if (MEDIA_TYPES.includes(a.type)) {
      items.push({
        type: a.type === "photo" ? "image" : a.type,
        token: (a.payload?.token as string | undefined) ?? null,
        url: (a.payload?.url as string | undefined) ?? null,
        fileName: a.filename ?? null,
        size: a.size ?? null,
      });
    } else if (!IGNORED_TYPES.includes(a.type)) {
      unknownTypes.push(a.type);
    }
  }
  if (unknownTypes.length) console.warn(`[max] unknown attachment type: ${unknownTypes.join(", ")}`);
  return { items, unknownTypes };
}

export function setMediaFlush(fn: Flush) {
  g.__maxMediaFlush = fn;
}

/** Сбросы, которые уже идут: «Готово» должно дождаться сохранения файлов. */
const inFlight = new Map<string, Promise<void>>();

async function run(maxUserId: string) {
  const pending = buffers.get(maxUserId);
  if (!pending) return;
  buffers.delete(maxUserId);
  const prev = inFlight.get(maxUserId) ?? Promise.resolve();
  const job = prev.then(async () => {
    try {
      await g.__maxMediaFlush?.(pending.batch);
    } catch (err) {
      console.error("[max] media flush failed:", err);
    }
  });
  inFlight.set(maxUserId, job);
  await job;
  if (inFlight.get(maxUserId) === job) inFlight.delete(maxUserId);
}

export function pushMedia(maxUserId: string, part: { items: MediaItem[]; caption?: string | null; unknown?: boolean }) {
  let pending = buffers.get(maxUserId);
  if (!pending) {
    pending = { batch: { maxUserId, items: [], captions: [], unknown: 0 }, timer: null };
    buffers.set(maxUserId, pending);
  }
  pending.batch.items.push(...part.items);
  if (part.caption) pending.batch.captions.push(part.caption);
  if (part.unknown) pending.batch.unknown += 1;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => void run(maxUserId), debounceMs());
}

export const hasPendingMedia = (maxUserId: string) => buffers.has(maxUserId);

/** Для тестов и для действий, которым нужны уже сохранённые файлы (кнопка «Готово»). */
export async function flushMedia(maxUserId?: string) {
  const ids = maxUserId ? [maxUserId] : [...new Set([...buffers.keys(), ...inFlight.keys()])];
  for (const id of ids) {
    const pending = buffers.get(id);
    if (!pending) continue; // уже сбрасывается по таймеру — дождёмся ниже
    if (pending.timer) clearTimeout(pending.timer);
    await run(id);
  }
  for (const id of ids) await inFlight.get(id);
}
