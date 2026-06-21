/**
 * app.js — Frontend client for the Gemini Voice Proxy.
 *
 * Manages:
 *  1. WebSocket connection to the backend proxy (ws://localhost:8000/ws)
 *  2. Microphone capture via AudioWorklet (16 kHz, 16-bit PCM)
 *  3. Audio playback of Gemini responses (24 kHz, 16-bit PCM)
 *  4. UI updates (status, transcript, visualizer)
 *
 * NO API keys are stored or referenced in this file.
 */

// ==========================================================================
// State
// ==========================================================================

let ws = null;
let isConnected = false;
let isRecording = false;
let audioContext = null;
let mediaStream = null;
let workletNode = null;

// Playback state
let playbackContext = null;
let playbackQueue = [];
let isPlaying = false;

// Downsampling state
let inputSampleRate = 48000; // Will be set from actual mic

// ==========================================================================
// DOM References
// ==========================================================================

const micButton = document.getElementById('mic-button');
const micLabel = document.getElementById('mic-label');
const orbContainer = document.getElementById('orb-container');
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const visualizer = document.getElementById('visualizer');
const transcriptPanel = document.getElementById('transcript-panel');
const textInput = document.getElementById('text-input');
const sendButton = document.getElementById('send-button');

// ==========================================================================
// WebSocket Connection
// ==========================================================================

function connectWebSocket() {
    updateStatus('connecting', 'Connecting…');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        console.log('[WS] Connected to backend proxy.');
        // Don't set "connected" yet — wait for Gemini setup confirmation
    };

    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            // Binary frame = PCM audio from Gemini
            handleAudioPlayback(event.data);
        } else {
            // Text frame = JSON control message
            try {
                const msg = JSON.parse(event.data);
                handleJsonMessage(msg);
            } catch (e) {
                console.warn('[WS] Non-JSON text message:', event.data);
            }
        }
    };

    ws.onerror = (err) => {
        console.error('[WS] Error:', err);
        updateStatus('error', 'Connection error');
    };

    ws.onclose = () => {
        console.log('[WS] Disconnected.');
        isConnected = false;
        updateStatus('disconnected', 'Disconnected — refresh page to reconnect');
        micButton.disabled = true;
        sendButton.disabled = true;
    };
}

function handleJsonMessage(msg) {
    switch (msg.type) {
        case 'status':
            if (msg.message === 'connected') {
                isConnected = true;
                updateStatus('connected', 'Connected to Gemini');
                micButton.disabled = false;
                sendButton.disabled = false;
                textInput.disabled = false;
                addTranscriptEntry('system', '✅ Ready — tap the mic to speak, or type a message.');
            }
            break;

        case 'transcript':
            addTranscriptEntry('gemini', msg.text);
            break;

        case 'tool_call':
            const resultStr = JSON.stringify(msg.result, null, 2);
            addTranscriptEntry('tool',
                `<strong>🔧 ${msg.tool_name}</strong>` +
                `<span class="tool-result">${resultStr}</span>`
            );
            break;

        case 'turn_complete':
            // Gemini finished its turn
            visualizer.classList.remove('active');
            break;

        case 'error':
            addTranscriptEntry('error', `❌ ${msg.message}`);
            updateStatus('error', 'Error');
            break;

        case 'gemini_message':
            console.log('[Gemini] Raw message:', msg.data);
            break;

        default:
            console.log('[WS] Unknown message type:', msg);
    }
}

// ==========================================================================
// Microphone Capture
// ==========================================================================

async function startRecording() {
    try {
        // Request microphone access
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            }
        });

        // Create AudioContext (prefer 16kHz but browser may override)
        audioContext = new AudioContext({ sampleRate: 16000 });
        inputSampleRate = audioContext.sampleRate;

        console.log(`[Audio] Mic sample rate: ${inputSampleRate} Hz`);

        // Register the AudioWorklet processor
        await audioContext.audioWorklet.addModule('/static/audio-processor.js');

        // Create source from the mic stream
        const source = audioContext.createMediaStreamSource(mediaStream);

        // Create worklet node
        workletNode = new AudioWorkletNode(audioContext, 'audio-capture-processor');

        // Listen for audio data from the worklet
        let chunkCount = 0;
        workletNode.port.onmessage = (event) => {
            if (event.data.type === 'audio' && ws && ws.readyState === WebSocket.OPEN) {
                let pcmBuffer = event.data.data;

                // If the AudioContext didn't honor our 16kHz request,
                // we need to downsample
                if (inputSampleRate !== 16000) {
                    pcmBuffer = downsample(pcmBuffer, inputSampleRate, 16000);
                }

                chunkCount++;
                if (chunkCount % 10 === 1) {
                    console.log(`[Audio] Sending chunk #${chunkCount}, size: ${pcmBuffer.byteLength} bytes`);
                }

                // Send raw PCM bytes as binary WebSocket frame
                ws.send(pcmBuffer);
            }
        };

        // Connect: mic → worklet
        source.connect(workletNode);
        workletNode.connect(audioContext.destination); // Required for worklet to process

        isRecording = true;
        micButton.textContent = '⏹️ Stop Mic';
        addTranscriptEntry('system', '🎙️ Listening…');

    } catch (err) {
        console.error('[Audio] Failed to start recording:', err);
        addTranscriptEntry('error', `Mic error: ${err.message}`);
    }
}

