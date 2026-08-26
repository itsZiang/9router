import { NextResponse } from "next/server";
import { getExposeCombos, createExposeCombo, getExposeComboByName } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// Validate combo name: only a-z, A-Z, 0-9, -, _, . and []
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-\[\]]+$/;

// GET /api/expose-combos - Get all expose combos
export async function GET() {
  try {
    const combos = await getExposeCombos();
    return NextResponse.json({ combos });
  } catch (error) {
    console.log("Error fetching expose combos:", error);
    return NextResponse.json({ error: "Failed to fetch expose combos" }, { status: 500 });
  }
}

// POST /api/expose-combos - Create new expose combo
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, models, kind } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Validate name format
    if (!VALID_NAME_REGEX.test(name)) {
      return NextResponse.json({ error: "Name can only contain letters, numbers, -, _, . and []" }, { status: 400 });
    }

    // Check if name already exists
    const existing = await getExposeComboByName(name);
    if (existing) {
      return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
    }

    const combo = await createExposeCombo({ name, models: models || [], kind: kind || null });

    return NextResponse.json(combo, { status: 201 });
  } catch (error) {
    console.log("Error creating expose combo:", error);
    return NextResponse.json({ error: "Failed to create expose combo" }, { status: 500 });
  }
}
