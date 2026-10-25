import type { PlanningDataset } from '../../contracts';
import { issueCounts } from '../../core';

export function ValidationPanel({ dataset }: { dataset: PlanningDataset }) {
  const counts = issueCounts(dataset);
  const ready = dataset.rows.filter((row) => row.readiness === 'READY').length;
  const review = dataset.rows.filter((row) => row.readiness === 'REVIEW_REQUIRED').length;
  const invalid = dataset.rows.filter((row) => row.readiness === 'INVALID').length;
  return (
    <section className="panel validation-panel" aria-labelledby="validation-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Step 4</p>
          <h2 id="validation-title">Validate planning data</h2>
          <p>Errors block reliable canonical use; warnings identify conditions that need operator review.</p>
        </div>
        <div className="issue-summary" aria-label="Validation issue counts">
          <span className="issue-count error">{counts.error} errors</span>
          <span className="issue-count warning">{counts.warning} warnings</span>
        </div>
      </div>
      <div className="readiness-summary" role="status">
        <strong>Decision readiness: {dataset.readiness.replaceAll('_', ' ').toLocaleLowerCase('en-US')}</strong>
        <span>{ready} ready</span>
        <span>{review} review required</span>
        <span>{invalid} invalid</span>
        {dataset.readiness !== 'READY' && <span>Only ready rows may enter future automatic decision processing.</span>}
      </div>
      {dataset.issues.length === 0 ? (
        <div className="validation-clear" role="status">No validation issues detected.</div>
      ) : (
        <ol className="issue-list">
          {dataset.issues.slice(0, 75).map((issue) => {
            const column = dataset.columns.find((candidate) => candidate.id === issue.columnId);
            const row = dataset.rows.find((candidate) => candidate.id === issue.rowId);
            return (
              <li key={issue.id} className={`issue ${issue.severity}`}>
                <span className="issue-code">{issue.code.replaceAll('_', ' ')}</span>
                <span>{issue.message}</span>
                {(column || row) && (
                  <span className="issue-location">
                    {[row ? `row ${row.sourceRow}` : '', column ? `column ${column.originalHeader || column.sourceIndex + 1}` : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {dataset.issues.length > 75 && <p className="inline-help">Showing the first 75 of {dataset.issues.length} issues.</p>}
    </section>
  );
}
