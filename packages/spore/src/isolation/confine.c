/*
 * confine — apply a Landlock ruleset and a seccomp filter, then exec a command inside them.
 *
 * Node cannot narrow a child's ruleset between fork and exec, so a
 * read-only command runs through this wrapper instead. Output is delivered
 * on inherited descriptors, which Landlock does not gate: it checks path
 * resolution, so a child with no writable path still writes stdout.
 *
 *   confine [--contain [--hide DIR --keep DIR]...] [--scope-signals] --write-root DIR [--read PATH]... [--write PATH]... -- CMD [ARG]...
 *   confine [--contain [--hide DIR --keep DIR]...] --no-landlock -- CMD [ARG]...     the command applies its own Landlock
 *   confine --contain-check                               exit 0 when this host can contain
 *
 * --contain runs the command in a user, PID and mount namespace of its own, with a /proc of
 * that namespace, so it sees only the processes it started; on a host that cannot make them it
 * runs nothing. Contract: ARCHITECTURE.md, "Spores of different people on one account".
 *
 * --hide DIR --keep DIR, in that namespace, lays an empty directory over DIR and puts back the one
 * directory KEEP below it: the command sees KEEP and nothing else of DIR — one socket of a
 * directory of them, say. KEEP must exist; Landlock does not gate connecting to a socket, and the
 * mount namespace is what does.
 *
 * It runs nothing as root. Exit codes: 126 confinement failed, 127 exec failed; otherwise the
 * command's own.
 *
 * The syscall boilerplate below duplicates sandbox.c rather than sharing a
 * header, because that file compiles into a prebuilt addon and a refactor
 * could not be verified without rebuilding both.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <limits.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#define LL_CREATE_RULESET_VERSION (1U << 0)
#define LL_RULE_PATH_BENEATH      1

#define LL_FS_EXECUTE     (1ULL << 0)
#define LL_FS_WRITE_FILE  (1ULL << 1)
#define LL_FS_READ_FILE   (1ULL << 2)
#define LL_FS_READ_DIR    (1ULL << 3)
#define LL_FS_REMOVE_DIR  (1ULL << 4)
#define LL_FS_REMOVE_FILE (1ULL << 5)
#define LL_FS_MAKE_CHAR   (1ULL << 6)
#define LL_FS_MAKE_DIR    (1ULL << 7)
#define LL_FS_MAKE_REG    (1ULL << 8)
#define LL_FS_MAKE_SOCK   (1ULL << 9)
#define LL_FS_MAKE_FIFO   (1ULL << 10)
#define LL_FS_MAKE_BLOCK  (1ULL << 11)
#define LL_FS_MAKE_SYM    (1ULL << 12)
#define LL_FS_REFER       (1ULL << 13)
#define LL_FS_TRUNCATE    (1ULL << 14)

#define LL_FS_READ  (LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR)
#define LL_FS_WRITE (LL_FS_WRITE_FILE | LL_FS_REMOVE_DIR | LL_FS_REMOVE_FILE | \
                     LL_FS_MAKE_CHAR | LL_FS_MAKE_DIR | LL_FS_MAKE_REG |       \
                     LL_FS_MAKE_SOCK | LL_FS_MAKE_FIFO | LL_FS_MAKE_BLOCK |    \
                     LL_FS_MAKE_SYM)
#define LL_FS_ALL   (LL_FS_READ | LL_FS_WRITE)

#define LL_NET_BIND_TCP (1ULL << 0)

#define LL_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define LL_SCOPE_SIGNAL               (1ULL << 1)

#define MAX_PATHS 256

struct ll_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};

struct ll_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

static int ll_create_ruleset (struct ll_ruleset_attr *attr, size_t size, uint32_t flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int ll_add_rule (int fd, int type, const void *attr, uint32_t flags) {
  return (int)syscall(__NR_landlock_add_rule, fd, type, attr, flags);
}

static int ll_restrict_self (int fd, uint32_t flags) {
  return (int)syscall(__NR_landlock_restrict_self, fd, flags);
}

static int add_path_rule (int ruleset_fd, int fd, uint64_t access) {
  struct ll_path_beneath_attr attr = { .allowed_access = access, .parent_fd = fd };
  int ret = ll_add_rule(ruleset_fd, LL_RULE_PATH_BENEATH, &attr, 0);
  if (ret < 0 && errno == EINVAL) {
    uint64_t file_access = access & (LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE | LL_FS_TRUNCATE);
    if (file_access) {
      attr.allowed_access = file_access;
      ret = ll_add_rule(ruleset_fd, LL_RULE_PATH_BENEATH, &attr, 0);
    }
  }
  return ret < 0 ? -errno : 0;
}

static void fail (const char *what, const char *detail) {
  fprintf(stderr, "confine: %s%s%s\n", what, detail ? ": " : "", detail ? detail : "");
  exit(126);
}

#if defined(__x86_64__)
#define FILTER_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define FILTER_ARCH AUDIT_ARCH_AARCH64
#else
#error "confine: no seccomp architecture for this target"
#endif

#define CLONE_NEW_ANY (CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | \
                       CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET)

#define REFUSE(nr, err) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), \
                        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (err))

/*
 * What the command and everything it starts may not call, whatever the container allows: the
 * calls a process uses to leave a sandbox or reach kernel code an unprivileged one never needs.
 * clone3 hides its flags behind a pointer, so it answers ENOSYS and libc falls back to clone.
 */
