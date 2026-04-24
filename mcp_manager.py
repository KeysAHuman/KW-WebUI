import json
import asyncio
import os
from typing import Dict, List, Any, Optional
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

class MCPManager:
    def __init__(self, config_path: str = "mcp_config.json"):
        self.config_path = config_path
        self._config_dir = os.path.dirname(os.path.abspath(config_path)) or "."
        self.servers = {}
        self.sessions: Dict[str, ClientSession] = {} # Store active sessions here
        self.exit_stack = None # To manage cleanup
        self._initialized = False  # True after start_all_servers completes
        self._tools_cache: Optional[List[Dict[str, Any]]] = None

    def load_config(self):
        if not os.path.exists(self.config_path):
            print(f"MCP config not found at {self.config_path}")
            return
        
        self._config_dir = os.path.dirname(os.path.abspath(self.config_path)) or "."
        with open(self.config_path, "r") as f:
            config = json.load(f)
            self.servers = config.get("mcpServers", {})

    async def start_all_servers(self):
        """Call this once on FastAPI startup"""
        from contextlib import AsyncExitStack

        # Guard against double-entry: close the old stack first
        if self.exit_stack is not None:
            print("⚠️ start_all_servers called again — closing previous exit_stack")
            await self.exit_stack.aclose()
            self.sessions.clear()

        self.exit_stack = AsyncExitStack()
        
        for name, config in self.servers.items():
            if not config.get("enabled", True): continue
            
            try:
                # Resolve relative paths against the config file's directory
                def _resolve(p: str) -> str:
                    return p if os.path.isabs(p) else os.path.join(self._config_dir, p)

                command = _resolve(config.get("command"))
                args = [_resolve(a) for a in config.get("args", [])]

                params = StdioServerParameters(
                    command=command,
                    args=args,
                    env={**os.environ, **config.get("env", {})}
                )
                
                # Keep the connection open in the background
                read, write = await self.exit_stack.enter_async_context(stdio_client(params))
                session = await self.exit_stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                self.sessions[name] = session
                print(f"✅ Connected to MCP Server: {name}")
            except Exception as e:
                print(f"❌ Failed to connect to MCP Server {name}: {e}")

        self._initialized = True
        # Eagerly populate the tools cache
        await self._refresh_tools_cache()

    async def _refresh_tools_cache(self):
        """Rebuild the tools cache from live sessions."""
        all_tools = []
        for name, session in self.sessions.items():
            try:
                tools_result = await session.list_tools()
                for tool in tools_result.tools:
                    all_tools.append({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.inputSchema
                        },
                        "server": name
                    })
            except Exception as e:
                print(f"⚠️ Error listing tools for {name}: {e}")
        self._tools_cache = all_tools

    def invalidate_tools_cache(self):
        """Call this if MCP servers are added/removed at runtime."""
        self._tools_cache = None

    async def get_all_tools(self) -> List[Dict[str, Any]]:
        if not self._initialized:
            raise RuntimeError(
                "MCPManager.get_all_tools() called before start_all_servers(). "
                "Ensure the FastAPI lifespan has completed before querying tools."
            )
        if self._tools_cache is None:
            await self._refresh_tools_cache()
        return self._tools_cache

    async def call_tool(self, server_name: str, tool_name: str, arguments: Dict[str, Any]) -> str:
        session = self.sessions.get(server_name)
        if not session:
            return f"Error: No active session for server {server_name}"

        try:
            result = await session.call_tool(tool_name, arguments)
            
            # Process result (concatenate text contents)
            text_outputs = [content.text for content in result.content if hasattr(content, 'text')]
            return "\n".join(text_outputs)
        except Exception as e:
            return f"Error calling tool {tool_name} on {server_name}: {e}"

# Global instance
mcp_manager = MCPManager()
