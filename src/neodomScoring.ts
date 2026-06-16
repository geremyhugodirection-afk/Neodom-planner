import { basename, extname } from "node:path";

export interface ProjectScoringConfig {
  project: {
    id: string;
    name: string;
    totalPoints: number;
    completionRule: string;
  };
  blocks: Array<{
    id: string;
    label: string;
    weightPercent: number;
    points: number;
  }>;
  imageSubtasks: Array<{
    id: string;
    label: string;
    weightPercent: number;
    points: number;
    workflowStatus: string;
  }>;
  imageWorkflowStatuses: Array<{
    id: string;
    label: string;
    order: number;
  }>;
  productImageWorkflowFields?: string[];
  variantAnalysisChecks?: string[];
  sourceImageStatuses?: Array<{
    id: string;
    label: string;
  }>;
  recommendedShopifyImageOrder?: string[];
  imageValidationChecklist: Array<{
    id: string;
    label: string;
  }>;
  qualityCoefficients: Array<{
    status: string;
    coefficient: number;
  }>;
  dashboardMetrics: string[];
  complexProductImageScoring: Array<{
    id: string;
    points: number;
  }>;
  nonImageSubtasks?: Array<{
    blockId: string;
    id: string;
    label: string;
    points: number;
    evidence?: string[];
  }>;
  detectedWorkspaceWorkstreams?: Array<{
    id: string;
    label: string;
    paths: string[];
  }>;
  filenameRules: {
    lowercase: boolean;
    asciiOnly: boolean;
    separator: string;
    forbiddenTerms: string[];
    recommendedExtensions: string[];
  };
}

export type TaskStatus =
  | "pending"
  | "validated"
  | "published"
  | "validated_with_corrections"
  | "corrections_requested"
  | "rejected";

export interface ScoringValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface TaskScoreInput {
  taskId: string;
  status: TaskStatus;
  qualityCoefficient?: number;
}

export interface TaskScoreResult {
  taskId: string;
  availablePoints: number;
  earnedPoints: number;
  coefficient: number;
}

