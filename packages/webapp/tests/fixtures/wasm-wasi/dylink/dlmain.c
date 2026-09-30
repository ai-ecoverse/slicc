/* dlmain: a PIE main module that dlopens side modules (5g fixture). */
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

typedef int (*op_t)(int);
static op_t op;

static void *in_thread(void *arg) {
  (void)arg;
  return (void *)(long)op(100);
}

/* A thread resolves a function nobody took a pointer to yet: its table slot is new. */
static void *resolve_in_thread(void *arg) {
  (void)arg;
  return dlsym(RTLD_DEFAULT, "a_name");
}

int main(int argc, char **argv) {
  const char *dir = argc > 1 ? argv[1] : ".";
  char path[256];
  snprintf(path, sizeof path, "%s/libb.so", dir);
  void *b = dlopen(path, RTLD_NOW);
  if (!b) return printf("dlopen: %s\n", dlerror()), 1;
  int (*twice)(int) = (int (*)(int))dlsym(b, "b_twice");
  char *(*describe)(void) = (char *(*)(void))dlsym(b, "b_describe");
  op_t (*get_op)(void) = (op_t (*)(void))dlsym(b, "b_op");
  int *counter = (int *)dlsym(b, "a_counter");
  if (!twice || !describe || !get_op) return printf("dlsym: %s\n", dlerror()), 1;
  printf("twice %d\n", twice(1));
  char *d = describe();
  printf("%s\n", d);
  free(d);
  printf("counter via dlsym %d\n", counter ? *counter : -1);
  printf("missing %s\n", dlsym(b, "no_such_symbol") ? "found" : "null");
  op = get_op();
  printf("pointer call %d\n", op(1));
  pthread_t t;
  void *r;
  pthread_create(&t, NULL, in_thread, NULL);
  pthread_join(t, &r);
  printf("thread call %ld\n", (long)r);
  pthread_create(&t, NULL, resolve_in_thread, NULL);
  pthread_join(t, &r);
  printf("resolved in a thread\n");
  printf("main calls it: %s\n", ((const char *(*)(void))r)());
  return 0;
}