static void filter_syscalls (void) {
  struct sock_filter rules[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, FILTER_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
#endif
    REFUSE(__NR_unshare, EPERM),
    REFUSE(__NR_setns, EPERM),
    REFUSE(__NR_mount, EPERM),
    REFUSE(__NR_umount2, EPERM),
    REFUSE(__NR_pivot_root, EPERM),
#ifdef __NR_open_tree
    REFUSE(__NR_open_tree, EPERM),
    REFUSE(__NR_move_mount, EPERM),
    REFUSE(__NR_fsopen, EPERM),
    REFUSE(__NR_fsconfig, EPERM),
    REFUSE(__NR_fsmount, EPERM),
    REFUSE(__NR_fspick, EPERM),
#endif
#ifdef __NR_mount_setattr
    REFUSE(__NR_mount_setattr, EPERM),
#endif
    REFUSE(__NR_keyctl, EPERM),
    REFUSE(__NR_add_key, EPERM),
    REFUSE(__NR_request_key, EPERM),
    REFUSE(__NR_bpf, EPERM),
    REFUSE(__NR_perf_event_open, EPERM),
    REFUSE(__NR_userfaultfd, EPERM),
#ifdef __NR_io_uring_setup
    REFUSE(__NR_io_uring_setup, ENOSYS),
    REFUSE(__NR_io_uring_enter, ENOSYS),
    REFUSE(__NR_io_uring_register, ENOSYS),
#endif
    REFUSE(__NR_init_module, EPERM),
    REFUSE(__NR_finit_module, EPERM),
    REFUSE(__NR_delete_module, EPERM),
    REFUSE(__NR_kexec_load, EPERM),
#ifdef __NR_kexec_file_load
    REFUSE(__NR_kexec_file_load, EPERM),
#endif
    REFUSE(__NR_open_by_handle_at, EPERM),
    REFUSE(__NR_acct, EPERM),
    REFUSE(__NR_swapon, EPERM),
    REFUSE(__NR_swapoff, EPERM),
    REFUSE(__NR_reboot, EPERM),
    REFUSE(__NR_syslog, EPERM),
#ifdef __NR_clone3
    REFUSE(__NR_clone3, ENOSYS),
#endif
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, CLONE_NEW_ANY),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(rules) / sizeof(rules[0]), .filter = rules };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("failed to set no_new_privs", strerror(errno));
  if (syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program) < 0) fail("failed to install the syscall filter", strerror(errno));
}

