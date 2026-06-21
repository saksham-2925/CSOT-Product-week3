# SUBMISSION.md — Gemini Voice Client

## Data Flow Architecture

This project implements a real-time voice conversation client where a browser-based frontend communicates with Google's Gemini Live API (BidiGenerateContent) through a Python backend proxy. The architecture follows a strict three-tier model: **Browser ↔ Backend Proxy ↔ Gemini API**, ensuring the API key never leaves the server.

### Audio Capture → Gemini

When the user taps the microphone, the browser requests mic access and creates an `AudioContext` targeting 16 kHz sample rate. An `AudioWorkletProcessor` (`audio-processor.js`) runs in a dedicated audio thread, converting incoming Float32 samples to 16-bit signed PCM integers. When sufficient samples accumulate (~100ms chunks), the worklet posts the buffer to the main thread, which sends it as a raw binary WebSocket frame to the backend.

The backend's `client_to_gemini` coroutine receives these binary frames, Base64-encodes the PCM data, wraps it in the Gemini `realtime_input` JSON envelope (specifying `audio/pcm;rate=16000` MIME type), and forwards it over the Gemini WebSocket.

### Gemini → Audio Playback

Gemini streams responses as JSON messages containing Base64-encoded audio in `serverContent.modelTurn.parts[].inlineData.data`. The backend's `gemini_to_client` coroutine decodes the Base64 back to raw PCM bytes (24 kHz, 16-bit) and forwards them as binary WebSocket frames to the browser.

The frontend maintains a playback queue: each incoming binary chunk is converted from Int16 to Float32, loaded into a Web Audio API `AudioBuffer` at 24 kHz, and played through an `AudioBufferSourceNode`. The `onended` callback triggers the next chunk, ensuring gapless sequential playback.

## Dual-WebSocket Handling

The core challenge is managing two simultaneous WebSocket connections that must relay data between each other in real-time. I solved this using Python's `asyncio.gather()` to run two independent coroutines concurrently:

1. **`client_to_gemini()`**: An async loop that awaits messages from the frontend WebSocket (`client_ws.receive()`). Binary frames are re-encoded and forwarded. Text frames (for typed messages) are parsed and wrapped in `client_content` envelopes.

2. **`gemini_to_client()`**: An async iterator over the Gemini WebSocket (`async for raw_message in gemini_ws`). It inspects each message to determine whether it contains audio data, a tool call, a turn-complete signal, or text — and routes accordingly.

Both loops run within the same `async with websockets.connect(...)` context manager, so when either connection drops, the gather completes and cleanup happens naturally.

## Tool Call Interception

When Gemini decides to use a tool (e.g., `get_current_time`), it sends a message with a `toolCall` field containing function names and arguments. The `gemini_to_client` loop detects this, calls `execute_tool()` from `tools.py`, and constructs a `tool_response` message with the function's return value. This response is sent back to Gemini (not to the browser), allowing the model to incorporate the result into its next spoken reply. The frontend receives a notification about the tool call for transcript display purposes.

## Challenges

**Sample rate mismatch**: Browsers don't always honor the requested 16 kHz `AudioContext` sample rate — Chrome on macOS often defaults to 48 kHz. I added a downsampling function that detects the actual rate and resamples if necessary.

**Playback gapping**: Naively creating a new `AudioBufferSourceNode` for each chunk caused audible gaps. The sequential queue with `onended` chaining solved this, though a proper ring-buffer approach would be even smoother for production use.

**Connection lifecycle**: Coordinating the setup handshake (the first message to Gemini must be `BidiGenerateContentSetup`) with the relay loops required careful sequencing — the setup acknowledgement must be received before starting the relay `gather()`.
