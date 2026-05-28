import { NextResponse } from "next/server";
import {
  pullKeysFromPool, getPoolSize, getProviderConnections, batchCreatePoolConnections,
} from "@/models";

export const dynamic = "force-dynamic";

// POST /api/providers/[id]/pool/pull
// Body: { count?: number }
export async function POST(req, { params }) {
  try {
    const provider = params.id;
    const body = await req.json().catch(() => ({}));

    const [poolSize, existing] = await Promise.all([
      getPoolSize(provider),
      getProviderConnections({ provider }),
    ]);

    const n = body.count && Number.isFinite(body.count) && body.count > 0
      ? Math.floor(body.count)
      : poolSize;

    const existingKeys = existing.map((c) => c.apiKey).filter(Boolean);

    const pulled = await pullKeysFromPool(provider, n, existingKeys);

    if (pulled.length === 0) {
      return NextResponse.json({ pulled: 0, skipped: 0, message: "Pool is empty or all keys already in use" });
    }

    // Pass existingKeys so batchCreatePoolConnections skips its internal SELECT
    const created = await batchCreatePoolConnections(provider, pulled, existingKeys);

    return NextResponse.json({ pulled: created, skipped: pulled.length - created });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
