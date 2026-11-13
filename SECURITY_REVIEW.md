# Security review - backslide

Item-by-item pass over the pre-ship checklist, with evidence. Statuses: PASS
(checked, evidence below), N/A (the thing the item protects does not exist in
this project - stated explicitly, not skipped silently), TODO (must happen
before or right after publication).

Architecture context for every item below: backslide is a fully static site.
No backend, no database, no auth, no accounts, no cookies, no analytics, no
API keys, no forms, no uploads. The only network calls the page makes are
same-origin (its own files) and HTTPS model downloads from the pinned
Hugging Face hosts named in the CSP. The live probe keeps everything in page
memory; nothing persists.

## Pre-ship routine

1. **Read the diff** - PASS. All source (src/, scripts/, tests/, data/) was
   reviewed line by line; there is no generated or copied code outside
   docs/ort/ (vendored onnxruntime-web binaries, see docs/ort/VERSION) and
   the bundled docs/app.js, which is built from src/ and diff-checked in CI
   (browser-smoke job rebuilds docs/ from source and fails on any drift).
2. **gitleaks detect** - PASS. CI job `supply-chain` runs gitleaks 8.24.3
   (sha256-verified binary, full history - the hosted action breaks on
   root-commit ranges). The minified bundle can trip the generic-api-key
   rule on the tokenizer special-token name "unk_token"; vendored artifacts
   (docs/app.js, docs/ort/) are allowlisted in .gitleaks.toml. No keys exist
   anywhere in the project by design (no backends to key); a manual scan of
   src/, scripts/, tests/, README.md, data/ found no key/token/secret
   strings.
3. **Dependency audit** - PASS. `npm audit`: 0 vulnerabilities. Runtime
   dependency is @huggingface/transformers (pinned 4.3.2) with its
   onnxruntime-web dependency; esbuild/typescript are dev-only. CI reruns
   npm audit on every push.
4. **Static scan** - PASS. CI job `supply-chain` runs semgrep with the
   repo's own local rules (.github/semgrep-rules.yml, no account) over src/
   and scripts/ on every push. Local evidence: same command run before
   every push; the risky-pattern greps are also in tests/check-docs.sh.
5. **Logged-out test** - N/A. There is nothing to log in to. Every byte the
   site serves is public by design; probe state is per-tab memory.
6. **MDN Observatory scan** - N/A, verified by hand instead. Observatory
   scans hosts, not paths: scanning aditya2375.github.io returns 404
   because there is no user-level Pages site at the apex. Verified directly
   instead: `curl -sI https://aditya2375.github.io/backslide/` must return
   200 with strict-transport-security (GitHub Pages default for *.github.io,
   curl-verified on the sibling site 2026-11-13); Pages cannot send the
   remaining security headers, so CSP is delivered via <meta> (item 17) and
   confirmed present in the served live HTML after publication.
7. **Push public only after checks** - PASS (process). Nothing was pushed
   before this review, check-docs, unit tests, browser smoke (including the
   live probe, SMOKE_LIVE=1 in CI) and the snapshot-consistency gate all
   passed locally.

## Secrets and keys

8. **(1) No secret in code, config, bundle or history** - PASS. The project
   has no secrets to leak. CI runs gitleaks over full git history. GitHub
   secret scanning + push protection to be enabled on the repo at creation
   (free on public repos).
9. **(2) Keys meant to be public** - N/A. No keys of any kind ship. The only
   hash in the bundle is the model revision pin, a public identifier.
10. **(3) Gitignore secrets before first commit** - PASS. .gitignore covers
    .env*, *.keystore, *.jks, local.properties, *service-account*.json,
    node_modules/, dist/ and the local model cache (.cache/) since the first
    commit.
11. **(4) Rotate anything that ever leaked** - N/A. Nothing ever existed to
    leak.

## Access control and data

12. **(5) RLS on every table** - N/A. No database.
13. **(6) Storage buckets private by default** - N/A. No buckets; nothing
    persists outside the tab.
14. **(7) Authorization on the server** - N/A. No server, no per-user
    resources.
15. **(8) Collect less** - PASS. The site collects nothing: no analytics, no
    telemetry, no cookies. The golden set is the public GLUE SST-2
    validation split (movie-review sentences); scanned for email addresses,
    phone numbers and street addresses - none present. Demo content contains
    no personal data.

## Injection and input handling

16. **(9) No untrusted text into innerHTML/eval/DOM HTML** - PASS.
    tests/check-docs.sh greps src/web/ for innerHTML, outerHTML,
    insertAdjacentHTML and document.write and fails on any hit; all example,
    verdict, table and probe text renders through textContent/createElement.
    The browser smoke test (SMOKE_LIVE=1) includes a live XSS probe
    (`<img src=x onerror=...>` as probe input) and asserts it cannot
    execute. CSP has no unsafe-inline and no unsafe-eval (only
    'wasm-unsafe-eval' for ONNX).
17. **(10) Parameterized queries; no shell strings** - N/A. No SQL, no shell
    execution. JSON artifacts are fetched and JSON.parsed; every statistic
    the page shows is recomputed from data/golden.json in CI
    (snapshot-consistency job), so a hand-edited snapshot cannot pass.
