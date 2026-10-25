export function normalizeIdentityText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-');
}

export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function makeColumnId(sourceIndex: number, header: string): string {
  const label = normalizeIdentityText(header) || 'unnamed';
  return `column-${sourceIndex + 1}-${label}-${stableHash(`${sourceIndex}\u0000${header}`)}`;
}

export function makeRowId(sourceName: string, sheetName: string, sourceRow: number): string {
  return `row-${sourceRow}-${stableHash(`${sourceName}\u0000${sheetName}\u0000${sourceRow}`)}`;
}

export function makeDatasetId(sourceName: string, sheetName: string, headers: string[]): string {
  return `dataset-${stableHash(`${sourceName}\u0000${sheetName}\u0000${headers.join('\u001f')}`)}`;
}
