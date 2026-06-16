import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import {
  isSeoImageFilename,
  percentage,
  validateScoringConfig,
  type ProjectScoringConfig
} from "./neodomScoring.js";

interface CliOptions {
  configPath: string;
  publicProductsPath: string;
  roots: string[];
  outputJson: string;
  outputMarkdown: string;
  validateOnly: boolean;
}

interface ImageRecord {
  productKey: string;
  manifestPath: string;
  filename: string;
  altText: string;
  status: string;
  imageType: "studio" | "variant" | "lifestyle" | "technical" | "other";
}

interface AuditMetrics {
  generatedImages: number;
  validatedImages: number;
  rejectedImages: number;
  variantsWithoutImage: number | null;
  imagesWithoutAltText: number;
  imagesNotRenamed: number;
  productsWithImagesFullyValidated: number;
  imageBlockProgress: number;
  globalProjectProgress: number;
  productCountWithGeneratedImages: number;
  manifestCount: number;
  notes: string[];
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const config = await readJson<ProjectScoringConfig>(options.configPath);
  const validation = validateScoringConfig(config);

  printValidation(validation.errors, validation.warnings);
  if (!validation.ok) {
    process.exitCode = 1;
    return;
  }

  if (options.validateOnly) return;

  const { images, manifestCount } = await collectImageRecords(options.roots, config);
  const publicProductsRaw = await readOptionalJson<unknown>(options.publicProductsPath);
  const publicProducts = Array.isArray(publicProductsRaw) ? publicProductsRaw : null;
  const metrics = buildMetrics(images, manifestCount, publicProducts, config);
  const payload = {
    generatedAt: new Date().toISOString(),
    scoring: {
      totalPoints: config.project.totalPoints,
      imageBlockPoints: config.blocks.find((block) => block.id === "product_images")?.points ?? 0,
      imageBlockWeightPercent: config.blocks.find((block) => block.id === "product_images")?.weightPercent ?? 0
    },
    metrics,
    imageTypes: countBy(images, (image) => image.imageType),
    dashboardMetrics: config.dashboardMetrics,
    blocks: config.blocks,
    imageSubtasks: config.imageSubtasks,
    nonImageSubtasks: config.nonImageSubtasks ?? [],
    detectedWorkspaceWorkstreams: config.detectedWorkspaceWorkstreams ?? [],
    workflowStatuses: config.imageWorkflowStatuses,
    productImageWorkflowFields: config.productImageWorkflowFields ?? [],
    variantAnalysisChecks: config.variantAnalysisChecks ?? [],
    sourceImageStatuses: config.sourceImageStatuses ?? [],
    recommendedShopifyImageOrder: config.recommendedShopifyImageOrder ?? [],
    validationChecklist: config.imageValidationChecklist
  };

