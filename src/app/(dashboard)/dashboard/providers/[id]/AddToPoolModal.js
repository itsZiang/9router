"use client";

import { useState } from "react";
import { Modal, Button } from "@/shared/components";

export default function AddToPoolModal({ isOpen, provider, onClose, onDone }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const validCount = lines.filter((l) => {
    const sep = l.indexOf("|");
    const key = sep === -1 ? l : l.slice(sep + 1).trim();
    return key.length > 0;
  }).length;

  async function handleSubmit() {
    if (!validCount) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch(`/api/providers/${provider}/pool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setResult(data);
      onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setText("");
    setResult(null);
    setError("");
    onClose();
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Add Keys to Pool">
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-sm text-text-muted mb-2">
            Paste keys below — one per line. Format: <code className="text-xs bg-black/10 dark:bg-white/10 px-1 rounded">name|key</code> or just <code className="text-xs bg-black/10 dark:bg-white/10 px-1 rounded">key</code>.
          </p>
          <textarea
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary resize-none"
            rows={10}
            placeholder={"my-key-1|sk-ant-api03-...\nmy-key-2|sk-ant-api03-...\nsk-ant-api03-..."}
            value={text}
            onChange={(e) => { setText(e.target.value); setResult(null); }}
          />
          <p className="text-xs text-text-muted mt-1">
            {validCount > 0 ? `${validCount} valid key${validCount !== 1 ? "s" : ""} detected` : "Paste keys above"}
          </p>
        </div>

        {result && (
          <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-600 dark:text-green-400">
            Added {result.added} key{result.added !== 1 ? "s" : ""} to pool.
            {result.skipped > 0 && ` Skipped ${result.skipped} duplicate${result.skipped !== 1 ? "s" : ""}.`}
          </div>
        )}

        {error && (
          <p className="text-sm text-red-500">{error}</p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={handleClose}>Close</Button>
          <Button onClick={handleSubmit} disabled={!validCount || loading}>
            {loading ? "Adding..." : `Add ${validCount || ""} Keys`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
