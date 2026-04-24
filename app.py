import os
import json
import uuid
import base64
import io
import sys
import asyncio
from typing import List, Optional, Dict, Any

# Optional: TTS requires torch, which may be installed outside this venv (e.g. via pipx).
# Set TORCH_PATH to point at the site-packages dir containing torch/torchaudio.
# If unset, we assume torch is available in the normal import path.
_torch_path = os.environ.get("TORCH_PATH")
if _torch_path and _torch_path not in sys.path:
    sys.path.append(_torch_path)

from fastapi import FastAPI, Request, UploadFile, File, Form, HTTPException, Response
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import re
from pydantic import BaseModel
import PyPDF2
import httpx
from mcp_manager import mcp_manager
from contextlib import asynccontextmanager

# ---------- helpers ----------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DEBUG = os.environ.get("DEBUG") == "1"

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434/api")
try:
    OLLAMA_TIMEOUT = float(os.environ.get("OLLAMA_TIMEOUT", "600"))
except ValueError:
    OLLAMA_TIMEOUT = 600.0

try:
    UPLOAD_MAX_MB = int(os.environ.get("UPLOAD_MAX_MB", "150"))
except ValueError:
    UPLOAD_MAX_MB = 150
UPLOAD_MAX_BYTES = max(1, UPLOAD_MAX_MB) * 1024 * 1024

def secure_filename(filename: str) -> str:
    """Sanitise a filename (replaces werkzeug.utils.secure_filename)."""
    # Normalise path separators then take only the basename
    filename = filename.replace("\\", "/")
    filename = filename.split("/")[-1]
    # Strip anything that isn't alphanumeric, dash, underscore, or dot
    filename = re.sub(r"[^\w.\-]", "_", filename).strip("._")
    return filename or "unnamed"

MAX_TOOL_ROUNDS = 5  # Depth guard for chained tool calls

# Global HTTPX client
client: Optional[httpx.AsyncClient] = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global client
    # Load configuration
    mcp_manager.load_config()
    # Boot up the MCP toolbelt
    await mcp_manager.start_all_servers()
    # Initialize global async client
    client = httpx.AsyncClient(base_url=OLLAMA_BASE_URL, timeout=OLLAMA_TIMEOUT)
    yield
    # Cleanup
    await client.aclose()
    if mcp_manager.exit_stack:
        await mcp_manager.exit_stack.aclose()

app = FastAPI(title="Ollama Workbench", lifespan=lifespan)

# Configuration
CONVERSATIONS_DIR = os.path.join(os.path.dirname(__file__), "conversations")
UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), "static", "uploads")
TTS_OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "static", "tts")

for d in [CONVERSATIONS_DIR, UPLOAD_FOLDER, TTS_OUTPUT_DIR]:
    if not os.path.exists(d):
        os.makedirs(d)

# Setup templates and static files
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

# Lazy loading TTS (Original logic preserved)
tts_model = None
HAS_TTS = False
try:
    from TTS.api import TTS
    HAS_TTS = True
except Exception as e:
    if DEBUG:
        print(f"TTS Import Error: {e}")

def get_tts():
    global tts_model
    if tts_model is None and HAS_TTS:
        try:
            tts_model = TTS("tts_models/en/ljspeech/vits")
        except Exception as e:
            if DEBUG:
                print(f"Error initializing TTS: {e}")
            return None
    return tts_model

def get_username():
    # Cross-platform: env vars first, then getpass, then fallback
    user = os.environ.get('USER') or os.environ.get('USERNAME') or os.environ.get('LOGNAME')
    if user:
        return user
    try:
        import getpass
        return getpass.getuser()
    except Exception:
        return "USER"

# Models for Request Bodies
class ChatRequest(BaseModel):
    model: str
    messages: List[Dict[str, Any]]
    tools_enabled: bool = False
    canvas_enabled: bool = False

class TTSRequest(BaseModel):
    text: str

class TitleRequest(BaseModel):
    message: str
    model: str

class ConversationSaveRequest(BaseModel):
    id: Optional[str] = None
    title: str
    timestamp: str
    messages: List[Dict[str, Any]]

# Routes
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"username": get_username()}
    )

