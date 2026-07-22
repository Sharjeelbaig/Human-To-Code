# Memory

This folder builds the grounded information supplied to generation and repair:
safe source context, FileMemory, ProjectMemory, compiler knowledge, and cached
official documentation.

Memory describes the repository; it does not decide the run order or write
files. For example, before generating `src/server.ts`, ProjectMemory can show
the model the planned route name and a compact contract for a related client
without sending the entire repository.

Import the folder through `index.ts` when several memory exports are needed.