/* Opened where the command runs, so a contained one is granted the /proc of its namespace. */
#define IN_NAMESPACE -2

/*
 * Every path is opened before any namespace is made, so a path meaning something only outside
 * one — a pinned /proc/<pid>/fd/<n> — keeps that meaning; /proc itself is opened in the
 * namespace. A grant that does not exist is no grant.
 */
static int open_grant (const char *path, int required) {
  if (strcmp(path, "/proc") == 0) return IN_NAMESPACE;
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd >= 0) return fd;
  if (errno == ENOENT && !required) return -1;
  fail("cannot open a granted path", path);
  return -1;
}

static void add_grant (int ruleset_fd, int fd, const char *path, uint64_t access) {
  if (fd == -1) return;
  int opened = fd == IN_NAMESPACE ? open(path, O_PATH | O_CLOEXEC) : fd;
  if (opened < 0) fail("cannot open a granted path", path);
  int ret = add_path_rule(ruleset_fd, opened, access);
  if (ret < 0) fail("failed to add a granted path", path);
  close(opened);
}

static void landlock (const char *write_root, int write_root_fd, const char **read_paths, const int *read_fds, int n_read, const char **write_paths, const int *write_fds, int n_write, int scope_signals) {
  int abi = ll_create_ruleset(NULL, 0, LL_CREATE_RULESET_VERSION);
  if (abi < 0) fail("landlock unavailable (kernel 5.13+ with CONFIG_SECURITY_LANDLOCK)", strerror(errno));

  uint64_t handled_fs = LL_FS_ALL;
  if (abi >= 2) handled_fs |= LL_FS_REFER;
  if (abi >= 3) handled_fs |= LL_FS_TRUNCATE;

  struct ll_ruleset_attr ruleset_attr = { .handled_access_fs = handled_fs, .handled_access_net = 0, .scoped = 0 };
  if (abi >= 4) ruleset_attr.handled_access_net = LL_NET_BIND_TCP;
  /* Signals are scoped only when asked: exec runs inside the agent's domain, already scoped, and
     must still signal a detached cell of that domain; a job's or a router's command starts
     unconfined and has no scope but its own. */
  if (abi >= 6) ruleset_attr.scoped = LL_SCOPE_ABSTRACT_UNIX_SOCKET | (scope_signals ? LL_SCOPE_SIGNAL : 0);

  int ruleset_fd = ll_create_ruleset(&ruleset_attr, sizeof(ruleset_attr), 0);
  if (ruleset_fd < 0) fail("failed to create ruleset", strerror(errno));

  add_grant(ruleset_fd, write_root_fd, write_root, handled_fs);
  for (int k = 0; k < n_write; k++) add_grant(ruleset_fd, write_fds[k], write_paths[k], handled_fs);
  for (int k = 0; k < n_read; k++) add_grant(ruleset_fd, read_fds[k], read_paths[k], LL_FS_READ);

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("failed to set no_new_privs", strerror(errno));
  if (ll_restrict_self(ruleset_fd, 0) < 0) fail("failed to restrict self", strerror(errno));
  close(ruleset_fd);
}

static int write_file (const char *path, const char *text) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return -errno;
  ssize_t n = write(fd, text, strlen(text));
  int err = errno;
  close(fd);
  return n == (ssize_t)strlen(text) ? 0 : -(n < 0 ? err : EIO);
}

static void close_from (int lowest, int keep) {
  if (keep >= lowest) {
    if (keep > lowest) syscall(SYS_close_range, lowest, keep - 1, 0);
    syscall(SYS_close_range, keep + 1, ~0U, 0);
  } else {
    syscall(SYS_close_range, lowest, ~0U, 0);
  }
}

static volatile pid_t forward_to = 0;
static volatile sig_atomic_t pending = 0;

static void forward (int sig) {
  if (forward_to > 0) kill(forward_to, sig);
  else pending = sig;
}