@app.get("/api/models")
async def get_models():
    if client is None:
        raise HTTPException(status_code=503, detail="Ollama client is not initialized")
    try:
        resp = await client.get("/tags")
        return resp.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/health")
async def health():
    ollama_ok = False
    if client is not None:
        try:
            r = await client.get("/version", timeout=2.0)
            ollama_ok = r.status_code == 200
        except Exception:
            ollama_ok = False
    return {
        "status": "ok",
        "ollama": ollama_ok,
        "tools": bool(mcp_manager.sessions),
        "upload_max_mb": UPLOAD_MAX_MB,
    }

@app.post("/api/chat")
async def chat(request: ChatRequest):
    if client is None:
        raise HTTPException(status_code=503, detail="Ollama client is not initialized")
    model = request.model
    messages = list(request.messages)
    tools_enabled = request.tools_enabled
    canvas_enabled = request.canvas_enabled

    if canvas_enabled:
        # Inject Canvas System Prompt
        canvas_instruction = (
            "You have access to a UI Canvas. "
            "IMPORTANT: The Canvas is NOT a JSON tool call or an MCP tool. It is a plaintext formatting feature! "
            "Whenever you write a complete script, code snippet, or formatted document (like markdown/html), "
            "you MUST wrap it entirely within `<canvas_mode lang=\"language\">` and `</canvas_mode>` tags right here in your normal text response. "
            "Example: <canvas_mode lang=\"python\">\nprint('hello')\n</canvas_mode>\n"
            "Never use standard markdown code blocks (```) for full scripts and never look for a canvas function tool. "
            "Do not use Canvas for conversational replies or follow-up responses. "
            "Only use Canvas when the user directly requests a canvas action or when you are providing a full script/document. "
            "After using Canvas, return to plain text unless the user explicitly asks you to use Canvas again."
        )
        
        if messages and messages[0].get("role") == "system":
            messages[0]["content"] = f"{messages[0].get('content', '')}\n\n{canvas_instruction}"
        else:
            messages.insert(0, {"role": "system", "content": canvas_instruction})
    
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "think": True  # Enable thinking tokens for reasoning models (ignored by others)
    }

    if tools_enabled:
        mcp_tools = await mcp_manager.get_all_tools()
        if mcp_tools:
            payload["tools"] = [
                {k: v for k, v in tool.items() if k != "server"} 
                for tool in mcp_tools
            ]

    async def generate():
        # Work on a copy so we never mutate the original request messages
        local_messages = list(messages)
        if DEBUG:
            print(f"DEBUG: Starting generation for model: {model}")
        
        current_payload = dict(payload)
        max_retries = 2
        
        for attempt in range(max_retries):
            try:
                # Add an initial heartbeat to flush headers immediately
                yield b" \n"
                async with client.stream("POST", "/chat", json=current_payload, timeout=None) as r:
                    iterator = r.aiter_lines().__aiter__()
                    while True:
                        try:
                            # 15s timeout to send a heartbeat ping to prevent browser fetch NetworkError
                            line = await asyncio.wait_for(iterator.__anext__(), timeout=15.0)
                        except asyncio.TimeoutError:
                            yield b" \n"
                            continue
                        except StopAsyncIteration:
                            break
                        
                        if not line: continue
                        
                        resp_data = json.loads(line)

                        # Handle Ollama-level errors (e.g. model doesn't support tools or thinking)
                        if "error" in resp_data:
                            error_msg = resp_data["error"]
                            if "does not support thinking" in error_msg.lower() and attempt == 0:
                                current_payload.pop("think", None)
                                raise ValueError("RETRY_NO_THINK")
                            elif "does not support tools" in error_msg.lower():
                                friendly = (f"\u26a0\ufe0f Model '{model}' does not support native tools. "
                                            "Please switch to a tool-compatible model "
                                            "(Llama 3.1, Mistral, Qwen 2.5, etc.) or disable the Tools toggle.")
                                yield json.dumps({"type": "content", "message": {"content": friendly}}).encode() + b"\n"
                                return
                            else:
                                yield json.dumps({"error": error_msg}).encode() + b"\n"
                                return

                        # Handle tool calls — loop to support chained tool use
                        if "message" in resp_data and "tool_calls" in resp_data["message"]:
                            tool_calls = resp_data["message"]["tool_calls"]
                            
                            local_messages.append({
                                "role": "assistant",
                                "content": "",
                                "tool_calls": tool_calls
                            })

                            all_tools = await mcp_manager.get_all_tools()
                            for tool_call in tool_calls:
                                tool_name = tool_call["function"]["name"]
                                arguments = tool_call["function"]["arguments"]
                                
                                if isinstance(arguments, str):
                                    arguments = json.loads(arguments)
                                
                                server_name = next((t["server"] for t in all_tools if t["function"]["name"] == tool_name), None)
                                
                                if server_name:
                                    yield json.dumps({"type": "tool_status", "message": {"content": f"\n[CALLING TOOL: {tool_name} via {server_name}...]\n"}}).encode() + b"\n"
                                    tool_result = await mcp_manager.call_tool(server_name, tool_name, arguments)
                                    local_messages.append({"role": "tool", "content": tool_result, "name": tool_name})
                                else:
                                    local_messages.append({"role": "tool", "content": f"Error: Tool {tool_name} not found.", "name": tool_name})

                            # Re-trigger with tool results, looping if the model chains more tool calls
                            for _depth in range(MAX_TOOL_ROUNDS):
                                new_payload = {**current_payload, "messages": local_messages}
                                needs_another_round = False
                                async with client.stream("POST", "/chat", json=new_payload, timeout=None) as r2:
                                    iterator_2 = r2.aiter_lines().__aiter__()
                                    while True:
                                        try:
                                            l2 = await asyncio.wait_for(iterator_2.__anext__(), timeout=15.0)
                                        except asyncio.TimeoutError:
                                            yield b" \n"
                                            continue
                                        except StopAsyncIteration:
                                            break
                                        
                                        if not l2: continue
                                        r2_data = json.loads(l2)

                                        # Chained tool call in the follow-up response
                                        if "message" in r2_data and "tool_calls" in r2_data["message"]:
                                            chained_calls = r2_data["message"]["tool_calls"]
                                            local_messages.append({"role": "assistant", "content": "", "tool_calls": chained_calls})
                                            for tc in chained_calls:
                                                tc_name = tc["function"]["name"]
                                                tc_args = tc["function"]["arguments"]
                                                if isinstance(tc_args, str):
                                                    tc_args = json.loads(tc_args)
                                                srv = next((t["server"] for t in all_tools if t["function"]["name"] == tc_name), None)
                                                if srv:
                                                    yield json.dumps({"type": "tool_status", "message": {"content": f"\n[CALLING TOOL: {tc_name} via {srv}...]\n"}}).encode() + b"\n"
                                                    result = await mcp_manager.call_tool(srv, tc_name, tc_args)
                                                    local_messages.append({"role": "tool", "content": result, "name": tc_name})
                                                else:
                                                    local_messages.append({"role": "tool", "content": f"Error: Tool {tc_name} not found.", "name": tc_name})
                                            needs_another_round = True
                                            break  # Break inner stream, re-trigger in next loop iteration
                                        else:
                                            yield l2.encode() + b"\n"

                                if not needs_another_round:
                                    break
                            else:
                                # Hit the depth limit
                                yield json.dumps({"type": "content", "message": {"content": f"\n⚠️ Tool call depth limit ({MAX_TOOL_ROUNDS}) reached. Stopping.\n"}}).encode() + b"\n"
                            return

                        # Handle thinking tokens (DeepSeek-R1, Qwen3, etc.)
                        if "message" in resp_data:
                            msg = resp_data["message"]
                            if msg.get("thinking"):
                                yield json.dumps({"type": "thinking", "content": msg["thinking"]}).encode() + b"\n"
                            if msg.get("content"):
                                yield json.dumps({"type": "content", "message": msg}).encode() + b"\n"
                            # If the chunk has neither thinking nor content (e.g. role-only), skip it
                            if not msg.get("thinking") and not msg.get("content"):
                                # Still forward done signals
                                if resp_data.get("done"):
                                    yield line.encode() + b"\n"
                                continue
                        else:
                            # Non-message chunks (e.g. done signal without message)
                            yield line.encode() + b"\n"
                            
                # If we made it here without error, the generation was fully successful
                break
            except ValueError as e:
                # Catch our internal retry signal
                if str(e) == "RETRY_NO_THINK":
                    if DEBUG:
                        print(f"DEBUG: Retrying model {model} without 'think' flag.")
                    continue
                raise e
            except Exception as e:
                if DEBUG:
                    print(f"DEBUG: Generation error: {e}")
                yield json.dumps({"error": str(e)}).encode() + b"\n"
                break

    return StreamingResponse(generate(), media_type="text/event-stream")

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    filename = secure_filename(file.filename)
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    written = 0
    try:
        with open(filepath, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > UPLOAD_MAX_BYTES:
                    raise HTTPException(status_code=413, detail=f"Upload exceeds limit of {UPLOAD_MAX_MB}MB")
                f.write(chunk)
    except HTTPException:
        if os.path.exists(filepath):
            try:
                os.remove(filepath)
            except Exception:
                pass
        raise
    
    text_content = ""
    if filename.endswith(".pdf"):
        try:
            with open(filepath, "rb") as f:
                pdf = PyPDF2.PdfReader(f)
                for page in pdf.pages:
                    text_content += page.extract_text() + "\n"
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"PDF extraction failed: {str(e)}")
    elif filename.endswith(".txt"):
        with open(filepath, "r", encoding="utf-8") as f:
            text_content = f.read()
    
    return {"status": "success", "filename": filename, "content": text_content, "url": f"/static/uploads/{filename}"}

