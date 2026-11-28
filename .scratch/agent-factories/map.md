## Destination

A working, local Lasso capability where a main Agent launches and supervises asynchronous bash-script Workers that run headless Lasso in separate sessions. Workers can coordinate through a durable shared channel; the parent can inspect status, stop Workers, and clean them up on exit.

## Notes

Domain: Lasso. Consult `codebase-design` for module boundaries and `domain-modeling` when concepts change. This effort includes implementation; this charting session only plans. Workers run locally, inherit the parent process's working directory and environment, and use standard Lasso configuration and tools. Jenkins polling is an example workload, not part of this effort.

## Decisions so far

- [Headless Lasso invocation contract](issues/01-headless-lasso-invocation-contract.md): Workers run a persistent headless Lasso session, polling until explicitly stopped or cleaned up with the parent.

## Not yet specified

- Channel message identity, ordering, reading/cursors, and error behavior.
- Process-tree supervision and recovery details; resource limits and retention for Worker output and channel history.
- How parallel Workers coordinate changes in their shared working directory.
- The implementation sequence and acceptance criteria after the remaining decisions are settled.

## Out of scope

- Jenkins-specific polling or integration; it was only an example workload.
