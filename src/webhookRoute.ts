// Shared between server.ts (which exempts this prefix from the initData auth
// hook) and bot.ts (which mounts the actual route). Kept in its own module so
// server.ts needn't import bot.js — tests mock bot.js and would otherwise throw
// on this named export.
export const WEBHOOK_ROUTE_PREFIX = '/tg'
