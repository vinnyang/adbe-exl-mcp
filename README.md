# experience-league-mcp

A TypeScript MCP server that provides AI tool capabilities for searching and fetching content from the Adobe Experience League documentation site.

## Local Development

### Prerequisites

- Node.js 20 or newer
- npm (bundled with Node.js)

### Install dependencies

```bash
npm ci
```

### Start the MCP server

```bash
npm run build
ACCESS_TOKE=<YOUR_ACCESS_TOKE_HERE> npm start
```

By default the server listens on `127.0.0.1:8899`. Update your MCP client (e.g., Cursor) to point at that address when testing locally.

### Environment Variables

The server requires the following environment variable:

- `ACCESS_TOKEN`: The Coveo API access token for Experience League search.
  - Example: `ab123456-7890-cdef-1234-567890abcdef`
  - Note: This token is required and must be provided; the default example value will not work for actual searches.

### Use in Cursor

1. Open Cursor and navigate to **Settings → Tools & MCP Servers**.
2. Click **New MCP Server** depending on the build.
3. Enter a name such as `experience-league-mcp` and set the URL to `http://127.0.0.1:8899/mcp`, in the mcp.json file.
4. Save the configuration. Cursor will attempt to connect immediately; ensure the server is running first.
5. Once connected, the tools `search_experience_league` and `fetch_article_content` appear in the MCP tool palette and can be invoked via natural-language prompts.
