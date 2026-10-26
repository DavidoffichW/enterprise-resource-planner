# Enterprise Resource Planner

Enterprise Resource Planner (ERP) is a local-first browser application for turning operational spreadsheets into clear planning, replacement, and portfolio decisions. It is built for engineers, planners, maintenance teams, and operations managers; it is not a finance or accounting ERP suite.

![ERP Recommendations workbench with a ranked replacement selected](media/erp-recommendations-workflow.png)

## Quick start

ERP currently requires Node.js 24.15 or later and npm 11 or later for development. The built application runs entirely in the browser and does not require a backend or Python.

```powershell
npm ci
npm run dev
```

For a production build:

```powershell
npm run verify
npm run preview
```

Open the local URL printed by Vite. `npm run build` writes the static application to `dist/`.

For a repository-hosted build, set `ERP_BASE_PATH` to the hosting subpath before running `npm run build:pages`. The included GitHub Pages workflow is manual-only; no hosted application is published until the project rights and license are approved.

## Try a replacement decision

1. Open **Facilities example** from Planning Data.
2. Go to **Recommendations** and choose the job to replace.
3. Open **Priority lists**, create **Example priorities**, and select **Apply ranking**.
4. Review the original priority order, choose a candidate, and select **Use this replacement**.
5. Open **History** to review the saved decision and its supporting details.

The two built-in plans contain fictional maintenance and facilities work intended only for demonstration.

## Main capabilities

- Import and export real `.xlsx` workbooks with multiple worksheets and dynamic source columns.
- Map spreadsheet columns to planning fields without renaming or discarding the originals.
- Search, sort, filter, resize, hide, edit, undo, and redo in a spreadsheet-style planning grid.
- Retain incomplete rows with visible warnings and allow an engineer to select them explicitly without presenting them as valid.
- Import and reuse immutable Priority List versions without changing their original numeric ranks or losing earlier versions.
- Compare Priority List, weighted-reference, example-model, and manual replacement choices.
- Build budget- and resource-constrained work portfolios with an explicit solution status.
- Save replacement decisions, scenarios, feedback, and outcomes with portable evidence records.
- Keep multiple planning workspaces in browser-local storage and export or restore a local backup.
- Run from locally packaged assets, including cached offline use after an initial hosted load.
- Switch between accessible dark and light workbench themes.

## Architecture

ERP uses TypeScript, React, Vite, AG Grid Community, `read-excel-file`, `write-excel-file`, and `fflate`.

- `src/contracts/` defines the public data and evidence structures.
- `src/core/` contains deterministic, framework-independent planning logic.
- `src/web/` provides the browser interface, spreadsheet adapters, and local persistence.
- `public/` contains the static runtime manifest, icons, and offline service worker.

Exact dependency versions are locked in `package-lock.json`; third-party licenses are summarized in `THIRD_PARTY_NOTICES.md`.

## Data handling and limitations

Planning data stays in the current browser during normal use. ERP does not include analytics, remote fonts, CDNs, cloud inference, or a server-side data service. Browser-local storage is not encrypted, synchronized, or a substitute for backups, so export a backup before clearing site data or moving devices.

The application preserves source values and distinguishes imported, edited, generated, and observed information. Missing values are not treated as zero. Example-model scores are relative ranking aids—not probabilities, confidence values, or validated operational predictions.

Direct `file://` launch is not supported; use the development server, preview server, or a static host. Spreadsheet safeguards reduce risk but do not provide universal OOXML compatibility or security certification. This project is under active development and has not been qualified for safety-critical or production operational use.

Version `0.1.0` is technically prepared as a release candidate; see [CHANGELOG.md](CHANGELOG.md). No project license is currently included. Without a license, no general permission is granted to copy, modify, or redistribute the source, and the repository is not yet approved for public release.
