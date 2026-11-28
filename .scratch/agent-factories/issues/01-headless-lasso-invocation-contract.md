# Headless Lasso invocation contract

Type: grilling
Status: resolved

## Question

What contract should a bash-script Worker use to invoke headless Lasso for its assigned task, including task input, session continuity, completion signaling, and final output? The repository currently has an interactive CLI entry point; the agreed direction is a separate Lasso session per Worker, with task input on stdin and normal Lasso configuration.

## Answer

A bash-script Worker starts one separate headless Lasso session with its task prompt on stdin. The session remains active, polling Jenkins and the shared channel on a 30-second loop; when Jenkins indicates work is needed, it broadcasts to the channel and checks for replies. The Worker does not stop itself: the main Agent can explicitly stop it, and the parent Lasso process cleans it up on exit.
