# Security

## Reporting a vulnerability

Report it privately, through this repository's private vulnerability reporting on GitHub
(Security → Report a vulnerability), not in a public issue. Say what you ran, on which kernel and
spore version, and what crossed a boundary below that should not have. Only the latest release is
fixed.

## What spore assumes

**The agent is untrusted.** Anything it reads — a web page, a document, a message, a tool's
output — can steer it, so spore treats what it runs as possibly hostile and confines it. **The
operator is trusted**: the Unix user spore runs as, who writes `~/.config/spore/`, the definitions
and the host's settings. **The trust boundary is that user.** Another unconfined process of the
same user can read every workspace and every key; spore does not defend against it.

## What confines an agent

Every turn's agent, and everything it runs, is held by the kernel, not by the tool list:

- **Files** (Landlock): it writes only its own write islands and the directories its definition
  `writes`, and reads only those, its workspace, its declared corpora, the runtime and the
  system's own directories (`/usr`, `/etc` and the like). It cannot
  read `~/.config/spore/` or another spore's workspace, and `/tmp` is not granted. `exec` runs
  read-only.
- **Credentials**: no provider key, bot token or source secret reaches an agent's environment.
  Model calls, vector stores and named endpoints go through brokers in the runner, which hold the
  credentials and demand a key minted per turn.
- **Processes**: each turn, job and router runs in user, PID and mount namespaces of its own and
  sees only the processes it started. A host that cannot provide them runs no turn unless the
  operator sets `contain` off.
- **Signals and abstract sockets** (Linux 6.12+): an agent can signal and reach only its own
  turn's processes.
- **Syscalls**: a filter refuses making or joining namespaces, mounting, `keyctl`, `bpf`,
  `perf_event_open`, `userfaultfd`, `io_uring`, module and kernel loading, and the like, whatever
  the surrounding container allows.
- **Ports**: TCP bind is refused (Linux 6.7+), so nothing an agent runs listens on TCP.
- **Not as root**: spore runs no turn, job or router as uid 0.
- **Spend**: a turn stops taking new model calls once its settled spend reaches its definition's
  hard cost; a call already running finishes and is paid.

`spore doctor` says which of these the host does not provide. `unconfined: true` in a spore's
`spore.cmk` turns confinement off deliberately, for that spore's turns; its cells stay confined.

Requirements: Linux with Landlock (5.13+; 6.12+ for signal and socket scoping), unprivileged user
namespaces for spore's `confine` (Ubuntu 24.04 restricts them by default; Docker's default
profiles refuse them), and a non-root user. The full account is [ARCHITECTURE.md](ARCHITECTURE.md),
§Sandbox and §Spores of different people on one account.

**The HTTP API** (`spore-api`) listens only on a unix socket or a loopback address, demands a
token on every request — kept in `environment`, never in its file — and reaches only the spores a
caller's patterns name. Exposing it further is a reverse proxy you choose.

## Accepted risks

- **What an agent reads can steer it, and it can send what it reads anywhere it can reach.** The
  network is open by design: spore bounds what an agent can read and holds no secret it could leak,
  but not where it connects. Restrict egress on the host — a firewall for the user spores run as,
  a network namespace, a container — when that matters.
- **An agent can connect to any unix socket its process can see**, and to any TCP port on the
  host: neither is gated by Landlock. **Anything you serve beside spores must authenticate every
  request** with a secret no workspace holds, as spore's own brokers do. A service that trusts
  whoever connects is open to every agent.
- **Spores of one user can still reach each other through UDP ports** and unix sockets one of them
  makes in its own socket directory. Spore's own sockets demand a key; what an agent makes does not.
- **Metadata endpoints and internal networks** reachable from the host are reachable from an
  agent. Block them on the host.

## Not in scope

A malicious operator; unconfined processes of the same user; kernel and container-runtime
vulnerabilities; what a model provider does with what it is sent; a turn of a spore whose `spore.cmk` says
`unconfined: true`.
