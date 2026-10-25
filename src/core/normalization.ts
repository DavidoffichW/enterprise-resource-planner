import type { CellScalar, PlanningCell, SemanticRole } from '../contracts';
import { SEMANTIC_ROLE_DEFINITIONS } from '../contracts';

const STRICT_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface NormalizationResult {
  value: CellScalar;
  valid: boolean;
  reason?: string;
}

export function normalizeForRole(cell: PlanningCell, role: SemanticRole | null): NormalizationResult {
  const raw = cell.currentRaw;
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { value: null, valid: true };
  }
  if (!role) return { value: raw, valid: true };

  const definition = SEMANTIC_ROLE_DEFINITIONS.find((candidate) => candidate.id === role);
  if (definition?.canonicalType === 'number') return normalizeNumber(raw);
  if (definition?.canonicalType === 'date') return normalizeDate(raw, cell.sourceType);
  return { value: typeof raw === 'string' ? raw.trim() : String(raw), valid: true };
}

function normalizeNumber(raw: Exclude<CellScalar, null>): NormalizationResult {
  if (typeof raw === 'number') {
    return Number.isFinite(raw)
      ? { value: raw, valid: true }
      : { value: null, valid: false, reason: 'Numeric value must be finite.' };
  }
  if (typeof raw !== 'string' || !STRICT_NUMBER.test(raw.trim())) {
    return { value: null, valid: false, reason: 'Use an unambiguous finite number without grouping separators.' };
  }
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed)
    ? { value: parsed, valid: true }
    : { value: null, valid: false, reason: 'Numeric value is outside the supported range.' };
}

function normalizeDate(raw: Exclude<CellScalar, null>, sourceType: PlanningCell['sourceType']): NormalizationResult {
  if (typeof raw !== 'string') {
    return { value: null, valid: false, reason: 'Date values must resolve to ISO YYYY-MM-DD text.' };
  }
  const trimmed = raw.trim();
  const match = ISO_DATE.exec(trimmed);
  if (!match) {
    return { value: null, valid: false, reason: 'Use ISO YYYY-MM-DD; ambiguous dates are not coerced.' };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  const valid =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day;
  return valid
    ? { value: trimmed, valid: true }
    : { value: null, valid: false, reason: `Invalid calendar date${sourceType === 'date' ? '' : '; no coercion applied'}.` };
}
