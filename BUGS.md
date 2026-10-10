# Lasso Bug Hunt Report

6. Lock stealing race. `overwriteLockFile` unlinks without re-checking the content, so two processes that both see a dead PID can each delete the other's fresh lock. Low likelihood.
