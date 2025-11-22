import { Blob } from '@google/genai';

// AudioWorklet processor code to be loaded via Blob URL
export const AUDIO_WORKLET_CODE = `
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048; // Send chunks of ~128ms at 16kHz
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
    this._targetSampleRate = 16000;
  }

  process(inputs) {
    const input = inputs[0];
    // If no input or empty channels, keep processor alive but do nothing
    if (!input || input.length === 0) return true;
    
    const channelData = input[0];
    if (!channelData) return true;
    
    // Access global sampleRate from AudioWorkletGlobalScope
    const currentSampleRate = sampleRate; 
    const ratio = currentSampleRate / this._targetSampleRate;
    
    // Logic to downsample/upsample to 16kHz
    // We loop through the input buffer and sample points based on the ratio
    for (let i = 0; i < channelData.length; i += ratio) {
       const idx = Math.floor(i);
       if (idx < channelData.length) {
         this.buffer[this.bufferIndex++] = channelData[idx];
         
         // When buffer is full, flush it
         if (this.bufferIndex >= this.bufferSize) {
           this.flush();
         }
       }
    }

    return true;
  }

  flush() {
    if (this.bufferIndex > 0) {
      const data = this.buffer.slice(0, this.bufferIndex);
      this.port.postMessage(data);
      this.bufferIndex = 0;
    }
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
`;

// Helper to create the Blob structure required by Gemini Live API
export function createPcmBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    // Clamp and convert to 16-bit PCM
    const s = Math.max(-1, Math.min(1, data[i]));
    // Convert float [-1.0, 1.0] to int16 [-32768, 32767]
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const base64 = arrayBufferToBase64(int16.buffer);
  // console.log("base64="+base64);
  return {
    data: base64,
    mimeType: 'audio/pcm;rate=16000',
  };
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function decodeAudioData(
  base64Data: string,
  ctx: AudioContext,
  sampleRate: number = 24000
): Promise<AudioBuffer> {
  const buffer = base64ToArrayBuffer(base64Data);
  
  const dataInt16 = new Int16Array(buffer);
  
  const numChannels = 1;
  const frameCount = dataInt16.length / numChannels;
  
  const audioBuffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  
  const channelData = audioBuffer.getChannelData(0);
  for (let i = 0; i < frameCount; i++) {
    // Convert int16 [-32768, 32767] to float [-1.0, 1.0]
    channelData[i] = dataInt16[i] / 32768.0;
  }
  
  console.log("Base64="+audioBufferToWavBase64(audioBuffer));

  return audioBuffer;
}

// AudioBuffer → WAV ArrayBuffer
function audioBufferToWavArrayBuffer(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitsPerSample = 16;
  const format = 1; // PCM

  const samples = buffer.length;
  const blockAlign = numChannels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const ab = new ArrayBuffer(totalSize);
  const view = new DataView(ab);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // --- WAV Header ---
  writeString(0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(8, 'WAVE');

  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // --- PCM 写入 ---
  let offset = 44;
  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < channelData.length; i++) {
      let v = Math.max(-1, Math.min(1, channelData[i]));
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      offset += 2;
    }
  }

  return ab;
}

// AudioBuffer → WAV Base64
export function audioBufferToWavBase64(buffer: AudioBuffer, withPrefix = true): string {
  const wavArrayBuffer = audioBufferToWavArrayBuffer(buffer);
  const base64 = arrayBufferToBase64(wavArrayBuffer);

  return withPrefix
    ? `data:audio/wav;base64,${base64}`
    : base64;
}