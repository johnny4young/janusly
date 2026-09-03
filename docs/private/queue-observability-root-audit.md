# `queue-observability-root` selective-port audit

This is the immutable decision record for the branch review requested before
Janusly can be considered ready for a direct, locally qualified integration
into `main`.

- Merge base: `cc643044a1a28c4af57d8ca8ae356f439c37b5ec`
- Audited source head: `a0619c8b460940bd01665573ca844a1267f1d070`
- Source commits: **75**, in `git rev-list --reverse` order
- Target: `develop`
- Audit date: 2026-08-31

No source commit was merged or cherry-picked wholesale. A **ported
selectively** result means its useful invariant was reimplemented or adapted to
the current single-binary, PostgreSQL-queue, contract-first architecture. An
**already equivalent** result means `develop` already has the behavior or a
stronger version. **Replaced** means a newer implementation solves the product
need through a different architecture. **Discarded** records an explicit reason
not to import the change.

## Outcome summary

| Classification | Count |
| --- | ---: |
| Already equivalent | 14 |
| Ported selectively | 32 |
| Replaced | 19 |
| Discarded | 10 |
| **Total** | **75** |

## Commit-by-commit decisions

| # | Source commit | Subject | Classification | Develop evidence or decision |
| ---: | --- | --- | --- | --- |
| 1 | `651f9849e033277bfb6657642bc79b64bf8beae6` | Queue columns | Ported selectively | `815c04d1` keeps durable eligible-at FIFO claims and the required hot indexes without importing named lanes. |
| 2 | `903080b46c2b812ec9cc006e2cca7747f7203e7e` | Queue wait and loop liveness | Ported selectively | `f4a37650` adds durable eligibility-aware queue wait plus bounded liveness, duration, and failure metrics for every supervised loop. |
| 3 | `d44b674b1463c8926ab2554d6886efc62838aa5f` | Authorization lookup cache | Replaced | The centralized request auth context carries `MembershipRole`, so built-in checks reuse the resolved membership. A cross-request TTL authorization cache was rejected because revocation must take effect immediately. |
| 4 | `0cc234d3efc56eceea628ca68fc015fda4825c05` | Unified operator view | Replaced | `/v1/operations/brief` is now the deterministic shared UI/MCP ranking model; current alerts remain executable-level contracts instead of consuming the old dashboard projection. |
| 5 | `f800b3b2e88dd5a49f5511de5686940d2ea0e561` | Sweep never-ran uptime guard | Already equivalent | `JanuslySweepNeverRan` is guarded by process uptime and is covered by Prometheus rule validation. |
| 6 | `6af6d2e30de3279a064820c7c0ed1a89271193d3` | Broad rig-name cleanup | Discarded | It is naming-only churn across unrelated files; “harness” remains the conventional name for executable test fixtures and is not user-facing product terminology. |
| 7 | `d23d37f1594e4a958aef848903e12e13ecd11ee2` | Empty dashboard panels | Ported selectively | `e3b9ac25` binds every panel and alert expression to metric families emitted by the exact executable and checks them against a real scrape. |
| 8 | `2b2da5800110d361f1abc858130f3fdb9783d4bf` | Seed schedule key | Already equivalent | `137f84da` and the current seed use the canonical `cronExpression` contract key. |
| 9 | `c9abc0af26ea69e3d723a7240ee4986d019d3e56` | Nonexistent metric references | Ported selectively | `e3b9ac25` removes nonexistent families, corrects units, and ratchets dashboard/alert references against the runtime scrape. |
| 10 | `ec1778170cbdf78e36d9cea55218ebbb1e63223e` | Resting queue UI state | Ported selectively | `91381600` distinguishes empty/healthy, degraded, and unavailable operator states instead of treating an idle system as an outage. |
| 11 | `248f2d132a549d56f9d6141f0d3cb696ba303798` | Module-map lint | Ported selectively | `556096a0` enforces the current Go dependency arrows with `depguard`, including pure grammar/domain and generated-store boundaries. |
| 12 | `a582cbec97322b740505171f277cd6fa2a820cb5` | Alert delivery | Ported selectively | `1a944454` adds digest-pinned Alertmanager routing, inhibition, scrape coverage, validators, and a real local webhook delivery proof. |
| 13 | `22036420f1acea7aa87cbb565d2eb6a9c1ad74ff` | Named queue lanes | Discarded | Named lanes add a product scheduling policy without a proven service contract. Current architecture retains fair durable FIFO and requires load evidence before adding priority policy. |
| 14 | `be8111213867e0d4b7f6b056f7c3739e627d79c8` | Per-lane telemetry | Discarded | It is coupled to the rejected named-lane model; current queue telemetry is tenant-safe and eligibility-aware without a lane label. |
| 15 | `956c6fdebfa9cbea8a5cba01a59d02edeba4f812` | Per-lane UI | Discarded | It exposes a scheduling abstraction Janusly does not adopt and would create UI/contract debt without a supported runtime policy. |
| 16 | `997236367e5b0b6f8c6ed5d889b0346fe540546a` | Health score animation | Ported selectively | `91381600` guarantees reduced-motion and frame-less rendering converge to the exact score while keeping arc and digits synchronized. |
| 17 | `939fd384d07c6892c4be24fcbca74915d38b74ee` | Recovery case focus | Ported selectively | `91381600` makes the selected Activity detail visible and focused; the later Assurance UX preserves deterministic focus in the governed case flow. |
| 18 | `f9da6d699bb8b006d71783c289ce592712995142` | AI chat empty response | Ported selectively | `91381600` validates the real explanation field and prevents paid calls from rendering an empty state. Provider-free fallback remains authoritative. |
| 19 | `5264ce9bb04930d3ffc66c2651f2e25313486eee` | MCP env-secret namespace | Ported selectively | `3e5d0edc` and the credential store reserve platform environment namespaces and reject unsafe references. |
| 20 | `c68032d2b4b58e66fe95d7bef58c45c321efea0c` | Lane seeding repairs | Discarded | This only repairs replay/fix seeding for the rejected named-lane architecture; current runs use the one durable queue contract. |
| 21 | `7d404b1fcb74c79fc5a03fbc78b62a7256e44e09` | Zero HTTP timeout | Ported selectively | `3e5d0edc` validates bounded outbound timeout inputs so zero cannot silently remove the deadline. |
| 22 | `bc449a22ab0f9d93d66be30480ecb285e21bb1b1` | Failure sampling full scan | Ported selectively | `8dd145cf` uses two sargable branches and an exact hot-plan assertion on `run_nodes_failed_finished_idx`. |
| 23 | `87c68828645a51197dc56e27c0513304fcf5c3e2` | Cross-workspace canvas state | Ported selectively | `91381600` clears the canvas and undo history on identity or workspace change and fences in-flight draft responses. |
| 24 | `bd6629d55f4ab21466541a88171a4f3583643f1a` | WorkOS environment name | Already equivalent | `.env.example` uses the exact `JANUSLY_SSO_CALLBACK_URL` and `JANUSLY_WEB_BASE_URL` runtime names. |
| 25 | `ff975828dd4c93be324ba1cd07feea24117ca556` | Workflow tag mutation | Ported selectively | `7c93d4ed` aligns replace-all and bulk tag bodies, validates explicit arrays, and reads the real affected count. |
| 26 | `f99cb198ed15720744f19718403aed6159c0696b` | Built-in role grants | Ported selectively | `6c7cc9a0` reports sorted effective built-in permissions, preserves virtual roles, and covers PostgreSQL plus UI behavior. |
| 27 | `d844d526c7f80107b1620cf0e3fbfe736c55707a` | Catalog regrouping | Discarded | It only reshuffles localization files after a script and changes no runtime, UX, or contract behavior. |
| 28 | `77f65d0e604512bf1c921178c02fedd64139ad7c` | Phantom-route check | Ported selectively | `67bf6d2d` plus `3021bcc0` statically resolve React calls against mounted Go routes and Vite proxy behavior; contract/auth parity tests cover registered versioned routes. |
| 29 | `e6468fd4e2ea1c1bdff9e5450102bfb8b861cf0b` | Unknown request fields | Ported selectively | `3e5d0edc` centralizes strict JSON decoding so handlers reject fields they do not consume. |
| 30 | `a657c6a740566aa6b4b0962d7ddb066d280087c9` | Run cancel contract | Ported selectively | `3e5d0edc` aligns the browser and handler request shape; cancellation is also a guarded terminal transition. |
| 31 | `4d06b8f5e13288e9f93c0bb6c7645d75077a4d28` | MCP connection routes | Already equivalent | Connection list/create/update/delete, rediscovery, tool discovery, and tool-toggle routes are mounted and present in the central authorization registry. |
| 32 | `1fbce28d9f78de257e2623756aa3e90a6956ac19` | Workflow SLO persistence | Already equivalent | `POST /workflows/{workflowId}/slo` persists the closed SLO shape with authorization and audit coverage. |
| 33 | `523d5e164a2bc799875a9a2d9f706dcf321c4baf` | Report and recovery routes | Ported selectively | Value-dashboard export and recovery occurrences are mounted; the unsafe phantom semantic resolve action was replaced by the governed cycle in `3f3f926f`. |
| 34 | `fd806828a388c249d07268e88ab03d7d285b6919` | E2E seeding path | Replaced | `scripts/test-e2e.sh` seeds through the running public API and isolated runtime, never through the Node-era database. |
| 35 | `3415dcf81613e29f47c7706d40ff35fc75619398` | Always run full browser suite | Replaced | Janusly separates hermetic default browser coverage from the explicit `make test-e2e-full` lane; importing a stale always-full runner would undermine bounded local qualification. |
| 36 | `63713f5792ff0437bf7c3682e2335a5ebfc49f12` | Stale E2E selectors | Ported selectively | `ffe85a82` fixes known dead selectors and adds a zero-baseline selector ratchet with focused exceptions. |
| 37 | `2ecf5c567c64c73c1482d631696a221a6976be21` | Container-reachable fixtures | Already equivalent | Current E2E scripts bind upstream fixtures on container-reachable addresses and pass explicit host URLs. |
| 38 | `be71df5daba34b2bd289fb97f6f29075152a2195` | Template environment access | Ported selectively | `3e5d0edc` keeps templates inside the safe context and blocks platform environment reads. |
| 39 | `6296a30f2e214bbf7f43af3548818f519cdab9c4` | Collector metrics reachability | Ported selectively | `63559a3b` binds the internal listener on the private container interface while retaining loopback-only host publication and a static Compose ratchet. |
| 40 | `5e20b8f03cc63d57e94686ca2fc174fd16ab0164` | Managed credential availability | Already equivalent | API and UI expose `managedStorageAvailable` and suppress managed-secret affordances when no root key exists. |
| 41 | `e97115aedf38010ad64375e11d89e4d2ad4423e5` | Credential and memory E2E | Ported selectively | Existing E2E covers the surfaces; `63559a3b` closes missing memory env forwarding and `b21ee95e` qualifies bounded feedback-memory behavior. |
| 42 | `05074906ae922f76b3fd754d7b3f694ac790eff8` | Router/manifest parity | Already equivalent | `contractparity_test.go` fails when mounted `/v1` routes and the central manifest diverge. |
| 43 | `cede1748ed5b8a5f6583fb8fa408056763d2fe09` | Generated web response types | Already equivalent | Current critical `/v1` clients consume generated OpenAPI types rather than handwritten response guesses. |
| 44 | `57c12578b1059f7428316ab564a1be265be5aa6e` | Generate frontend contract | Already equivalent | `make generate` invokes the frontend contract generator and the drift gate checks its output. |
| 45 | `7ca51e3419a2d1b1400e1f03f0a5a5ac87788daa` | Inferred same-origin browser schema | Replaced | Janusly uses explicit public `/v1` OpenAPI plus route, auth, and manifest parity. The 1.1 MB inferred legacy-browser schema is not imported; legacy unversioned typing remains incremental and is not claimed as complete. |
| 46 | `823d2b79c76a381c76090f32cc263be48931bba8` | Dual-wire mount helper | Replaced | The central authorization registry plus real ServeMux parity is the enforcement boundary; duplicating mount declarations would create another source of truth. |
| 47 | `4de1244ba387bc01d99579592cf25341d7596263` | Infer 69 browser routes | Replaced | Critical Assurance APIs are explicit contract-first routes; old bulk inference is intentionally not carried forward. |
| 48 | `2d9934fc139e55baa25fd7ed5053515612524873` | Type-check inferred shapes | Replaced | Generated OpenAPI types cover the supported versioned contract, while static route parity guards legacy calls without pretending inferred shapes are authoritative. |
| 49 | `2e6b99912b7b569717e462318a608a6ec687788b` | Closure-aware shape inference | Replaced | The same explicit contract strategy supersedes this compiler-analysis machinery and avoids a second browser-only schema. |
| 50 | `4951f5df8aeaaabef16cd940a1fa4503887d5c3e` | Memory and web hardening bundle | Replaced | `3f3f926f`, `b52ea852`, and current memory security split the work into governed Assurance artifacts, bounded UI states, and consented provider-safe persistence. |
| 51 | `324b9f18e4176b92308eb60b50cfc095ab7cb9f8` | Exact-head qualification runner | Already equivalent | Current local qualification records exact commit/tree provenance and refuses dirty or mismatched candidate evidence. |
| 52 | `e1b93923be9633c5ca770a8febcd7713990a7e5e` | Semantic recovery resolution | Ported selectively | `3f3f926f` carries the semantic core into append-only artifacts, immutable candidates, exact validation, one-use approval grants, apply, and verification. |
| 53 | `327e9c4c6c044c639fd1c0eff3aaa2ac9cd649c6` | Isolated local profiles | Already equivalent | Qualification profiles own unique Compose projects, explicit reset confirmation, isolated ports, schema, evidence, and cleanup. |
| 54 | `b81561c148838df59f948d6a5cd6c7bff514095a` | Recovery and soak profiles | Ported selectively | Current recovery/load profiles preserve the bounded intent; `45f6a1fc` adds per-phase queue snapshot availability and blackout gates. |
| 55 | `9032bd31da22e151da141ee7e05570883374c037` | Bulk inferred recovery contract | Replaced | Governed recovery endpoints are explicit `/v1` contracts with generated types and adversarial tests, not inferred from legacy handler bodies. |
| 56 | `ad7d91f2dcdf83c9ab798f0f4449d6bc20c79c11` | Bulk inferred workflow contract | Replaced | Authoring brief, capabilities, proposals, readiness, and save boundaries are explicit contract-first surfaces; legacy routes remain behind route/auth parity. |
| 57 | `4300df00f87b6a2445c7786d397ea0861358eb5d` | Bulk inferred admin contract | Replaced | Owner/admin/RBAC critical journeys use explicit contracts and integration coverage without importing the obsolete browser-schema generator. |
| 58 | `7ee90bfd4c2fd7ee4c9ce0eddb6979ec648d1aed` | Scalable tenant search | Ported selectively | `c3a9fb8c` provides one Unicode boundary, literal escaping, two partial trigram indexes, 100k-row plan evidence, tenant isolation, and EN/ES E2E. |
| 59 | `9ec2ff588b95a37c4a513e17853ebfc70a315e2a` | Reversible embedding lifecycle | Discarded | This expands schema and product policy far beyond Workflow Assurance. Current consent, retention, purge, and durable run-summary lifecycle remain the supported boundary. |
| 60 | `dfeb5b9eab718a1f46094899bf2d021d1beed060` | Local embedding model qualification | Discarded | Shipping a multi-model embedding corpus is a separate product/ops commitment; it is not required for provider-free Assurance and would add large model assets to the gate. |
| 61 | `5f90bfc7d39f001cde3d973e8711ddb9bbb44cc7` | Bounded feedback memory | Ported selectively | `b21ee95e` adapts the bounded worker/queue/deadline model, adds scheduler-safe race tests, isolated saturation integration, metrics, safe logs, and pre-pool shutdown draining. |
| 62 | `a0ec153890bc539c67873bb90b9585c50c2f699e` | Percentage coverage floor | Discarded | A global percentage is easy to game and does not prove actor/tenant/state transitions; Janusly gates behavior, contracts, qualification journeys, race tests, and adversarial cases instead. |
| 63 | `29aa95dbfd5c01b0a2ea91bdcba1f7ed8f9f5e8b` | Recovery surface refactor | Replaced | `b52ea852` implements the governed Assurance case workspace with semantic primitives and zero legacy-control references. |
| 64 | `383d0e55e22774525422bc5c875ee118886227b1` | Operational surface refactor | Replaced | `b52ea852` and the Operator Brief centralize loading, empty, degraded, error, permission, and recommendation states without importing the older component split. |
| 65 | `61fd6cd50989988e93ad6c4e93fa0edb4f97eddd` | Recovery decision clarity | Replaced | The current candidate comparison, validation, explicit approval, apply, monitoring, and verification sequence is the authoritative decision UX. |
| 66 | `8ac382e2b47223952ff6f35f4ed8825ef0c67a52` | Real-provider gate | Replaced | `133c8e66` defines the stronger 20-case EN/ES Assurance evaluation with 40-call/USD 3 breakers, no retries, bounded envelopes, hallucination checks, and provider-free twins. Execution evidence is still a later gate. |
| 67 | `1a2c1f777ce69a7de87de7d563cbc0d024bfe460` | Broad async typing rewrite | Replaced | Current strict TypeScript, Oxlint, targeted abort/fencing fixes, and browser tests address observed races without importing stale broad UI churn. |
| 68 | `2090990dd43602181be111546a63185bfc051e1a` | Recovery and alert hardening bundle | Ported selectively | Current recovery artifacts, one-use grants, outbox/alert hardening, security boundaries, and observability commits carry the applicable invariants in smaller reviewed slices. |
| 69 | `94a66ba6db49dc146b1f3a3f576fc5e3638214f1` | Tenant access and policy UX | Replaced | Durable organization owners, delegated admins, effective role grants, and modern Access/Settings surfaces form the supported tenant-scoped authority model. |
| 70 | `19aeec6d5a29134234ba1ebb1052b8b91c7caf97` | Global platform administration | Discarded | A separate support/platform-admin control plane expands production authority beyond the approved owner-scoped Assurance goal and is not required for super-admin organization delegation. |
| 71 | `0343f6361170764b69d354d66b2bac69dd0c6042` | Platform overlay focus | Ported selectively | `b051d808` ports the applicable account-menu Escape/focus restoration. Platform-console overlay changes are inapplicable because that control plane was not adopted. |
| 72 | `2b63da514aad3c1d51f86f16896ded0994907c6b` | Viewer member visibility | Already equivalent | Viewers can load the organization member list while mutation controls remain permission-gated. |
| 73 | `273e63c5e18c238adae7b4d5c179168de48816bd` | Search qualification parents | Ported selectively | `c3a9fb8c` seeds valid workflow/run parents before its large tenant-search and executable browser qualification. |
| 74 | `bb1631764c0d413370ab93b14f0f27e01e4e7005` | Member-panel request reduction | Already equivalent | The current panel does not issue the pending-invitation request for read-only viewers. A future pending-invitation UI is a separate product gap, not a reason to restore this fetch. |
| 75 | `a0619c8b460940bd01665573ca844a1267f1d070` | Queue probe availability | Ported selectively | `45f6a1fc` probes every warmup/measured phase, distinguishes `queue:null`, fails malformed transport, and gates 99.5% availability plus a six-probe blackout ceiling. |

## Architectural conclusions

1. The branch's valuable queue, observability, security, search, and semantic
   recovery invariants are now present as reviewed slices on `develop`.
2. Named queue lanes, global platform administration, and the large inferred
   browser schema were consciously rejected because they add unsupported
   product or authority models rather than closing the approved Assurance loop.
3. Static route parity prevents phantom React endpoints today, but legacy
   unversioned response typing is still incremental. Only the explicit `/v1`
   contract and generated clients should be described as contract-complete.
4. This audit proves disposition of the 75 commits; it is not final runtime,
   provider, visual, performance, load, or production certification.
