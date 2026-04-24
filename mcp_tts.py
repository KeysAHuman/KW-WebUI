import asyncio
from typing import Any
from mcp.server.models import InitializationOptions
from mcp.server import NotificationOptions, Server
from mcp.server.stdio import stdio_server
import mcp.types as types
import httpx

server = Server("tts-server")

@server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    """
    List available tools.
    """
    return [
        types.Tool(
            name="generate_speech",
            description="Convert text to an audio file when the user asks you to 'say' something out loud.",
            inputSchema={
                "type": "object",
                "properties": {"text": {"type": "string", "description": "The text to synthesize to speech"}},
                "required": ["text"],
            },
        )
    ]

@server.call_tool()
async def handle_call_tool(
    name: str, arguments: dict | None
) -> Any:
    """
    Handle tool calls from the LLM.
    """
    if name == "generate_speech":
        text = (arguments or {}).get("text")
        if not text:
            return [types.TextContent(type="text", text="Error: No text provided")]
        
        try:
            # Hit the local TTS endpoint running in app.py
            # Default Uvicorn port is 5000 in your setup
            async with httpx.AsyncClient() as client:
                resp = await client.post("http://127.0.0.1:5000/api/tts", json={"text": text}, timeout=60.0)
                
                if resp.status_code == 200:
                    data = resp.json()
                    audio_url = data.get("url")
                    # Return an HTML audio player embedded in Markdown!
                    content = f"Speech generated successfully:\n\n<audio controls autoplay src='{audio_url}'></audio>"
                else:
                    err = resp.json()
                    content = f"TTS generation failed: {err.get('detail', 'Unknown error')}"
                    
            return [types.TextContent(type="text", text=content)]
        except Exception as e:
            return [types.TextContent(type="text", text=f"TTS error: {str(e)}")]
    
    raise ValueError(f"Unknown tool: {name}")

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="tts-server",
                server_version="0.1.0",
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            ),
        )

if __name__ == "__main__":
    asyncio.run(main())
