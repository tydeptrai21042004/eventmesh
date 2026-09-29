# Market Gap and Validation Plan

_Last reviewed: 2026-09-29._

## 1. The narrow pain EventMesh should own

A payment rail can tell two parties that value moved. It does not automatically tell two independently operated applications **which business state both sides accepted** when a response disappears, one process restarts, an event is replayed, or local records conflict.

The target failure is:

```text
Fiber payment: Paid
Operator A: service completed
Operator B: state uncertain / response lost
```

Without an explicit bilateral evidence layer, teams commonly fall back to one operator's database, ad-hoc webhook/idempotency conventions, or manual support reconciliation. Those approaches may be sufficient in many ordinary client/server products; EventMesh is only justified where **independent operators do not want one side's database to be authoritative and later verification matters**.

## 2. Who should be interviewed first

Do not market to "all Web3 apps". Test the problem with builders who already have at least two of these characteristics:

- two separately operated services, devices, games, agents, or providers;
- repeated or stateful interactions rather than a one-shot checkout;
- Fiber payment or CKB/UDT value involved in the session;
- retries/restarts/partial failures that can leave local records inconsistent;
- a reason to retain evidence that a third party can verify later.

Good first interview/integration targets are existing CKB/Fiber application teams, not another EventMesh-owned demo.

## 3. The ecosystem evidence is promising but not yet market proof

The public August 2026 report **"AI, machine payments, and Fiber in 2026: an opportunity map for CKB and Fiber developers"** classifies **CGE — cross-operator game/device events** as a *frontier hypothesis*. It explicitly notes that technical demos exist while the user/trust model and market evidence are still early.

That supports a validation grant, not a large-market claim.

Source:
- https://talk.nervos.org/t/ai-machine-payments-and-fiber-in-2026-an-opportunity-map-for-ckb-and-fiber-developers/10665

## 4. Why this should not overlap existing projects

| Neighbor | Existing responsibility | EventMesh boundary |
| --- | --- | --- |
| Fiber | channels, routing, invoices, payment lifecycle, recovery | mutually accepted **application** events/state above the payment rail |
| Clasp | scoped/revocable application authority over a Fiber wallet, spending limits, policy/replay checks | operator-to-operator application reconciliation; no wallet authority |
| FiberLatch Access | after a host already trusts a payment/business decision, issue/verify/redeem signed access receipts | no access token/resource redemption; reconcile the bilateral event that may precede such a receipt |
| Myelin | off-chain CKB-style execution/session runtime, state transitions, finality/dispute evidence | no VM/runtime/finality/court; only signed application evidence and explicit counterparty acceptance |
| generic event bus | delivery/routing/pub-sub | no routing fabric; bilateral signed evidence for one session |

Public references:

- Fiber: https://github.com/nervosnetwork/fiber
- Clasp: https://github.com/Enoch208/Clasp
- FiberLatch Access: https://talk.nervos.org/t/dis-fiberlatch-access-open-source-access-control-for-fiber-payments/10414
- Myelin: https://talk.nervos.org/t/introducing-myelin-a-ckb-aligned-off-chain-cell-session-runtime/10498

## 5. Why differentiation must be explicit in a Spark proposal

Spark has publicly rejected projects when the committee judged the proposed value to be redundant with established ecosystem tools. Two useful examples are:

- CellKit Actions, rejected as redundant/insufficiently differentiated from CCC: https://talk.nervos.org/t/spark-program-cellkit-actions-reusable-transaction-actions-for-ckb-apps/10375
- CKB NFT Marketplace, rejected because an existing platform already covered the category: https://talk.nervos.org/t/spark-program-ckb-nft-marketplace-on-chain-digital-object-trading-platform/10544

The proposal should therefore answer in one paragraph:

> Fiber proves payment state; Clasp controls wallet authority; FiberLatch controls post-payment access; Myelin executes/finalizes off-chain CKB-like state. EventMesh does none of those. It tests whether two independently operated Fiber applications need a small reconciliation proof for the exact business events and payment-linked state they mutually accepted.

## 6. Validation hypothesis

### Primary hypothesis

At least one independent CKB/Fiber application can integrate a 3–5-event EventMesh adapter and use it to recover from a real retry/restart boundary without treating either operator's database as the unilateral source of truth.

### Strong evidence

The funded experiment should produce all of the following:

1. an integration PR/commit in a repository not maintained as part of EventMesh;
2. two operator deployments with different keys, databases, and FNNs;
3. one real Fiber Testnet payment;
4. a receiver restart or lost-response scenario between payment and application settlement acknowledgement;
5. recovery without manual database editing;
6. exactly one accepted payment-linked application transition after retry;
7. a dual-signed close;
8. a committed CKB Testnet checkpoint;
9. a fresh-machine standalone verification;
10. structured adopter feedback describing whether the mechanism solved a real operational concern.

## 7. Interview questions

Keep interviews concrete. Avoid leading with protocol terminology.

1. Have you had duplicate/replayed application actions after timeout or retry?
2. What happens if payment succeeds but your application response is lost?
3. If two separately operated services disagree about session state, which database is authoritative today?
4. Do you retain enough evidence to determine which exact business action both sides accepted?
5. Would an explicit signed ACK between operators simplify recovery, or would normal idempotency/webhooks be enough?
6. When would third-party-verifiable evidence matter to you?
7. Would you accept a 3–5-event adapter integration? What integration cost is too high?
8. Does the CKB checkpoint add useful durability/audit value, or is the dual-signed transcript alone enough?

Record negative answers too.

## 8. Decision / kill criteria

The experiment should be allowed to falsify the thesis.

### Continue if

- an independent adopter can describe a real state-mismatch/recovery problem;
- the adapter materially reduces ambiguity during the failure test;
- integration remains small and does not require EventMesh to own payment authorization, application execution, or arbitration;
- independent verification is useful enough to justify keeping the CKB proof path.

### Narrow or stop if

- builders consistently say standard idempotency + one trusted backend already solves the problem;
- no independent application will integrate even a small adapter;
- CKB anchoring adds no practical verification value for the target users;
- the only convincing use cases require EventMesh to become an escrow/runtime/wallet product already covered elsewhere.

A negative result is still useful Spark output because the opportunity map itself says the user/trust model needs evidence.

## 9. Metrics to publish

Do not report only unit-test counts.

| Metric | What to publish |
| --- | --- |
| duplicate business transitions after replay | expected 0 |
| duplicate payment-hash acceptance | expected 0 |
| manual DB edits during restart recovery | expected 0 |
| recovery attempts / elapsed time | measured result |
| conflicting evidence overwritten | expected 0 |
| external adapter integration size | files/LOC/functions changed |
| transcript size | measured bytes |
| CKB commitment size/capacity | measured value |
| standalone verifier result | terminal output + command |
| adopter feedback | problem confirmed / not confirmed + reason |

## 10. Branding risk to resolve

"EventMesh" is also the name of the established Apache EventMesh cloud-native eventing project. The current protocol strings can remain stable for testnet compatibility, but the public product should adopt a distinctive name before broad distribution so search results, package identity, and positioning are not confused with Apache EventMesh.