function stopRecording() {
    if (workletNode) {
        workletNode.disconnect();
        workletNode = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    isRecording = false;
    micButton.textContent = '🎙️ Start Mic';
    addTranscriptEntry('system', '⏹️ Mic stopped. Waiting for Gemini response…');
}

/**
 * Downsample Int16 PCM buffer from one sample rate to another.
 */
function downsample(buffer, fromRate, toRate) {
    if (fromRate === toRate) return buffer;

    const inputSamples = new Int16Array(buffer);
    const ratio = fromRate / toRate;
    const outputLength = Math.round(inputSamples.length / ratio);
    const output = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
        const srcIndex = Math.round(i * ratio);
        output[i] = inputSamples[Math.min(srcIndex, inputSamples.length - 1)];
    }

    return output.buffer;
}

// ==========================================================================
// Audio Playback (24 kHz PCM from Gemini)
// ==========================================================================

let nextPlayTime = 0;
let leftoverByte = null; // Handle odd-length chunks

function handleAudioPlayback(arrayBuffer) {
    try {
        // Create playback context on first use
        if (!playbackContext || playbackContext.state === 'closed') {
            playbackContext = new AudioContext({ sampleRate: 24000 });
            nextPlayTime = 0;
        }

        // Resume context if suspended (browser autoplay policy)
        if (playbackContext.state === 'suspended') {
            playbackContext.resume();
        }

        // Handle byte alignment — Int16 needs even number of bytes
        let bytes = new Uint8Array(arrayBuffer);

        if (leftoverByte !== null) {
            // Prepend the leftover byte from last chunk
            const combined = new Uint8Array(1 + bytes.length);
            combined[0] = leftoverByte;
            combined.set(bytes, 1);
            bytes = combined;
            leftoverByte = null;
        }

        if (bytes.length % 2 !== 0) {
            // Save the last byte for next chunk
            leftoverByte = bytes[bytes.length - 1];
            bytes = bytes.slice(0, bytes.length - 1);
        }

        if (bytes.length === 0) return;

        // Convert Int16 PCM to Float32
        const int16Data = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
        const float32Data = new Float32Array(int16Data.length);
        for (let i = 0; i < int16Data.length; i++) {
            float32Data[i] = int16Data[i] / 32768.0;
        }

        // Create AudioBuffer and schedule it
        const audioBuffer = playbackContext.createBuffer(1, float32Data.length, 24000);
        audioBuffer.getChannelData(0).set(float32Data);

        const sourceNode = playbackContext.createBufferSource();
        sourceNode.buffer = audioBuffer;
        sourceNode.connect(playbackContext.destination);

        // Schedule chunks back-to-back with no gaps
        const currentTime = playbackContext.currentTime;
        if (nextPlayTime < currentTime) {
            nextPlayTime = currentTime;
        }

        sourceNode.start(nextPlayTime);
        nextPlayTime += audioBuffer.duration;

    } catch (err) {
        console.error('[Playback] Error:', err);
    }
}

// ==========================================================================
// Text Input
// ==========================================================================

function sendTextMessage() {
    const text = textInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({ text_input: text }));
    addTranscriptEntry('system', `💬 You: ${text}`);
    textInput.value = '';
}

// ==========================================================================
// UI Helpers
// ==========================================================================

function updateStatus(state, text) {
    statusBadge.className = `status-badge ${state}`;
    statusText.textContent = text;
}

function addTranscriptEntry(type, html) {
    // Remove empty state if present
    const empty = transcriptPanel.querySelector('em');
    if (empty) empty.remove();

    const entry = document.createElement('p');
    entry.innerHTML = html;

    transcriptPanel.appendChild(entry);
    transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
}

// ==========================================================================
// Event Listeners
// ==========================================================================

micButton.addEventListener('click', () => {
    if (!isConnected) return;

    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
});

sendButton.addEventListener('click', sendTextMessage);

textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendTextMessage();
    }
});

// ==========================================================================
// Initialization
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
    micButton.disabled = true;
    sendButton.disabled = true;
    connectWebSocket();
});
