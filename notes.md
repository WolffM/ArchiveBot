## Steps to reproduce
1. Install dependencies with `npm install`.
2. Run only the helper test file with `npm test -- tests/helper.test.js --runInBand`.
3. Observe the new test `preserves task arrays instead of converting them to keyed objects`.
4. The test calls `helper.scrubEmptyFields()` with an array of task objects and checks that the result stays an array.

## Observed
The test fails because the function returns an object with numeric keys (`{ "0": {...}, "1": {...} }`) instead of returning an array. This effectively scrubs or reshapes task collections into a non-array structure. Any downstream logic that expects array behavior (length checks, array iteration methods, or schema assumptions) can break or behave unexpectedly.

## Expected
`scrubEmptyFields()` should preserve input arrays as arrays while still recursively removing null/undefined/empty fields from each task entry. A list of tasks should remain a list of tasks after scrubbing, not be converted into an object keyed by indexes.