static void forward_signals (void) {
  static const int passed[] = { SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2, SIGALRM, SIGXCPU };
  struct sigaction action = { .sa_handler = forward };
  sigemptyset(&action.sa_mask);
  for (size_t k = 0; k < sizeof(passed) / sizeof(passed[0]); k++) sigaction(passed[k], &action, NULL);
}

static void forwarding_to (pid_t pid) {
  forward_to = pid;
  if (pending) kill(pid, pending);
}

/* Ends this process as the command ended: the same code, or the same signal. */
static void end_as (int status) {
  if (WIFEXITED(status)) exit(WEXITSTATUS(status));
  int sig = WTERMSIG(status);
  signal(sig, SIG_DFL);
  sigset_t only;
  sigemptyset(&only);
  sigaddset(&only, sig);
  sigprocmask(SIG_UNBLOCK, &only, NULL);
  raise(sig);
  exit(128 + sig);
}

#define MAX_KEPT 8

static const char *hide_paths[MAX_KEPT];
static const char *keep_paths[MAX_KEPT];
static int n_hide = 0, n_keep = 0;
static char hid_step[PATH_MAX + 64];

/* Makes each directory of `path` past its first `from` bytes, as mkdir -p would. */
static int make_below (const char *path, size_t from) {
  char at[PATH_MAX];
  size_t n = strlen(path);
  if (n >= sizeof(at)) return -ENAMETOOLONG;
  memcpy(at, path, n + 1);
  for (size_t k = from + 1; k <= n; k++) {
    if (at[k] != '/' && at[k] != '\0') continue;
    char was = at[k];
    at[k] = '\0';
    if (mkdir(at, 0700) < 0 && errno != EEXIST) return -errno;
    at[k] = was;
  }
  return 0;
}

/*
 * Each DIR hidden under an empty tmpfs, then each KEEP put back in it from a descriptor opened
 * before anything was hidden. NULL when done; otherwise the step that failed, `*err` its errno.
 */
static const char *hide_and_keep (int *err) {
  int kept[MAX_KEPT];
  for (int k = 0; k < n_keep; k++) {
    kept[k] = open(keep_paths[k], O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (kept[k] < 0) {
      *err = -errno;
      for (int j = 0; j < k; j++) close(kept[j]);
      snprintf(hid_step, sizeof(hid_step), "cannot open %s", keep_paths[k]);
      return hid_step;
    }
  }
  const char *step = NULL;
  for (int k = 0; !step && k < n_hide; k++) {
    if (mount("tmpfs", hide_paths[k], "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "mode=0700") < 0) {
      *err = -errno;
      snprintf(hid_step, sizeof(hid_step), "cannot hide %s", hide_paths[k]);
      step = hid_step;
    }
  }
  for (int k = 0; !step && k < n_keep; k++) {
    char from[64];
    snprintf(from, sizeof(from), "/proc/self/fd/%d", kept[k]);
    if ((*err = make_below(keep_paths[k], strlen(hide_paths[k]))) < 0 || mount(from, keep_paths[k], NULL, MS_BIND, NULL) < 0) {
      if (*err == 0) *err = -errno;
      snprintf(hid_step, sizeof(hid_step), "cannot keep %s", keep_paths[k]);
      step = hid_step;
    }
  }
  for (int k = 0; k < n_keep; k++) close(kept[k]);
  return step;
}

/*
 * The namespaces' first process: it maps the user to itself, mounts a /proc of its own, says
 * whether it could, then starts the command, passes it the signals it is sent, reaps whatever is
 * orphaned to it, and reports how the command ended. When it exits, the kernel ends every
 * process left in the namespace.
 */
static void first_process (int report, uid_t uid, gid_t gid, int check, char **command, void (*confine_command)(void)) {
  char map[64];
  const char *step = NULL;
  int err = 0;
  prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0);
  snprintf(map, sizeof(map), "%u %u 1", (unsigned)uid, (unsigned)uid);
  if ((err = write_file("/proc/self/uid_map", map)) < 0) step = "cannot map the user";
  else if ((err = write_file("/proc/self/setgroups", "deny")) < 0) step = "cannot deny setgroups";
  else if (snprintf(map, sizeof(map), "%u %u 1", (unsigned)gid, (unsigned)gid), (err = write_file("/proc/self/gid_map", map)) < 0) step = "cannot map the group";
  else if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) < 0) { err = -errno; step = "cannot make the mounts private"; }
  else if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) < 0) { err = -errno; step = "cannot mount a /proc of its own"; }
  if (step) {
    dprintf(report, "F%s: %s", step, strerror(-err));
    _exit(0);
  }
  if (n_hide && (step = hide_and_keep(&err))) {
    dprintf(report, "H%s: %s", step, strerror(-err));
    _exit(0);
  }
  if (write(report, "K", 1) != 1 || check) _exit(0);

  forward_signals();
  pid_t child = fork();
  if (child < 0) _exit(126);
  if (child == 0) {
    confine_command();
    execvp(command[0], command);
    fprintf(stderr, "confine: cannot exec %s: %s\n", command[0], strerror(errno));
    _exit(127);
  }
  forwarding_to(child);
  close_from(3, report);
  int status = 0, ended = 0;
  for (;;) {
    int st;
    pid_t gone = wait(&st);
    if (gone == child) { status = st; ended = 1; break; }
    if (gone < 0 && errno != EINTR) break;
  }
  if (!ended) status = 126 << 8;
  if (write(report, &status, sizeof(status)) != sizeof(status)) _exit(126);
  _exit(0);
}