@app.post("/api/tts")
async def text_to_speech(request: TTSRequest):
    text = request.text
    _tts = get_tts()
    if not _tts:
        raise HTTPException(status_code=503, detail="TTS engine not available")
    
    output_filename = f"tts_{uuid.uuid4()}.wav"
    output_path = os.path.join(TTS_OUTPUT_DIR, output_filename)
    
    try:
        await asyncio.to_thread(_tts.tts_to_file, text=text, file_path=output_path)
        return {"url": f"/static/tts/{output_filename}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate-title")
async def generate_title(request: TitleRequest):
    """Generate a short title for a conversation based on the first message."""
    if client is None:
        return {"title": "New Chat"}
    try:
        resp = await client.post("/chat", json={
            "model": request.model,
            "messages": [{"role": "user", "content": (
                "Summarize this chat request into a short 3-5 word title. "
                "Output ONLY the title, nothing else: " + request.message
            )}],
            "stream": False
        })
        data = resp.json()
        content = data.get("message", {}).get("content", "New Chat")
        # Strip <think> tags if model prepended them (common with DeepSeek-R1 and similar)
        content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
        title = content.strip().strip('"')
        # Clamp length just in case the model is verbose
        if len(title) > 60:
            title = title[:57] + "..."
        return {"title": title}
    except Exception as e:
        print(f"Title generation error: {e}")
        return {"title": "New Chat"}

