# Workflow deployments

Workflow versions may be assigned as baseline or canary candidates. Assignment
is deterministic and stored on each run and inbound event.

Automatic outcome handling uses terminal receipts and minimum sample gates.
Validation runs, recovery replay, and explicitly pinned subworkflows do not
consume canary traffic. Version writes and deployment updates use durable locks
so a run always records the exact evaluator and version pair used.

Rollback changes future assignment; it never rewrites existing run history.
