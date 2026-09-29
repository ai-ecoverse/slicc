/*
 * socktest — a BSD-sockets client and server for the wasm realm's loopback
 * network (#3571), built with the SLICC Emscripten toolchain and its
 * slicc_socket.c / slicc_select.c shims (see build.sh). Its tests run it as a
 * real wasm-realm process against the kernel (wasm-sockets.test.ts).
 *
 *   socktest server PORT COUNT    echo COUNT connections, upper-cased
 *   socktest client HOST PORT MSG non-blocking connect, send MSG, print the reply
 *   socktest http HOST PORT PATH  GET PATH over read/write, print the response
 *   socktest pipe HOST PORT       send stdin (a whole request), print the response
 *   socktest errors PORT          connect refused / unreachable, unknown host
 *   socktest unix PATH            AF_UNIX listener, client and socketpair in one process
 */
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static int fail(const char *what) {
  printf("%s: %s\n", what, strerror(errno));
  fflush(stdout);
  return 1;
}

static int server(int port, int count) {
  int one = 1;
  int s = socket(AF_INET, SOCK_STREAM, 0);
  if (s < 0) return fail("socket");
  if (setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one) < 0) return fail("setsockopt");
  struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(port)};
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(s, (struct sockaddr *)&addr, sizeof addr) < 0) return fail("bind");
  if (listen(s, 8) < 0) return fail("listen");
  socklen_t len = sizeof addr;
  if (getsockname(s, (struct sockaddr *)&addr, &len) < 0) return fail("getsockname");
  printf("listening %d\n", ntohs(addr.sin_port));
  fflush(stdout);
  for (int i = 0; i < count; i++) {
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(s, &rfds);
    if (select(s + 1, &rfds, NULL, NULL, NULL) != 1 || !FD_ISSET(s, &rfds)) return fail("select");
    struct sockaddr_in peer;
    len = sizeof peer;
    int c = accept(s, (struct sockaddr *)&peer, &len);
    if (c < 0) return fail("accept");
    char ip[INET_ADDRSTRLEN];
    printf("accepted %s\n", inet_ntop(AF_INET, &peer.sin_addr, ip, sizeof ip));
    fflush(stdout);
    char buf[4096];
    for (;;) {
      struct pollfd p = {.fd = c, .events = POLLIN};
      if (poll(&p, 1, 10000) != 1) return fail("poll");
      ssize_t n = recv(c, buf, sizeof buf, 0);
      if (n < 0) return fail("recv");
      if (n == 0) break;
      for (ssize_t j = 0; j < n; j++) buf[j] = (char)toupper((unsigned char)buf[j]);
      if (send(c, buf, n, MSG_NOSIGNAL) != n) return fail("send");
    }
    close(c);
  }
  close(s);
  return 0;
}

static int connect_to(const char *host, const char *port, int nonblock) {
  struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM}, *res;
  int r = getaddrinfo(host, port, &hints, &res);
  if (r != 0) {
    printf("getaddrinfo: %s\n", gai_strerror(r));
    return -1;
  }
  int s = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
  if (s < 0) return fail("socket"), -1;
  if (nonblock) fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);
  r = connect(s, res->ai_addr, res->ai_addrlen);
  freeaddrinfo(res);
  if (r < 0 && !(nonblock && errno == EINPROGRESS)) return fail("connect"), -1;
  if (r < 0) {
    printf("connect: in progress\n");
    struct pollfd p = {.fd = s, .events = POLLOUT};
    if (poll(&p, 1, 5000) != 1 || !(p.revents & POLLOUT)) return fail("poll connect"), -1;
    int err = -1;
    socklen_t len = sizeof err;
    if (getsockopt(s, SOL_SOCKET, SO_ERROR, &err, &len) < 0 || err != 0) return fail("SO_ERROR"), -1;
    fcntl(s, F_SETFL, fcntl(s, F_GETFL) & ~O_NONBLOCK);
  }
  return s;
}

static int client(const char *host, const char *port, const char *msg) {
  int s = connect_to(host, port, 1);
  if (s < 0) return 1;
  int one = 1;
  if (setsockopt(s, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one) < 0) return fail("TCP_NODELAY");
  if (setsockopt(s, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof one) < 0) return fail("SO_KEEPALIVE");
  char buf[4096];
  if (recv(s, buf, sizeof buf, MSG_DONTWAIT) < 0 && errno == EAGAIN) printf("dontwait: EAGAIN\n");
  size_t len = strlen(msg);
  if (send(s, msg, len, MSG_NOSIGNAL) != (ssize_t)len) return fail("send");
  if (shutdown(s, SHUT_WR) < 0) return fail("shutdown");
  size_t got = 0;
  ssize_t peeked = recv(s, buf, 1, MSG_PEEK);
  if (peeked != 1) return fail("peek");
  char first = buf[0];
  for (ssize_t n; (n = recv(s, buf + got, sizeof buf - 1 - got, 0)) > 0;) got += n;
  buf[got] = '\0';
  printf("peek %c, reply %s\n", first, buf);
  close(s);
  return 0;
}

