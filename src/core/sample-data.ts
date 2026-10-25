import type { SourceTable } from '../contracts';
import { createDatasetFromTable } from './dataset';

const AREAS = ['North Utilities', 'Assembly East', 'Warehouse', 'Packaging', 'Water Treatment'];
const CATEGORIES = ['Inspection', 'Corrective', 'Preventive', 'Calibration'];
const CREWS = ['Mechanical', 'Electrical', 'Instrumentation', 'Mixed'];
const STATUSES = ['Proposed', 'Ready', 'On hold'];
const MAINTENANCE_JOBS = [
  'Inspect cooling-water pump alignment', 'Calibrate compressor discharge transmitter',
  'Replace switchgear ventilation filters', 'Service workshop extraction fan',
  'Repair loading-bay safety barrier', 'Overhaul process-water isolation valve',
  'Test emergency lighting circuit', 'Verify tank-level alarm set points',
  'Clean control-room condenser coils', 'Renew warehouse floor markings',
  'Inspect standby generator fuel system', 'Replace damaged cable-tray covers',
  'Calibrate custody-transfer flow meter', 'Repair administration air handler',
  'Service overhead-door safety sensors', 'Inspect cooling-tower gearbox',
  'Test motor-control center protection', 'Replace corroded impulse tubing',
  'Balance laboratory ventilation system', 'Repair access-road drainage channel',
  'Lubricate transfer-pump bearings', 'Thermographic survey of main panels',
  'Validate shutdown-system pressure switches', 'Service electrical-room split unit',
  'Replace damaged pedestrian handrail', 'Inspect firewater pump coupling',
  'Test uninterruptible power supply batteries', 'Calibrate vibration monitoring channels',
] as const;
const FACILITIES_JOBS = [
  'Inspect chilled-water pump seals', 'Replace emergency-exit lighting',
  'Service lobby air-handling unit', 'Repair loading-dock leveller',
  'Test fire-alarm sounders', 'Replace workshop compressed-air hose',
  'Clean cafeteria extract duct', 'Inspect roof drainage outlets',
  'Calibrate cold-room temperature sensor', 'Repair office partition door',
  'Service passenger-lift door operator', 'Replace parking-area light fitting',
  'Inspect domestic-water booster pump', 'Clean data-room cooling coils',
  'Repair warehouse racking guard', 'Test emergency generator changeover',
  'Replace damaged floor drain grate', 'Service reception automatic doors',
] as const;
export const FACILITIES_EXAMPLE_PRIORITY_ORDER = [
  'FS-0001', 'FS-0002', 'FS-0004', 'FS-0007', 'FS-0010', 'FS-0013',
  'FS-0003', 'FS-0005', 'FS-0008', 'FS-0011', 'FS-0014', 'FS-0016',
  'FS-0006', 'FS-0009', 'FS-0012', 'FS-0015', 'FS-0017', 'FS-0018',
] as const;

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
      MAINTENANCE_JOBS[index],
      CATEGORIES[index % CATEGORIES.length],
      ['P1', 'P2', 'P3', 'P4'][index % 4],
      index === 8 ? null : index === 15 ? '12,500' : 1800 + index * 425,
      index === 10 ? 0 : index === 21 ? 'unknown' : 3 + (index % 9),
      CREWS[index % CREWS.length],
      index === 12 ? '04/05/2027' : `2027-${String((index % 6) + 1).padStart(2, '0')}-${String((index % 25) + 1).padStart(2, '0')}`,
      STATUSES[index % STATUSES.length],
      ['Standard', 'Electrical isolation', 'Confined space'][index % 3],
      index === 6 ? null : ['Coordinate access permit', 'Confirm materials before start', 'Schedule during planned outage', 'Notify area supervisor'][index % 4],
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
    FACILITIES_JOBS[index],
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
