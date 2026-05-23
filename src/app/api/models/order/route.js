import { NextResponse } from "next/server";
import { getModelOrder, setModelOrder } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    if (!providerAlias) {
      return NextResponse.json({ error: "providerAlias is required" }, { status: 400 });
    }
    const order = await getModelOrder(providerAlias);
    return NextResponse.json({ order });
  } catch (error) {
    console.log("Error fetching model order:", error);
    return NextResponse.json({ error: "Failed to fetch model order" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    const { providerAlias, order } = body;
    if (!providerAlias || !Array.isArray(order)) {
      return NextResponse.json({ error: "providerAlias and order array are required" }, { status: 400 });
    }
    await setModelOrder(providerAlias, order);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error saving model order:", error);
    return NextResponse.json({ error: "Failed to save model order" }, { status: 500 });
  }
}
