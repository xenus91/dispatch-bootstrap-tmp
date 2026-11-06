import { base } from "../core/app";

export const ping = base.handler(() => ({ message: `Pong! ${Date.now()}` }));
