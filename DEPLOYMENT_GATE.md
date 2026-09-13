XOFT Core v0.8.1 Deployment Gate
Built from intact v0.8.0 source with dependency reproducibility fixes.

Validated in this environment:
- Archive extraction/integrity
- package.json/package-lock version alignment
- runtime dependency doctor (correctly blocks when deps are absent)
- JavaScript syntax checks
- focused computer-use + vision tests: 7/7

Not claimable in this offline environment:
- clean npm ci (registry/cache unavailable)
- full npm test (requires installed runtime dependencies)
- live provider/device E2E
