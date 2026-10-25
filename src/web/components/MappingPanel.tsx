import { useState } from 'react';
import type { PlanningDataset, SemanticRole } from '../../contracts';
import { SEMANTIC_ROLE_DEFINITIONS } from '../../contracts';
import { confirmMappings, setColumnRole, setDatasetGrain, validateDataset } from '../../core';

interface MappingPanelProps {
  dataset: PlanningDataset;
  onChange: (dataset: PlanningDataset) => void;
}

export function MappingPanel({ dataset, onChange }: MappingPanelProps) {
  const [confirmationBlocked, setConfirmationBlocked] = useState<string | null>(null);
  const changeRole = (columnId: string, value: string) => {
    setConfirmationBlocked(null);
    onChange(validateDataset(setColumnRole(dataset, columnId, (value || null) as SemanticRole | null)));
  };

  const confirm = () => {
    const next = validateDataset(confirmMappings(dataset));
    if (next.mappingsConfirmed) {
      setConfirmationBlocked(null);
    } else {
      const reasons = next.issues
        .filter((issue) => ['SOURCE_IDENTITY_MISSING', 'DUPLICATE_SEMANTIC_ROLE', 'GRAIN_COLUMN_MISSING', 'INVALID_GRAIN_ROLE'].includes(issue.code))
        .map((issue) => issue.message);
      if (!next.grainColumnId) reasons.push('Select a dataset-grain column.');
      setConfirmationBlocked(`Confirmation blocked: ${reasons.join(' ')} Your selections were preserved.`);
    }
    onChange(next);
  };

  return (
    <section className="panel mapping-panel" aria-labelledby="mapping-title">
      <div className="panel-heading">
        <div>
          <h2 id="mapping-title">Column mapping</h2>
          <p>Match source columns to the fields ERP uses. Original headers remain unchanged.</p>
        </div>
        <div className="mapping-statuses">
          <span className={`status-chip ${dataset.mappingsConfirmed ? 'success' : 'attention'}`}>
            {dataset.mappingsConfirmed ? 'Mappings confirmed' : 'Confirmation required'}
          </span>
          <span className={`status-chip ${dataset.readiness === 'READY' ? 'success' : dataset.readiness === 'PARTIALLY_READY' ? 'attention' : 'error'}`}>
            {dataset.readiness === 'READY' ? 'Ready for decisions' : dataset.readiness === 'PARTIALLY_READY' ? 'Some rows need review' : 'Not ready for decisions'}
          </span>
        </div>
      </div>

      <div className="grain-control">
        <label htmlFor="grain-column">Record identifier</label>
        <select
          id="grain-column"
          value={dataset.grainColumnId ?? ''}
          onChange={(event) => {
            setConfirmationBlocked(null);
            onChange(validateDataset(setDatasetGrain(dataset, event.target.value || null)));
          }}
        >
          <option value="">Select the column that uniquely identifies each row</option>
          {dataset.columns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.originalHeader || `(unnamed column ${column.sourceIndex + 1})`}
              {column.duplicateOrdinal > 1 ? ` [${column.duplicateOrdinal}]` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="mapping-table-wrap">
        <table className="mapping-table">
          <thead>
            <tr>
              <th scope="col">Source column</th>
              <th scope="col">Position</th>
              <th scope="col">Semantic role</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {dataset.columns.map((column) => (
              <tr key={column.id}>
                <th scope="row">
                  {column.originalHeader || '(unnamed)'}
                  {column.duplicateOrdinal > 1 && <span className="duplicate-tag">duplicate {column.duplicateOrdinal}</span>}
                </th>
                <td>{column.sourceIndex + 1}</td>
                <td>
                  <label className="sr-only" htmlFor={`mapping-${column.id}`}>
                    Semantic role for {column.originalHeader || `column ${column.sourceIndex + 1}`}
                  </label>
                  <select
                    id={`mapping-${column.id}`}
                    value={column.semanticRole ?? ''}
                    onChange={(event) => changeRole(column.id, event.target.value)}
                  >
                    <option value="">Unmapped / preserve as extra field</option>
                    {SEMANTIC_ROLE_DEFINITIONS.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <span className={`mapping-state ${column.mappingState}`}>{column.mappingState.replace('_', ' ')}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel-actions">
        <button
          className="button primary"
          type="button"
          onClick={confirm}
        >
          Confirm mapping
        </button>
        {!dataset.grainColumnId && <span className="inline-help">Choose a unique row identifier first.</span>}
        {confirmationBlocked && (
          <span className="inline-help error-text" role="alert">
            {confirmationBlocked}
          </span>
        )}
      </div>
    </section>
  );
}
