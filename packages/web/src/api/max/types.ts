/** Типы MAX Bot API — только то, что реально используется адаптером. */

export interface MaxUser {
  user_id: number;
  first_name?: string;
  last_name?: string;
  name?: string;
  username?: string;
  is_bot?: boolean;
}

export interface MaxButton {
  type: "callback" | "link" | "request_contact" | "request_geo_location" | "message" | "open_app" | "clipboard";
  text: string;
  /** callback: данные обработчика; open_app: start_param мини-приложения */
  payload?: string;
  url?: string;
  /** callback | positive | negative */
  intent?: "default" | "positive" | "negative";
  quick?: boolean;
  /** open_app: username бота, чьё мини-приложение запускаем */
  web_app?: string;
}

export interface MaxAttachmentRequest {
  type: "inline_keyboard" | "image" | "video" | "file" | "location" | "contact" | "share";
  payload?: Record<string, unknown>;
}

export interface MaxNewMessageBody {
  text?: string;
  attachments?: MaxAttachmentRequest[];
  notify?: boolean;
  format?: "markdown" | "html";
}

export interface MaxAttachment {
  type: string;
  payload?: {
    token?: string;
    url?: string;
    vcf_info?: string;
    hash?: string;
    max_info?: MaxUser;
    latitude?: number;
    longitude?: number;
    [k: string]: unknown;
  };
  filename?: string;
  size?: number;
}

export interface MaxMessage {
  sender?: MaxUser;
  recipient?: { chat_id?: number; chat_type?: string; user_id?: number };
  timestamp?: number;
  body?: {
    mid?: string;
    seq?: number;
    text?: string | null;
    attachments?: MaxAttachment[];
  };
}

export interface MaxCallback {
  timestamp: number;
  callback_id: string;
  payload?: string;
  user: MaxUser;
}

export interface MaxUpdate {
  update_type: string;
  timestamp: number;
  /** bot_started / bot_stopped */
  chat_id?: number;
  user?: MaxUser;
  payload?: string;
  user_locale?: string;
  /** message_created / message_edited */
  message?: MaxMessage;
  /** message_callback */
  callback?: MaxCallback;
  user_id?: number;
}

export interface MaxSendResult {
  ok: boolean;
  messageId?: string;
  stub?: boolean;
  error?: string;
}
