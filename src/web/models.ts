/**
 * Live probe adapter: the two pinned builds of the SST-2 checkpoint, loaded
 * lazily through ONNX Runtime Web - only when a visitor runs their own
 * sentence. Every number on the page comes from the committed Node-measured
 * artifacts; this exists so visitors can feel the two builds, not to
 * regenerate the evidence.
 */

export const MODEL = 'Xenova/distilbert-base-uncased-finetuned-sst-2-english';
export const MODEL_REVISION = '0b6928efcb76139cae2c6881d49cda67fe119f42';

export interface BuildResult {
  label: 'POSITIVE' | 'NEGATIVE';
  score: number;
}

type ClassifyPipeline = (text: string) => Promise<Array<{ label: string; score: number }>>;

/** Point ONNX Runtime Web at the wasm files the repo ships under docs/ort/. */
type OrtWasmEnv = { wasmPaths?: { mjs: string; wasm: string }; proxy?: boolean };
let ortConfigured = false;
async function configureOrt(): Promise<void> {
  if (ortConfigured) return;
  const { env } = await import('@huggingface/transformers');
  // Test hook: CI serves the pinned weights from a same-origin mirror so the
  // probe does not depend on Hugging Face's datacenter download speeds.
  // Same-origin only, so a crafted link can never point the page at a
  // third-party host (connect-src 'self' blocks cross-origin fetches anyway).
  const mb = new URLSearchParams(location.search).get('modelBase');
  if (mb) {
    const u = new URL(mb, location.origin);
    if (u.origin === location.origin) {
      (env as { remoteHost?: string }).remoteHost = u.href.replace(/\/$/, '');
    }
  }
  const onnx = (env.backends as Record<string, unknown> | undefined)?.['onnx'] as { wasm?: OrtWasmEnv } | undefined;
  if (onnx?.wasm) {
    onnx.wasm.wasmPaths = {
      mjs: './ort/ort-wasm-simd-threaded.mjs',
      wasm: './ort/ort-wasm-simd-threaded.wasm',
    };
    onnx.wasm.proxy = false;
  }
  ortConfigured = true;
}

export class PairClassifier {
  readonly id = `${MODEL}@${MODEL_REVISION.slice(0, 8)}`;
  private v1: ClassifyPipeline | null = null; // fp16 incumbent
  private v2: ClassifyPipeline | null = null; // int8 candidate

  async load(onProgress?: (fraction: number, stage: string) => void): Promise<void> {
    if (this.v1 !== null && this.v2 !== null) return;
    await configureOrt();
    const { pipeline } = await import('@huggingface/transformers');
    const mk = async (dtype: string, base: number, stage: string) => {
      const p = await pipeline('text-classification', MODEL, {
        dtype,
        revision: MODEL_REVISION,
        progress_callback: (info: { status?: string; progress?: number }) => {
          if (info.status === 'progress' && typeof info.progress === 'number') {
            onProgress?.(base + (info.progress / 100) * 0.5, stage);
          }
        },
      });
      return p as unknown as ClassifyPipeline;
    };
    if (this.v1 === null) this.v1 = await mk('fp16', 0, 'full-precision build');
    if (this.v2 === null) this.v2 = await mk('int8', 0.5, 'int8 build');
  }

  get loaded(): boolean {
    return this.v1 !== null && this.v2 !== null;
  }

  async classify(text: string): Promise<{ v1: BuildResult; v2: BuildResult }> {
    if (!this.loaded) await this.load();
    const [r1, r2] = await Promise.all([this.v1!(text), this.v2!(text)]);
    return {
      v1: { label: r1[0]!.label === 'POSITIVE' ? 'POSITIVE' : 'NEGATIVE', score: r1[0]!.score },
      v2: { label: r2[0]!.label === 'POSITIVE' ? 'POSITIVE' : 'NEGATIVE', score: r2[0]!.score },
    };
  }
}
