/*
 * wasisock: a WASI preview1 socket program (wasi-libc) for the wasm realm
 * (#3530 phase 5b). Its listener is the socket `wasm --listen` hands it,
 * named by $SLICC_LISTEN_FDS. See wasi-programs.test.ts.
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int listener(void) {
  const char *fds = getenv("SLICC_LISTEN_FDS");
  if (!fds) {
    fprintf(stderr, "wasisock: no SLICC_LISTEN_FDS\n");
    exit(2);
  }
  return atoi(fds);
}

/* One connection: read a line, answer "echo: LINE", shut down the write side. */
static int serve_one(int conn) {
  char buf[256];
  char peek[8] = {0};
  ssize_t n = recv(conn, peek, 4, MSG_PEEK);
  if (n < 0) return perror("recv peek"), 1;
  size_t got = 0;
  while (got < sizeof buf - 1) {
    n = recv(conn, buf + got, sizeof buf - 1 - got, 0);
    if (n <= 0) break;
    got += (size_t)n;
    if (memchr(buf, '\n', got)) break;
  }
  buf[got] = 0;
  char reply[300];
  int len = snprintf(reply, sizeof reply, "echo: %s", buf);
  if (send(conn, reply, (size_t)len, 0) != len) return perror("send"), 1;
  if (shutdown(conn, SHUT_WR)) return perror("shutdown"), 1;
  printf("served (peeked %.4s)\n", peek);
  fflush(stdout);
  close(conn);
  return 0;
}

int main(int argc, char **argv) {
  const char *cmd = argc > 1 ? argv[1] : "serve";
  if (!strcmp(cmd, "serve")) {
    int l = listener();
    /* The listener comes non-blocking: this server blocks in accept. */
    fcntl(l, F_SETFL, fcntl(l, F_GETFL) & ~O_NONBLOCK);
    int count = argc > 2 ? atoi(argv[2]) : 1;
    printf("listening on fd %d\n", l);
    fflush(stdout);
    for (int i = 0; i < count; i++) {
      int conn = accept(l, NULL, NULL);
      if (conn < 0) return perror("accept"), 1;
      if (serve_one(conn)) return 1;
    }
    return 0;
  }
  if (!strcmp(cmd, "nonblock")) {
    int l = listener();
    printf("starts %s\n", (fcntl(l, F_GETFL) & O_NONBLOCK) ? "non-blocking" : "blocking");
    int conn = accept(l, NULL, NULL);
    printf("accept now: %s\n", conn < 0 && errno == EAGAIN ? "EAGAIN" : "?");
    fflush(stdout);
    struct pollfd p = {.fd = l, .events = POLLIN};
    int r = poll(&p, 1, 10000);
    printf("poll: %d %s\n", r, (p.revents & POLLIN) ? "POLLIN" : "-");
    fflush(stdout);
    conn = accept(l, NULL, NULL);
    if (conn < 0) return perror("accept"), 1;
    return serve_one(conn);
  }
  if (!strcmp(cmd, "hangup")) {
    /* stdin is a pipe whose writer goes away: poll reports POLLHUP. */
    char buf[64];
    for (;;) {
      struct pollfd p = {.fd = 0, .events = POLLIN};
      if (poll(&p, 1, 10000) < 1) return printf("timeout\n"), 1;
      if (p.revents & POLLHUP) {
        ssize_t n = read(0, buf, sizeof buf);
        printf("POLLHUP, then read %zd\n", n);
        if (n == 0) return 0;
        continue;
      }
      if (read(0, buf, sizeof buf) <= 0) return printf("eof without POLLHUP\n"), 1;
    }
  }
  if (!strcmp(cmd, "notsock")) {
    char c;
    printf("recv on stdin: %s\n", recv(0, &c, 1, 0) < 0 && errno == ENOTSOCK ? "ENOTSOCK" : "?");
    return 0;
  }
  return 2;
}
