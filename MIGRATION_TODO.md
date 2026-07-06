# Full OmniRoute → 9router Migration Plan

## Goal
Port all 847 non-test TypeScript files from `OmniRoute/open-sse/` into `9router/open-sse/` as JavaScript, to achieve full feature parity and fix NIM kimi-k2.6 stream drops.

## Scope

| Category | OmniRoute (.ts) | 9router (.js) | Delta |
|----------|-----------------|---------------|-------|
| services/ | 322 | 32 | +290 |
| config/ | 216 | 14 | +202 |
| handlers/ | 95 | 59 | +36 |
| executors/ | 71 | 24 | +47 |
| utils/ | 70 | 41 | +29 |
| translator/ | 37 | 47 | -10 |
| mcp-server/ | 32 | 0 | +32 |
| **Total** | **847 non-test** | **~365** | **~+753 new, 94 overwrite, 271 keep** |

## Key Decisions
- **TS → JS**: Strip TypeScript types using Babel (`@babel/preset-typescript`)
- **Directory structure**: Keep 9router's existing structure; OmniRoute files go to their own paths (coexist)
- **External deps**: Stub all 84 `@/lib/`, `@/shared/`, `@/domain/` imports
- **94 overlapping files**: Overwrite with OmniRoute versions
- **271 9router-only files**: Keep untouched (rtk/, streaming/, providers/registry/*.js)

---

## Phases

### Phase 0: Setup & Tooling
- [x] 0.1 Verify `@babel/cli`, `@babel/preset-typescript` in OmniRoute node_modules
- [x] 0.2 Create Babel config at `/tmp/opencode/babel.config.json`
- [x] 0.3 Create migration post-processing script at `/tmp/opencode/migrate.mjs`
  - Replace `.ts"` → `.js"` in import/export statements
  - Replace `@omniroute/open-sse/...` → relative paths
  - Replace `@/lib/...` → `../../lib/...` (if exists in 9router) or `../stubs/lib/...`
  - Replace `@/shared/...` → `../stubs/shared/...`
  - Replace `@/domain/...` → `../stubs/domain/...`
- [x] 0.4 Verify script works on a single test file

### Phase 1: TypeScript → JavaScript Conversion
- [x] 1.1 Run Babel on OmniRoute's open-sse/ → `/tmp/omniroute-converted/`
  - Exclude `__tests__/` and `*.test.*`
  - Strip all TypeScript types, interfaces, generics, `import type`
- [x] 1.2 Verify output file count matches 846 (847 - 1 .d.ts file)
- [x] 1.3 Spot-check a few converted files (chatCore.js, stream.js, streamHandler.js)

### Phase 2: Post-process Imports
- [x] 2.1 Run `migrate.mjs` on `/tmp/omniroute-converted/` (combined with Phase 1)
- [x] 2.2 Verify no remaining `@omniroute/open-sse/` imports
- [x] 2.3 Verify no remaining `@/` imports (all mapped to stubs or 9router paths)
- [x] 2.4 Verify no remaining `.ts"` import extensions
- [x] 2.5 Spot-check converted files for correct relative paths

### Phase 3: Create Stubs (84 external deps)
- [ ] 3.1 Create `open-sse/stubs/` directory structure
- [ ] 3.2 Create stubs for `@/lib/db/*` (core, readCache, settings, models, providers, etc.)
- [ ] 3.3 Create stubs for `@/lib/localDb`
- [ ] 3.4 Create stubs for `@/lib/events/eventBus`
- [ ] 3.5 Create stubs for `@/lib/guardrails`
- [ ] 3.6 Create stubs for `@/lib/compliance/*`
- [ ] 3.7 Create stubs for `@/lib/logPayloads`
- [ ] 3.8 Create stubs for `@/lib/memory/*`
- [ ] 3.9 Create stubs for `@/lib/providers/*`
- [ ] 3.10 Create stubs for `@/lib/resilience/*`
- [ ] 3.11 Create stubs for `@/lib/combos/*`
- [ ] 3.12 Create stubs for `@/lib/credentialHealth/*`
- [ ] 3.13 Create stubs for `@/lib/middleware/*`
- [ ] 3.14 Create stubs for `@/lib/oauth/*`
- [ ] 3.15 Create stubs for remaining `@/` imports
- [ ] 3.16 Verify all stubs export the expected symbols (named exports + defaults)

### Phase 4: Copy to 9router
- [ ] 4.1 Copy all converted files from `/tmp/omniroute-converted/` to `9router/open-sse/`
- [ ] 4.2 Verify 94 overlapping files were overwritten
- [ ] 4.3 Verify 271 9router-only files are still present
- [ ] 4.4 Verify total file count in open-sse/ is correct

### Phase 5: Reconcile & Fix
- [ ] 5.1 Run ESLint on open-sse/ to find broken imports/syntax
- [ ] 5.2 Fix any missing stub exports
- [ ] 5.3 Fix any path mismatches from directory structure differences
- [ ] 5.4 Handle edge cases:
  - 9router `providers/registry/index.js` vs OmniRoute `config/providers/registry/index.js`
  - 9router `rtk/` vs OmniRoute `services/compression/engines/rtk/`
  - 9router `config/providers.js` vs OmniRoute `config/providers/index.js`
- [ ] 5.5 Fix any remaining ESLint errors iteratively

### Phase 6: Build Verification
- [ ] 6.1 `npx eslint open-sse/ --quiet` → 0 errors
- [ ] 6.2 `npm run build` → EXIT=0
- [ ] 6.3 Fix any build errors iteratively
- [ ] 6.4 Verify no regressions in existing 9router features

### Phase 7: Test NIM kimi-k2.6
- [ ] 7.1 Start dev server
- [ ] 7.2 Test NIM kimi-k2.6 streaming
- [ ] 7.3 Verify no stream drops
- [ ] 7.4 Test other providers still work (kimi, openai, claude, etc.)

---

## Progress Tracking
- **Started**: 2026-07-05
- **Current phase**: Phase 3 (Create Stubs)
- **Completed phases**: 0, 1, 2

## Notes
- After each phase, user will compact context to keep working memory clean
- If a phase reveals unexpected issues, add sub-tasks as needed
- Stubs should be minimal (no-ops, passthroughs) — upgrade to real implementations only if needed for functionality
- 9router's `lib/usageDb.js` already exists — map `@/lib/usageDb` to it instead of stubbing
- OmniRoute's `config/providers/registry/*/index.ts` → keep at `config/providers/registry/*/index.js` (new path in 9router); 9router's existing `providers/registry/*.js` stays for app-level imports
