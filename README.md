# Enterprise Resource Planner

Enterprise Resource Planner (ERP) is a local-first browser application for engineering planning, resource allocation, replacement choices, and auditable decision evidence. It is designed for planners, engineers, maintenance teams, and operations managers who work with imperfect spreadsheets. It is not a conventional finance or accounting ERP suite.

The engineer remains in control. ERP can display Priority List, reference, and model-based recommendations, but it does not make the final replacement decision and it does not silently turn a rule result into a mandatory workflow gate.

![ERP Recommendations workspace showing an engineer-controlled replacement workflow](media/erp-recommendations-workflow.png)

## Current product workflow

`Load sample or import XLSX → Review and edit planning data → Select a planned job → Apply a Priority List or optional analysis → Accept #1 or choose another replacement → Record an immutable Case`

What works in the current development candidate:

- Real browser-based `.xlsx` import and export with multiple worksheets, dynamic columns, original headers, mappings, provenance, external-edit reconciliation, and stable SHA-256 snapshot identities.
- An editable spreadsheet grid with search, sort, filters, column visibility/resizing, keyboard navigation, selection, validation feedback, and undo/redo.
- Readable but incomplete or invalid planning records remain visible, editable, exportable, and available for an explicit engineer decision. Data-quality and eligibility states remain visible evidence.
- Reusable Priority Lists with a stable logical identity, immutable revision digest, explicit item/rank mapping, retained invalid source rows, and deterministic numeric rank order.
- A focused Recommendations workspace that shows the planned job, active source, #1 recommendation, remaining candidates, and a prominent **Accept #1 as Replacement** action. Any other loaded record can be selected manually.
- Optional transparent weighted and synthetic-model rankings. Unsupported candidates remain visible and unranked instead of being silently removed.
- Budget/resource portfolio optimization with reproducible inputs. Up to 20 candidates use an exact deterministic solver; larger populations use a clearly labeled bounded greedy method.
- Immutable Cases with explicit human decision events, portable integrity-checked export, parent-linked scenario re-evaluation, and no inference that browsing or acceptance is feedback, an outcome, or a training label.
- Browser-profile-local IndexedDB persistence, application backup/restore, explicit deletion, versioned state migration, and cached offline use after an initial hosted load.

ERP sends no analytics or planning data and uses no remote fonts, CDNs, inference services, or backend during normal operation.

## Quick start

Requirements are declared in `package.json` (currently Node.js 24.15+ and npm 11+). Python, a database server, and a backend are not application requirements.

```powershell
npm ci
npm run dev
```

For a production-equivalent local build:

```powershell
npm run verify
npm run preview
```

Open the URL printed by Vite. `npm run build` creates static assets in `dist/`. Direct `file://` execution is not supported.

## Guided demonstration

1. Select **Load facilities sample**.
2. Review the planning data. Mapping confirmation is available for canonical analysis, but it is not required to inspect, edit, export, or make a manual replacement choice.
3. Open **Recommendations** and select a planned job.
4. Select **Create synthetic Priority List**, then **Apply Priority List**.
5. Review the active source and #1 recommendation. Choose **Accept #1 as Replacement**, or select a different row under **Manual alternative**.
6. Open **Cases** to inspect the immutable snapshot and the single explicit `DECISION_RECORDED` event.
7. Optionally run a reference/model ranking or portfolio optimization. Scenario branches re-evaluate changed budget, scope, or ranking inputs from immutable parent-Case evidence and create no decision event by themselves.

The included maintenance and facilities examples are independently generated synthetic data. They do not represent private operations or demonstrate real-world model accuracy.

## Data and evidence behavior

Imported, synthetic, user-entered, externally edited, derived, assumed, and observed values remain distinguishable. Missing is not zero. Semantic roles do not rename source headers, and unmapped columns remain part of the workbook.

Candidate Scope defines the considered population. Validation, deterministic eligibility, and feasibility provide advisory evidence and hard-constraint findings where applicable; they do not silently override a user's final replacement selection. Priority Rank, Model Rank, and My Rank remain separate meanings.

A Priority List has one stable logical identity and one or more immutable revisions. A revision preserves every imported row, including invalid identifiers, invalid ranks, and duplicate entries, together with their issues. Only valid entries produce Priority Rank. Numeric ranks are ordered as numbers, with unranked entries always last.

Case evidence separates a deliberate replacement decision from feedback, outcomes, and learning evidence. The one-click acceptance action records the chosen source and candidate exactly once; it does not fabricate any later evidence.

## Local storage and offline limits

IndexedDB stores ERP state in the current browser profile. **Saved locally** means the last aggregate transaction completed in that profile; it does not mean synchronized, encrypted, or backed up. Use **Export local backup** before clearing site data or moving devices.

The static application can be installed/cached and used offline after one successful hosted load. Direct `file://` launch is not supported. Private browsing, storage pressure, browser cleanup, profile loss, or device loss can erase local state. There is no cloud recovery or multi-user synchronization.

## Architecture

ERP uses TypeScript, React, Vite, AG Grid Community, `read-excel-file`, `write-excel-file`, and `fflate`.

- `src/contracts/` defines planning, recommendation, portfolio, Case, scenario, and persistence schemas.
- `src/core/` contains deterministic framework-independent domain functions.
- `src/web/` contains the browser UI, spreadsheet/grid adapters, and IndexedDB integration.
- `public/` contains reviewed static runtime assets and offline metadata.

Dependencies and exact resolutions are declared in `package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.md`, and `public/runtime-manifest.json`.

## Status and limitations

This repository is a private distribution candidate, not a public release. The application has development verification but is not security-certified, operationally qualified, or Owner-accepted for release.

- Spreadsheet safeguards reduce risk but do not constitute comprehensive XLSX fuzzing or universal OOXML compatibility.
- The bundled model is a synthetic demonstration ranker, not a probability, confidence, expected-benefit estimate, or validated operational model.
- IndexedDB is local and unencrypted at the application layer.
- Formal accessibility, release-candidate security, and Owner acceptance remain open gates.
- No project software license has been approved. Until the Owner selects and adds a license, this repository grants no general permission to copy, modify, or redistribute the project.
- The repository must remain private and must not be deployed or released publicly until rights, licensing, qualification, and Owner approval are complete.
