// A WASI command that imports functions from a namespace the runtime does not
// provide (acme_host.*) and prints what the calls returned.
#include <stdio.h>

__attribute__((import_module("acme_host"), import_name("probe"))) int acme_probe(void);
__attribute__((import_module("acme_host"), import_name("thread-spawn"))) int acme_spawn(void);
__attribute__((import_module("acme_host"), import_name("wide"))) long long acme_wide(void);
__attribute__((import_module("acme_host"), import_name("note"))) void acme_note(void);

int main(void) {
  acme_note();
  printf("probe=%d spawn=%d wide=%lld\n", acme_probe(), acme_spawn(), acme_wide());
  return 0;
}
