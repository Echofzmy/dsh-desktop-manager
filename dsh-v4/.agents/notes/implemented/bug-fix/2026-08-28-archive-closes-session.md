# Archive Closes Sessions Before Permanent Deletion

## Decision

Archiving a session is a lifecycle transition, not only a list filter. After the durable archive commit, each Web runtime releases an owned live session handle it observes. Permanent deletion rejects running sessions, but an archived idle session may be deleted while an external runtime finishes releasing its lifecycle state.

## Reason

Users understand closing and archiving a session as ending its use. Requiring them to identify and stop an invisible Web runtime exposed an implementation ownership detail and made the archive flow unusable. Running sessions remain protected because deleting their durable log could race with new writes.

## Verification

Host workspace tests, GUI tests, typecheck, and replayed Web tests cover the transition. The replay lane passed 84 files, 285 tests, with 15 skipped.
