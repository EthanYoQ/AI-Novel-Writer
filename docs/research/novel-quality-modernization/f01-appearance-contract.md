# F01 appearance storage delivery

Dependency: S01 `7143d301313b95a2df572a3b17f1d459b48d5947`. This slice implements and tests the renderer appearance owner. Production App/main startup integration belongs to S03 and is not claimed complete by this delivery.

## Ownership and migration

`src/shared/appearance-profile.ts` defines the versioned JSON stored only at `ai-novel-writer-appearance`. `src/stores/appearance-bootstrap.ts` is its sole writer. `theme-store.ts` and `ui-version-store.ts` project its acknowledged state and delegate edits; neither uses Zustand persistence nor writes legacy keys. No database migration, background-image storage, or application business initialization is owned here.

| Input | Canonical disposition |
| --- | --- |
| Legacy theme state theme | light/dark/paper/galaxy preserved; night becomes dark; system resolves once against current system appearance |
| zoom, writingFont, uiFont | Valid explicit values preserved, including former defaults; missing values use existing application defaults |
| fontDefaultsVersion | Optional legacy provenance retained; never permission to replace an explicit font |
| Legacy ui-version v1/v2, JSON string, object version or Zustand uiVersion | Explicit classic/writer preference |
| Missing shell key | unset, resolved through release policy; no default written as user choice |
| Corrupt or unsupported canonical/legacy input | Block with recoverable notice; preserve original bytes and unrelated data |
| main SkinService background | Read-only snapshot, never added to localStorage appearance profile |

Both legacy keys remain byte-for-byte intact. A valid canonical value wins on restart even if legacy keys subsequently change. Development release policy remains classic. F05 can activate writer policy for unset preferences; explicit classic remains classic. Unknown canonical fields are rejected rather than silently discarded.

## S03 central integration request

Importing the stores does not access storage, contact main, or apply appearance. Initial state is `phase: pending`, `profile: null`, `snapshot: null`, and safe Classic resolution. Before ordinary App/business initialization, await `useAppearanceStore.getState().bootstrap(dependencies)`. Only a true result permits that initialization. A false result exposes blocked state, notice and safe error classification for the startup recovery surface.

The dependency interface requires:

1. `waitForMainReady(): Promise<MainReady>` from the actual S03 startup coordinator. A pending/blocked result cannot authorize hydration.
2. `readSkinSnapshot(ready)` returning `{globalGeneration, skinRevision, backgroundSkin}` from main's authoritative service. Generation and revision must equal the ready message. A renderer catch-and-return-success initializer is insufficient.
3. `acknowledgeReadback({storageKey, profileRevision, globalGeneration, skinRevision}): Promise<boolean>`. Main must validate sender/origin and the still-current generation/revision and accept explicitly with true.

Bootstrap performs main ready, successful skin read, legacy/canonical validation, at most one canonical `setItem`, exact readback, main acknowledgement, and a second exact readback before publishing migrated. Concurrent bootstrap calls share one promise. Failed acknowledgement after a successful write leaves the durable value for idempotent restart; it never deletes or overwrites that value to simulate rollback. A storage exception or concurrent change blocks further preference writes.

After readiness, theme compatibility adapters apply CSS/theme, zoom and font values. User edits use the same writer, revision increments, parse validation and exact readback. These edits do not repeat global startup migration. Cross-window live synchronization and main generation revocation handling remain central integration responsibilities; concurrent raw storage changes are detected before the next write.

F02 receives profile, resolvedShell and the read-only main snapshot as props/data attributes. The main skin revision remains separate from profile revision; it is never a renderer persistence fallback. This module provides the startup snapshot, not a live skin subscription. F04 owns business-safe shell presentation switching; F01 does not mount or remount shell components.

## Verification and limits

- `pnpm exec vitest run src/shared/__tests__/appearance-profile.test.ts src/stores/__tests__/theme-store.test.ts`: 33 passing tests. Includes night/system conversion, explicit legacy fonts, zoom step/bounds/reset, both font projections, pending protection and corrupt input preservation.
- `AI_NOVEL_VITEST_BROWSER_API_PORT=63513 pnpm exec vitest run --config vitest.browser.config.ts src/stores/__tests__/appearance-bootstrap.browser.tsx`: 16 passing Chromium tests using actual browser localStorage and DOM. Includes one-write migration, readiness/skin/ack ordering, absent shell defaults, legacy retention, corrupt input, storage denial/quota, before/after-write interruption, restart, and acknowledgement-time concurrent modification.
- Main readiness, skin and acknowledgement in these tests are explicit fixtures. They validate the injected interface and browser storage behavior, not the actual Electron main gate, installed-package origin, product shell switch or full startup migration.
- `pnpm run typecheck` validates the shared workspace types; application launch, real main transport and packaged Electron qualification are reserved for central integration gates.

No original author content, preferences, skin assets, production database, machine paths or secret values are included in this evidence. No external temporary directories were created for this slice.