/*
 * 1 when the command ran contained and ended with *status; 0 when this host could not contain it
 * and nothing ran, the step it refused in `why`; -1 when it could, but a --hide or --keep failed
 * and nothing ran, why in `why`.
 */
static int contained (char **command, int check, void (*confine_command)(void), int *status, char *why, size_t why_size) {
  int report[2];
  uid_t uid = getuid();
  gid_t gid = getgid();
  if (pipe2(report, O_CLOEXEC) < 0) fail("cannot open a pipe", strerror(errno));
  fflush(NULL);
  forward_signals();
  pid_t first = (pid_t)syscall(SYS_clone, CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNS | SIGCHLD, NULL, NULL, NULL, 0);
  if (first < 0) {
    snprintf(why, why_size, "cannot make the namespaces: %s", strerror(errno));
    close(report[0]);
    close(report[1]);
    return 0;
  }
  if (first == 0) {
    close(report[0]);
    first_process(report[1], uid, gid, check, command, confine_command);
  }
  close(report[1]);
  forwarding_to(first);

  char said[256] = { 0 };
  ssize_t n;
  while ((n = read(report[0], said, 1)) < 0 && errno == EINTR) {}
  if (n == 1 && (said[0] == 'F' || said[0] == 'H')) {
    ssize_t more;
    while ((more = read(report[0], said + 1, sizeof(said) - 2)) < 0 && errno == EINTR) {}
    snprintf(why, why_size, "%s", said + 1);
    close(report[0]);
    waitpid(first, NULL, 0);
    forward_to = 0;
    return said[0] == 'H' ? -1 : 0;
  }
  if (n != 1 || said[0] != 'K') fail("the namespaces' first process ended before saying anything", NULL);
  close_from(3, report[0]);

  int reported = 126 << 8;
  ssize_t got;
  while ((got = read(report[0], &reported, sizeof(reported))) < 0 && errno == EINTR) {}
  int ended;
  while (waitpid(first, &ended, 0) < 0 && errno == EINTR) {}
  *status = got == sizeof(reported) ? reported : (WIFSIGNALED(ended) ? ended : 126 << 8);
  return 1;
}

static const char *write_root = NULL;
static const char *read_paths[MAX_PATHS];
static const char *write_paths[MAX_PATHS];
static int write_root_fd = -1;
static int read_fds[MAX_PATHS];
static int write_fds[MAX_PATHS];
static int n_read = 0, n_write = 0, scope_signals = 0, no_landlock = 0;