  await mkdir(dirname(options.outputJson), { recursive: true });
  await writeFile(options.outputJson, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(options.outputMarkdown, renderMarkdown(config, metrics, payload.imageTypes), "utf8");

  console.log(`Report JSON: ${options.outputJson}`);
  console.log(`Report Markdown: ${options.outputMarkdown}`);
}

function parseCli(args: string[]): CliOptions {
  const options: CliOptions = {
    configPath: "data/neodom-project-scoring.json",
    publicProductsPath: "neodom_public_products.json",
    roots: ["neodom-product-images", "shopify-product-images", "shopify-image-work", "shopify-generated"],
    outputJson: "outputs/neodom-image-project-dashboard.json",
    outputMarkdown: "outputs/neodom-image-project-dashboard.md",
    validateOnly: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--validate-only") options.validateOnly = true;
    else if (arg === "--config") options.configPath = args[++index];
    else if (arg === "--public-products") options.publicProductsPath = args[++index];
    else if (arg === "--output-json") options.outputJson = args[++index];
    else if (arg === "--output-md") options.outputMarkdown = args[++index];
    else if (arg === "--root") options.roots.push(args[++index]);
    else if (arg.startsWith("--config=")) options.configPath = arg.slice("--config=".length);
    else if (arg.startsWith("--public-products=")) options.publicProductsPath = arg.slice("--public-products=".length);
    else if (arg.startsWith("--output-json=")) options.outputJson = arg.slice("--output-json=".length);
    else if (arg.startsWith("--output-md=")) options.outputMarkdown = arg.slice("--output-md=".length);
    else if (arg.startsWith("--root=")) options.roots.push(arg.slice("--root=".length));
  }

  return options;
}

async function collectImageRecords(roots: string[], config: ProjectScoringConfig): Promise<{
  images: ImageRecord[];
  manifestCount: number;
}> {
  const images = new Map<string, ImageRecord>();
  let manifestCount = 0;

  for (const root of roots) {
    const manifests = await findManifestFiles(root);
    manifestCount += manifests.length;
    for (const manifestPath of manifests) {
      const parsed = await readOptionalJson<unknown>(manifestPath);
      if (!parsed) continue;
      const candidates = extractImageCandidates(parsed);
      for (const candidate of candidates) {
        const filename = filenameFromCandidate(candidate);
        if (!filename || !isImageFilename(filename)) continue;

        const productKey = inferProductKey(root, manifestPath);
        const record: ImageRecord = {
          productKey,
          manifestPath,
          filename,
          altText: altFromCandidate(candidate),
          status: statusFromCandidate(candidate),
          imageType: inferImageType(filename)
        };
        const key = `${productKey}|${record.filename}`;
        if (!images.has(key) || isSeoImageFilename(record.filename, config)) {
          images.set(key, record);
        }
      }
    }
  }

  return { images: Array.from(images.values()), manifestCount };
}

async function findManifestFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__" || entry.name === "sources" || entry.name === "source") continue;
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".json") continue;
      if (isGeneratedImageManifest(entry.name, fullPath)) results.push(fullPath);
    }
  }

  await walk(root);
  return results;
}

function isGeneratedImageManifest(filename: string, fullPath: string): boolean {
  const normalized = fullPath.toLowerCase().replace(/\\/g, "/");
  const lower = filename.toLowerCase();
  if (lower.includes("source") && !normalized.includes("/review/generated-")) return false;
  return (
    lower.includes("generated") ||
    lower.includes("final") ||
    lower.includes("upload-manifest") ||
    lower.includes("upload-items") ||
    normalized.includes("/review/generated-metadata.json")
  );
}

function extractImageCandidates(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractImageCandidates(item, depth + 1));
  }
  if (!isPlainObject(value)) return [];
  if (filenameFromCandidate(value)) return [value];

  const candidates: Record<string, unknown>[] = [];
  for (const nested of Object.values(value)) {
    candidates.push(...extractImageCandidates(nested, depth + 1));
  }
  return candidates;
}

