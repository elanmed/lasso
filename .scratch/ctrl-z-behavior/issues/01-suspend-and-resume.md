# Restore normal Ctrl-Z suspend/resume behavior

Status: ready-for-agent

## Problem

In an interactive terminal, pressing Ctrl-Z while using lasso prints `^Z` instead of suspending the app.

## Expected behavior

In terminals with job control, Ctrl-Z suspends lasso and returns control to the shell. Running `fg` resumes lasso, restores normal terminal input, and allows the session to continue. Ctrl-Z should not be inserted into or printed as user input.

## Acceptance criteria

- Ctrl-Z suspends lasso in an interactive terminal with job control.
- The shell regains control, and `fg` resumes the existing lasso session.
- After resuming, terminal settings are restored and keyboard input works normally.
- Add automated coverage for the relevant input/signal behavior and verify suspend/resume in a real terminal.
