/**
 * can-fsd's HTTP API — the FSD daemon's own listener (`:20350`), published
 * under this hostname. There is no separate internal address: every route it
 * serves, datafeed and all, is on this origin.
 */
export const FSD_ORIGIN = "https://data.airwaysn.org";

/**
 * The live datafeed. Public and unauthenticated, which is why the islands
 * fetch it directly rather than through this app.
 */
export const DATAFEED_URL = `${FSD_ORIGIN}/v1/data.json`;

export interface FlightPlan {
  aircraft: string;
  alternate: string;
  arrival: string;
  cruise_tas: string;
  cruising_altitude: string;
  departure: string;
  depatime: string;
  flight_rules: string;
  raw_data: string;
  remarks: string;
  route: string;
}

export interface Pilot {
  altitude: number;
  bank: number;
  callsign: string;
  cid: string;
  flight_plan?: FlightPlan;
  groundspeed: number;
  heading: number;
  latitude: number;
  logon_time: string;
  longitude: number;
  name: string;
  pitch: number;
  send_time: number;
  /**
   * Callsign of the controller holding this aircraft's radar track, absent
   * when nobody has taken it.
   *
   * Once a controller owns the strip it is theirs to amend, so the flight plan
   * form locks itself against this rather than letting a member overwrite a
   * reroute the controller had issued. can-fsd refuses such an edit either way;
   * this is what lets the page say so before the button is pressed.
   */
  tracked_by?: string;
  transponder: number;
  visual_range: number;
}

export interface Controller {
  callsign: string;
  cid: string;
  facility: number;
  frequency: string;
  latitude: string;
  logon_time: string;
  longitude: string;
  name: string;
  rating: number;
  send_time: number;
  server: string;
  text_atis: string[];
  type: number;
  visual_range: number;
}

export type AtisData = Controller;

export interface ApiData {
  atis: AtisData[];
  controllers: Controller[];
  general: {
    atc: number;
    pilots: number;
    socket: number;
    update: string;
    update_timestamp: number;
    user: number;
    version: string;
  };
  pilots: Pilot[];
}
