# Enterprise Resource Planner

> Plan job replacements and work portfolios from Excel.

Enterprise Resource Planner is a local-first planning workbench for maintenance
and operations teams. Import a schedule, inspect it in a spreadsheet-style
view, compare possible replacements, and keep a record of the decision.

Your priority lists come first. Scoring and the example model offer another
view of the data, but they never make the final choice for you.

Despite the name, this is not a finance or accounting suite.

**[Open the live application](https://davidoffichw.github.io/enterprise-resource-planner/)**

![ERP Recommendations workbench with a ranked replacement selected](media/erp-recommendations-workflow.png)

## What it does

- Import and export multi-sheet Excel workbooks
- Edit, filter, sort, and map planning data without discarding source columns
- Create and reuse ranked priority lists
- Compare replacement candidates or choose one directly
- Plan a portfolio around budget and resource limits
- Save decisions and revisit earlier scenarios
- Back up and restore browser-local plans
- Continue working offline after the hosted app has cached its assets

## Try it

The built-in maintenance and facilities plans use fictional data.

1. Open **Facilities example** from **Planning Data**.
2. Go to **Recommendations** and select the job to replace.
3. Open **Priority lists** and create **Example priorities**.
4. Choose **Example priorities** under **Rank by**, then apply the ranking.
5. Pick a replacement and choose **Use this replacement**.
6. Open **History** to review the saved decision.

You do not need to run a model to make a decision. Any loaded replacement can
be selected manually, including records with incomplete data. Warnings remain
visible instead of silently removing those choices.

## Run locally

You need Node.js 24.15 or newer and npm 11 or newer.

```bash
git clone https://github.com/DavidoffichW/enterprise-resource-planner.git
cd enterprise-resource-planner
npm ci
npm run dev
```

Open the local address printed by Vite. Press `Ctrl+C` to stop the development
server.

Verify the project and preview a production build:

```bash
npm run verify
npm run preview
```

The static build is written to `dist/`. The built application does not need
Node.js, Python, or a backend at runtime.

## Working with data

ERP keeps the original workbook structure and records how imported columns map
to planning roles. Source values, edits, mappings, rankings, and saved decisions
remain distinguishable instead of being flattened into one opaque dataset.

Priority Lists preserve exact numeric ranks. Missing ranks stay unranked. The
optional scoring methods are decision-support tools, not eligibility gates.

Portfolio planning uses exact subset enumeration for up to 20 candidates. For
larger sets it switches to a deterministic heuristic and tells you that the
result is not guaranteed to be optimal.

## Data and privacy

All spreadsheet processing happens in the browser. There is no account system,
backend database, telemetry, remote font, CDN dependency, or remote inference
service.

Plans and decisions are stored in IndexedDB for the current browser profile.
That storage is not encrypted, synchronized, or backed up automatically. Export
a backup before clearing browser data, changing profiles, or moving to another
device.

## Project structure

- `src/contracts/` contains shared data and evidence contracts
- `src/core/` contains deterministic planning logic with no React dependency
- `src/web/` contains the interface, spreadsheet adapters, and browser storage
- `public/` contains static assets and the offline service worker

The separation keeps planning rules independently testable and prevents React
state from becoming the source of domain truth.

ERP uses TypeScript, React, Vite, AG Grid Community, `read-excel-file`,
`write-excel-file`, and `fflate`. Exact dependency versions are recorded in
`package-lock.json`; third-party license information is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Limits

ERP is a decision-support tool. It does not provide organization-specific
validation, policy enforcement, encrypted team storage, automatic sync, or a
guarantee that a recommendation is operationally correct.

Use your own data controls, validation rules, and professional judgment before
adopting a plan in a real operating environment.

## Deployment

The production build can be served from any suitable static host over HTTP or
HTTPS. Opening `dist/index.html` directly with `file://` is not supported.

The repository includes a manual GitHub Pages workflow in
`.github/workflows/deploy-pages.yml`. Set `ERP_BASE_PATH` when deploying below
a repository subpath.

## License

[MIT](LICENSE) © DavidoffichW

Release notes are available in [CHANGELOG.md](CHANGELOG.md).
