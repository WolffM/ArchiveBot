## Steps to reproduce
1. Run `npm test -- --runInBand tests/tasklist.test.js` from the repository root.
2. Observe the reproduction test named `issue reproduction: scrubbed task`.
3. The test invokes `tasklist.handleSlashCommand()` with a `/done` interaction that provides a plain text task description (`Fix deployment docs`) through the `name` option instead of numeric IDs.
4. Inspect the failing assertion and the error response emitted by the command handler.

## Observed
The `/done` handler treats the plain-text description as if it were an ID list and sends an error reply containing `No valid task IDs provided.`. This means a normal description string is rejected instead of being converted into a newly created completed task. The failing unit test captures this behavior by asserting that this error should not be produced for a plain-text description input.

## Expected
When `/done` receives a non-ID text description, it should behave as a create-and-complete flow for that task text (consistent with the command intent to complete existing tasks or create/complete a new one). The command should not reject plain-text descriptions with an ID parsing error, and should produce a successful completion-style response.
