/*
 * proctest — fork, exec, ownership and the controlling terminal in the wasm
 * realm, built with the SLICC Emscripten toolchain: its fork emulation
 * (slicc_fork.c, slicc-fork.js), execve (slicc_exec.c), posix_spawn / waitpid
 * (slicc_spawn.c), sessions (slicc_jobs.c) and the realm user
 * (slicc_libc_gaps.c). See build.sh. Its tests run it as a real wasm-realm
 * process against the kernel (wasm-exec.test.ts); its children are proctest
 * again.
 *
 *   proctest owner PATH...  the effective ids, then the owner of each PATH,
 *                           of a pipe, a socket and /dev/fd/0
 *   proctest notify         git's start_command: fork, exec with a
 *                           close-on-exec pipe to the parent, which reads it
 *                           to EOF (the exec happened) before it waits
 *   proctest atexit         buffered output and an atexit handler in a
 *                           process that forked: exit() still flushes and runs it
 *   proctest tty            open /dev/tty and write to it (or report ENXIO)
 *   proctest detached       `tty` in a forked child on /dev/null stdio: in
 *                           this session, then in a new one (setsid)
 *   proctest sleep MS       sleep, then say so
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static int fail(const char *what) {
  fprintf(stderr, "proctest: %s: %s\n", what, strerror(errno));
  return 1;
}

static void owner_of(const char *label, const struct stat *st) {
  printf("%s %u %u\n", label, (unsigned)st->st_uid, (unsigned)st->st_gid);
}

static int owner(int argc, char **argv) {
  printf("euid %u egid %u\n", (unsigned)geteuid(), (unsigned)getegid());
  struct stat st;
  for (int i = 0; i < argc; i++) {
    if (stat(argv[i], &st)) return fail(argv[i]);
    owner_of(argv[i], &st);
  }
  int p[2], s[2];
  if (pipe(p) || fstat(p[0], &st)) return fail("pipe");
  owner_of("pipe", &st);
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, s) || fstat(s[0], &st)) return fail("socketpair");
  owner_of("socket", &st);
  if (stat("/dev/fd/0", &st)) return fail("/dev/fd/0");
  owner_of("/dev/fd/0", &st);
  return 0;
}

static int notify(void) {
  int n[2];
  if (pipe2(n, O_CLOEXEC)) return fail("pipe2");
  pid_t pid = fork();
  if (pid < 0) return fail("fork");
  if (pid == 0) {
    close(n[0]);
    char *argv[] = {"proctest", "sleep", "300", NULL};
    execve("/usr/bin/proctest", argv, environ);
    _exit(127);
  }
  close(n[1]);
  char c;
  ssize_t got = read(n[0], &c, 1);
  printf("exec seen: %s\n", got == 0 ? "EOF" : "data");
  fflush(stdout);
  int status = 0;
  if (waitpid(pid, &status, 0) != pid) return fail("waitpid");
  printf("child exited %d\n", WEXITSTATUS(status));
  return 0;
}

static void at_exit(void) { printf(" atexit ran\n"); }

static int after_fork(void) {
  atexit(at_exit);
  printf("buffered");
  pid_t pid = fork();
  if (pid < 0) return fail("fork");
  if (pid == 0) _exit(0);
  waitpid(pid, NULL, 0);
  exit(0);
}

static int tty(void) {
  int fd = open("/dev/tty", O_RDWR);
  if (fd < 0) {
    fprintf(stderr, "/dev/tty: %s\n", errno == ENXIO ? "ENXIO" : strerror(errno));
    return 0;
  }
  dprintf(fd, "on the terminal, isatty %d\n", isatty(fd));
  return 0;
}

/* A forked child on /dev/null stdio opens /dev/tty; its stderr comes back here. */
static int tty_in_child(int new_session) {
  int p[2];
  if (pipe(p)) return fail("pipe");
  pid_t pid = fork();
  if (pid < 0) return fail("fork");
  if (pid == 0) {
    close(p[0]);
    if (new_session && setsid() < 0) _exit(fail("setsid"));
    int null = open("/dev/null", O_RDWR);
    dup2(null, 0);
    dup2(null, 1);
    dup2(p[1], 2);
    _exit(tty());
  }
  close(p[1]);
  char buf[128];
  ssize_t n, len = 0;
  while ((n = read(p[0], buf + len, sizeof buf - 1 - len)) > 0) len += n;
  buf[len] = 0;
  waitpid(pid, NULL, 0);
  printf("%s", buf);
  fflush(stdout);
  return 0;
}

static int detached(void) {
  printf("same session:\n");
  fflush(stdout);
  if (tty_in_child(0)) return 1;
  printf("new session:\n");
  fflush(stdout);
  return tty_in_child(1);
}

static int sleep_ms(const char *ms) {
  struct timespec t = {0, atol(ms) * 1000000L};
  nanosleep(&t, NULL);
  printf("slept\n");
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && !strcmp(argv[1], "owner")) return owner(argc - 2, argv + 2);
  if (argc >= 2 && !strcmp(argv[1], "notify")) return notify();
  if (argc >= 2 && !strcmp(argv[1], "atexit")) return after_fork();
  if (argc >= 2 && !strcmp(argv[1], "tty")) return tty();
  if (argc >= 2 && !strcmp(argv[1], "detached")) return detached();
  if (argc >= 3 && !strcmp(argv[1], "sleep")) return sleep_ms(argv[2]);
  fprintf(stderr, "usage: proctest owner PATH... | notify | atexit | tty | detached | sleep MS\n");
  return 2;
}
