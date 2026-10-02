/*
 * fdtest — descriptor inheritance, FD_CLOEXEC and /dev/fd in the wasm realm,
 * built with the SLICC Emscripten toolchain and its slicc_spawn.c shim (see
 * build.sh). Its tests run it as a real wasm-realm process against the kernel
 * (wasm-fds.test.ts).
 *
 *   fdtest inherit       FD_CLOEXEC per fd, then spawn `fdtest probe` twice
 *                        (plain; with posix_spawn file actions beyond fd 2)
 *   fdtest probe FD...   which FDs are open; read the first through /dev/fd;
 *                        whether the next two fstat as the same file
 *   fdtest devfd         /dev/fd/N, /proc/self/fd/N and /dev/stdout in one process
 *   fdtest sockets       SOCK_CLOEXEC on socket, socketpair and accept4, then
 *                        spawn `fdtest probe` on an inherited socketpair end
 *   fdtest devices       /dev/null and /dev/urandom beyond fd 2, then spawn
 *                        `fdtest readdev` on them
 *   fdtest readdev FD... what a read of 4 bytes from each FD gives
 */
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int fail(const char *what) {
  printf("%s: %s\n", what, strerror(errno));
  fflush(stdout);
  return 1;
}

/* Everything readable on `fd` until end of file. */
static void read_all(int fd, char *buf, size_t size) {
  size_t n = 0;
  ssize_t r;
  while (n + 1 < size && (r = read(fd, buf + n, size - 1 - n)) > 0) n += (size_t)r;
  buf[n] = 0;
}

static int spawn_probe(posix_spawn_file_actions_t *fa, int *fds, int count) {
  char args[8][16];
  char *argv[10] = {"fdtest", "probe"};
  for (int i = 0; i < count; i++) {
    snprintf(args[i], sizeof args[i], "%d", fds[i]);
    argv[2 + i] = args[i];
  }
  argv[2 + count] = NULL;
  pid_t pid;
  int err = posix_spawn(&pid, "fdtest", fa, NULL, argv, environ);
  if (err) {
    errno = err;
    return fail("posix_spawn");
  }
  int status = 0;
  if (waitpid(pid, &status, 0) != pid) return fail("waitpid");
  printf("probe exited %d\n", WEXITSTATUS(status));
  fflush(stdout);
  return 0;
}

static int inherit(void) {
  int a[2], b[2], c[2], d[2], e[2];
  if (pipe(a) || pipe2(b, O_CLOEXEC) || pipe(c) || pipe(d) || pipe(e)) return fail("pipe");
  if (fcntl(c[0], F_SETFD, FD_CLOEXEC) < 0) return fail("F_SETFD");
  int dup_of_b = dup(b[0]);                         /* dup clears FD_CLOEXEC */
  int cloexec_dup = fcntl(a[0], F_DUPFD_CLOEXEC, 20);
  int dup3_fd = dup3(a[0], 30, O_CLOEXEC);
  printf("F_GETFD pipe=%d pipe2=%d setfd=%d dup=%d dupfd_cloexec=%d dup3=%d\n",
         fcntl(a[0], F_GETFD), fcntl(b[0], F_GETFD), fcntl(c[0], F_GETFD),
         fcntl(dup_of_b, F_GETFD), fcntl(cloexec_dup, F_GETFD), fcntl(dup3_fd, F_GETFD));
  printf("O_CLOEXEC in F_GETFL: %s\n", fcntl(b[0], F_GETFL) & O_CLOEXEC ? "yes" : "no");
  fflush(stdout);
  if (write(a[1], "through a\n", 10) != 10 || write(d[1], "through d\n", 10) != 10 ||
      write(e[1], "through e\n", 10) != 10) {
    return fail("write");
  }
  close(a[1]);
  close(d[1]);
  close(e[1]);
  close(b[1]);
  close(c[1]);
  /* a[0], d[0] and dup_of_b are inherited; b[0], c[0], cloexec_dup, dup3_fd are not. */
  int probe[] = {a[0], d[0], dup_of_b, b[0], c[0], cloexec_dup, dup3_fd};
  if (spawn_probe(NULL, probe, 7)) return 1;
  /* File actions beyond fd 2: e[0] at 40, d[0] closed. */
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, e[0], 40);
  posix_spawn_file_actions_addclose(&fa, d[0]);
  int acted[] = {40, d[0]};
  int r = spawn_probe(&fa, acted, 2);
  posix_spawn_file_actions_destroy(&fa);
  return r;
}

static int probe(int argc, char **argv) {
  int fds[8];
  int count = argc > 8 ? 8 : argc;
  for (int i = 0; i < count; i++) {
    fds[i] = atoi(argv[i]);
    printf("fd %d %s\n", fds[i], fcntl(fds[i], F_GETFD) >= 0 ? "open" : "closed");
  }
  char path[32];
  snprintf(path, sizeof path, "/dev/fd/%d", fds[0]);
  int fd = open(path, O_RDONLY);
  if (fd < 0) return fail(path);
  char buf[64];
  read_all(fd, buf, sizeof buf);
  printf("%s: %s", path, buf);
  if (count >= 3 && fcntl(fds[1], F_GETFD) >= 0 && fcntl(fds[2], F_GETFD) >= 0) {
    struct stat s1, s2;
    char p1[32], p2[32];
    snprintf(p1, sizeof p1, "/dev/fd/%d", fds[1]);
    snprintf(p2, sizeof p2, "/dev/fd/%d", fds[2]);
    if (stat(p1, &s1) || stat(p2, &s2)) return fail("stat");
    printf("fifo %s, same file %s\n", S_ISFIFO(s1.st_mode) && S_ISFIFO(s2.st_mode) ? "yes" : "no",
           s1.st_ino == s2.st_ino && s1.st_dev == s2.st_dev ? "yes" : "no");
  }
  fflush(stdout);
  return 0;
}