static void confine_command (void) {
  if (!no_landlock) landlock(write_root, write_root_fd, read_paths, read_fds, n_read, write_paths, write_fds, n_write, scope_signals);
  filter_syscalls();
}

int main (int argc, char **argv) {
  int i = 1, contain = 0, check = 0;

  for (; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) { i++; break; }
    if (strcmp(argv[i], "--scope-signals") == 0) { scope_signals = 1; continue; }
    if (strcmp(argv[i], "--contain") == 0) { contain = 1; continue; }
    if (strcmp(argv[i], "--contain-check") == 0) { check = 1; continue; }
    if (strcmp(argv[i], "--no-landlock") == 0) { no_landlock = 1; continue; }
    if (i + 1 >= argc) fail("missing value for", argv[i]);
    if (strcmp(argv[i], "--hide") == 0) {
      if (n_hide >= MAX_KEPT) fail("too many directories to hide", NULL);
      if (n_keep != n_hide) fail("--hide again before its --keep", NULL);
      hide_paths[n_hide++] = argv[++i];
    } else if (strcmp(argv[i], "--keep") == 0) {
      if (n_keep + 1 != n_hide) fail("--keep without the --hide it lies under", NULL);
      const char *hide = hide_paths[n_keep], *keep = argv[++i];
      size_t len = strlen(hide);
      if (hide[0] != '/' || strncmp(keep, hide, len) != 0 || keep[len] != '/' || keep[len + 1] == '\0') fail("--keep must lie under its --hide, both absolute", keep);
      keep_paths[n_keep++] = keep;
    } else if (strcmp(argv[i], "--write-root") == 0) write_root = argv[++i];
    else if (strcmp(argv[i], "--read") == 0) {
      if (n_read >= MAX_PATHS) fail("too many read paths", NULL);
      read_paths[n_read++] = argv[++i];
    } else if (strcmp(argv[i], "--write") == 0) {
      if (n_write >= MAX_PATHS) fail("too many write paths", NULL);
      write_paths[n_write++] = argv[++i];
    } else fail("unknown option", argv[i]);
  }

  if (getuid() == 0 || geteuid() == 0) fail("refuses to run anything as root", "run spore as an ordinary user (in a container, USER or --user)");
  if (n_keep != n_hide) fail("--hide without its --keep", hide_paths[n_hide - 1]);
  if (n_hide && !contain) fail("--hide and --keep need --contain", "they lay mounts in the command's own namespace");

  char why[256] = { 0 };
  if (check) {
    int status;
    char *nothing[] = { NULL };
    if (contained(nothing, 1, confine_command, &status, why, sizeof(why)) == 1) {
      puts("contained");
      return 0;
    }
    puts(why);
    return 1;
  }

  if (!write_root && !no_landlock) fail("--write-root is required, or --no-landlock for a command that applies its own", NULL);
  if (write_root && no_landlock) fail("--write-root and --no-landlock together", NULL);
  if (i >= argc) fail("no command given after --", NULL);

  if (!no_landlock) {
    write_root_fd = open_grant(write_root, 1);
    for (int k = 0; k < n_write; k++) write_fds[k] = open_grant(write_paths[k], 0);
    for (int k = 0; k < n_read; k++) read_fds[k] = open_grant(read_paths[k], 0);
  }

  if (contain) {
    int status;
    int how = contained(&argv[i], 0, confine_command, &status, why, sizeof(why));
    if (how == 1) end_as(status);
    if (how < 0) fail("the command was not run: what it is shown of the host could not be laid out", why);
    fail("this host cannot contain the command, so it was not run", why);
  }

  confine_command();
  execvp(argv[i], &argv[i]);
  fprintf(stderr, "confine: cannot exec %s: %s\n", argv[i], strerror(errno));
  return 127;
}
