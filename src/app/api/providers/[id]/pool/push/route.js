import { NextResponse } from "next/server";
import {
  getProviderConnectionById, moveConnectionsToPool,
} from "@/models";

export const dynamic = "force-dynamic";

// POST /api/providers/[id]/pool/push
// Reverse of /pool/pull: move active apikey connections back into the key pool reserve.
// Body: { connectionIds: [connectionId, ...] }
export async function POST(req, { params }) {
  try {
    const { id: provider } = await params;
    const body = await req.json().catch(() => ({}));

    const ids = Array.isArray(body.connectionIds)
      ? body.connectionIds.map((x) => String(x).trim()).filter(Boolean)
      : [];

    if (ids.length === 0) {
      return NextResponse.json({ error: "No connection IDs provided" }, { status: 400 });
    }

    // Fetch connections and filter to apikey connections with an apiKey.
    const connections = (await Promise.all(ids.map((id) => getProviderConnectionById(id)))).filter(Boolean);

    const valid = connections.filter((c) => c.authType === "apikey" && c.apiKey);
    const skipped = connections.length - valid.length;

    if (valid.length === 0) {
      return NextResponse.json({
        moved: 0,
        skipped,
        message: "No API key connections to move (OAuth/access-token connections stay active)",
      });
    }

    const result = await moveConnectionsToPool(provider, valid);

    return NextResponse.json({
      moved: result.moved,
      skipped: result.skipped + skipped,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