static int devfd(void) {
  int p[2];
  if (pipe(p)) return fail("pipe");
  if (write(p[1], "piped\n", 6) != 6) return fail("write");
  close(p[1]);
  char path[32];
  snprintf(path, sizeof path, "/dev/fd/%d", p[0]);
  int n = open(path, O_RDONLY);
  if (n < 0) return fail(path);
  struct stat s1, s2;
  if (stat(path, &s1) || fstat(p[0], &s2)) return fail("stat");
  char buf[64];
  read_all(n, buf, sizeof buf);
  printf("new fd %s, fifo %s, same file %s, read %s", n != p[0] ? "yes" : "no",
         S_ISFIFO(s1.st_mode) ? "yes" : "no", s1.st_ino == s2.st_ino ? "yes" : "no", buf);

  /* A file: the opened fd shares the offset, as a dup does. */
  int f = open("/tmp/fdtest", O_CREAT | O_RDWR | O_TRUNC, 0600);
  if (f < 0 || write(f, "hello world", 11) != 11 || lseek(f, 0, SEEK_SET) != 0) {
    return fail("file");
  }
  snprintf(path, sizeof path, "/proc/self/fd/%d", f);
  int g = open(path, O_RDONLY);
  if (g < 0) return fail(path);
  char head[8] = {0}, tail[8] = {0};
  if (read(g, head, 5) != 5 || read(f, tail, 6) != 6) return fail("read");
  snprintf(path, sizeof path, "/dev/fd/%d", f);
  int h = open(path, O_RDONLY | O_CLOEXEC);
  printf("file %s|%s, F_GETFD %d %d\n", head, tail, fcntl(g, F_GETFD), fcntl(h, F_GETFD));

  int bad = open("/dev/fd/99", O_RDONLY);
  printf("closed fd: %s\n", bad < 0 && errno == EBADF ? "EBADF" : "opened");
  fflush(stdout);
  int out = open("/dev/stdout", O_WRONLY);
  if (out < 0 || write(out, "via /dev/stdout\n", 16) != 16) return fail("/dev/stdout");
  return 0;
}

static int sockets(void) {
  int plain[2], cloexec_pair[2];
  int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (s < 0) return fail("socket");
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, plain) ||
      socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, cloexec_pair)) {
    return fail("socketpair");
  }
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  strcpy(addr.sun_path, "/tmp/fdtest.sock");
  if (bind(s, (struct sockaddr *)&addr, sizeof addr) || listen(s, 1)) return fail("listen");
  int client = socket(AF_UNIX, SOCK_STREAM, 0);
  if (client < 0 || connect(client, (struct sockaddr *)&addr, sizeof addr)) return fail("connect");
  int conn = accept4(s, NULL, NULL, SOCK_CLOEXEC);
  if (conn < 0) return fail("accept4");
  printf("F_GETFD socket=%d client=%d pair=%d cloexec_pair=%d accept4=%d\n", fcntl(s, F_GETFD),
         fcntl(client, F_GETFD), fcntl(plain[0], F_GETFD), fcntl(cloexec_pair[0], F_GETFD),
         fcntl(conn, F_GETFD));
  fflush(stdout);
  if (write(plain[1], "through a socket\n", 17) != 17) return fail("write");
  close(plain[1]);
  int probe[] = {plain[0], s, cloexec_pair[0], conn};
  return spawn_probe(NULL, probe, 4);
}

static int readdev(int argc, char **argv) {
  for (int i = 0; i < argc; i++) {
    int fd = atoi(argv[i]);
    unsigned char buf[4];
    ssize_t n = read(fd, buf, sizeof buf);
    if (n < 0) printf("fd %d: %s\n", fd, errno == EBADF ? "closed" : strerror(errno));
    else if (n == 0) printf("fd %d: eof\n", fd);
    else printf("fd %d: %zd bytes\n", fd, n);
  }
  fflush(stdout);
  return 0;
}

static int devices(void) {
  int null_fd = open("/dev/null", O_RDONLY);
  int random_fd = open("/dev/urandom", O_RDONLY);
  if (null_fd < 0 || random_fd < 0) return fail("open");
  if (dup2(null_fd, 50) != 50 || dup2(random_fd, 51) != 51) return fail("dup2");
  char *argv[] = {"fdtest", "readdev", "50", "51", NULL};
  pid_t pid;
  int err = posix_spawn(&pid, "fdtest", NULL, NULL, argv, environ);
  if (err) {
    errno = err;
    return fail("posix_spawn");
  }
  int status = 0;
  if (waitpid(pid, &status, 0) != pid) return fail("waitpid");
  printf("readdev exited %d\n", WEXITSTATUS(status));
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && !strcmp(argv[1], "inherit")) return inherit();
  if (argc >= 3 && !strcmp(argv[1], "probe")) return probe(argc - 2, argv + 2);
  if (argc >= 2 && !strcmp(argv[1], "devfd")) return devfd();
  if (argc >= 2 && !strcmp(argv[1], "sockets")) return sockets();
  if (argc >= 2 && !strcmp(argv[1], "devices")) return devices();
  if (argc >= 3 && !strcmp(argv[1], "readdev")) return readdev(argc - 2, argv + 2);
  fprintf(stderr, "usage: fdtest inherit | probe FD... | devfd | sockets | devices\n");
  return 2;
}
