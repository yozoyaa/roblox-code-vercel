import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "../../src/db";
import { requireEnv } from "../../src/env";
import { getHeader, sendJson } from "../../src/http";

export const config = {
	runtime: "nodejs",
};

const ADMIN_SECRET_KEY = requireEnv("ADMIN_SECRET_KEY");
const ALLOWED_CATEGORIES = new Set(["gopay_cashback", "gopay_coins"] as const);
type Category = "gopay_cashback" | "gopay_coins";
const DB_TIMEOUT_MS = 10_000;

const USED_QUERY = `
SELECT id, redeemed_at, player_user_id, roblox_job_id
FROM used_code
WHERE code_id = $1
ORDER BY id DESC
LIMIT 1;
`;

function isTimeoutError(err: unknown): boolean {
	if (typeof err !== "object" || err == null) return false;
	const e = err as { name?: string; message?: string };
	return e.name === "AbortError" || (e.message ?? "").toLowerCase().includes("timed out");
}

function isConnectionError(err: unknown): boolean {
	if (typeof err !== "object" || err == null) return false;
	const msg = ((err as { message?: string }).message ?? "").toLowerCase();
	return (
		msg.includes("fetch failed") ||
		msg.includes("ecconnreset") ||
		msg.includes("econnreset") ||
		msg.includes("etimedout") ||
		msg.includes("socket") ||
		msg.includes("network")
	);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		return sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
	}

	const apiKey = getHeader(req, "x-api-key");
	if (apiKey !== ADMIN_SECRET_KEY) {
		return sendJson(res, 401, { error: "UNAUTHORIZED" });
	}

	const categoryRaw = req.query.category;
	const category = typeof categoryRaw === "string" ? categoryRaw : Array.isArray(categoryRaw) ? categoryRaw[0] : undefined;
	if (category && !ALLOWED_CATEGORIES.has(category as Category)) {
		return sendJson(res, 400, {
			error: "INVALID_CATEGORY",
			expected: "gopay_cashback | gopay_coins",
		});
	}

	const codeRaw = req.query.code;
	const code = typeof codeRaw === "string" ? codeRaw : Array.isArray(codeRaw) ? codeRaw[0] : undefined;
	if (!code) {
		return sendJson(res, 400, { error: "INVALID_CODE", expected: "code query param required" });
	}

	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort("timed out"), DB_TIMEOUT_MS);

	try {
		let codeQuery = `
SELECT id, category::text AS category, code, used_at, created_at
FROM codes
WHERE code = $1
`;
		const params: (string | Category)[] = [code];
		if (category) {
			codeQuery += " AND category = $2::code_category";
			params.push(category as Category);
		}
		codeQuery += "\nLIMIT 1;";

		const codeResult = await sql.query(codeQuery, params, {
			fetchOptions: { signal: abortController.signal },
			fullResults: true,
		});

		const codeRow = codeResult.rows[0] as
			| {
					id?: number;
					category?: string;
					code?: string;
					used_at?: string | null;
					created_at?: string;
			  }
			| undefined;

		if (!codeRow?.id) {
			return sendJson(res, 404, { error: "NOT_FOUND" });
		}

		if (!codeRow.used_at) {
			return sendJson(res, 200, { found: true, used: false, codeRow });
		}

		const usedResult = await sql.query(USED_QUERY, [codeRow.id], {
			fetchOptions: { signal: abortController.signal },
			fullResults: true,
		});

		const usedRecord = usedResult.rows[0] as
			| { id?: number; redeemed_at?: string; player_user_id?: number | null; roblox_job_id?: string | null }
			| undefined;

		return sendJson(res, 200, {
			found: true,
			used: true,
			codeRow,
			usedRecord: usedRecord ?? null,
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			return sendJson(res, 504, { error: "DB_TIMEOUT" });
		}
		if (isConnectionError(err)) {
			return sendJson(res, 503, { error: "DB_UNAVAILABLE" });
		}

		console.error("Code status failed:", err);
		return sendJson(res, 500, { error: "INTERNAL_ERROR" });
	} finally {
		clearTimeout(timeout);
	}
}
