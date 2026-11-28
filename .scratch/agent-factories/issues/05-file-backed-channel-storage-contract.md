# File-backed channel storage contract

Type: grilling
Blocked by: 02

## Question

How should the shared channel be represented and updated in local files using the repository's existing lockfile utilities? Resolve the file layout and atomic read/write behavior needed for durable concurrent message access, including recovery from malformed or partial data.
