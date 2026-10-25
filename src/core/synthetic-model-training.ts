import { DEMONSTRATION_MODEL_SPEC } from './ranking';

export interface SyntheticModelTrainingReport {
  recipe: string;
  seed: number;
  split: { trainGroups: number[]; validationGroups: number[]; testGroups: number[] };
  sampleCounts: { train: number; validation: number; test: number };
  fittedCoefficients: { intercept: number; priority: number; cost: number; duration: number };
  meanAbsoluteError: { validation: number; test: number };
  limitation: string;
}

interface TrainingPoint {
  group: number;
  features: [number, number, number, number];
  target: number;
}

function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
function syntheticPoints(seed: number): TrainingPoint[] {
  const next = generator(seed);
  const truth = DEMONSTRATION_MODEL_SPEC.coefficients;
  return Array.from({ length: 12 }, (_, group) => Array.from({ length: 40 }, () => {
    const priority = 1 + Math.floor(next() * 5);
    const priorityInverse = 6 - priority;
    const cost = 750 + Math.round(next() * 29_250);
    const duration = 1 + Math.round(next() * 95);
    const features: TrainingPoint['features'] = [1, priorityInverse, cost, duration];
    const target = truth.intercept + truth.priority * priorityInverse + truth.cost * cost + truth.duration * duration;
    return { group, features, target };
  })).flat();
}

function solve(matrix: number[][], vector: number[]): number[] {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < augmented.length; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < augmented.length; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) best = row;
    }
    [augmented[pivot], augmented[best]] = [augmented[best], augmented[pivot]];
    const divisor = augmented[pivot][pivot];
    if (Math.abs(divisor) < 1e-12) throw new Error('Synthetic training matrix is singular.');
    for (let column = pivot; column <= augmented.length; column += 1) augmented[pivot][column] /= divisor;
    for (let row = 0; row < augmented.length; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let column = pivot; column <= augmented.length; column += 1) augmented[row][column] -= factor * augmented[pivot][column];
    }
  }
  return augmented.map((row) => row[augmented.length]);
}

function fit(points: TrainingPoint[]): number[] {
  const width = 4;
  const matrix = Array.from({ length: width }, () => Array(width).fill(0) as number[]);
  const vector = Array(width).fill(0) as number[];
  for (const point of points) {
    for (let left = 0; left < width; left += 1) {
      vector[left] += point.features[left] * point.target;
      for (let right = 0; right < width; right += 1) matrix[left][right] += point.features[left] * point.features[right];
    }
  }
  return solve(matrix, vector);
}

function mae(points: TrainingPoint[], coefficients: number[]): number {
  return points.reduce((sum, point) => sum + Math.abs(point.target - point.features.reduce((score, value, index) => score + value * coefficients[index], 0)), 0) / points.length;
}

export function trainSyntheticDemonstrationModel(seed = 20261024): SyntheticModelTrainingReport {
  const points = syntheticPoints(seed);
  const trainGroups = [0, 1, 2, 3, 4, 5, 6, 7];
  const validationGroups = [8, 9];
  const testGroups = [10, 11];
  const train = points.filter((point) => trainGroups.includes(point.group));
  const validation = points.filter((point) => validationGroups.includes(point.group));
  const test = points.filter((point) => testGroups.includes(point.group));
  const fitted = fit(train);
  return {
    recipe: DEMONSTRATION_MODEL_SPEC.trainingRecipe,
    seed,
    split: { trainGroups, validationGroups, testGroups },
    sampleCounts: { train: train.length, validation: validation.length, test: test.length },
    fittedCoefficients: { intercept: fitted[0], priority: fitted[1], cost: fitted[2], duration: fitted[3] },
    meanAbsoluteError: { validation: mae(validation, fitted), test: mae(test, fitted) },
    limitation: 'Synthetic coefficient recovery validates implementation mechanics only; it is not field accuracy or operational evidence.',
  };
}

