import type { APIContext } from "astro";

import { LIMITS, clientIp, enforce } from "@/server/rateLimit";
import { readMember } from "@/server/session";

/**
 * 「我现在是谁」——给页面里的岛屿用的那一份。
 *
 * 页面第一次渲染时会话是**服务端**读好、当作 prop 传进去的，所以这个路由不是
 * 首屏用的。它存在只为一件事：**在另一个标签页登录完之后，这一页自己认出来**。
 *
 * 登录入口在主站（这个站点没有密码表单，也不该有），所以「登录」是一个跳到
 * ceruleanavi.net 的链接。人在那边登录完回到这个标签页时，浏览器里已经有会话
 * cookie 了，但这一页是十分钟前渲染的，它并不知道 —— 于是岛屿在标签页重新获得
 * 焦点时问一次这里。不问的话，唯一的出路是让人手动刷新，而「我明明登录了」是
 * 一种没有人会去报的 bug。
 *
 * 答复的形状照抄 can-api：没登录是 `200 {"user": null}`，不是 401。公开页面上
 * 「没登录」是常态而不是错误，而每次匿名访问都在控制台留一条红色 401，只会训
 * 练人忽略控制台。
 */

export const GET = async (context: APIContext) => {
  const limited = enforce([
    [`session:ip:${clientIp(context)}`, LIMITS.session],
  ]);
  if (limited) return limited;

  const member = await readMember(context);

  return Response.json(
    { user: member },
    {
      headers: {
        // 绝不能被缓存：这是随人而异的答复，中间任何一层把它存下来，都等于把
        // 一个人的身份发给下一个访客。
        "Cache-Control": "no-store, private",
      },
    },
  );
};
