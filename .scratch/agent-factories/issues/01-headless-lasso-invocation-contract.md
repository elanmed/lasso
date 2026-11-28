# Headless Lasso invocation contract

Type: grilling

## Question

What contract should a bash-script Worker use to invoke headless Lasso for its assigned task, including task input, session continuity, completion signaling, and final output? The repository currently has an interactive CLI entry point; the agreed direction is a separate Lasso session per Worker, with task input on stdin and normal Lasso configuration.
