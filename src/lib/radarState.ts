/**
 * 雷达的两种「记得住的状态」，以及它们为什么分开。
 *
 * **设置**（底图、图层开关、单位）是**这个人**的偏好，跟着浏览器走，存
 * localStorage。发给别人的链接不该把我的底图口味一起带过去。
 *
 * **视图**（选中了谁、地图中心和缩放）是**这一刻在看什么**，写进 URL。管制员在
 * 群里发「看这架」的时候，需要对方点开就是同一个画面；而这种东西存进
 * localStorage 只会让下次打开时停在一架早就落地的飞机上。
 *
 * 两边都必须容错到「读不出来就当没有」：localStorage 可能被隐私模式禁用，URL 可
 * 能被人手工改坏，而这两种情况都不该让地图打不开。
 */

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

/** 底图。深浅两套跟随主题，卫星是独立选择。 */
export type Basemap = "auto" | "dark" | "light" | "satellite";

/** 高度和距离的单位。航空口径是英尺/海里，公制是给不看航图的人准备的。 */
export type Units = "aviation" | "metric";

export interface RadarSettings {
  basemap: Basemap;
  /** 管制区边界。关掉之后地图上只剩飞机，看流量分布时清爽得多。 */
  boundaries: boolean;
  /** 机场标签（带在场席位的那些方块）。 */
  airportTags: boolean;
  /** 管制员的覆盖范围环。 */
  rangeRings: boolean;
  units: Units;
}

export const DEFAULT_SETTINGS: RadarSettings = {
  basemap: "auto",
  boundaries: true,
  airportTags: true,
  rangeRings: true,
  units: "aviation",
};

const SETTINGS_KEY = "can-radar:settings";

/**
 * 读设置。任何一项读不出来或类型不对，就退回默认值那一项 —— 不是整份退回。
 *
 * 逐项校验而不是整份信任，是因为这份东西会跨版本存活：加了一个新开关之后，老浏
 * 览器里存着的那份没有它，整份退回会把用户其余的选择一起清掉。
 */
export function loadSettings(): RadarSettings {
  const stored = readJSON(SETTINGS_KEY);
  if (!stored || typeof stored !== "object") return { ...DEFAULT_SETTINGS };

  const raw = stored as Record<string, unknown>;
  return {
    basemap: oneOf(
      raw.basemap,
      ["auto", "dark", "light", "satellite"] as const,
      DEFAULT_SETTINGS.basemap,
    ),
    boundaries: bool(raw.boundaries, DEFAULT_SETTINGS.boundaries),
    airportTags: bool(raw.airportTags, DEFAULT_SETTINGS.airportTags),
    rangeRings: bool(raw.rangeRings, DEFAULT_SETTINGS.rangeRings),
    units: oneOf(
      raw.units,
      ["aviation", "metric"] as const,
      DEFAULT_SETTINGS.units,
    ),
  };
}

export function saveSettings(settings: RadarSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式下 localStorage 会抛。设置存不下是小事，地图打不开是大事。
  }
}

/* ------------------------------------------------------------------ *
 * 视图（URL）
 * ------------------------------------------------------------------ */

export interface RadarView {
  /** `pilot:<cid>` / `atc:<callsign>` / `apt:<icao>`，和地图与列表共用的那把键。 */
  selected: string | null;
  lat: number | null;
  lon: number | null;
  zoom: number | null;
}

export const EMPTY_VIEW: RadarView = {
  selected: null,
  lat: null,
  lon: null,
  zoom: null,
};

/**
 * 从 URL 读视图。
 *
 * 用查询串而不是 hash：这一页没有锚点，而查询串在聊天软件里粘贴时不会被吞掉最后
 * 一段 —— 有些客户端会把 `#` 后面当成片段丢掉。
 */
export function readView(search: string): RadarView {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return { ...EMPTY_VIEW };
  }

  return {
    selected: sanitizeKey(params.get("sel")),
    lat: coordinate(params.get("lat"), 90),
    lon: coordinate(params.get("lon"), 180),
    zoom: zoomLevel(params.get("z")),
  };
}

/**
 * 把视图写成查询串。空的项一律不写，所以没选中任何东西时地址栏是干净的。
 *
 * 坐标截到四位小数（约 11 米）：再多的位数只是让链接变长，而这张图最细也就到跑
 * 道级别。
 */
export function writeView(view: RadarView): string {
  const params = new URLSearchParams();
  if (view.selected) params.set("sel", view.selected);
  if (view.lat !== null && view.lon !== null) {
    params.set("lat", view.lat.toFixed(4));
    params.set("lon", view.lon.toFixed(4));
  }
  if (view.zoom !== null) params.set("z", String(Math.round(view.zoom)));
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * 选中键的白名单。
 *
 * 这个值会走进 DOM 查询和地图标记的键里，所以它不能是任意字符串。只认三种前缀，
 * 后面只认呼号和 ICAO 用得到的那些字符 —— 别的一律当没选。
 */
function sanitizeKey(value: string | null): string | null {
  if (!value) return null;
  const match = /^(pilot|atc|apt):([A-Za-z0-9_-]{1,16})$/.exec(value);
  return match ? `${match[1]}:${match[2].toUpperCase()}` : null;
}

function coordinate(value: string | null, limit: number): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) return null;
  return parsed;
}

function zoomLevel(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  // Leaflet 的合法范围；越界的值会让地图初始化就抛。
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 18) return null;
  return Math.round(parsed);
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function readJSON(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
