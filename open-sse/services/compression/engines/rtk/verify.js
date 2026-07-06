import { estimateCompressionTokens } from "../../stats";
import { getRtkFilterLoadDiagnostics, loadRtkFilters } from "./filterLoader";
import { applyLineFilter } from "./lineFilter";
function trimComparable(value) {
  return value.replace(/\n+$/g, "");
}
export function runRtkFilterTests(options = {}) {
  const filters = loadRtkFilters({
    refresh: true,
    customFiltersEnabled: options.customFiltersEnabled,
    trustProjectFilters: options.trustProjectFilters
  });
  const outcomes = [];
  const filtersWithoutTests = [];
  const benchmarkByCategory = new Map();
  for (const filter of filters) {
    const categoryStats = benchmarkByCategory.get(filter.category) ?? {
      filters: new Set(),
      tests: 0,
      savingsTotal: 0
    };
    categoryStats.filters.add(filter.id);
    benchmarkByCategory.set(filter.category, categoryStats);
    if (filter.tests.length === 0) {
      filtersWithoutTests.push(filter.id);
      continue;
    }
    for (const test of filter.tests) {
      const result = applyLineFilter(test.input, filter).text;
      const actual = trimComparable(result);
      const expected = trimComparable(test.expected);
      const originalTokens = estimateCompressionTokens(test.input);
      const compressedTokens = estimateCompressionTokens(result);
      const savings = originalTokens > 0 ? (originalTokens - compressedTokens) / originalTokens * 100 : 0;
      categoryStats.tests += 1;
      categoryStats.savingsTotal += Math.max(0, savings);
      outcomes.push({
        filterId: filter.id,
        testName: test.name,
        passed: actual === expected,
        actual,
        expected
      });
    }
  }
  const benchmark = Array.from(benchmarkByCategory.entries()).map(([category, value]) => ({
    category,
    filters: value.filters.size,
    tests: value.tests,
    averageSavingsPercent: value.tests > 0 ? Math.round(value.savingsTotal / value.tests * 100) / 100 : 0
  })).sort((a, b) => a.category.localeCompare(b.category));
  const failed = outcomes.some(outcome => !outcome.passed);
  return {
    passed: !failed && (!options.requireAll || filtersWithoutTests.length === 0),
    outcomes,
    filtersWithoutTests,
    benchmark,
    diagnostics: options.customFiltersEnabled === false ? [] : getRtkFilterLoadDiagnostics()
  };
}