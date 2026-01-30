import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "../src/db";
import { requireEnv } from "../src/env";
import { getHeader, sendJson } from "../src/http";

export const config = {
	runtime: "nodejs",
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		return sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
	}

	const apiKey = getHeader(req, "x-api-key");
	if (apiKey !== requireEnv("ADMIN_SECRET_KEY")) {
		return sendJson(res, 401, { error: "UNAUTHORIZED" });
	}

	try {
		const rows = (await sql`
			SELECT category::text AS category, remaining, used
			FROM db_meta_data
			ORDER BY category;
		`) as { category: string; remaining: number; used: number }[];

		return sendJson(res, 200, { stats: rows });
	} catch (err) {
		console.error("Stats failed:", err);
		return sendJson(res, 500, { error: "INTERNAL_ERROR" });
	}
}
