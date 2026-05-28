"use client";

import { useState, useEffect, useCallback } from "react";
import { Button, Toggle } from "@/shared/components";
import AddToPoolModal from "./AddToPoolModal";

export default function KeyPoolTab({ provider, onPullDone }) {
  const [poolData, setPoolData] = useState({ keys: [], count: 0, page: 1, totalPages: 1, poolSize: 30, autoReplace: true });
  const [loading, setLoading] = useState(true);
  const [pullCount, setPullCount] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [deletingKey, setDeletingKey] = useState(null);
  const [page, setPage] = useState(1);

  const fetchPool = useCallback(async (p = page) => {
    try {
      const res = await fetch(`/api/providers/${provider}/pool?page=${p}&limit=50`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setPoolData(data);
        if (!pullCount) setPullCount(String(data.poolSize));
      }
    } catch {}
    setLoading(false);
  }, [provider, page, pullCount]);

  useEffect(() => { fetchPool(page); }, [provider, page]); // eslint-disable-line

  async function handlePull() {
    setPulling(true);
    setPullResult(null);
    try {
      const n = parseInt(pullCount, 10) || poolData.poolSize;
      const res = await fetch(`/api/providers/${provider}/pool/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: n }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Pull failed");
      setPullResult(data);
      setPage(1);
      await fetchPool(1);
      onPullDone?.();
    } catch (err) {
      setPullResult({ error: err.message });
    } finally {
      setPulling(false);
    }
  }

  async function handleDeleteKey(id) {
    setDeletingKey(id);
    try {
      await fetch(`/api/providers/${provider}/pool?keyId=${id}`, { method: "DELETE" });
      await fetchPool(page);
    } finally {
      setDeletingKey(null);
    }
  }

  async function handleAutoReplaceToggle(value) {
    setPoolData((d) => ({ ...d, autoReplace: value }));
    await fetch(`/api/providers/${provider}/pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoReplace: value }),
    });
  }

  async function handlePoolSizeSave() {
    const n = parseInt(pullCount, 10);
    if (!Number.isFinite(n) || n < 1) return;
    if (n === poolData.poolSize) return; // no change — skip unnecessary write
    setPoolData((d) => ({ ...d, poolSize: n }));
    await fetch(`/api/providers/${provider}/pool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poolSize: n }),
    });
  }

  if (loading) {
    return <div className="py-8 text-center text-sm text-text-muted">Loading pool...</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span className="font-medium">
            {poolData.count} key{poolData.count !== 1 ? "s" : ""} in pool
          </span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">Auto-replace</span>
            <Toggle checked={poolData.autoReplace} onChange={handleAutoReplaceToggle} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-text-muted">Pull</span>
          <input
            type="number"
            min="1"
            className="w-16 rounded-md border border-border bg-background px-2 py-1 text-sm text-center focus:outline-none focus:border-primary"
            value={pullCount}
            onChange={(e) => setPullCount(e.target.value)}
            onBlur={handlePoolSizeSave}
          />
          <span className="text-xs text-text-muted">keys</span>
          <Button size="sm" icon="download" onClick={handlePull} disabled={pulling || poolData.count === 0}>
            {pulling ? "Pulling..." : "Pull from pool"}
          </Button>
          <Button size="sm" variant="secondary" icon="add" onClick={() => setShowAddModal(true)}>
            Add to pool
          </Button>
        </div>
      </div>

      {pullResult && (
        <div className={`rounded-md border px-3 py-2 text-sm ${pullResult.error ? "border-red-500/30 bg-red-500/10 text-red-500" : "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400"}`}>
          {pullResult.error
            ? pullResult.error
            : `Pulled ${pullResult.pulled} key${pullResult.pulled !== 1 ? "s" : ""} to connections.${pullResult.skipped ? ` Skipped ${pullResult.skipped} duplicate${pullResult.skipped !== 1 ? "s" : ""}.` : ""}${pullResult.message ? ` ${pullResult.message}` : ""}`
          }
        </div>
      )}

      {/* Pool keys table */}
      {poolData.keys.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border py-10 text-center">
          <span className="material-symbols-outlined text-3xl text-text-muted">key_off</span>
          <p className="text-sm text-text-muted">No keys in pool</p>
          <Button size="sm" icon="add" onClick={() => setShowAddModal(true)}>Add Keys to Pool</Button>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-black/[0.02] dark:bg-white/[0.02] text-xs text-text-muted">
                  <th className="px-4 py-2 text-left font-medium uppercase tracking-wide">Name</th>
                  <th className="px-4 py-2 text-left font-medium uppercase tracking-wide">Key</th>
                  <th className="px-4 py-2 text-right font-medium uppercase tracking-wide">Action</th>
                </tr>
              </thead>
              <tbody>
                {poolData.keys.map((k, i) => (
                  <tr key={k.id} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "" : "bg-black/[0.01] dark:bg-white/[0.01]"}`}>
                    <td className="px-4 py-2 text-text-muted">{k.name || <span className="text-text-muted/50 italic">—</span>}</td>
                    <td className="px-4 py-2 font-mono text-xs text-text-muted">{k.key}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        className="text-red-500 hover:text-red-400 transition-colors disabled:opacity-40"
                        onClick={() => handleDeleteKey(k.id)}
                        disabled={deletingKey === k.id}
                        title="Remove from pool"
                      >
                        <span className="material-symbols-outlined text-base">close</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {poolData.totalPages > 1 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-muted text-xs">
                Page {poolData.page} of {poolData.totalPages} ({poolData.count} total)
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  icon="chevron_left"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Prev
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="chevron_right"
                  disabled={page >= poolData.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <AddToPoolModal
        isOpen={showAddModal}
        provider={provider}
        onClose={() => setShowAddModal(false)}
        onDone={() => { setShowAddModal(false); setPage(1); fetchPool(1); }}
      />
    </div>
  );
}
