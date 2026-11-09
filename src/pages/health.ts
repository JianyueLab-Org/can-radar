import type { APIRoute } from "astro";
import { health, healthResponse } from "../server/health";

export const prerender = false;

export const GET: APIRoute = async () => healthResponse(await health());
