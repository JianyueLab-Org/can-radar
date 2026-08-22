import type { APIContext } from "astro";

import { BOARD_TTL_SECONDS, readActivityBoard } from "@/server/activityBoard";
import { LIMITS, clientIp, enforce } from "@/server/rateLimit";

/**
 * 活动板 —— 未来的活动，加上里面已经有人预约的管制席位。
 *
 * 这条和别的 `/api/v1/*` 不一样：它不是一条对一条的转发，而是把「列表 + 每场活
 * 动的席位」那一圈扇出收在服务端跑完，浏览器只发一个请求。为什么这样、以及那份
 * 60 秒缓存和 in-flight 合流，全写在 `src/server/activityBoard.ts` 里。
 *
 * 上游是公开的，这里也不带 cookie，所以**答复对所有人一样** —— 这正是它能带
 * `public` 缓存头的原因，也是它和隔壁 `atc/reservations.ts` 那条最大的分别：那条
 * 每一行都带着 `mine`，只能 `no-store`。
 *
 * 路径没有照抄上游（上游是 `/activity/list` 加 N 个 `/activity/{id}`），因为这里
 * 答的本来就不是它们中的任何一个。`board` 是这一页自己的东西。
 */

export const GET = async (context: APIContext) => {
  const limited = enforce([
    [`activityBoard:ip:${clientIp(context)}`, LIMITS.activityBoard],
  ]);
  if (limited) return limited;

  const board = await readActivityBoard();
  if (!board) {
    return Response.json(
      { status: 502, error: "上游没有响应。" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(board, {
    headers: { "Cache-Control": `public, max-age=${BOARD_TTL_SECONDS}` },
  });
};