function filenameFromCandidate(candidate: Record<string, unknown>): string {
  const raw =
    candidate.filename ??
    candidate.file ??
    candidate.path ??
    candidate.src ??
    candidate.url ??
    candidate.image ??
    candidate.imagePath;
  if (typeof raw !== "string") return "";
  const clean = raw.split(/[?#]/)[0].replace(/\\/g, "/");
  return basename(clean);
}

function altFromCandidate(candidate: Record<string, unknown>): string {
  const raw = candidate.alt ?? candidate.altText ?? candidate.alt_text ?? candidate.seoAlt ?? candidate.description;
  return typeof raw === "string" ? raw.trim() : "";
}

function statusFromCandidate(candidate: Record<string, unknown>): string {
  const raw = candidate.status ?? candidate.validationStatus ?? candidate.qualityStatus ?? candidate.reviewStatus;
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function inferProductKey(root: string, manifestPath: string): string {
  const relativeDir = relative(root, dirname(manifestPath)).replace(/\\/g, "/");
  const parts = relativeDir.split("/").filter(Boolean);
  if (parts.length === 0) return basename(root);
  if (/^bloc-\d+$/i.test(parts[0]) && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function inferImageType(filename: string): ImageRecord["imageType"] {
  const lower = filename.toLowerCase();
  if (/variant|option|pack|lot|white|black|blanc|noir|gris|gang|button|bouton/.test(lower)) return "variant";
  if (/lifestyle|scene|salon|room|maison|wall|installed|radiateur|context/.test(lower)) return "lifestyle";
  if (/dimension|spec|technical|detail|macro|terminal|wiring|schema|package|contents|overview/.test(lower)) return "technical";
  if (/studio|hero|packshot|main/.test(lower)) return "studio";
  return "other";
}

function buildMetrics(
  images: ImageRecord[],
  manifestCount: number,
  publicProducts: unknown[] | null,
  config: ProjectScoringConfig
): AuditMetrics {
  const productKeys = new Set(images.map((image) => image.productKey));
  const validatedStatuses = new Set(["validated", "approved", "published", "uploaded"]);
  const rejectedStatuses = new Set(["rejected", "refused", "refuse", "failed"]);
  const generatedImages = images.length;
  const validatedImages = images.filter((image) => validatedStatuses.has(image.status)).length;
  const rejectedImages = images.filter((image) => rejectedStatuses.has(image.status)).length;
  const imagesWithoutAltText = images.filter((image) => !image.altText).length;
  const imagesNotRenamed = images.filter((image) => !isSeoImageFilename(image.filename, config)).length;
  const productsWithImagesFullyValidated = countFullyValidatedProducts(images, validatedStatuses, config);
  const variantsWithoutImage = publicProducts ? countVariantsWithoutImage(publicProducts) : null;
  const imageBlockProgress = percentage(validatedImages, generatedImages);
  const imageBlockWeight = config.blocks.find((block) => block.id === "product_images")?.weightPercent ?? 70;
  const globalProjectProgress = roundNumber((imageBlockProgress * imageBlockWeight) / 100, 2);
  const notes: string[] = [];

  if (validatedImages === 0) {
    notes.push("No validated status was found in local manifests; generated images are not counted as validated until a status is stored.");
  }
  if (variantsWithoutImage === null) {
    notes.push("Variant image association could not be audited because the Shopify public product export was not found.");
  }

  return {
    generatedImages,
    validatedImages,
    rejectedImages,
    variantsWithoutImage,
    imagesWithoutAltText,
    imagesNotRenamed,
    productsWithImagesFullyValidated,
    imageBlockProgress,
    globalProjectProgress,
    productCountWithGeneratedImages: productKeys.size,
    manifestCount,
    notes
  };
}

function countFullyValidatedProducts(
  images: ImageRecord[],
  validatedStatuses: Set<string>,
  config: ProjectScoringConfig
): number {
  const byProduct = groupBy(images, (image) => image.productKey);
  let count = 0;

  for (const productImages of byProduct.values()) {
    if (
      productImages.length > 0 &&
      productImages.every(
        (image) => validatedStatuses.has(image.status) && image.altText && isSeoImageFilename(image.filename, config)
      )
    ) {
      count += 1;
    }
  }

  return count;
}

function countVariantsWithoutImage(products: unknown[]): number {
  let count = 0;
  for (const product of products) {
    if (!isPlainObject(product) || !Array.isArray(product.variants)) continue;
    for (const variant of product.variants) {
      if (!isPlainObject(variant)) continue;
      if (!variant.featured_image) count += 1;
    }
  }
  return count;
}

function renderMarkdown(
  config: ProjectScoringConfig,
  metrics: AuditMetrics,
  imageTypes: Record<string, number>
): string {
  const blockRows = config.blocks
    .map((block) => `| ${block.label} | ${block.weightPercent}% | ${block.points} |`)
    .join("\n");
  const subtaskRows = config.imageSubtasks
    .map((task) => `| ${task.label} | ${task.weightPercent}% | ${task.points} | ${task.workflowStatus} |`)
    .join("\n");
  const nonImageRows = (config.nonImageSubtasks ?? [])
    .map((task) => `| ${task.blockId} | ${task.label} | ${task.points} | ${formatEvidence(task.evidence)} |`)
    .join("\n");
  const workstreamRows = (config.detectedWorkspaceWorkstreams ?? [])
    .map((workstream) => `| ${workstream.label} | ${workstream.paths.map((path) => `\`${path}\``).join("<br>")} |`)
    .join("\n");
  const workflowRows = config.imageWorkflowStatuses
    .sort((a, b) => a.order - b.order)
    .map((status) => `| ${status.order} | ${status.label} | \`${status.id}\` |`)
    .join("\n");
  const productFields = (config.productImageWorkflowFields ?? []).map((field) => `- ${field}`).join("\n");
  const variantChecks = (config.variantAnalysisChecks ?? []).map((check) => `- ${check}`).join("\n");
  const sourceStatuses = (config.sourceImageStatuses ?? [])
    .map((status) => `- ${status.label} (\`${status.id}\`)`)
    .join("\n");
  const shopifyOrder = (config.recommendedShopifyImageOrder ?? [])
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n");
  const dashboardMetrics = config.dashboardMetrics.map((metric) => `- ${metric}`).join("\n");
  const checklist = config.imageValidationChecklist.map((item) => `- [ ] ${item.label}`).join("\n");
  const notes = metrics.notes.length > 0 ? metrics.notes.map((note) => `- ${note}`).join("\n") : "- No audit notes.";

  return `# Neodom image project dashboard

Generated: ${new Date().toISOString()}

## Metrics

| Metric | Value |
|---|---:|
| Global project progress from validated image work only | ${metrics.globalProjectProgress}% |
| Image block progress | ${metrics.imageBlockProgress}% |
| Generated images found in local manifests | ${metrics.generatedImages} |
| Validated images | ${metrics.validatedImages} |
| Rejected images | ${metrics.rejectedImages} |
| Variants without Shopify featured image | ${metrics.variantsWithoutImage ?? "not audited"} |
| Images without alt text in local manifests | ${metrics.imagesWithoutAltText} |
| Images not SEO-renamed in local manifests | ${metrics.imagesNotRenamed} |
| Products with images 100% validated | ${metrics.productsWithImagesFullyValidated} |
| Products with generated images found | ${metrics.productCountWithGeneratedImages} |
| Manifests audited | ${metrics.manifestCount} |

## Image Types

| Type | Count |
|---|---:|
${Object.entries(imageTypes)
  .map(([type, count]) => `| ${type} | ${count} |`)
  .join("\n")}

## Project Scoring

| Block | Weight | Points |
|---|---:|---:|
${blockRows}

## Image Scoring

| Image task | Project weight | Points | Workflow status |
|---|---:|---:|---|
${subtaskRows}

## Non-Image Scoring

| Block | Task | Points | Evidence |
|---|---|---:|---|
${nonImageRows || "| - | No non-image tasks configured. | 0 | - |"}

## Detected Workstreams

| Workstream | Paths |
|---|---|
${workstreamRows || "| No workstreams configured. | - |"}

## Dashboard Metrics To Display

${dashboardMetrics}

## Image Workflow

| Order | Status | ID |
|---:|---|---|
${workflowRows}

## Product Image Workflow Fields

${productFields || "- No fields configured."}

## Variant Analysis Checks

${variantChecks || "- No checks configured."}

## Source Image Statuses

${sourceStatuses || "- No source statuses configured."}

## Recommended Shopify Image Order

${shopifyOrder || "- No image order configured."}

## Image Validation Checklist

${checklist}

## Notes

${notes}
`;
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch {
    return null;
  }
}

function printValidation(errors: string[], warnings: string[]): void {
  if (errors.length === 0) console.log("Scoring config: OK");
  for (const warning of warnings) console.warn(`Warning: ${warning}`);
  for (const error of errors) console.error(`Error: ${error}`);
}

function isImageFilename(filename: string): boolean {
  return /\.(webp|png|jpe?g|avif)$/i.test(filename);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function roundNumber(value: number, decimals: number): number {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function formatEvidence(evidence: string[] | undefined): string {
  if (!evidence || evidence.length === 0) return "-";
  return evidence.map((entry) => `\`${entry}\``).join("<br>");
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const existing = grouped.get(key) ?? [];
    existing.push(item);
    grouped.set(key, existing);
  }
  return grouped;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
