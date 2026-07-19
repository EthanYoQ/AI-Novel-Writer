# Bilingual README and Hero Visuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mixed README with synchronized English and Chinese documentation and original editorial-workbench hero artwork.

**Architecture:** `README.md` is the English default and `README_zh.md` is the Chinese counterpart. Two static SVG heroes share one visual system while each language receives native copy; a real application screenshot immediately follows the hero as product evidence.

**Tech Stack:** GitHub-flavored Markdown, SVG 1.1, Python README audit scripts, browser/SVG raster rendering.

## Global Constraints

- Use the selected “editorial writing desk” direction: warm black, parchment, restrained gold, manuscript/page/production markers.
- Create static SVG only; no GIF or video.
- Do not embed a tiny unreadable UI screenshot in the hero.
- Keep English and Chinese claims equivalent and evidence-backed.
- Put the real product screenshot immediately below the hero.
- Default file is `README.md`; Chinese file is `README_zh.md`.

---

### Task 1: Create the two original hero SVGs

**Files:**
- Create: `docs/assets/readme/hero-en.svg`
- Create: `docs/assets/readme/hero-zh.svg`

**Interfaces:**
- Produces: two 1200 × 400 SVGs with identical geometry and localized text.

- [ ] **Step 1: Build the shared SVG composition**

Use `viewBox="0 0 1200 400"`, background `#11100F`, primary text `#F4EADC`, gold `#C9A968`, brown accent `#845A2B`, and muted text `#8F877D`. Compose only rectangles, lines, circles, text, and gradients; do not add handwritten icon paths.

The left text block contains product name, one-line positioning, and `LOCAL-FIRST · STRUCTURED · MODEL-AGNOSTIC`. The right side contains three overlapping manuscript sheets and a production sequence `01 ARCHITECTURE → 02 DRAFT → 03 REVIEW → 04 FINAL` rendered as text and rules.

- [ ] **Step 2: Localize the hero copy independently**

English positioning: `A local-first production workspace for long-form fiction.`

Chinese positioning: `面向长篇小说的本地优先创作与生产工作台。`

Keep text inside safe margins `x=72..1128`, use system font stacks, and ensure the Chinese variant has enough width rather than reusing English font sizes blindly.

- [ ] **Step 3: Render and inspect both heroes**

Render each SVG to PNG at 1200 × 400 using a browser screenshot or the workspace’s SVG renderer. Inspect both at original resolution with `view_image`.

Expected: no clipping, no missing glyphs, no overlap, strong title hierarchy, and legible copy at GitHub README width.

- [ ] **Step 4: Commit**

```powershell
git add docs/assets/readme/hero-en.svg docs/assets/readme/hero-zh.svg
git commit -m "docs: add bilingual editorial hero artwork"
```

### Task 2: Rewrite the English README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `docs/assets/readme/hero-en.svg`, `docs/assets/screenshot-main.png`, package scripts, and release filename from the release plan.

- [ ] **Step 1: Replace the top section**

Use this order:

```markdown
<div align="right"><a href="README_zh.md">简体中文</a></div>

![AI Novel Writer — local-first fiction production workspace](docs/assets/readme/hero-en.svg)

<div align="center">
  <strong>Plan, draft, review, revise, and finalize long-form fiction in one local desktop workspace.</strong>
</div>

![AI Novel Writer application screenshot](docs/assets/screenshot-main.png)
```

- [ ] **Step 2: Write evidence-backed sections**

Include: Why AI Novel Writer; production workflow; Windows quick start; model configuration; language switching; core capabilities; local data and privacy; development commands using pnpm; project structure; FAQ; contributing; license.

Quick start must point to the `v0.2.0` Release page and `AI-Novel-Writer-0.2.0-windows-x64.zip`, and tell users to extract before running `AI小说作家.exe`.

- [ ] **Step 3: Remove unverified claims**

Delete claims about performance, user count, model quality, platform support, or security guarantees that are not proven by repository code or release evidence. State accurately that users supply their own compatible model endpoint.

- [ ] **Step 4: Run link and structure checks**

Run the beautify audit script against `README.md` and manually verify every relative asset path exists.

Expected: no missing asset, balanced information hierarchy, no mixed-language body sections.

### Task 3: Rewrite the Chinese README with claim parity

**Files:**
- Modify: `README_zh.md`

**Interfaces:**
- Consumes: the same factual claims and section order as `README.md`.

- [ ] **Step 1: Replace the top section**

```markdown
<div align="right"><a href="README.md">English</a></div>

![AI 小说作家——本地优先的长篇小说创作工作台](docs/assets/readme/hero-zh.svg)

<div align="center">
  <strong>在一个本地桌面工作台中完成规划、草稿、评审、修订与定稿。</strong>
</div>

![AI 小说作家应用界面](docs/assets/screenshot-main.png)
```

- [ ] **Step 2: Translate for readers rather than line-by-line**

Keep the same factual content, release filename, commands, limitations, and links as English. Use natural Simplified Chinese headings and explanations; do not add claims absent from English.

- [ ] **Step 3: Audit parity**

Compare headings, code blocks, release links, assets, and factual claims side by side. Both READMEs must describe the same supported platform and dependency workflow.

- [ ] **Step 4: Commit both READMEs**

```powershell
git add README.md README_zh.md
git commit -m "docs: rewrite bilingual project readmes"
```

### Task 4: Verify the GitHub rendering contract

**Files:**
- No new files unless a rendering correction is required.

**Interfaces:**
- Produces: visual and structural evidence for release.

- [ ] **Step 1: Read the visual verification checklist**

Read `github-readme-visuals/references/visual-checklist.md` completely before verification.

- [ ] **Step 2: Run both README audit tools**

Run:

```powershell
python C:\tmp\beautify-github-readme-inspect\skills\beautify-github-readme\scripts\audit_readme.py README.md
python C:\tmp\beautify-github-readme-inspect\skills\beautify-github-readme\scripts\audit_readme.py README_zh.md
```

Run the `github-readme-visuals` `verify_readme_visuals.py` script with expected 1200 × 400 hero dimensions against both README files.

- [ ] **Step 3: Inspect actual raster output**

Render and inspect both heroes at original resolution. Open the README in a local GitHub-like Markdown preview and confirm the hero, language link, screenshot, headings, and code blocks render without horizontal overflow.

- [ ] **Step 4: Run repository checks and commit corrections**

Run: `git diff --check`

Expected: no whitespace errors, missing assets, broken local links, or mixed-language hero references.

If corrections are needed, stage only README and visual files and commit with `docs: fix readme rendering verification`.
