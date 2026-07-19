# README 中文优先与首图更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Chinese-first README content, use newly generated localized hero images, and retain only v0.2.0 additions.

**Architecture:** `README.md` becomes the primary Chinese entry using historical copy; `README_en.md` provides the English equivalent. Both consume separately named PNG hero assets under `docs/assets/readme/`, while the real product screenshot remains separate proof.

**Tech Stack:** Markdown, Git history, PNG assets, README audit script.

## Global Constraints

- Keep application claims aligned with source-backed historical README content.
- Default README is Chinese; English README references only its English hero asset.
- Only add v0.2.0 release notes and current Windows asset name to restored text.
- Do not alter user-owned untracked files.

---

### Task 1: Establish README language and content contract

**Files:**
- Modify: `README.md`
- Create: `README_en.md`
- Test: `scripts/__tests__/readme-localization.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
expect(readFileSync('README.md', 'utf8')).toContain('hero-zh-v2.png')
expect(readFileSync('README_en.md', 'utf8')).toContain('hero-en-v2.png')
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run scripts/__tests__/readme-localization.test.ts`
Expected: FAIL because the new localized hero paths do not yet exist in the README files.

- [ ] **Step 3: Restore and adapt the Markdown**

Restore the pre-v0.2.0 historical README content as the base, replace v0.1.0 archive references with `AI-Novel-Writer-0.2.0-windows-x64.zip`, add a concise v0.2.0 update section, and use reciprocal Chinese/English links.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run scripts/__tests__/readme-localization.test.ts`
Expected: PASS.

### Task 2: Add and validate localized hero assets

**Files:**
- Create: `docs/assets/readme/hero-zh-v2.png`
- Create: `docs/assets/readme/hero-en-v2.png`
- Verify: `README.md`, `README_en.md`

- [ ] **Step 1: Copy reviewed generated assets to tracked paths**

Use the reviewed Chinese and English writing-desk heroes without overwriting the prior SVG assets.

- [ ] **Step 2: Audit README image references**

Run: `audit_readme.py README.md` and `audit_readme.py README_en.md`.
Expected: both report image references and SVG basics passed.

- [ ] **Step 3: Inspect both PNG files at display size**

Confirm title legibility, correct language, no generated fake UI, no watermark, and no clipping.

- [ ] **Step 4: Commit**

```bash
git add README.md README_en.md docs/assets/readme/hero-zh-v2.png docs/assets/readme/hero-en-v2.png scripts/__tests__/readme-localization.test.ts docs/superpowers
git commit -m "docs: prioritize Chinese README and refresh heroes"
```
