/**
 * audio-processor.js — AudioWorklet processor for microphone capture.
 *
 * Runs in a separate audio thread. Receives Float32 audio samples from
 * the microphone, converts them to 16-bit signed PCM, and posts the
 * resulting buffer back to the main thread for WebSocket transmission.
 *
 * Input:  Float32 samples at the AudioContext's sample rate
 * Output: Int16 PCM buffer (via postMessage)
 *
 * The main thread handles downsampling to 16 kHz if the mic's native
 * sample rate differs.
 */

class AudioCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buffer = [];
        // Send audio chunks roughly every 32ms
        this._bufferSize = 512;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const channelData = input[0]; // Mono channel

        // Convert Float32 → Int16
        for (let i = 0; i < channelData.length; i++) {
            // Clamp to [-1, 1] range
            let sample = Math.max(-1, Math.min(1, channelData[i]));
            // Convert to 16-bit signed integer
            sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            this._buffer.push(sample);
        }

        // When we have enough samples, send them to the main thread
        if (this._buffer.length >= this._bufferSize) {
            const pcmData = new Int16Array(this._buffer);
            this.port.postMessage({
                type: 'audio',
                data: pcmData.buffer,
            }, [pcmData.buffer]);
            this._buffer = [];
        }

        return true;
    }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
