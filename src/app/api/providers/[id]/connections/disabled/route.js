import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

// DELETE /api/providers/[id]/connections/disabled
export async function DELETE(req, { params }) {
  try {
    const { id: provider } = await params;
    const db = await getAdapter();
    const result = db.run(
      `DELETE FROM providerConnections WHERE provider = ? AND isActive = 0`,
      [provider]
    );
    return NextResponse.json({ deleted: result.changes ?? 0 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
