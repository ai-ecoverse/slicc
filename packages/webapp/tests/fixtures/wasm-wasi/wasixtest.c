/*
 * wasixtest: a WASIX program (wasix-libc, Asyncify) for the wasm realm's
 * WASIX host (#3530 phase 5c): fork, exec, pipes, a file shared across a
 * fork, setjmp/longjmp, signals, chdir. See wasix-programs.test.ts.
 */
#include <errno.h>
#include <fcntl.h>
#include <setjmp.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static void report(const char *what, int status) {
  if (WIFEXITED(status)) printf("%s: exit %d\n", what, WEXITSTATUS(status));
  else if (WIFSIGNALED(status)) printf("%s: signal %d\n", what, WTERMSIG(status));
  else printf("%s: status %#x\n", what, status);
  fflush(stdout);
}

static jmp_buf env;
static int depth(int n) {
  if (n == 0) longjmp(env, 42);
  return depth(n - 1) + 1;
}

int main(int argc, char **argv) {
  const char *cmd = argc > 1 ? argv[1] : "";
  if (!strcmp(cmd, "fork")) {
    int local = 7;
    pid_t pid = fork();
    if (pid < 0) return perror("fork"), 1;
    if (pid == 0) {
      local += 1;
      printf("child sees %d\n", local);
      fflush(stdout);
      _exit(3);
    }
    int status = 0;
    if (waitpid(pid, &status, 0) != pid) return perror("waitpid"), 1;
    printf("parent still sees %d\n", local);
    report("child", status);
    return 0;
  }
  if (!strcmp(cmd, "pipe")) {
    /* parent | exec'd child (wasitest upper) */
    int fds[2];
    if (pipe(fds)) return perror("pipe"), 1;
    pid_t pid = fork();
    if (pid == 0) {
      dup2(fds[0], 0);
      close(fds[0]);
      close(fds[1]);
      char *args[] = {"wasitest", "upper", NULL};
      execvp("wasitest", args);
      perror("execvp");
      _exit(127);
    }
    close(fds[0]);
    const char *text = "through a pipe\nand an exec\n";
    write(fds[1], text, strlen(text));
    close(fds[1]);
    int status;
    waitpid(pid, &status, 0);
    report("upper", status);
    return 0;
  }
  if (!strcmp(cmd, "file")) {
    /* One open file across a fork: one offset, so writes append in order. */
    int fd = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    write(fd, "a", 1);
    pid_t pid = fork();
    if (pid == 0) {
      write(fd, "b", 1);
      _exit(0);
    }
    int status;
    waitpid(pid, &status, 0);
    write(fd, "c", 1);
    close(fd);
    return 0;
  }
  if (!strcmp(cmd, "longjmp")) {
    int v = setjmp(env);
    if (v == 0) {
      printf("setjmp 0\n");
      fflush(stdout);
      depth(5);
      printf("not reached\n");
      return 1;
    }
    printf("longjmp back with %d\n", v);
    return 0;
  }
  if (!strcmp(cmd, "signal")) {
    pid_t pid = fork();
    if (pid == 0) {
      kill(getpid(), SIGTERM);
      for (;;) sleep(1);
      _exit(0);
    }
    int status;
    waitpid(pid, &status, 0);
    report("killed child", status);
    return 0;
  }
  if (!strcmp(cmd, "cwd")) {
    char buf[256];
    printf("cwd %s\n", getcwd(buf, sizeof buf));
    if (chdir("sub")) return perror("chdir"), 1;
    printf("cwd %s\n", getcwd(buf, sizeof buf));
    FILE *f = fopen("inside.txt", "r");
    if (!f) return perror("fopen"), 1;
    printf("read %s", fgets(buf, sizeof buf, f));
    fclose(f);
    return 0;
  }
  if (!strcmp(cmd, "spawn")) {
    pid_t pid;
    char *args[] = {"wasitest", "env", NULL};
    int r = posix_spawnp(&pid, "wasitest", NULL, NULL, args, environ);
    if (r) return printf("posix_spawnp: %s\n", strerror(r)), 1;
    int status;
    waitpid(pid, &status, 0);
    report("spawned", status);
    return 0;
  }
  fprintf(stderr, "wasixtest: unknown %s\n", cmd);
  return 2;
}
