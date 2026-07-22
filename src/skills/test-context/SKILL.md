---
name: test-context
description: Generate focused code inside existing tests and test fixtures. Use for test, spec, fixture, mock, stub, assertion, expectation, regression, property, integration-test, or test-file markers.
---

# Test Context

- Follow the detected test framework, fixture lifecycle, naming, assertion style, and async convention.
- Test observable behavior through the public/local contract rather than duplicating implementation logic.
- Keep setup minimal and deterministic; isolate time, randomness, network, filesystem, and global state using existing project helpers.
- Assert the requested normal case plus only the boundary/failure cases implied by the instruction.
- Make mocks match real signatures and behavior relevant to the test. Do not mock the unit under test.
- Clean up patched globals, timers, resources, and temporary artifacts.
- Never weaken or delete an assertion merely to make generated production code pass.

For a regression marker, ensure the test fails for the described defect and passes for the corrected behavior.
