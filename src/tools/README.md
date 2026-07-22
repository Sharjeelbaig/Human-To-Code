# Tools

Tools are focused capabilities used by workflows. They are grouped by purpose:
discovery, static analysis, validation, security, and file operations.

For example, marker discovery can produce a conversion unit, validation can
prove its candidate is syntactically safe, and file operations can replace the
exact marker only if the source bytes are still current. The workflow decides
when those tools run and what happens after a failure.

Each subfolder has an `index.ts`; `tools/index.ts` combines them for callers
that need the complete tool surface.
