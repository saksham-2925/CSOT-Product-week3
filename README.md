# CSOT-Product-week3

# Gemini Voice Client

A real-time voice conversation client that communicates with Google's Gemini AI through a secure backend proxy server. Supports bidirectional audio streaming and tool calling.


- **Frontend** (`frontend/`): Vanilla HTML/CSS/JS with AudioWorklet-based mic capture and PCM playback.
- **Backend** (`server.py`): FastAPI with dual-WebSocket relay. Handles Gemini setup, audio encoding/decoding, and tool call interception.
- **Tools** (`tools.py`): Extensible tool registry. Ships with `get_current_time`.

## Prerequisites

- Python 3.9+
- A [Gemini API key](https://aistudio.google.com/apikey)

## Setup

1. **Clone the repository**:
   ```bash
   git clone <your-repo-url>
   cd Product
   ```

2. **Create a virtual environment** (recommended):
   ```bash
   python -m venv venv
   source venv/bin/activate    # macOS/Linux
   # or: venv\Scripts\activate  # Windows
   ```

3. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure your API key**:
   ```bash
   # Edit .env and replace the placeholder with your actual key
   echo "GEMINI_API_KEY=your_actual_key_here" > .env
   ```

## Running

```bash
uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

## Usage

1. Wait for the status badge to show **Connected to Gemini** (green dot).
2. **Tap the microphone** button to start speaking. Your audio streams to Gemini in real-time.
3. Gemini's spoken reply plays through your speakers automatically.
4. Try asking: **"What time is it right now?"** — the backend will intercept Gemini's tool call, execute `get_current_time()`, and send the result back so Gemini can speak the answer.
5. You can also **type messages** in the text input field.

## Security

- The Gemini API key lives **exclusively** in the `.env` file on the backend server.
- The frontend contains **zero API keys or secrets**.
- The `.gitignore` prevents `.env` from being committed.

## Project Structure

```
Product/
├── .env                  # API key (git-ignored)
├── .gitignore
├── requirements.txt
├── server.py             # FastAPI dual-WebSocket proxy
├── tools.py              # Tool declarations + execution
├── README.md
├── SUBMISSION.md         # Assignment write-up
└── frontend/
    ├── index.html        # UI shell
    ├── style.css         # Premium dark-mode design
    ├── app.js            # WebSocket + audio pipeline
    └── audio-processor.js # AudioWorklet for mic capture
```

## Adding New Tools

1. Add a `FunctionDeclaration` to `TOOL_DECLARATIONS` in `tools.py`.
2. Implement the Python function.
3. Register it in `_TOOL_REGISTRY`.
4. Restart the server — Gemini will see the new tool on next connection.
