import { NextResponse } from "next/server";
import { reorderExposeCombos } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const { ids } = await request.json();
    if (!Array.isArray(ids)) {
      return NextResponse.json({ error: "ids must be an array" }, { status: 400 });
    }
    await reorderExposeCombos(ids);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error reordering expose combos:", error);
    return NextResponse.json({ error: "Failed to reorder expose combos" }, { status: 500 });
  }
}
