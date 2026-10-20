// A stdio MCP server for test/mcp-probe.test.ts (#333): it answers initialize; with `stall` it reads stdin and never answers. Read from the
// repo, as lsp-stub.mjs is: .mjs files are not copied to dist/.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

if (process.argv[2] === 'stall') process.stdin.resume();
else await new McpServer({ name: 'stub', version: '1.0.0' }).connect(new StdioServerTransport());
