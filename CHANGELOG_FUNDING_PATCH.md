# Funding-readiness patch v0.1.1

Implemented: signature domains; immutable session/event/ACK/close evidence; conflict/equivocation records; strict payment claim schema; receiver-side Fiber `Paid` verification; payment-hash reuse protection; final-state/payment-set close binding; CKB `committed` + exact-data verification; standalone verifier hardening; admin/public-mode/SSRF controls; CI/env templates; funding and verification documentation.

Validation note: this environment did not have project npm dependencies available, so the full Vitest/TypeScript runtime suite was not executed here. Run `npm install && npm run typecheck && npm test && npm run build` before tagging or submitting public proof. Real Fiber/CKB Testnet evidence is explicitly a funding milestone, not claimed as completed by this patch.
