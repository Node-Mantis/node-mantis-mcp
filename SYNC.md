# Source synchronization

The client is the authoritative source. This repository receives a reviewed snapshot when the MCP layer changes for a client release. Changes proposed here must also be applied to the client before they are advertised as released behavior.

The snapshot contains both implementations and a shared tool-schema fixture. Tests check each implementation against that fixture. A manifest records the baseline client version and a SHA-256 hash for every publishable file.

During release preparation, the client's export tool copies an explicit allowlist of MCP files. The only code-path substitution is the TypeScript SDK type import: the embedded build uses its SDK entry point, while this checkout uses the installed `node-mantis` package. The argument-parser header is shortened for this repository; its implementation is unchanged.

The client release integration is prepared but is not yet active. Once enabled, its release gate checks the exported files against the public checkout and verifies the manifest hashes. A mismatch blocks release planning, and the release log records the public source commit checked. Until that integration is enabled, maintainers must run the comparison during release preparation. The check does not create a repository, commit, push, release, or update any registry.

Release preparation must also review documentation, dependency pins, tests, catalogue metadata, and diagnostic wording. When only unrelated client functionality changes, the MCP snapshot can retain its last-change baseline version; its source must still pass the synchronization check. Registry package versions are updated separately after the matching client version is available.

Every public source update and client release requires maintainer approval. No automatic publication is configured in this repository.