static int http(const char *host, const char *port, const char *path) {
  int s = connect_to(host, port, 0);
  if (s < 0) return 1;
  char req[512];
  int n = snprintf(req, sizeof req, "GET %s HTTP/1.0\r\nHost: %s:%s\r\n\r\n", path, host, port);
  if (write(s, req, n) != n) return fail("write");
  char buf[4096];
  for (ssize_t r; (r = read(s, buf, sizeof buf)) > 0;) fwrite(buf, 1, r, stdout);
  close(s);
  return 0;
}

/* Send everything stdin holds, then copy the reply to stdout until the peer closes. */
static int pipe_request(const char *host, const char *port) {
  int s = connect_to(host, port, 0);
  if (s < 0) return 1;
  char buf[4096];
  for (ssize_t n; (n = read(0, buf, sizeof buf)) > 0;) {
    for (ssize_t off = 0; off < n;) {
      ssize_t w = write(s, buf + off, n - off);
      if (w < 0) return fail("write");
      off += w;
    }
  }
  for (ssize_t r; (r = read(s, buf, sizeof buf)) > 0;) fwrite(buf, 1, r, stdout);
  close(s);
  return 0;
}

static int errors(const char *port) {
  struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(atoi(port))};
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int s = socket(AF_INET, SOCK_STREAM, 0);
  if (connect(s, (struct sockaddr *)&addr, sizeof addr) < 0) printf("loopback: %s\n", strerror(errno));
  addr.sin_addr.s_addr = inet_addr("10.1.2.3");
  if (connect(s, (struct sockaddr *)&addr, sizeof addr) < 0) printf("remote: %s\n", strerror(errno));
  close(s);
  struct addrinfo *res;
  int r = getaddrinfo("example.com", "80", NULL, &res);
  printf("example.com: %s\n", r ? gai_strerror(r) : "resolved");
  if (socket(AF_INET6, SOCK_STREAM, 0) < 0) printf("inet6: %s\n", strerror(errno));
  return 0;
}

static int unix_sockets(const char *path) {
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  strncpy(addr.sun_path, path, sizeof addr.sun_path - 1);
  int l = socket(AF_UNIX, SOCK_STREAM, 0);
  if (bind(l, (struct sockaddr *)&addr, sizeof addr) < 0) return fail("bind");
  if (listen(l, 1) < 0) return fail("listen");
  int c = socket(AF_UNIX, SOCK_STREAM, 0);
  if (connect(c, (struct sockaddr *)&addr, sizeof addr) < 0) return fail("connect");
  int a = accept4(l, NULL, NULL, SOCK_NONBLOCK);
  if (a < 0) return fail("accept4");
  char buf[64];
  if (read(a, buf, sizeof buf) < 0 && errno == EAGAIN) printf("accepted nonblocking: EAGAIN\n");
  write(c, "over unix", 9);
  ssize_t n = read(a, buf, sizeof buf);
  printf("unix: %.*s\n", (int)n, buf);
  int sv[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) < 0) return fail("socketpair");
  write(sv[0], "paired", 6);
  n = read(sv[1], buf, sizeof buf);
  printf("socketpair: %.*s\n", (int)n, buf);
  return 0;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (argc == 4 && strcmp(argv[1], "server") == 0) return server(atoi(argv[2]), atoi(argv[3]));
  if (argc == 5 && strcmp(argv[1], "client") == 0) return client(argv[2], argv[3], argv[4]);
  if (argc == 5 && strcmp(argv[1], "http") == 0) return http(argv[2], argv[3], argv[4]);
  if (argc == 4 && strcmp(argv[1], "pipe") == 0) return pipe_request(argv[2], argv[3]);
  if (argc == 3 && strcmp(argv[1], "errors") == 0) return errors(argv[2]);
  if (argc == 3 && strcmp(argv[1], "unix") == 0) return unix_sockets(argv[2]);
  fprintf(stderr, "usage: socktest server|client|http|pipe|errors|unix ...\n");
  return 2;
}
