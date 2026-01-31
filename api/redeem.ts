import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "../src/db";
import { requireEnv } from "../src/env";
import { getHeader, readJson, sendJson } from "../src/http";

const REDEEM_SECRET_KEY = requireEnv("REDEEM_SECRET_KEY");

const ALLOWED_CATEGORIES = new Set(["gopay_cashback", "gopay_coins"] as const);
type Category = "gopay_cashback" | "gopay_coins";

type RedeemBody = {
	category: Category;
	playerUserId: number;
	jobId?: string;
};

export const config = {
	runtime: "nodejs",
};

const DB_TIMEOUT_MS = 10_000;
const MAX_JOB_ID_LEN = 128;

/**
 * Atomic flow (single SQL statement + advisory lock):
 * - Lock by (playerUserId, category) so concurrent requests don't race.
 * - If already redeemed for that category, return ALREADY_REDEEMED without consuming a code.
 * - Otherwise FIFO pop a code, mark used, and log to used_code.
 */
const REDEEM_SQL = `
WITH lock_cte AS (
	SELECT pg_advisory_xact_lock(
		hashtextextended(($1::text || ':' || $2::text), 0)
	) AS locked
),
existing AS (
	SELECT c.code
	FROM used_code u
	JOIN codes c ON c.id = u.code_id
	WHERE u.player_user_id = $1::bigint
		AND c.category = $2::code_category
	LIMIT 1
),
picked AS (
	SELECT id, code
	FROM codes
	WHERE category = $2::code_category
		AND used_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM existing)
	ORDER BY id
	FOR UPDATE SKIP LOCKED
	LIMIT 1
),
updated AS (
	UPDATE codes c
	SET used_at = now()
	FROM picked p
	WHERE c.id = p.id
	RETURNING c.id, p.code
),
logged AS (
	INSERT INTO used_code (code_id, roblox_job_id, player_user_id, category)
	SELECT id, $3, $1::bigint, $2::code_category
	FROM updated
	RETURNING code_id
)
SELECT
	(SELECT code FROM existing) AS already_code,
	(SELECT code FROM updated) AS new_code
FROM lock_cte;
`;

function parseRedeemBody(value: unknown): RedeemBody | null {
	if (typeof value !== "object" || value == null) return null;

	const body = value as Record<string, unknown>;
	const category = body.category;

	if (typeof category !== "string" || !ALLOWED_CATEGORIES.has(category as Category)) {
		return null;
	}

	const playerUserIdRaw = body.playerUserId;
	if (typeof playerUserIdRaw !== "number" || !Number.isFinite(playerUserIdRaw)) {
		return null;
	}

	const jobIdRaw = body.jobId;
	let jobId = typeof jobIdRaw === "string" ? jobIdRaw : undefined;
	if (jobId && jobId.length > MAX_JOB_ID_LEN) {
		jobId = jobId.slice(0, MAX_JOB_ID_LEN);
	}

	return {
		category: category as Category,
		playerUserId: playerUserIdRaw,
		jobId,
	};
}

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
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		return sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
	}

	const apiKey = getHeader(req, "x-api-key");
	if (apiKey !== REDEEM_SECRET_KEY) {
		return sendJson(res, 401, { error: "UNAUTHORIZED" });
	}

	let bodyRaw: unknown;
	try {
		bodyRaw = await readJson(req);
	} catch {
		return sendJson(res, 400, { error: "INVALID_JSON" });
	}

	const body = parseRedeemBody(bodyRaw);
	if (!body) {
		return sendJson(res, 400, {
			error: "INVALID_BODY",
			expected: {
				category: "gopay_cashback | gopay_coins",
				playerUserId: "number (required)",
				jobId: "string?",
			},
		});
	}

	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort("timed out"), DB_TIMEOUT_MS);

	try {
		const jobId = body.jobId ?? null;

		const result = await sql.query(REDEEM_SQL, [body.playerUserId, body.category, jobId], {
			fetchOptions: { signal: abortController.signal },
			fullResults: true,
		});

		const row =
			(result.rows[0] as { already_code?: string | null; new_code?: string | null } | undefined) ??
			{};
		const alreadyCode = row.already_code ?? null;
		const newCode = row.new_code ?? null;

		if (alreadyCode) {
			return sendJson(res, 409, { error: "ALREADY_REDEEMED" });
		}

		if (!newCode) {
			return sendJson(res, 404, { error: "OUT_OF_STOCK" });
		}

		return sendJson(res, 200, { code: newCode });
	} catch (err) {
		if (isTimeoutError(err)) {
			return sendJson(res, 504, { error: "DB_TIMEOUT" });
		}
		if (isConnectionError(err)) {
			return sendJson(res, 503, { error: "DB_UNAVAILABLE" });
		}

		console.error("Redeem failed:", err);
		return sendJson(res, 500, { error: "INTERNAL_ERROR" });
	} finally {
		clearTimeout(timeout);
	}
}
