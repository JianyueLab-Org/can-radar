import type { Pilot } from "./radarTypes";

/**
 * 登录着的那个人，以及怎么在数据源里认出他的飞机。
 *
 * 放在 `lib/` 而不是 `server/`：服务端读会话（`server/session.ts`）和岛屿在地
 * 图上找飞机，用的是同一个形状和同一条规则，而那条规则值得只写一遍。
 */

/** can-api 愿意告诉前端的那份成员身份（它的 `memberIdentity`）。 */
export interface Member {
  /** CAN ID。 */
  username: string;
  name: string;
  rating: number;
}

/**
 * 「我的飞机」的全部依据：**数据源里的 `cid` 就是成员的 `username`**。
 *
 * 这不是巧合，是一条跨了三个仓库的等式。can-fsd 用飞行员登录时报的 CID 去查
 * `user` 表（`WHERE username = ?`，见它的 `internal/store/user.go`），认下来之
 * 后原样写进数据源的 `cid` 字段；can-api 的会话里那个 `sub` 也是同一列。所以
 * 一个字符串比较就够了，不需要再去问任何人「这架是谁的」。
 *
 * 比较忽略大小写。注册发出来的 CAN ID 是纯数字（can-api 的 `nextCANID`），大
 * 小写无从谈起；但那张表里**还有一批不是 CAN ID 的用户名**（它自己的注释这么
 * 写的），而那些账号一样能连线。两边同一个字符串、只有大小写不同就认不出自己
 * 的飞机，是一种没人能自己看出原因的失败。
 */
export function isMine(pilot: Pilot, member: Member | null): boolean {
  if (!member?.username) return false;
  return (pilot.cid || "").toLowerCase() === member.username.toLowerCase();
}

/**
 * 自己那架飞机在地图和列表里用的键，没连线时是 null。
 *
 * 键从**数据源里的那架飞机**拼出来，而不是从会话里的 ID 拼：地图和列表的键是
 * `cid || callsign`，照着会话拼会在极少数没有 cid 的连接上对不上号，大小写也
 * 会跟着会话那一份走而不是数据源那一份。
 */
export function myFlightKey(
  pilots: Pilot[] | undefined,
  member: Member | null,
): string | null {
  const mine = pilots?.find((p) => isMine(p, member));
  return mine ? `pilot:${mine.cid || mine.callsign}` : null;
}