export function validateScoringConfig(config: ProjectScoringConfig): ScoringValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const blockWeight = sum(config.blocks.map((block) => block.weightPercent));
  const blockPoints = sum(config.blocks.map((block) => block.points));
  const imageBlock = config.blocks.find((block) => block.id === "product_images");
  const imageSubtaskWeight = sum(config.imageSubtasks.map((task) => task.weightPercent));
  const imageSubtaskPoints = sum(config.imageSubtasks.map((task) => task.points));
  const complexProductPoints = sum(config.complexProductImageScoring.map((task) => task.points));
  const workflowIds = new Set(config.imageWorkflowStatuses.map((status) => status.id));
  const blockPointsById = new Map(config.blocks.map((block) => [block.id, block.points]));

  if (config.project.totalPoints <= 0) {
    errors.push("Project totalPoints must be greater than 0.");
  }
  if (!nearlyEqual(blockWeight, 100)) {
    errors.push(`Project block weights must total 100%; current total is ${blockWeight}%.`);
  }
  if (!nearlyEqual(blockPoints, config.project.totalPoints)) {
    errors.push(`Project block points must total ${config.project.totalPoints}; current total is ${blockPoints}.`);
  }
  if (!imageBlock) {
    errors.push("Missing required product_images block.");
  } else {
    if (!nearlyEqual(imageBlock.weightPercent, 70)) {
      errors.push(`product_images block must be 70%; current value is ${imageBlock.weightPercent}%.`);
    }
    if (!nearlyEqual(imageBlock.points, 700)) {
      errors.push(`product_images block must be 700 points; current value is ${imageBlock.points}.`);
    }
    if (!nearlyEqual(imageSubtaskWeight, imageBlock.weightPercent)) {
      errors.push(`Image subtask weights must total ${imageBlock.weightPercent}%; current total is ${imageTaskWeight}%.`);
    }
    if (!nearlyEqual(imageSubtaskPoints, imageBlock.points)) {
      errors.push(`Image subtask points must total ${imageBlock.points}; current total is ${imageSubtaskPoints}.`);
    }
  }

  for (const task of config.imageSubtasks) {
    if (!workflowIds.has(task.workflowStatus)) {
      warnings.push(`Image task ${task.id} references unknown workflow status ${task.workflowStatus}.`);
    }
  }

  for (const coefficient of config.qualityCoefficients) {
    if (coefficient.coefficient < 0 || coefficient.coefficient > 1) {
      errors.push(`Quality coefficient ${coefficient.status} must be between 0 and 1.`);
    }
  }

  if (!nearlyEqual(complexProductPoints, 90)) {
    warnings.push(`Complex product image scoring example should total 90 points; current total is ${complexProductPoints}.`);
  }

  const nonImageSubtasks = config.nonImageSubtasks ?? [];
  if (nonImageSubtasks.length > 0) {
    const pointsByBlock = new Map<string, number>();
    for (const task of nonImageSubtasks) {
      if (task.blockId === "product_images") {
        errors.push(`Non-image task ${task.id} cannot use product_images block.`);
      }
      if (!blockPointsById.has(task.blockId)) {
        errors.push(`Non-image task ${task.id} references unknown block ${task.blockId}.`);
      }
      pointsByBlock.set(task.blockId, (pointsByBlock.get(task.blockId) ?? 0) + task.points);
    }

    for (const block of config.blocks.filter((entry) => entry.id !== "product_images")) {
      const subtotal = pointsByBlock.get(block.id) ?? 0;
      if (!nearlyEqual(subtotal, block.points)) {
        errors.push(`Non-image tasks for ${block.id} must total ${block.points}; current total is ${subtotal}.`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function scoreImageTask(config: ProjectScoringConfig, input: TaskScoreInput): TaskScoreResult {
  const task = config.imageSubtasks.find((entry) => entry.id === input.taskId);
  if (!task) {
    throw new Error(`Unknown image task: ${input.taskId}`);
  }

  const configuredCoefficient = config.qualityCoefficients.find((entry) => entry.status === input.status)?.coefficient ?? 0;
  const coefficient =
    input.status === "validated_with_corrections"
      ? clamp(input.qualityCoefficient ?? configuredCoefficient, 0, 1)
      : configuredCoefficient;

  return {
    taskId: input.taskId,
    availablePoints: task.points,
    earnedPoints: round(task.points * coefficient, 2),
    coefficient
  };
}

export function scoreImageTasks(config: ProjectScoringConfig, tasks: TaskScoreInput[]): {
  earnedPoints: number;
  availablePoints: number;
  progressPercent: number;
  tasks: TaskScoreResult[];
} {
  const scoredTasks = tasks.map((task) => scoreImageTask(config, task));
  const availablePoints = sum(config.imageSubtasks.map((task) => task.points));
  const earnedPoints = round(sum(scoredTasks.map((task) => task.earnedPoints)), 2);
  return {
    earnedPoints,
    availablePoints,
    progressPercent: percentage(earnedPoints, availablePoints),
    tasks: scoredTasks
  };
}

export function isSeoImageFilename(filename: string, config: ProjectScoringConfig): boolean {
  const parsedExtension = extname(filename).replace(".", "").toLowerCase();
  const rawBaseName = basename(filename, extname(filename));
  const rules = config.filenameRules;

  if (!rules.recommendedExtensions.includes(parsedExtension)) return false;
  if (rules.lowercase && rawBaseName !== rawBaseName.toLowerCase()) return false;
  if (rules.asciiOnly && /[^\x00-\x7F]/.test(rawBaseName)) return false;
  if (/\s|_|--/.test(rawBaseName)) return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(rawBaseName)) return false;

  const parts = rawBaseName.split(rules.separator).filter(Boolean);
  if (parts.length < 4) return false;

  return !rules.forbiddenTerms.some((term) => parts.includes(term.toLowerCase()));
}

export function percentage(value: number, total: number): number {
  if (total <= 0) return 0;
  return round((value / total) * 100, 2);
}

function sum(values: number[]): number {
  return round(values.reduce((total, value) => total + value, 0), 4);
}

function round(value: number, decimals: number): number {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.0001;
}
