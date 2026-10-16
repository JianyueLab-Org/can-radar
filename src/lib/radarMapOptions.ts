import type { MapOptions } from "leaflet";

/**
 * Keep a continuous horizontal world when a viewer drags across the date
 * line. Leaflet otherwise leaves overlays in the original world copy while
 * the viewport moves to the next one.
 */
export const RADAR_MAP_WORLD_OPTIONS: Pick<MapOptions, "worldCopyJump"> = {
  worldCopyJump: true,
};
