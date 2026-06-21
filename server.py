"""
server.py — FastAPI backend proxy for the Gemini Live API.

Architecture:
  Browser  ←—WebSocket—→  FastAPI (/ws)  ←—WebSocket—→  Gemini Live API

"""

import os
import json
import asyncio
import base64
import traceback

import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from dotenv import load_dotenv

from tools import TOOL_DECLARATIONS, execute_tool

load_dotenv()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025"

GEMINI_WS_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
    f"?key={GEMINI_API_KEY}"
)

app = FastAPI()

app.mount("/static", StaticFiles(directory="frontend"), name="static")


@app.get("/")
async def serve_frontend():
    """Serve the main frontend page."""
    return FileResponse("frontend/index.html")


@app.websocket("/ws")
async def proxy_endpoint(client_ws: WebSocket):
    await client_ws.accept()
    print("✅ Frontend connected.")

    
    client_alive = True

    async def safe_send_text(data: str):
        """Send text to client, ignoring errors if client disconnected."""
        nonlocal client_alive
        if not client_alive:
            return
        try:
            await client_ws.send_text(data)
        except Exception:
            client_alive = False

    async def safe_send_bytes(data: bytes):
        """Send bytes to client, ignoring errors if client disconnected."""
        nonlocal client_alive
        if not client_alive:
            return
        try:
            await client_ws.send_bytes(data)
        except Exception:
            client_alive = False

    try:
        print("⏳ Connecting to Gemini...")
        async with websockets.connect(
            GEMINI_WS_URL,
            max_size=None,
            open_timeout=15,
            close_timeout=5,
        ) as gemini_ws:
            print("✅ Connected to Gemini Live API.")

          
            setup_message = {
                "setup": {
                    "model": MODEL,
                    "generation_config": {
                        "response_modalities": ["AUDIO"],
                        "speech_config": {
                            "voice_config": {
                                "prebuilt_voice_config": {
                                    "voice_name": "Aoede"
                                }
                            }
                        },
                    },
                    "system_instruction": {
                        "parts": [
                            {
                                "text": "You are a helpful voice assistant. Wait for the user to speak or send a message before responding. Only use the get_current_time tool when the user explicitly asks about the current time or date. Do not call any tools proactively. Do not attempt to call tools that are not available to you."
                            }
                        ]
                    },
                    "tools": TOOL_DECLARATIONS,
                }
            }

            await gemini_ws.send(json.dumps(setup_message))
            print("📤 Sent BidiGenerateContentSetup.")

            
            try:
                setup_response = await asyncio.wait_for(gemini_ws.recv(), timeout=15)
                print(f"📥 Setup response received (type: {'text' if isinstance(setup_response, str) else 'binary'})")
            except asyncio.TimeoutError:
                print("❌ Gemini setup timed out.")
                await safe_send_text(json.dumps({
                    "type": "error",
                    "message": "Gemini setup timed out. Please refresh.",
                }))
                return

            
            await safe_send_text(json.dumps({
                "type": "status",
                "message": "connected"
            }))
            print("📤 Sent 'connected' status to frontend.")

           

            async def client_to_gemini():
                """Receive from browser, forward to Gemini."""
                nonlocal client_alive
                try:
                    while client_alive:
                        data = await client_ws.receive()

                        # Check for disconnect
                        if data.get("type") == "websocket.disconnect":
                            print("🔌 Frontend disconnected (clean).")
                            client_alive = False
                            return

                        if "bytes" in data and data["bytes"]:
                            audio_bytes = data["bytes"]
                            audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

                            realtime_msg = {
                                "realtime_input": {
                                    "media_chunks": [
                                        {
                                            "data": audio_b64,
                                            "mime_type": "audio/pcm;rate=16000",
                                        }
                                    ]
                                }
                            }
                            await gemini_ws.send(json.dumps(realtime_msg))

                        elif "text" in data and data["text"]:
                            text = data["text"]
                            try:
                                msg = json.loads(text)
                                if "text_input" in msg:
                                    client_content = {
                                        "client_content": {
                                            "turns": [
                                                {
                                                    "role": "user",
                                                    "parts": [{"text": msg["text_input"]}],
                                                }
                                            ],
                                            "turn_complete": True,
                                        }
                                    }
                                    await gemini_ws.send(json.dumps(client_content))
                                    print(f"📤 Sent text input to Gemini: {msg['text_input'][:50]}")
                            except json.JSONDecodeError:
                                pass

                except WebSocketDisconnect:
                    print("🔌 Frontend disconnected.")
                    client_alive = False
                except Exception as e:
                    print(f"❌ client_to_gemini error: {e}")
                    client_alive = False

            async def gemini_to_client():
                """Receive from Gemini, forward to browser or handle tool calls."""
                nonlocal client_alive
                try:
                    async for raw_message in gemini_ws:
                        if not client_alive:
                            print("⏹️ Client gone, stopping gemini_to_client.")
                            return

                        
                        message = None
                        if isinstance(raw_message, bytes):
                            try:
                                message = json.loads(raw_message.decode("utf-8"))
                            except (json.JSONDecodeError, UnicodeDecodeError):
                               
                                await safe_send_bytes(raw_message)
                                continue
                        else:
                            try:
                                message = json.loads(raw_message)
                            except json.JSONDecodeError:
                                print(f"⚠️ Non-JSON from Gemini: {raw_message[:100]}")
                                continue

                        if message is None:
                            continue

                        
                        tool_call = message.get("toolCall")
                        if tool_call:
                            function_calls = tool_call.get("functionCalls", [])
                            function_responses = []

                            for fc in function_calls:
                                fn_name = fc.get("name", "")
                                fn_args = fc.get("args", {})
                                fn_id = fc.get("id", "")

                                print(f"🔧 Tool call: {fn_name}({fn_args})")

                                result = execute_tool(fn_name, fn_args)
                                print(f"🔧 Tool result: {result}")

                                function_responses.append({
                                    "name": fn_name,
                                    "id": fn_id,
                                    "response": result,
                                })

                            
                            tool_response_msg = {
                                "tool_response": {
                                    "function_responses": function_responses
                                }
                            }
                            await gemini_ws.send(json.dumps(tool_response_msg))
                            print(f"📤 Sent tool response to Gemini.")

                            
                            await safe_send_text(json.dumps({
                                "type": "tool_call",
                                "tool_name": function_calls[0]["name"] if function_calls else "",
                                "result": function_responses[0]["response"] if function_responses else {},
                            }))
                            continue

                        
                        server_content = message.get("serverContent")
                        if server_content:
                            model_turn = server_content.get("modelTurn")
                            if model_turn:
                                parts = model_turn.get("parts", [])
                                for part in parts:
                                    inline_data = part.get("inlineData")
                                    if inline_data:
                                        audio_b64 = inline_data.get("data", "")
                                        if audio_b64:
                                            audio_bytes = base64.b64decode(audio_b64)
                                            await safe_send_bytes(audio_bytes)
                                            print(f"🔊 Forwarded {len(audio_bytes)} bytes audio to client.")

                                    text_content = part.get("text")
                                    if text_content:
                                        await safe_send_text(json.dumps({
                                            "type": "transcript",
                                            "text": text_content,
                                        }))
                                        print(f"📝 Transcript: {text_content[:80]}")

                            turn_complete = server_content.get("turnComplete")
                            if turn_complete:
                                await safe_send_text(json.dumps({
                                    "type": "turn_complete",
                                }))
                                print("✅ Gemini turn complete.")
                            continue

                       
                        await safe_send_text(json.dumps({
                            "type": "gemini_message",
                            "data": message,
                        }))

                except websockets.exceptions.ConnectionClosed:
                    print("🔌 Gemini connection closed.")
                except Exception as e:
                    print(f"❌ gemini_to_client error: {e}")

            

            async def keepalive():
                """Send a tiny silent audio chunk every 15s to keep the Gemini connection alive."""
                nonlocal client_alive
              
                silent_pcm = base64.b64encode(b'\x00' * 320).decode("utf-8")
                try:
                    while client_alive:
                        await asyncio.sleep(15)
                        if not client_alive:
                            return
                        keepalive_msg = {
                            "realtime_input": {
                                "media_chunks": [
                                    {
                                        "data": silent_pcm,
                                        "mime_type": "audio/pcm;rate=16000",
                                    }
                                ]
                            }
                        }
                        await gemini_ws.send(json.dumps(keepalive_msg))
                except Exception:
                    pass  

           
            await asyncio.gather(
                client_to_gemini(),
                gemini_to_client(),
                keepalive(),
            )

    except websockets.exceptions.InvalidStatusCode as e:
        print(f"❌ Failed to connect to Gemini: {e}")
        await safe_send_text(json.dumps({
            "type": "error",
            "message": f"Failed to connect to Gemini API: {str(e)}",
        }))
    except Exception as e:
        print(f"❌ Proxy error: {e}")
        traceback.print_exc()
    finally:
        print("🔌 Proxy session ended.")
