import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";

export const dynamic = "force-dynamic";

// GET /api/providers/[id]/secret - Reveal raw API key for apikey connections only.
// Read-only: no DB writes, no changes to existing list/detail responses.
// Protected by dashboardGuard (deny-by-default for /api/*), same as other provider routes.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Connection id required" }, { status: 400 });
    }

    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    // Only pure API key connections are copyable. Cookie values and OAuth
    // tokens stay hidden on purpose (user scope: API Key only).
    if (connection.authType !== "apikey") {
      return NextResponse.json(
        { error: "Only API key connections support copy" },
        { status: 400 }
      );
    }

    if (!connection.apiKey) {
      return NextResponse.json({ error: "No API key stored for this connection" }, { status: 404 });
    }

    const res = NextResponse.json({ apiKey: connection.apiKey });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (error) {
    // Never include the secret in logs.
    console.log("Error revealing connection secret");
    return NextResponse.json({ error: "Failed to reveal secret" }, { status: 500 });
  }
}
