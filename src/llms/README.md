# LLM adapters

This folder owns model-provider boundaries: the provider-neutral contract,
OpenAI and Ollama adapters, structured-output schemas, and certification.

A workflow may ask this layer for a completion, but this layer does not discover
files, choose a workflow, or write generated code. For example, when the CLI is
configured for Ollama, `adapters.ts` converts the same typed request used for
OpenAI into Ollama's HTTP shape and returns plain model output to the workflow.

Import the folder through `index.ts` when several LLM exports are needed.
