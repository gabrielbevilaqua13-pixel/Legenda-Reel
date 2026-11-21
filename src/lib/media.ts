import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  type InputVideoTrack,
  type VideoSample,
} from "mediabunny";
import { drawCaptions, type CaptionStyle, type Chunk } from "./captions";
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

/**
 * Renders the captioned video frame by frame (not in real time), so no frames
 * are dropped and the output never stutters. If the browser refuses the
 * encoder settings, retries with smaller resolutions before falling back to
 * real-time capture.
 */
export async function renderVideo(
  file: File,
  url: string,
  chunks: Chunk[],
  style: CaptionStyle,
  opts: { posY: number; scale: number },
  onProgress: (p: number) => void,
): Promise<{ blob: Blob; ext: string }> {
  const problems: string[] = [];

  if (typeof VideoEncoder !== "undefined") {
    // Tenta 1080p e, se o navegador recusar, 720p e depois 540p.
    for (const maxLongSide of [1920, 1280, 960]) {
      try {
        onProgress(0);
        return await renderPrecise(file, chunks, style, opts, onProgress, maxLongSide);
      } catch (e) {
        console.warn(`Renderização precisa falhou (${maxLongSide}px):`, e);
        problems.push(e instanceof Error ? e.message : String(e));
      }
    }
  }

  try {
    onProgress(0);
    return await renderRealtime(url, chunks, style, opts, onProgress);
  } catch (e) {
    console.warn("Captura em tempo real falhou:", e);
    problems.push(e instanceof Error ? e.message : String(e));
  }

  throw new Error(
    "Seu navegador não conseguiu gerar o vídeo. Tente no Chrome ou Edge (computador) ou com um vídeo menor. " +
      `Detalhe: ${problems[problems.length - 1] ?? "desconhecido"}`,
  );
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

async function renderPrecise(
  file: File,
  chunks: Chunk[],
  style: CaptionStyle,
  opts: { posY: number; scale: number },
  onProgress: (p: number) => void,
  maxLongSide: number,
): Promise<{ blob: Blob; ext: string }> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Não foi possível criar o canvas de exportação.");

    const processFrame = (sample: VideoSample) => {
      const w = sample.displayWidth;
      const h = sample.displayHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      sample.draw(ctx, 0, 0, w, h);
      drawCaptions(ctx, w, h, chunks, sample.timestamp, style, opts);
      return canvas;
    };

    // Limita a resolução: vídeos 4K/alto bitrate costumam ser recusados pelo
    // encoder H.264 do navegador ("The given encoding is not supported").
    const videoOptions = async (track: InputVideoTrack) => {
      const rotation = await track.getRotation();
      const sw = await track.getSquarePixelWidth();
      const sh = await track.getSquarePixelHeight();
      const [w, h] = rotation % 180 === 0 ? [sw, sh] : [sh, sw];
      const base = {
        quality: QUALITY_HIGH,
        allowTransformationMetadata: false,
        process: processFrame,
      };
      const scale = Math.min(1, maxLongSide / Math.max(w, h));
      if (scale < 1) {
        return { ...base, width: even(w * scale), height: even(h * scale), fit: "fill" as const };
      }
      return base;
    };

    const conversion = await Conversion.init({
      input,
      output,
      video: videoOptions,
      showWarnings: false,
    });

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(", ");
      throw new Error(`Não foi possível converter este vídeo (${reasons || "sem detalhes"}).`);
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

async function renderRealtime(
  url: string,
  chunks: Chunk[],
  style: CaptionStyle,
  opts: { posY: number; scale: number },
  onProgress: (p: number) => void,
): Promise<{ blob: Blob; ext: string }> {
  if (typeof MediaRecorder === "undefined") throw new Error("Este navegador não suporta gravação de vídeo.");

  const video = document.createElement("video");
  video.src = url;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  await new Promise<void>((r, j) => {
    video.onloadedmetadata = () => r();
    video.onerror = () => j(new Error("Não foi possível ler o vídeo."));
  });
  const w = video.videoWidth;
  const h = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  ac.createMediaElementSource(video).connect(dest);
  const stream = canvas.captureStream(30);
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

  // Tenta cada formato (e com/sem bitrate) até o navegador aceitar um.
  const types = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  let rec: MediaRecorder | null = null;
  let mime = "video/webm";
  for (const t of types) {
    if (!MediaRecorder.isTypeSupported(t)) continue;
    for (const bits of [8_000_000, undefined]) {
      try {
        rec = new MediaRecorder(stream, bits ? { mimeType: t, videoBitsPerSecond: bits } : { mimeType: t });
        mime = t;
        break;
      } catch {
        rec = null;
      }
    }
    if (rec) break;
  }
  if (!rec) {
    try {
      rec = new MediaRecorder(stream);
      mime = rec.mimeType || "video/webm";
    } catch {
      await ac.close();
      throw new Error("O navegador não suporta nenhum formato de gravação de vídeo.");
    }
  }
  const recorder = rec;
  const parts: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise<void>((r) => (recorder.onstop = () => r()));

  let raf = 0;
  const loop = () => {
    ctx.drawImage(video, 0, 0, w, h);
    drawCaptions(ctx, w, h, chunks, video.currentTime, style, opts);
    onProgress(video.currentTime / video.duration);
    raf = requestAnimationFrame(loop);
  };
  video.currentTime = 0;
  recorder.start(250);
  await video.play();
  loop();
  await new Promise<void>((r) => (video.onended = () => r()));
  cancelAnimationFrame(raf);
  recorder.stop();
  await done;
  await ac.close();
  onProgress(1);
  return { blob: new Blob(parts, { type: mime.split(";")[0] ?? mime }), ext: mime.startsWith("video/mp4") ? "mp4" : "webm" };
}
