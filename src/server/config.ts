/**
 * 服务端读的那几个地址，以及会话 cookie 的名字。
 *
 * 三个 `/api/v1/*` 转发以前各自抄了一遍 `CAN_API_ORIGIN` 的解析，加上会话又要
 * 用一次就是第四遍了 —— 这里收成一处。全部在服务端读，**一个都不带 `PUBLIC_`
 * 前缀的语义**：`PUBLIC_ORIGIN` 是个例外的名字（Astro 不会把它塞进客户端包，
 * 它只是这个部署自己的对外地址），也只在服务端用来比对写操作的 Origin。
 */

/** 会话 cookie 的名字。can-api 的 `internal/session` 定义，改名要两边一起改。 */
export const SESSION_COOKIE = "can_session";

const trim = (value: string) => value.replace(/\/+$/, "");

/** 数据层。航迹、天气、以及「这枚 cookie 是谁」都问它。 */
export const apiOrigin = () =>
  trim(process.env.CAN_API_ORIGIN || "https://api.ceruleanavi.net");

/**
 * 主站。页眉的导航和**唯一的登录入口**都指向它。
 *
 * 和 can-dev 一样分成两个地址而不是一个：登录页是一个要渲染给人看、带着主站样
 * 式的**页面**，它没有跟着数据层搬进 can-api。本地开发时主站在 :4321，所以这
 * 个值必须可配，否则开发机上的「登录」会把人送到线上去。
 */
export const webOrigin = () =>
  trim(process.env.CAN_WEB_ORIGIN || "https://ceruleanavi.net");

/**
 * 这个部署自己的对外地址。
 *
 * 只有一个用途：比对写操作的 `Origin` 头（见 `guard.ts`）。它是**显式配置**
 * 而不是从 `Host` 头推的，因为这个站跑在 TLS 终止的反代后面，从请求头推出来的
 * 东西正是反代能影响的东西。
 */
export const publicOrigin = () =>
  trim(process.env.PUBLIC_ORIGIN || "http://localhost:4323");
