import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "../src/db";
import { requireEnv } from "../src/env";
import { getHeader, readJson, sendJson } from "../src/http";

const ALLOWED_CATEGORIES = new Set(["gopay_cashback", "gopay_coins"] as const);
type Category = "gopay_cashback" | "gopay_coins";

type RedeemBody = {
	category: Category;
	playerUserId?: number;
	jobId?: string;
};

export const config = {
	runtime: "nodejs",
};

function parseRedeemBody(value: unknown): RedeemBody | null {
	if (typeof value !== "object" || value == null) return null;

	const body = value as Record<string, unknown>;
	const category = body.category;

	if (typeof category !== "string" || !ALLOWED_CATEGORIES.has(category as Category)) {
		return null;
	}

	const playerUserIdRaw = body.playerUserId;
	const jobIdRaw = body.jobId;

	const playerUserId =
		typeof playerUserIdRaw === "number" && Number.isFinite(playerUserIdRaw)
			? playerUserIdRaw
			: undefined;

	const jobId = typeof jobIdRaw === "string" ? jobIdRaw : undefined;

	return {
		category: category as Category,
		playerUserId,
		jobId,
	};
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		return sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
	}

	const apiKey = getHeader(req, "x-api-key");
	if (apiKey !== requireEnv("REDEEM_SECRET_KEY")) {
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
			expected: { category: "gopay_cashback | gopay_coins", playerUserId: "number?", jobId: "string?" },
		});
	}

	try {
		const rows = (await sql`
			WITH picked AS (
				SELECT id, code
				FROM codes
				WHERE category = ${body.category}::code_category
					AND used_at IS NULL
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
				INSERT INTO used_code (code_id, roblox_job_id, player_user_id)
				SELECT id, ${body.jobId ?? null}, ${body.playerUserId ?? null}
				FROM updated
				RETURNING code_id
			)
			SELECT code FROM updated;
		`) as { code: string }[];

		const code = rows[0]?.code;
		if (!code) {
			return sendJson(res, 404, { error: "OUT_OF_STOCK" });
		}

		return sendJson(res, 200, { code });
	} catch (err) {
		console.error("Redeem failed:", err);
		return sendJson(res, 500, { error: "INTERNAL_ERROR" });
	}
}
