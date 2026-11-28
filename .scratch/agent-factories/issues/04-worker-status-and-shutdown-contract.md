# Worker status and shutdown contract

Type: grilling
Blocked by: 03

## Question

Given the agreed read-only status and separate stop operation, what exact lifecycle states and output limits should status expose for exit code and captured stdout/stderr? Resolve unexpected child-process exits and ensure stopping is graceful first, then forceful; Workers are cleaned up when the parent exits, and failures are not automatically retried.
