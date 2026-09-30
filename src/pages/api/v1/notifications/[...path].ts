import type { APIContext } from "astro";

import { handleNotifications } from "@/server/notifications";

/**
 * 通知铃：`/api/v1/notifications`、`…/unread`、`…/read-all`、
 * `…/{member|broadcast}/{id}`。不带 `can_session` 答 401，不问上游。
 * 逻辑和测试在 `@/server/notifications`。
 */
export const GET = (context: APIContext) => handleNotifications(context);
export const POST = GET;
export const PATCH = GET;
