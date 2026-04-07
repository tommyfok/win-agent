import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingProvider } from "./index.js";

type TransformerPipeline = (
  text: string,
  options: { pooling: string; normalize: boolean }
) => Promise<{ data: Float32Array }>;

let pipelineInstance: TransformerPipeline | null = null;

/**
 * Resolve project root from the current file location.
 * - In dev (src/embedding/local.ts): up 2 levels → project root
 * - In dist (dist/index.js): up 1 level → project root
 * Both cases land on the same project root where models/ lives.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname.includes("dist")
  ? path.resolve(__dirname, "..")
  : path.resolve(__dirname, "..", "..");
const LOCAL_MODELS_DIR = path.join(PROJECT_ROOT, "models");

/**
 * Local embedding provider using @huggingface/transformers.
 * Runs entirely on CPU via ONNX Runtime — no API calls.
 * Models are loaded from the project's models/ directory (committed to git).
 * Default model: Xenova/bge-small-zh-v1.5 (512 dimensions).
 */
export function createLocalEmbedding(model?: string): EmbeddingProvider {
  const modelId = model || "Xenova/bge-small-zh-v1.5";
  return {
    async generate(text: string): Promise<number[]> {
      if (!pipelineInstance) {
        const { pipeline, env } = await import("@huggingface/transformers");
        // Load from project's models/ directory, no remote download needed
        env.localModelPath = LOCAL_MODELS_DIR;
        env.allowRemoteModels = false;
        console.log(`   ⏳ 加载本地 embedding 模型: ${modelId} ...`);
        pipelineInstance = await pipeline("feature-extraction", modelId, {
          dtype: "fp32",
        }) as unknown as TransformerPipeline;
        console.log(`   ✓ 模型加载完成`);
      }

      const output = await pipelineInstance!(text, {
        pooling: "mean",
        normalize: true,
      });

      // output is a Tensor; convert to flat number array
      return Array.from(output.data);
    },
  };
}
