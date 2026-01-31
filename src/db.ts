import { neon, neonConfig } from "@neondatabase/serverless";
import { requireEnv } from "./env";

// Reuse server-side HTTP connection cache (helps serverless workloads).
neonConfig.fetchConnectionCache = true;

export const sql = neon(requireEnv("DATABASE_URL"));
