// A WASI command that imports a function from a namespace the runtime does
// not provide (acme_host.probe) and prints what the call returned.
#include <stdio.h>

__attribute__((import_module("acme_host"), import_name("probe"))) int acme_probe(void);
__attribute__((import_module("acme_host"), import_name("thread-spawn"))) int acme_spawn(void);

int main(void) {
  printf("probe=%d spawn=%d\n", acme_probe(), acme_spawn());
  return 0;
}
