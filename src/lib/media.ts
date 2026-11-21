import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_VERY_HIGH,
} from "mediabunny";
import { downloadZip } from "client-zip";
import { toSrt, drawCaptions, type CaptionStyle, type Chunk } from "./captions";
import { segmentWindows, type SegmentWindow } from "./timing";

const RATE = 16000;

export type AudioSegment = SegmentWindow & { base64: string };

/**
 * Decode on the media timeline (including track offsets and gaps), then use
 * short windows with context on both sides of each ownership boundary.
 */
export async function extractWavSegments(file: File, target = 8): Promise<{ segments: AudioSegment[]; duration: number }> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const duration = await input.computeDuration();
    if (duration > 600) throw new Error("Vídeos de até 10 minutos.");
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Não foi possível ler a duração do vídeo.");
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("Não encontramos áudio neste vídeo.");
    const off = new OfflineAudioContext(1, Math.ceil(duration * RATE), RATE);
    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
      if (timestamp + buffer.duration <= 0 || timestamp >= duration) continue;
      const src = off.createBufferSource();
      src.buffer = buffer;
      src.connect(off.destination);
      src.start(Math.max(0, timestamp), Math.max(0, -timestamp));
    }
    const pcm = (await off.startRendering()).getChannelData(0);
    const segments = segmentWindows(pcm, RATE, target).map((window) => ({
      ...window,
      base64: encodeWav(pcm.subarray(Math.round(window.offset * RATE), Math.round((window.offset + window.duration) * RATE))),
    }));
    return { segments, duration };
  } finally {
    input.dispose();
  }
}

function encodeWav(pcm: Float32Array): string {
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const ws = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  ws(0, "RIFF");
  out.setUint32(4, 36 + pcm.length * 2, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, RATE, true);
  out.setUint32(28, RATE * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  ws(36, "data");
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(out.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function packageOriginal(file: File, chunks: Chunk[]) {
  const stem = file.name.replace(/\.[^.]+$/, "") || "video";
  return downloadZip([file, { name: stem + ".srt", input: toSrt(chunks) }]).blob();
}

export async function makePreview(file: File, signal: AbortSignal, onProgress: (value: number) => void = () => {}) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let conversion: Conversion | undefined;
  const cancel = () => { void conversion?.cancel().catch(() => {}); };
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw Error("Vídeo indisponível.");
    const w = await track.getDisplayWidth();
    const h = await track.getDisplayHeight();
    const ratio = Math.min(1, 640 / Math.max(w, h));
    const target = new BufferTarget();
    conversion = await Conversion.init({
      input,
      output: new Output({ format: new Mp4OutputFormat(), target }),
      video: {
        fit: "contain", width: Math.max(2, 2 * Math.round(w * ratio / 2)),
        height: Math.max(2, 2 * Math.round(h * ratio / 2)), frameRate: 24,
        bitrate: 900000, allowTransformationMetadata: false,
      },
    });
    if (!conversion.isValid || conversion.discardedTracks.some(({track}) => track.type === "audio" || track.type === "video")) throw Error("Formato incompatível.");
    signal.throwIfAborted();
    signal.addEventListener("abort", cancel, { once: true });
    conversion.onProgress = onProgress;
    await conversion.execute();
    return new Blob([target.buffer!], { type: "video/mp4" });
  } finally {
    signal.removeEventListener("abort", cancel);
    input.dispose();
  }
}

export async function renderVideo(
  file: File,
  chunks: Chunk[],
  style: CaptionStyle,
  opts: { posY: number; scale: number },
  onProgress: (p: number) => void,
): Promise<{ blob: Blob; ext: string }> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("Este navegador não consegue gravar as legendas no MP4. Use a opção Original + SRT.");
  }
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    const conversion = await Conversion.init({
      input,
      output,
      video: {
        codec: "avc",
        quality: QUALITY_VERY_HIGH,
        forceTranscode: true,
        allowTransformationMetadata: false,
        process: (sample) => {
          const w = sample.displayWidth;
          const h = sample.displayHeight;
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          sample.draw(ctx, 0, 0, w, h);
          drawCaptions(ctx, w, h, chunks, sample.timestamp, style, opts);
          return canvas;
        },
      },
      showWarnings: false,
    });

    if (!conversion.isValid || conversion.discardedTracks.some(({ track }) => track.type === "video")) {
      throw new Error("O navegador não conseguiu codificar a imagem deste vídeo.");
    }
    if (conversion.discardedTracks.some(({ track }) => track.type === "audio")) {
      throw new Error("O navegador não conseguiu preservar o áudio deste vídeo. A exportação foi interrompida.");
    }

    conversion.onProgress = (p) => onProgress(p);
    await conversion.execute();

    const buffer = target.buffer;
    if (!buffer) throw new Error("Falha ao finalizar o vídeo.");
    onProgress(1);
    return { blob: new Blob([buffer], { type: "video/mp4" }), ext: "mp4" };
  } finally {
    input.dispose();
  }
}