@app.get("/api/conversations")
async def list_conversations():
    files = [f for f in os.listdir(CONVERSATIONS_DIR) if f.endswith(".json")]
    conversations = []
    for f in files:
        with open(os.path.join(CONVERSATIONS_DIR, f), "r") as file:
            try:
                data = json.load(file)
                conversations.append({
                    "id": f.replace(".json", ""),
                    "title": data.get("title", "Untitled"),
                    "timestamp": data.get("timestamp")
                })
            except: continue
    conversations.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    return conversations

@app.get("/api/conversations/{conv_id}")
async def get_conversation(conv_id: str):
    path = os.path.join(CONVERSATIONS_DIR, f"{conv_id}.json")
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    raise HTTPException(status_code=404, detail="Not found")

@app.delete("/api/conversations/{conv_id}")
async def delete_conversation(conv_id: str):
    path = os.path.join(CONVERSATIONS_DIR, f"{conv_id}.json")
    if os.path.exists(path):
        os.remove(path)
        return {"status": "deleted"}
    raise HTTPException(status_code=404, detail="Not found")

@app.post("/api/conversations")
async def save_conversation(request: ConversationSaveRequest):
    conv_id = request.id or str(uuid.uuid4())
    path = os.path.join(CONVERSATIONS_DIR, f"{conv_id}.json")
    with open(path, "w") as f:
        json.dump(request.model_dump(), f)
    return {"status": "success", "id": conv_id}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)
