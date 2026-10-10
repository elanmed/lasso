# Lasso Bug Hunt Report

5. Base64 image data in tool results. `getApproxTokensFromMessages` only filters top-level `image` and `file` parts, but `read_image` results are nested in `tool-result` output. If the SDK stores that shape, approximate counts balloon when the token cache is dirty, and compaction JSON-stringifies the base64 into the summary prompt. Check by reading an image, then `/resume` and `/tokens`.

6. Lock stealing race. `overwriteLockFile` unlinks without re-checking the content, so two processes that both see a dead PID can each delete the other's fresh lock. Low likelihood.
