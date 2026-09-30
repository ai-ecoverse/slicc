/*
 * wasixtest: a WASIX program (wasix-libc, Asyncify) for the wasm realm's
 * WASIX host (#3530 phase 5c): fork, exec, pipes, a file shared across a
 * fork, setjmp/longjmp, signals, chdir. See wasix-programs.test.ts.
 */
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
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

static void *twice(void *p) {
  int *v = p;
  *v *= 2;
  return NULL;
}

static void *opener(void *p) {
  (void)p;
  return (void *)(long)open("tfile.txt", O_RDONLY);
}

static volatile sig_atomic_t got;
static void on_signal(int sig) { got = sig; }

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
  if (!strcmp(cmd, "subprocess")) {
    /*
     * Python's subprocess: a close-on-exec error pipe the parent reads to
     * EOF (the exec happened) before it writes the child's stdin.
     */
    int in[2], err[2];
    if (pipe(in) || pipe2(err, O_CLOEXEC)) return perror("pipe"), 1;
    pid_t pid = fork();
    if (pid == 0) {
      dup2(in[0], 0);
      close(in[0]);
      close(in[1]);
      close(err[0]);
      char *args[] = {"wasitest", "upper", NULL};
      execvp("wasitest", args);
      _exit(127);
    }
    close(in[0]);
    close(err[1]);
    char buf[16];
    ssize_t n = read(err[0], buf, sizeof buf);
    printf("errpipe EOF %d\n", n == 0);
    fflush(stdout);
    close(err[0]);
    write(in[1], "hi\n", 3);
    close(in[1]);
    int status;
    waitpid(pid, &status, 0);
    report("subprocess", status);
    return 0;
  }
  if (!strcmp(cmd, "handler")) {
    /* sigaction handlers run (5f): kill(self), an interval timer, and an uncaught SIGTERM. */
    struct sigaction sa = {0};
    sa.sa_handler = on_signal;
    sigaction(SIGUSR1, &sa, NULL);
    kill(getpid(), SIGUSR1);
    printf("handled %d\n", (int)got);
    sigaction(SIGALRM, &sa, NULL);
    got = 0;
    /* wasix-libc's setitimer passes it_interval only: a periodic timer. */
    struct itimerval it = {{0, 50000}, {0, 50000}};
    setitimer(ITIMER_REAL, &it, NULL);
    for (int i = 0; i < 100 && !got; i++) usleep(20000);
    struct itimerval off = {{0, 0}, {0, 0}};
    setitimer(ITIMER_REAL, &off, NULL);
    printf("alarm %d\n", (int)got);
    fflush(stdout);
    pid_t pid = fork();
    if (pid == 0) {
      /* A handler for another signal registers the callback; SIGTERM has none. */
      sigaction(SIGUSR2, &sa, NULL);
      kill(getpid(), SIGTERM);
      for (;;) usleep(20000);
    }
    int status;
    waitpid(pid, &status, 0);
    report("uncaught", status);
    return 0;
  }
  if (!strcmp(cmd, "socket")) {
    /* Sockets it opens itself (5f): listen, connect, accept, send, recv, getaddrinfo. */
    int s = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = {0};
    a.sin_family = AF_INET;
    inet_aton("127.0.0.1", &a.sin_addr);
    if (bind(s, (struct sockaddr *)&a, sizeof a) || listen(s, 1)) return perror("bind/listen"), 1;
    socklen_t len = sizeof a;
    getsockname(s, (struct sockaddr *)&a, &len);
    int c = socket(AF_INET, SOCK_STREAM, 0);
    if (connect(c, (struct sockaddr *)&a, sizeof a)) return perror("connect"), 1;
    struct sockaddr_in peer;
    len = sizeof peer;
    int d = accept(s, (struct sockaddr *)&peer, &len);
    if (d < 0) return perror("accept"), 1;
    send(c, "ping", 4, 0);
    char b[8];
    ssize_t n = recv(d, b, sizeof b, 0);
    printf("got %.*s on port>0 %d from %s\n", (int)n, b, ntohs(a.sin_port) > 0,
           inet_ntoa(peer.sin_addr));
    struct addrinfo hints = {0}, *ai;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    int r = getaddrinfo("localhost", "80", &hints, &ai);
    printf("localhost %s\n", r ? "unresolved" : inet_ntoa(((struct sockaddr_in *)ai->ai_addr)->sin_addr));
    r = getaddrinfo("example.com", "80", &hints, &ai);
    printf("example.com %s\n", r ? "unresolved" : "resolved");
    close(d);
    close(c);
    close(s);
    return 0;
  }
  if (!strcmp(cmd, "threads")) {
    /* pthreads on thread_spawn_v2; one descriptor table; a fork of a threaded process. */
    int fd = open("tfile.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    write(fd, "threaded\n", 9);
    close(fd);
    pthread_t t[3];
    int v[3] = {1, 2, 3};
    for (int i = 0; i < 3; i++) pthread_create(&t[i], NULL, twice, &v[i]);
    for (int i = 0; i < 3; i++) pthread_join(t[i], NULL);
    printf("doubled %d %d %d\n", v[0], v[1], v[2]);
    pthread_t o;
    void *r;
    pthread_create(&o, NULL, opener, NULL);
    pthread_join(o, &r);
    int tfd = (int)(long)r;
    char buf[32];
    ssize_t n = read(tfd, buf, sizeof buf);
    printf("read %.*s", (int)n, buf);
    fflush(stdout);
    pid_t pid = fork();
    if (pid == 0) {
      lseek(tfd, 0, SEEK_SET);
      n = read(tfd, buf, sizeof buf);
      printf("child read %.*s", (int)n, buf);
      fflush(stdout);
      _exit(0);
    }
    int status;
    waitpid(pid, &status, 0);
    report("child", status);
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
