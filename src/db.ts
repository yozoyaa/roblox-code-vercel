import { neon } from "@neondatabase/serverless";
import { requireEnv } from "./env";

export const sql = neon(requireEnv("DATABASE_URL"));