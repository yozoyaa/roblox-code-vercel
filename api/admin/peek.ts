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

const PEEK_SQL = `
SELECT id, code, category::text AS category
FROM codes
WHERE category = $1::code_category
	AND used_at IS NULL
ORDER BY id
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
	if (!category || !ALLOWED_CATEGORIES.has(category as Category)) {
		return sendJson(res, 400, {
			error: "INVALID_CATEGORY",
			expected: "gopay_cashback | gopay_coins",
		});
	}

	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort("timed out"), DB_TIMEOUT_MS);

	try {
		const result = await sql.query(PEEK_SQL, [category], {
			fetchOptions: { signal: abortController.signal },
			fullResults: true,
		});

		const row = result.rows[0] as { id?: number; code?: string; category?: string } | undefined;
		if (!row?.id || !row.code || !row.category) {
			return sendJson(res, 404, { error: "OUT_OF_STOCK" });
		}

		return sendJson(res, 200, { id: row.id, code: row.code, category: row.category });
	} catch (err) {
		if (isTimeoutError(err)) {
			return sendJson(res, 504, { error: "DB_TIMEOUT" });
		}
		if (isConnectionError(err)) {
			return sendJson(res, 503, { error: "DB_UNAVAILABLE" });
		}

		console.error("Peek failed:", err);
		return sendJson(res, 500, { error: "INTERNAL_ERROR" });
	} finally {
		clearTimeout(timeout);
	}
}
