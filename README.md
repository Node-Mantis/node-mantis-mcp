# Node Mantis MCP server

[![Node-Mantis/node-mantis-mcp MCP server](https://glama.ai/mcp/servers/Node-Mantis/node-mantis-mcp/badges/score.svg)](https://glama.ai/mcp/servers/Node-Mantis/node-mantis-mcp)

This MCP server connects your AI assistant to Node Mantis browser automation. Give Node Mantis a task in natural language, and it carries it out in a real browser, acting like a person: clicking buttons, filling forms, and interacting with complex widgets the way a person would. It can also read data from pages and return structured results.

## Connect your assistant

You need a Node Mantis API key from the [dashboard](https://nodemantis.com/app) and Node.js or Python. The server is included in the `node-mantis` package on [npm](https://www.npmjs.com/package/node-mantis) and [PyPI](https://pypi.org/project/node-mantis/).

Add this entry to your assistant's MCP settings, replacing the API key placeholder:

```json
{
  "mcpServers": {
    "node-mantis": {
      "command": "npx",
      "args": ["-y", "node-mantis", "mcp"],
      "env": {
        "NODEMANTIS_API_KEY": "<your-node-mantis-api-key>"
      }
    }
  }
}
```

For Python with `uv`, use `"command": "uvx"` and `"args": ["node-mantis", "mcp"]` instead. Keep the same API key setting.

Your assistant starts the server for you. Save the settings and restart your assistant. The [setup guide](https://nodemantis.com/docs/mcp) has installation requirements and instructions for individual assistants.

## Try it on the sandbox

The [Node Mantis sandbox](https://sandbox.nodemantis.com) is a demo bookshop where you can try website tasks.

### Add a book to the bag

Ask your assistant:

> Use Node Mantis to open https://sandbox.nodemantis.com. Open Travel & Adventure, add one copy of Journey to the Center of the Earth to the bag, then open the bag and report the book's title and quantity.

The corresponding `run_task` inputs are:

```json
{
  "goal": "Open Travel & Adventure, add one copy of Journey to the Center of the Earth to the bag, then open the bag and report the book's title and quantity.",
  "start_url": "https://sandbox.nodemantis.com"
}
```

### Read a book's details

Ask your assistant:

> Use Node Mantis to read the title, author, and displayed price from https://sandbox.nodemantis.com/books/journey-to-the-center-of-the-earth without interacting with the page.

The corresponding `retrieve_data` inputs are:

```json
{
  "url": "https://sandbox.nodemantis.com/books/journey-to-the-center-of-the-earth",
  "prompt": "Read the book's title, author, and displayed price."
}
```

## Tools

| Tool | What it does |
|---|---|
| `run_task` | Carries out a website task from a natural-language goal. Supports an optional starting URL, result schema, effort setting, cost and step limits, and timeout. |
| `retrieve_data` | Reads data from one page without interacting with it. Use `run_task` if reaching the data requires clicking, typing, or moving between pages. |
| `get_task` | Checks a task's progress and collects its result. |
| `cancel_task` | Stops a running task. |

For results in a particular format, pass `result_schema`, a JSON Schema describing the fields you want. See the [tool reference](https://nodemantis.com/docs/mcp#mcp-tools) for all inputs.

Calls wait up to 45 seconds by default. If the task takes longer, it keeps running and returns a `task_id`. Your assistant uses `get_task` to check back or `cancel_task` to stop it.

## Error reports

Node Mantis collects startup error reports by default to help improve the product. Reports can include an error type and filtered message, app version, operating system, installation method, and a random installation ID.

To opt out, set `NODEMANTIS_TELEMETRY=0` or `DO_NOT_TRACK=1` in your MCP server's environment.

## Source and licence

This repository contains the Python and TypeScript source for the MCP server. To run the source or contribute changes, see [CONTRIBUTING.md](CONTRIBUTING.md).

The MCP code is licensed under [MIT](LICENSE). The separately installed Node Mantis client and other Node Mantis software and services keep their own licences.

For an MCP problem or request, open an issue with your client version and an example with private data removed. More help and the full reference are at [nodemantis.com/docs/mcp](https://nodemantis.com/docs/mcp).
