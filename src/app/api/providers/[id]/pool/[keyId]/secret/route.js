import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

// GET /api/providers/[id]/pool/[keyId]/secret - Reveal one raw pool key.
// Read-only SELECT by (id, provider). No pull/delete, no masking change to
// the existing list endpoint. Protected by dashboardGuard like other routes.
export async function GET(request, { params }) {
  try {
    const { id: provider, keyId } = await params;
    if (!provider || !keyId) {
      return NextResponse.json({ error: "provider and keyId required" }, { status: 400 });
    }

    const db = await getAdapter();
    const row = db.get(
      `SELECT id, provider, key FROM keyPool WHERE id = ? AND provider = ?`,
      [keyId, provider]
    );

    if (!row || !row.key) {
      return NextResponse.json({ error: "Pool key not found" }, { status: 404 });
    }

    const res = NextResponse.json({ key: row.key });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (error) {
    console.log("Error revealing pool secret");
    return NextResponse.json({ error: "Failed to reveal secret" }, { status: 500 });
  }
}
