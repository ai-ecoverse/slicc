/*
 * wasitest: a WASI preview1 program (wasi-libc) for the wasm realm's WASI
 * host (#3530 phase 5a). One subcommand per behavior; see wasi-programs.test.ts.
 */
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static int fail(const char *what) {
  fprintf(stderr, "%s: %s\n", what, strerror(errno));
  return 1;
}

/* stdin -> stdout, upper-cased, in 64 KiB reads. */
static int upper(void) {
  static char buf[65536];
  ssize_t n;
  while ((n = read(0, buf, sizeof buf)) > 0) {
    for (ssize_t i = 0; i < n; i++) buf[i] = (char)toupper((unsigned char)buf[i]);
    if (write(1, buf, (size_t)n) != n) return fail("write");
  }
  return n < 0 ? fail("read") : 0;
}

static int cmp(const void *a, const void *b) {
  return strcmp(*(const char *const *)a, *(const char *const *)b);
}

/* Sorted names of a directory, one line. */
static int list(const char *dir) {
  DIR *d = opendir(dir);
  if (!d) return fail("opendir");
  char *names[512];
  int n = 0;
  struct dirent *e;
  while ((e = readdir(d)) && n < 512) {
    if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) names[n++] = strdup(e->d_name);
  }
  closedir(d);
  qsort(names, (size_t)n, sizeof *names, cmp);
  printf("ls %s:", dir);
  for (int i = 0; i < n; i++) printf(" %s", names[i]);
  printf("\n");
  return 0;
}

/* Create, append, read back, rename, stat, symlink, list, remove. */
static int files(const char *dir) {
  char a[256], b[256], l[256], sub[256];
  snprintf(sub, sizeof sub, "%s/sub", dir);
  snprintf(a, sizeof a, "%s/sub/a.txt", dir);
  snprintf(b, sizeof b, "%s/sub/b.txt", dir);
  snprintf(l, sizeof l, "%s/sub/link", dir);
  if (mkdir(sub, 0755) && errno != EEXIST) return fail("mkdir");
  int fd = open(a, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return fail("open a");
  write(fd, "alpha\n", 6);
  close(fd);
  fd = open(a, O_WRONLY | O_APPEND);
  write(fd, "beta\n", 5);
  close(fd);
  if (rename(a, b)) return fail("rename");
  char buf[64] = {0};
  fd = open(b, O_RDONLY);
  ssize_t n = read(fd, buf, sizeof buf - 1);
  off_t end = lseek(fd, 0, SEEK_END);
  close(fd);
  struct stat st;
  if (stat(b, &st)) return fail("stat");
  printf("read %zd %s", n, buf);
  printf("size %lld end %lld reg %d\n", (long long)st.st_size, (long long)end, S_ISREG(st.st_mode));
  if (symlink("b.txt", l)) return fail("symlink");
  char target[64] = {0};
  readlink(l, target, sizeof target - 1);
  printf("link -> %s\n", target);
  list(sub);
  if (open(a, O_RDONLY) >= 0 || errno != ENOENT) return fail("gone");
  printf("a.txt: ENOENT\n");
  unlink(l);
  unlink(b);
  if (rmdir(sub)) return fail("rmdir");
  return list(dir);
}

/* pread / pwrite / ftruncate on one file. */
static int rw(const char *path) {
  int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return fail("open");
  write(fd, "0123456789", 10);
  pwrite(fd, "AB", 2, 4);
  char buf[16] = {0};
  pread(fd, buf, 6, 2);
  ftruncate(fd, 7);
  struct stat st;
  fstat(fd, &st);
  close(fd);
  printf("pread %s size %lld\n", buf, (long long)st.st_size);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) return 0;
  const char *cmd = argv[1];
  if (!strcmp(cmd, "upper")) return upper();
  if (!strcmp(cmd, "files")) return files(argc > 2 ? argv[2] : ".");
  if (!strcmp(cmd, "rw")) return rw(argv[2]);
  if (!strcmp(cmd, "ls")) return list(argv[2]);
  if (!strcmp(cmd, "cat")) {
    FILE *f = fopen(argv[2], "r");
    if (!f) return fail(argv[2]);
    int c;
    while ((c = fgetc(f)) != EOF) putchar(c);
    fclose(f);
    return 0;
  }
  if (!strcmp(cmd, "env")) {
    printf("argv0 %s argc %d HOME=%s\n", argv[0], argc, getenv("HOME") ? getenv("HOME") : "-");
    return 0;
  }
  if (!strcmp(cmd, "exit")) return atoi(argv[2]);
  if (!strcmp(cmd, "sleep")) {
    struct timespec t0, t1, d = {0, 30 * 1000 * 1000};
    clock_gettime(CLOCK_MONOTONIC, &t0);
    nanosleep(&d, NULL);
    clock_gettime(CLOCK_MONOTONIC, &t1);
    long ms = (t1.tv_sec - t0.tv_sec) * 1000 + (t1.tv_nsec - t0.tv_nsec) / 1000000;
    printf("slept %s\n", ms >= 30 ? "enough" : "too little");
    return 0;
  }
  if (!strcmp(cmd, "tty")) {
    printf("isatty 0=%d 1=%d\n", isatty(0), isatty(1));
    printf("lseek stdin %s\n", lseek(0, 0, SEEK_CUR) < 0 && errno == ESPIPE ? "ESPIPE" : "ok");
    return 0;
  }
  if (!strcmp(cmd, "dev")) {
    int fd = open("/dev/null", O_WRONLY);
    printf("devnull write %zd\n", write(fd, "x", 1));
    close(fd);
    unsigned char r[8];
    fd = open("/dev/urandom", O_RDONLY);
    printf("urandom %zd\n", read(fd, r, sizeof r));
    close(fd);
    fflush(stdout);
    fd = open("/dev/fd/1", O_WRONLY);
    dprintf(fd, "via /dev/fd/1\n");
    close(fd);
    return 0;
  }
  if (!strcmp(cmd, "spin")) {
    long n = atol(argv[2]);
    for (long i = 0; i < n; i++) write(1, "y\n", 2);
    return 0;
  }
  fprintf(stderr, "wasitest: unknown %s\n", cmd);
  return 2;
}
