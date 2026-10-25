import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellValueChangedEvent,
  type ColDef,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import type { CellScalar, PlanningCell, PlanningDataset } from '../../contracts';
import { editCell, restoreCell } from '../../core';

ModuleRegistry.registerModules([AllCommunityModule]);

interface GridRow {
  __rowId: string;
  [columnId: string]: CellScalar | string;
}

interface PlanningGridProps {
  dataset: PlanningDataset;
  onChange: (dataset: PlanningDataset) => void;
}

const gridTheme = themeQuartz.withParams({
  accentColor: '#0b7189',
  backgroundColor: '#ffffff',
  borderColor: '#d6dfe3',
  fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
  foregroundColor: '#17313f',
  headerBackgroundColor: '#eef4f5',
  headerTextColor: '#173a4f',
  rowHoverColor: '#f2f8f8',
  selectedRowBackgroundColor: '#d9eff2',
});

interface CellTransaction {
  rowId: string;
  columnId: string;
  before: PlanningCell;
  after: PlanningCell;
}

export function PlanningGrid({ dataset, onChange }: PlanningGridProps) {
  const [search, setSearch] = useState('');
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => new Set());
  const [showColumns, setShowColumns] = useState(false);
  const undoStack = useRef<CellTransaction[]>([]);
  const redoStack = useRef<CellTransaction[]>([]);
  const [historyCounts, setHistoryCounts] = useState({ undo: 0, redo: 0 });

  useEffect(() => {
    if (!dataset.snapshotRevision) return;
    undoStack.current = [];
    redoStack.current = [];
    setHistoryCounts({ undo: 0, redo: 0 });
  }, [dataset.snapshotRevision]);

  const rowData = useMemo<GridRow[]>(
    () =>
      dataset.rows.map((row) => {
        const result: GridRow = { __rowId: row.id };
        dataset.columns.forEach((column) => {
          result[column.id] = row.cells[column.id]?.currentRaw ?? null;
        });
        return result;
      }),
    [dataset],
  );

  const columnDefs = useMemo<ColDef<GridRow>[]>(
    () =>
      dataset.columns.map((column) => ({
        colId: column.id,
        field: column.id,
        headerName: `${column.originalHeader || `(unnamed ${column.sourceIndex + 1})`}${column.duplicateOrdinal > 1 ? ` [${column.duplicateOrdinal}]` : ''}`,
        headerTooltip: `${column.originalHeader || 'Unnamed source column'} · ${column.semanticRole ?? 'unmapped'}`,
        editable: true,
        sortable: true,
        filter: true,
        resizable: true,
        hide: hiddenColumns.has(column.id),
        minWidth: 140,
        flex: 1,
        cellClassRules: {
          'cell-invalid': (params) =>
            dataset.issues.some(
              (issue) => issue.severity === 'error' && issue.rowId === params.data?.__rowId && issue.columnId === column.id,
            ),
          'cell-modified': (params) => {
            const row = dataset.rows.find((candidate) => candidate.id === params.data?.__rowId);
            return row?.cells[column.id]?.modified === true;
          },
        },
      })),
    [dataset, hiddenColumns],
  );

  const onCellValueChanged = (event: CellValueChangedEvent<GridRow>) => {
    const columnId = event.column.getColId();
    const value = (event.newValue ?? null) as CellScalar;
    const before = dataset.rows.find((row) => row.id === event.data.__rowId)?.cells[columnId];
    if (!before || Object.is(before.currentRaw, value)) return;
    const updated = editCell(dataset, event.data.__rowId, columnId, value);
    const after = updated.rows.find((row) => row.id === event.data.__rowId)?.cells[columnId];
    if (!after) return;
    undoStack.current.push({ rowId: event.data.__rowId, columnId, before, after });
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
    setHistoryCounts({ undo: undoStack.current.length, redo: 0 });
    onChange(updated);
  };

  const undo = () => {
    const transaction = undoStack.current.pop();
    if (!transaction) return;
    redoStack.current.push(transaction);
    setHistoryCounts({ undo: undoStack.current.length, redo: redoStack.current.length });
    onChange(restoreCell(dataset, transaction.rowId, transaction.columnId, transaction.before));
  };

  const redo = () => {
    const transaction = redoStack.current.pop();
    if (!transaction) return;
    undoStack.current.push(transaction);
    setHistoryCounts({ undo: undoStack.current.length, redo: redoStack.current.length });
    onChange(restoreCell(dataset, transaction.rowId, transaction.columnId, transaction.after));
  };

  const toggleColumn = (columnId: string) => {
    setHiddenColumns((current) => {
      const next = new Set(current);
      if (next.has(columnId)) next.delete(columnId);
      else next.add(columnId);
      return next;
    });
  };

  return (
    <section className="panel grid-panel" aria-labelledby="grid-title">
      <div className="panel-heading grid-heading">
        <div>
          <p className="eyebrow">Step 5</p>
          <h2 id="grid-title">Inspect and edit</h2>
          <p>{dataset.rows.length.toLocaleString()} rows · {dataset.columns.length} source columns · edits stay local until export</p>
        </div>
        <span className={`status-chip ${dataset.dirty ? 'attention' : 'neutral'}`}>
          {dataset.dirty ? 'Unsaved edits' : 'No local edits'}
        </span>
      </div>
      <div className="grid-toolbar">
        <label className="search-control">
          <span>Search rows</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search all visible values"
          />
        </label>
        <button className="button secondary" type="button" onClick={() => setShowColumns((value) => !value)} aria-expanded={showColumns}>
          Columns ({dataset.columns.length - hiddenColumns.size}/{dataset.columns.length})
        </button>
        <div className="history-actions" aria-label="Cell edit history">
          <button className="button secondary" type="button" onClick={undo} disabled={historyCounts.undo === 0}>Undo edit</button>
          <button className="button secondary" type="button" onClick={redo} disabled={historyCounts.redo === 0}>Redo edit</button>
        </div>
      </div>
      {showColumns && (
        <fieldset className="column-chooser">
          <legend>Visible columns</legend>
          {dataset.columns.map((column) => (
            <label key={column.id}>
              <input type="checkbox" checked={!hiddenColumns.has(column.id)} onChange={() => toggleColumn(column.id)} />
              {column.originalHeader || `(unnamed ${column.sourceIndex + 1})`}
              {column.duplicateOrdinal > 1 ? ` [${column.duplicateOrdinal}]` : ''}
            </label>
          ))}
        </fieldset>
      )}
      <div className="grid-frame" data-testid="planning-grid">
        <AgGridReact<GridRow>
          theme={gridTheme}
          rowData={rowData}
          columnDefs={columnDefs}
          quickFilterText={search}
          getRowId={(params) => params.data.__rowId}
          onCellValueChanged={onCellValueChanged}
          rowSelection={{ mode: 'multiRow', enableClickSelection: true }}
          animateRows={false}
          suppressClipboardPaste={true}
          defaultColDef={{ suppressHeaderMenuButton: false }}
        />
      </div>
      <p className="grid-guidance">Select a cell and type to edit. Use header menus for filtering, click headers to sort, and use Tab or arrow keys to navigate.</p>
    </section>
  );
}
