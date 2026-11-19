# Working with the source

This repository contains the MCP server's Python and TypeScript implementations. They use the installed Node Mantis client to perform website tasks.

## Run the Python source

From the repository root, install the dependencies and start the server:

```bash
python -m pip install -r python/requirements-dev.txt
PYTHONPATH=python python -m nodemantis_mcp
```

The dependency file specifies the client version compatible with this source. Configure `NODEMANTIS_API_KEY` as described in the [README](README.md).

## Run tests

From the repository root:

```bash
PYTHONPATH=python python -m unittest discover -s python/tests -v
```

For TypeScript:

```bash
cd typescript
npm ci --ignore-scripts
npm run typecheck
npm test
```

These tests check protocol handling, the four tools, task progress, and cancellation without performing website tasks. Both implementations are checked against [the same tool definitions](fixtures/mcp-tools.json).

## Propose a change

Explain the problem, the expected behavior, and how you checked the change. Remove credentials and private task data from examples and error messages.

Keep both implementations consistent. See [SYNC.md](SYNC.md) for how this source is synchronized with the client and [source-manifest.json](source-manifest.json) for the current snapshot hashes.
