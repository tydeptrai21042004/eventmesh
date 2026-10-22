# Evidence levels for reviewers

| Level | Proves | Does **not** prove |
|---|---|---|
| CI check | A given GitHub commit compiled and passed tests, typecheck, demo build on runner | No real Fiber payment or CKB settlement |
| Offline transcript | Signature/hash-chain/application-profile consistency of *provided* transcript | Operator's real-world identity, actual service truth, receiver's live invoice state, chain status |
| Receiver live Fiber proof | Receiver-controlled FNN query establishes matching paid invoice under specified trust assumptions | Objective correctness of service delivered |
| CKB live proof | A matching checkpoint is committed on CKB with specified confirmations | Enforced application agreement or arbitration |
| Controlled fault test | Observed recovery behavior for selected failure schedule and seed | Exhaustive distributed-systems correctness |
| Comparative experiment | Difference in guarantees and overhead versus same-workflow baselines | Universal demand or adoption |

Required manifest fields: repository, Git SHA, workflow URL, test configuration and seed, SHA-256 of logs, result, artifact source and verification scope. Never call a structural manifest check a cryptographic proof. Store keys/tokens only in protected secrets; redact business details before public release. Protect signed evidence from accidental corruption but do not remove context needed to independently verify it.
