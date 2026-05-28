import { NextResponse } from "next/server";
import {
  addKeysToPool, getPoolKeysPaged, getPoolCount, removeKeyFromPool,
  getPoolSize, setPoolSize, getAutoReplace, setAutoReplace,
} from "@/models";

export const dynamic = "force-dynamic";

// GET /api/providers/[id]/pool?page=1&limit=50
export async function GET(req, { params }) {
  try {
    const provider = params.id;
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(Math.max(1, parseInt(searchParams.get("limit") || "50", 10)), 200);
    const offset = (page - 1) * limit;

    const [count, keys, poolSize, autoReplace] = await Promise.all([
      getPoolCount(provider),
      getPoolKeysPaged(provider, limit, offset),
      getPoolSize(provider),
      getAutoReplace(provider),
    ]);

    const masked = keys.map((k) => ({
      id: k.id,
      name: k.name,
      key: maskKey(k.key),
      createdAt: k.createdAt,
    }));

    return NextResponse.json({
      keys: masked,
      count,
      page,
      totalPages: Math.max(1, Math.ceil(count / limit)),
      limit,
      poolSize,
      autoReplace,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/providers/[id]/pool
// Body: { lines: "name|key\nkey2\n..." } — bulk add
// OR: { poolSize: number } / { autoReplace: boolean } — update settings
export async function POST(req, { params }) {
  try {
    const provider = params.id;
    const body = await req.json();

    // Settings update
    if (body.poolSize !== undefined) {
      const n = parseInt(body.poolSize, 10);
      if (!Number.isFinite(n) || n < 1) return NextResponse.json({ error: "Invalid poolSize" }, { status: 400 });
      await setPoolSize(provider, n);
      return NextResponse.json({ ok: true });
    }
    if (body.autoReplace !== undefined) {
      await setAutoReplace(provider, Boolean(body.autoReplace));
      return NextResponse.json({ ok: true });
    }

    // Bulk add keys
    const lines = (body.lines || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const keys = lines.map((line) => {
      const sep = line.indexOf("|");
      if (sep === -1) return { name: null, key: line };
      return { name: line.slice(0, sep).trim() || null, key: line.slice(sep + 1).trim() };
    }).filter((k) => k.key);

    if (keys.length === 0) return NextResponse.json({ error: "No valid keys" }, { status: 400 });

    const result = await addKeysToPool(provider, keys);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE /api/providers/[id]/pool?keyId=<id>
export async function DELETE(req, { params }) {
  try {
    const { searchParams } = new URL(req.url);
    const keyId = searchParams.get("keyId");
    if (!keyId) return NextResponse.json({ error: "keyId required" }, { status: 400 });
    await removeKeyFromPool(keyId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function maskKey(key) {
  if (!key || key.length <= 8) return "••••••••";
  return key.slice(0, 8) + "••••" + key.slice(-4);
}
