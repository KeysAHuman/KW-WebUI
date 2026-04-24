import asyncio
from datetime import datetime
from typing import Any

import pytz
import mcp.types as types
from duckduckgo_search import DDGS
from mcp.server import NotificationOptions, Server
from mcp.server.models import InitializationOptions
from mcp.server.stdio import stdio_server

server = Server("web-search")

@server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    """
    List available tools.
    Each tool specifies its arguments using JSON Schema.
    """
    return [
        types.Tool(
            name="web_search",
            description="Search the web for real-time information using DuckDuckGo",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                },
                "required": ["query"],
            },
        ),
        types.Tool(
            name="get_current_time",
            description="Returns the current date and time for a given timezone (e.g. 'America/New_York', 'UTC', 'Europe/London'). Use this whenever the user asks what time or date it is.",
            inputSchema={
                "type": "object",
                "properties": {
                    "timezone": {
                        "type": "string",
                        "description": "IANA timezone name, e.g. 'America/New_York'"
                    }
                },
                "required": []
            },
        ),
    ]

@server.call_tool()
async def handle_call_tool(
    name: str, arguments: dict | None
) -> Any:
    """
    Handle tool calls from the LLM.
    """
    if name == "web_search":
        query = (arguments or {}).get("query")
        if not query:
            return [types.TextContent(type="text", text="Error: No query provided")]

        results = []
        last_error = None

        def _search_sync(q: str) -> list[str]:
            out: list[str] = []
            with DDGS() as ddgs:
                for r in ddgs.text(q, max_results=5):
                    out.append(
                        f"Title: {r['title']}\nSnippet: {r['body']}\nURL: {r['href']}"
                    )
            return out

        for attempt in range(3):  # up to 3 retries
            try:
                results = await asyncio.to_thread(_search_sync, query)
                if results:
                    break  # success — stop retrying
            except Exception as e:
                last_error = str(e)
                await asyncio.sleep(1.5 * (attempt + 1))  # back off between attempts

        if results:
            content = "\n\n".join(results)
        else:
            content = f"No results found after 3 attempts. Last error: {last_error}"

        return [types.TextContent(type="text", text=content)]

    if name == "get_current_time":
        tz_name = (arguments or {}).get("timezone", "UTC")
        try:
            tz = pytz.timezone(tz_name)
        except pytz.UnknownTimeZoneError:
            tz = pytz.utc
            tz_name = "UTC"
        now = datetime.now(tz)
        result = now.strftime(f"%A, %B %d %Y — %I:%M:%S %p ({tz_name})")
        return [types.TextContent(type="text", text=result)]
    
    raise ValueError(f"Unknown tool: {name}")

async def main():
    # Run the server using stdin/stdout streams
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="web-search",
                server_version="0.1.0",
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            ),
        )

if __name__ == "__main__":
    asyncio.run(main())
