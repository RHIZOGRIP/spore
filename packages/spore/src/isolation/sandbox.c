/**
 * sandbox.c — Landlock LSM bindings for Node.js (N-API)
 *
 * sandbox({ readPaths, writePaths }) confines the process (and all its
 * children) to the given paths. Irreversible within the process lifetime.
 */

#define _GNU_SOURCE
#define NAPI_VERSION 8
#include <node_api.h>

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>

/* ── Landlock constants (defined locally — no kernel header dependency) ── */

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule      445
#define __NR_landlock_restrict_self 446
#endif

#define LL_CREATE_RULESET_VERSION (1U << 0)
#define LL_RULE_PATH_BENEATH      1
#define LL_RULE_NET_PORT           2

/* Filesystem access flags */
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
#define LL_FS_REFER       (1ULL << 13)  /* ABI v2 */
#define LL_FS_TRUNCATE    (1ULL << 14)  /* ABI v3 */

#define LL_FS_READ  (LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR)
#define LL_FS_WRITE (LL_FS_WRITE_FILE | LL_FS_REMOVE_DIR | LL_FS_REMOVE_FILE | \
                     LL_FS_MAKE_CHAR | LL_FS_MAKE_DIR | LL_FS_MAKE_REG |       \
                     LL_FS_MAKE_SOCK | LL_FS_MAKE_FIFO | LL_FS_MAKE_BLOCK |    \
                     LL_FS_MAKE_SYM)
#define LL_FS_ALL   (LL_FS_READ | LL_FS_WRITE)

/* Network access flags (ABI v4) */
#define LL_NET_BIND_TCP    (1ULL << 0)
#define LL_NET_CONNECT_TCP (1ULL << 1)

/* Scopes (ABI v6): what lies outside the domain a process may not reach */
#define LL_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define LL_SCOPE_SIGNAL               (1ULL << 1)

/* ── Structs ─────────────────────────────────────────────────────────── */

struct ll_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};

struct ll_path_beneath_attr {
  uint64_t allowed_access;
  int32_t  parent_fd;
} __attribute__((packed));

/* ── Syscall wrappers ────────────────────────────────────────────────── */

