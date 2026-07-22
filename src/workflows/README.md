# Workflows

This folder owns sequencing and run policy: conversion-unit types, shared
blueprints, per-unit todos, generation, repair, integration reconciliation,
receipts, planning artifacts, and run storage.

For example, a multi-file run may create one shared blueprint, generate each
target independently, request one bounded repair for a failing dependency
group, and then hand only accepted candidates to file operations.

Workflows may call memory, LLMs, prompts, and tools. Those lower-level folders
must not depend on a CLI command or silently start an end-to-end run.
