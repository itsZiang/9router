import { NextResponse } from "next/server";
import { getExposeComboById, updateExposeCombo, deleteExposeCombo, getExposeComboByName } from "@/lib/localDb";
import { resetComboRotation } from "open-sse/services/combo.js";

// Validate combo name: only a-z, A-Z, 0-9, -, _, . and []
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-\[\]]+$/;

// GET /api/expose-combos/[id] - Get expose combo by ID
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const combo = await getExposeComboById(id);

    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error fetching expose combo:", error);
    return NextResponse.json({ error: "Failed to fetch expose combo" }, { status: 500 });
  }
}

// PUT /api/expose-combos/[id] - Update expose combo
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    // Validate name format if provided
    if (body.name) {
      if (!VALID_NAME_REGEX.test(body.name)) {
        return NextResponse.json({ error: "Name can only contain letters, numbers, -, _, . and []" }, { status: 400 });
      }

      // Check if name already exists (exclude current combo)
      const existing = await getExposeComboByName(body.name);
      if (existing && existing.id !== id) {
        return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
      }
    }

    // Capture previous name to invalidate rotation state on rename
    const prev = await getExposeComboById(id);
    const combo = await updateExposeCombo(id, body);

    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Invalidate rotation state (models/strategy/name may have changed)
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) resetComboRotation(combo.name);

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error updating expose combo:", error);
    return NextResponse.json({ error: "Failed to update expose combo" }, { status: 500 });
  }
}

// DELETE /api/expose-combos/[id] - Delete expose combo
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const prev = await getExposeComboById(id);
    const success = await deleteExposeCombo(id);

    if (!success) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    if (prev?.name) resetComboRotation(prev.name);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting expose combo:", error);
    return NextResponse.json({ error: "Failed to delete expose combo" }, { status: 500 });
  }
}
