"use client";

import { useState, useEffect } from "react";
import { getDefaultPricing } from "@/shared/constants/pricing.js";

export default function PricingModal({ isOpen, onClose, onSave }) {
  const [pricingData, setPricingData] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterProvider, setFilterProvider] = useState("");

  const loadPricing = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/pricing");
      if (response.ok) {
        const data = await response.json();
        setPricingData(data);
      } else {
        const defaults = getDefaultPricing();
        setPricingData(defaults);
      }
    } catch (error) {
      console.error("Failed to load pricing:", error);
      const defaults = getDefaultPricing();
      setPricingData(defaults);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadPricing();
      setSearchQuery("");
      setFilterProvider("");
    }
  }, [isOpen]);

  const handlePricingChange = (provider, model, field, value) => {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue < 0) return;

    setPricingData(prev => {
      const newData = { ...prev };
      if (!newData[provider]) newData[provider] = {};
      if (!newData[provider][model]) newData[provider][model] = {};
      newData[provider][model][field] = numValue;
      return newData;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Strip metadata keys before saving
      const saveData = {};
      for (const [provider, models] of Object.entries(pricingData)) {
        if (provider.startsWith("_")) continue;
        saveData[provider] = models;
      }
      const response = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(saveData)
      });

      if (response.ok) {
        onSave?.();
        onClose();
      } else {
        const error = await response.json();
        alert(`Failed to save pricing: ${error.error}`);
      }
    } catch (error) {
      console.error("Failed to save pricing:", error);
      alert("Failed to save pricing");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm("Reset all pricing to defaults? This cannot be undone.")) return;

    try {
      const response = await fetch("/api/pricing", { method: "DELETE" });
      if (response.ok) {
        const defaults = getDefaultPricing();
        setPricingData(defaults);
      }
    } catch (error) {
      console.error("Failed to reset pricing:", error);
      alert("Failed to reset pricing");
    }
  };

  if (!isOpen) return null;

  const providerModels = pricingData._providerModels || {};
  const providerNames = pricingData._providerNames || {};
  const providerList = Object.keys(providerModels).sort();
  const pricingFields = ["input", "output", "cached", "reasoning", "cache_creation"];

  // Build the effective set of models for the selected provider (for filtering "*")
  const selectedProviderModels = filterProvider && providerModels[filterProvider]
    ? new Set(providerModels[filterProvider])
    : null;

  const allProviders = Object.keys(pricingData)
    .filter(p => !p.startsWith("_"))
    .sort();

  // Filter and render a provider section
  const renderProviderSection = (provider, label, models) => {
    let filteredModels = models;
    if (selectedProviderModels) {
      filteredModels = models.filter(m => selectedProviderModels.has(m));
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filteredModels = filteredModels.filter(m => m.toLowerCase().includes(q));
    }
    if (!filteredModels.length) return null;

    return (
      <div key={provider} className="border border-border rounded-lg overflow-hidden">
        <div className="bg-bg-subtle px-4 py-2 font-semibold text-sm flex items-center justify-between">
          <span>{label}</span>
          <span className="text-text-subtle text-xs font-normal">{filteredModels.length} models</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-hover text-text-muted uppercase text-xs">
              <tr>
                <th className="px-3 py-2 text-left">Model</th>
                <th className="px-3 py-2 text-right">Input</th>
                <th className="px-3 py-2 text-right">Output</th>
                <th className="px-3 py-2 text-right">Cached</th>
                <th className="px-3 py-2 text-right">Reasoning</th>
                <th className="px-3 py-2 text-right">Cache Creation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredModels.map(model => (
                <tr key={model} className="hover:bg-bg-subtle/50">
                  <td className="px-3 py-2 font-medium">{model}</td>
                  {pricingFields.map(field => (
                    <td key={field} className="px-3 py-2">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={pricingData[provider][model][field] || 0}
                        onChange={(e) => handlePricingChange(provider, model, field, e.target.value)}
                        className="w-20 px-2 py-1 text-right bg-bg-base border border-border rounded focus:outline-none focus:border-primary"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-base border border-border rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="text-xl font-semibold">Pricing Configuration</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="text-center py-8 text-text-muted">Loading pricing data...</div>
          ) : (
            <div className="space-y-6">
              {/* Instructions */}
              <div className="bg-bg-subtle border border-border rounded-lg p-3 text-sm">
                <p className="font-medium mb-1">Pricing Rates Format</p>
                <p className="text-text-muted">
                  All rates are in <strong>dollars per million tokens</strong> ($/1M tokens).
                  Example: Input rate of 2.50 means $2.50 per 1,000,000 input tokens.
                </p>
              </div>

              {/* Filter Bar */}
              <div className="px-4 py-3 border-b border-border flex items-center gap-3">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle text-sm material-symbols-outlined">search</span>
                  <input
                    type="text"
                    placeholder="Filter models..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-3 py-1.5 text-sm bg-bg-base border border-border rounded focus:outline-none focus:border-primary"
                  />
                </div>
                <select
                  value={filterProvider}
                  onChange={(e) => setFilterProvider(e.target.value)}
                  className="px-3 py-1.5 text-sm bg-bg-base border border-border rounded focus:outline-none focus:border-primary max-w-[200px]"
                >
                  <option value="">All providers</option>
                  {providerList.map(p => (
                    <option key={p} value={p}>{providerNames[p] || p}</option>
                  ))}
                </select>
                {(searchQuery || filterProvider) && (
                  <button
                    onClick={() => { setSearchQuery(""); setFilterProvider(""); }}
                    className="px-2 py-1.5 text-sm text-text-muted hover:text-text border border-border rounded transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Pricing Tables */}
              {allProviders.map(provider => {
                const isDefault = provider === "*";
                const models = Object.keys(pricingData[provider]).sort();

                if (isDefault) {
                  return renderProviderSection(provider, "Global Pricing Overrides", models);
                }

                if (filterProvider && provider !== filterProvider) return null;

                return renderProviderSection(provider, providerNames[provider] || provider.toUpperCase(), models);
              })}

              {allProviders.length === 0 && (
                <div className="text-center py-8 text-text-muted">
                  No pricing data available
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex items-center justify-between gap-2">
          <button
            onClick={handleReset}
            className="px-4 py-2 text-sm text-red-500 hover:bg-red-500/10 rounded border border-red-500/20 transition-colors"
            disabled={saving}
          >
            Reset to Defaults
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-text-muted hover:text-text border border-border rounded transition-colors"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