18. **(11) Validate URLs and file paths** - PASS. The page fetches only two
    fixed relative data paths (data/golden.json, data/snapshot.json) plus
    Hugging Face model URLs allowed by CSP connect-src; no user input is
    ever turned into a fetch URL.

## Dependencies and supply chain

19. **(12) Every package exists and is the right one** - PASS. Dependencies
    are @huggingface/transformers, onnxruntime-web (transitive), esbuild,
    typescript - all long-established, verified on npmjs.com before install.
    package-lock.json pins exact versions and integrity hashes.
20. **(13) Commit lockfiles and audit** - PASS. package-lock.json is
    committed; npm audit is clean and runs in CI.
21. **(14) Treat AI config files as code** - PASS. The repo contains no
    AI-assistant instruction files of any kind. No code or README content
    was copied from external repos; everything here is written for this
    project.
22. **(15) Agents never get production access** - N/A. There is no
    production data or environment; the site is static and its data is
    public content.

## Config, transport and accounts

23. **(16) HTTPS only** - PASS. Pages serves the site over HTTPS with HSTS
    (curl-verified live after publication); "Enforce HTTPS" is on and
    non-disableable for the default aditya2375.github.io domain. The site
    itself makes no http:// requests (grep-verified).
24. **(17) Security headers** - PASS within Pages' limits. CSP via <meta>:
    default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src
    'self'; connect-src 'self' plus the pinned Hugging Face download hosts;
    img-src 'self' data:; worker-src 'self'; object-src 'none'; base-uri
    'none'; form-action 'none'. frame-ancestors cannot be set via meta
    (documented Pages limitation).
25. **(18) Debug off, errors quiet, source maps off** - PASS. esbuild runs
    with minify and no sourcemaps; no .map files ship in docs/. Errors
    surface as one-line messages in the probe status, not stack traces;
    nothing logs sensitive state (there is none).
26. **(19) Login provider, never homemade auth** - N/A. No auth anywhere.
27. **(20) Rate limits and abuse controls** - PASS (client-side). All
    statistics are precomputed at build time; the probe runs one bounded
    inference per submit and the button disables while busy. No public
    endpoint exists to abuse.
28. **(21) Fail closed and log the failure** - PASS. Missing or malformed
    artifacts surface as an explicit failure line in the page header, not a
    half-rendered demo; a failed model download leaves the measured evidence
    (the point of the site) fully functional; the promotion gate fails
    closed - it ships only when both conditions provably hold.
29. **(22) Two-factor on accounts** - N/A to this repo's code; account-level
    setting on GitHub is the owner's own checklist item and stays with them.

## Static sites, GitHub Pages and Vercel

30. **(23) Everything in the published folder is public** - PASS. docs/
    contains only the built site, vendored wasm, and the public golden-set /
    snapshot data (a public benchmark). Searched for phone, email, address,
    and personal names: none present. Git author identity is the owner's
    public GitHub noreply address only.
31. **(24) No client-side login or hidden admin page** - N/A. No login, no
    admin, no hidden routes.
32. **(25) Vercel secrets** - N/A. Hosted on GitHub Pages, not Vercel; and
    no secrets exist regardless.
33. **(26) Pin or self-host third-party scripts and fonts** - PASS. Zero CDN
    scripts, zero web fonts, zero external assets: app.js and the ONNX wasm
    are self-hosted in docs/; model weights download only from the pinned
    Hugging Face hosts at an exact content revision. system-ui font stack
    only.
34. **(27) Forms go to a service with spam protection** - N/A. No forms.
35. **(28) Delete old deployments** - N/A to this new repo; owner's standing
    account hygiene item.

## Android apps (items 29-36, 37-39)

36. **(29-39) APK, manifest, keystore, WebView, relay channel, update
    hashes** - N/A. This project ships no Android app and no update channel.

## Python tools and the pension monitor (items 40-45)

37. **(40-43) Credentials, read-only monitors, log scrubbing, safe
    parsing** - N/A. No Python, no monitor, no credentials. (Item 44 applies
    to this repo's CI and is answered below.)
38. **(44) GitHub Actions least privilege** - PASS. The CI workflow sets
    `permissions: contents: read` at the top level, uses no secrets, and
    pins every third-party action to a full commit SHA.
39. **(45) Alerts to a private channel** - N/A. The project sends no alerts.

## Residual risks accepted on purpose

- **Model weight supply chain**: weights download from Hugging Face at a
  pinned revision; a compromised upstream revision would still be sandboxed
  by the CSP (no exfil host is whitelisted beyond the HF hosts themselves).
- **Slice tags are heuristics**: mis-tagged slices would change per-slice
  numbers, never the overall verdict. Documented in the Method tab.
- **CI minutes**: the workflow runs on push/PR only; no scheduled runs. The
  live-probe smoke downloads ~200 MB of pinned weights; it is the honest
  end-to-end proof of the wasm path and worth the minutes.

Addendum (CI mirror fix): the `?modelBase=` query parameter is a test hook that
redirects model fetches. It is resolved against the page origin and applied
only when the result is same-origin, so a crafted link cannot make a visitor's
browser fetch weights from a third-party host; connect-src 'self' blocks any
cross-origin remainder. The mirror itself (docs/hf-mirror, .model-cache/) is
gitignored and exists only inside the CI job.
