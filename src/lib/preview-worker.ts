import { FFmpeg } from "@ffmpeg/ffmpeg";
import type { FFFSType } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import classWorkerURL from "@ffmpeg/ffmpeg/worker?worker&url";

export async function createLightPreview(file: File, signal: AbortSignal, onProgress: (value: number) => void) {
  const ffmpeg = new FFmpeg();
  const cancel = () => ffmpeg.terminate();
  signal.throwIfAborted();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await ffmpeg.load({ coreURL: new URL(coreURL, location.href).href, wasmURL: new URL(wasmURL, location.href).href, classWorkerURL });
    signal.throwIfAborted();
    await ffmpeg.createDir("/source");
    await ffmpeg.mount("WORKERFS" as FFFSType, { blobs: [{ name: "input", data: file }] }, "/source");
    ffmpeg.on("progress", ({ progress }) => onProgress(Math.min(0.99, Math.max(0, progress))));
    const code = await ffmpeg.exec([
      "-i", "/source/input", "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", "scale=w=640:h=640:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-threads", "1", "-c:a", "aac", "-b:a", "128k", "preview.mp4",
    ]);
    if (code !== 0) throw new Error("Não foi possível preparar a prévia deste vídeo.");
    const bytes = await ffmpeg.readFile("preview.mp4");
    if (typeof bytes === "string") throw new Error("Prévia inválida.");
    onProgress(1);
    return new Blob([bytes.buffer as ArrayBuffer], { type: "video/mp4" });
  } finally {
    signal.removeEventListener("abort", cancel);
    ffmpeg.terminate();
  }
}
