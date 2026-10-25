import type { SourceTable } from '../contracts';
import { createDatasetFromTable } from './dataset';

const AREAS = ['North Utilities', 'Assembly East', 'Warehouse', 'Packaging', 'Water Treatment'];
const CATEGORIES = ['Inspection', 'Corrective', 'Preventive', 'Calibration'];
const CREWS = ['Mechanical', 'Electrical', 'Instrumentation', 'Mixed'];
const STATUSES = ['Proposed', 'Ready', 'On hold'];

export function createSyntheticPlanningDataset() {
  const headers = [
    'Asset ID',
    'Operational Area',
    'Planned Job ID',
    'Job Description',
    'Job Category',
    'Priority',
    'Estimated Cost',
    'Estimated Duration',
    'Resource Requirement',
    'Planned Date',
    'Status',
    'Permit Class',
    'Planner Note',
    'Priority',
  ];

  const rows: SourceTable['rows'] = Array.from({ length: 28 }, (_, index) => {
    const number = index + 1;
    return [
      `AST-${String((index % 14) + 1).padStart(3, '0')}`,
      AREAS[index % AREAS.length],
      index === 18 ? 'JOB-0012' : `JOB-${String(number).padStart(4, '0')}`,
      `${CATEGORIES[index % CATEGORIES.length]} service for industrial asset ${((index % 14) + 1)}`,
      CATEGORIES[index % CATEGORIES.length],
      ['P1', 'P2', 'P3', 'P4'][index % 4],
      index === 8 ? null : index === 15 ? '12,500' : 1800 + index * 425,
      index === 10 ? 0 : index === 21 ? 'unknown' : 3 + (index % 9),
      CREWS[index % CREWS.length],
      index === 12 ? '04/05/2027' : `2027-${String((index % 6) + 1).padStart(2, '0')}-${String((index % 25) + 1).padStart(2, '0')}`,
      STATUSES[index % STATUSES.length],
      ['Standard', 'Electrical isolation', 'Confined space'][index % 3],
      index === 6 ? null : `Synthetic planning assumption ${number}`,
      ['High', 'Medium', 'Low'][index % 3],
    ];
  });

  return createDatasetFromTable({
    sourceName: 'erp-synthetic-industrial-maintenance-v1',
    sourceIdentity: 'synthetic:erp-industrial-maintenance:v1',
    sheetName: 'Synthetic Plan',
    synthetic: true,
    headers,
    rows,
  });
}

export function createSyntheticFacilitiesDataset() {
  const areas = ['Campus North', 'Campus South', 'Distribution Hub'];
  const resources = ['HVAC', 'Electrical', 'General'];
  const categories = ['Inspection', 'Preventive', 'Corrective'];
  const statuses = ['Ready', 'Proposed', 'Scheduled'];
  const rows: SourceTable['rows'] = Array.from({ length: 18 }, (_, index) => [
    `FAC-${String((index % 9) + 1).padStart(3, '0')}`,
    areas[index % areas.length],
    `FS-${String(index + 1).padStart(4, '0')}`,
    `Synthetic facilities work order ${index + 1}`,
    categories[index % categories.length],
    `P${(index % 4) + 1}`,
    950 + index * 310,
    2 + (index % 7),
    resources[index % resources.length],
    `2028-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 24) + 1).padStart(2, '0')}`,
    statuses[index % statuses.length],
    `Zone ${String.fromCharCode(65 + (index % 4))}`,
  ]);
  return createDatasetFromTable({
    sourceName: 'erp-synthetic-facilities-scheduling-v1',
    sourceIdentity: 'synthetic:facilities-scheduling:recipe-1:seed-271828',
    sheetName: 'Facilities Plan',
    synthetic: true,
    headers: [
      'Asset ID', 'Operational Area', 'Planned Job ID', 'Job Description', 'Job Category', 'Priority',
      'Estimated Cost', 'Estimated Duration', 'Resource Requirement', 'Planned Date', 'Status', 'Service Zone',
    ],
    rows,
  });
}