static int ll_create_ruleset (struct ll_ruleset_attr *attr, size_t size, uint32_t flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int ll_add_rule (int fd, int type, const void *attr, uint32_t flags) {
  return (int)syscall(__NR_landlock_add_rule, fd, type, attr, flags);
}

static int ll_restrict_self (int fd, uint32_t flags) {
  return (int)syscall(__NR_landlock_restrict_self, fd, flags);
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

static int add_path_rule (int ruleset_fd, const char *path, uint64_t access) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return -errno;  /* caller decides whether to ignore ENOENT */
  struct ll_path_beneath_attr attr = { .allowed_access = access, .parent_fd = fd };
  int ret = ll_add_rule(ruleset_fd, LL_RULE_PATH_BENEATH, &attr, 0);
  if (ret < 0 && errno == EINVAL) {
    /* Non-directory path: directory-only flags (MAKE_DIR etc.) are invalid.
       Retry with file-only subset. */
    uint64_t file_access = access & (LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE | LL_FS_TRUNCATE);
    if (file_access) {
      attr.allowed_access = file_access;
      ret = ll_add_rule(ruleset_fd, LL_RULE_PATH_BENEATH, &attr, 0);
    }
  }
  int err = errno;
  close(fd);
  return ret < 0 ? -err : 0;
}

/* Add rules for each path in a JS string array. A missing path is skipped when `missing_ok`,
   and otherwise fails, left in `path` so the caller can name it. */
static int add_paths_from_array (napi_env env, int ruleset_fd, napi_value arr, uint64_t access, int missing_ok, char *path, size_t path_len) {
  uint32_t len;
  napi_get_array_length(env, arr, &len);
  for (uint32_t i = 0; i < len; i++) {
    napi_value elem;
    napi_get_element(env, arr, i, &elem);
    size_t copied;
    napi_get_value_string_utf8(env, elem, path, path_len, &copied);
    int ret = add_path_rule(ruleset_fd, path, access);
    if (ret < 0 && !(missing_ok && ret == -ENOENT)) return ret;
  }
  return 0;
}

/* ── Exported function ───────────────────────────────────────────────── */

/**
 * sandbox(opts)
 *
 * opts.readPaths  — string[], read-only paths; one missing on this host is skipped
 * opts.writePaths — string[], read-write paths; each must exist
 *
 * Throws on error. Returns ABI version on success.
 */
static napi_value Sandbox (napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_error(env, NULL, "sandbox() requires an options object");
    return NULL;
  }

  /* Detect ABI version */
  int abi = ll_create_ruleset(NULL, 0, LL_CREATE_RULESET_VERSION);
  if (abi < 0) {
    napi_throw_error(env, NULL, "Landlock not supported (check kernel version and CONFIG_SECURITY_LANDLOCK)");
    return NULL;
  }

  /* Build handled_access_fs for the detected ABI */
  uint64_t handled_fs = LL_FS_ALL;
  if (abi >= 2) handled_fs |= LL_FS_REFER;
  if (abi >= 3) handled_fs |= LL_FS_TRUNCATE;

  struct ll_ruleset_attr ruleset_attr = { .handled_access_fs = handled_fs, .handled_access_net = 0, .scoped = 0 };

  /* ABI v4+: restrict TCP bind, allow TCP connect (unhandled = unrestricted) */
  if (abi >= 4) {
    ruleset_attr.handled_access_net = LL_NET_BIND_TCP;
  }

  /* ABI v6+: signal and abstract-socket only within this domain and the ones nested in it, so
     another spore of the same uid is out of reach. An older kernel takes the struct's zero tail. */
  if (abi >= 6) {
    ruleset_attr.scoped = LL_SCOPE_SIGNAL | LL_SCOPE_ABSTRACT_UNIX_SOCKET;
  }

  int ruleset_fd = ll_create_ruleset(&ruleset_attr, sizeof(ruleset_attr), 0);
  if (ruleset_fd < 0) {
    napi_throw_error(env, NULL, "Failed to create landlock ruleset");
    return NULL;
  }

  int ret;
  char path[4096];

  /* Read-only paths */
  napi_value read_paths;
  if (napi_get_named_property(env, argv[0], "readPaths", &read_paths) == napi_ok) {
    bool is_array;
    napi_is_array(env, read_paths, &is_array);
    if (is_array) {
      ret = add_paths_from_array(env, ruleset_fd, read_paths, LL_FS_READ, 1, path, sizeof(path));
      if (ret < 0) {
        close(ruleset_fd);
        char msg[4352];
        snprintf(msg, sizeof(msg), "Failed to add read-only rule for '%s': %s", path, strerror(-ret));
        napi_throw_error(env, NULL, msg);
        return NULL;
      }
    }
  }

  /* Additional write paths: the islands, the spore's socket directory */
  napi_value write_paths;
  if (napi_get_named_property(env, argv[0], "writePaths", &write_paths) == napi_ok) {
    bool is_array;
    napi_is_array(env, write_paths, &is_array);
    if (is_array) {
      ret = add_paths_from_array(env, ruleset_fd, write_paths, handled_fs, 0, path, sizeof(path));
      if (ret < 0) {
        close(ruleset_fd);
        char msg[4352];
        snprintf(msg, sizeof(msg), "Failed to add write rule for '%s': %s", path, strerror(-ret));
        napi_throw_error(env, NULL, msg);
        return NULL;
      }
    }
  }

  /* Required: prevent privilege escalation via SUID binaries */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
    close(ruleset_fd);
    napi_throw_error(env, NULL, "Failed to set PR_SET_NO_NEW_PRIVS");
    return NULL;
  }

  /* Apply — irreversible */
  if (ll_restrict_self(ruleset_fd, 0) < 0) {
    close(ruleset_fd);
    napi_throw_error(env, NULL, "Failed to restrict self with landlock");
    return NULL;
  }

  close(ruleset_fd);

  /* Return ABI version */
  napi_value result;
  napi_create_int32(env, abi, &result);
  return result;
}

/* abi() — the Landlock ABI version, or -errno without one. Never confines. */
static napi_value Abi (napi_env env, napi_callback_info info) {
  int abi = ll_create_ruleset(NULL, 0, LL_CREATE_RULESET_VERSION);
  napi_value result;
  napi_create_int32(env, abi < 0 ? -errno : abi, &result);
  return result;
}

/* ── Module init ─────────────────────────────────────────────────────── */

static napi_value Init (napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "sandbox", NAPI_AUTO_LENGTH, Sandbox, NULL, &fn);
  napi_set_named_property(env, exports, "sandbox", fn);
  napi_create_function(env, "abi", NAPI_AUTO_LENGTH, Abi, NULL, &fn);
  napi_set_named_property(env, exports, "abi", fn);

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
